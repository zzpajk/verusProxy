// Run shell commands on devices over SSH (Termux sshd, port 8022) from the dashboard.
// Uses the proxy machine's own `ssh` client with key authentication only - no passwords
// are stored. Devices are addressed by worker name; the proxy looks up their IP itself,
// so the dashboard can never point it at an arbitrary host.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const OUTPUT_CAP = 32 * 1024;        // per device, stdout + stderr each
const KEEP_RUNS = 30;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\]PX^_][^\x1b]*\x1b\\|\r/g;

function hint(text, code) {
    let t = text || '';
    if (/Permission denied/i.test(t)) return 'Key not accepted: install the proxy\'s public key on this device (see Remote commands → Setup).';
    if (/Connection refused/i.test(t)) return 'Nothing listening on the SSH port: start sshd in Termux (run `sshd`).';
    if (/timed out|No route to host|Network is unreachable|Host is down/i.test(t)) return 'Device not reachable on the network.';
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(t)) return 'Host key changed (Termux reinstalled?). Remove this device\'s line from data/ssh_known_hosts and try again.';
    if (/Could not resolve hostname/i.test(t)) return 'Bad device address.';
    if (code === 255) return 'SSH connection failed.';
    return null;
}

class SshRunner {
    constructor(config) {
        let s = config.ssh || {};
        let d = config.dashboard || {};
        this.dataDir = path.resolve(__dirname, '..', d.dataDir || 'data');
        this.cfg = {
            enabled: s.enabled === true,
            user: /^[a-zA-Z0-9._-]{1,32}$/.test(s.user || '') ? s.user : 'eek',
            port: Number(s.port) > 0 && Number(s.port) < 65536 ? Number(s.port) : 8022,
            identityFile: s.identityFile ? s.identityFile.replace(/^~(?=\/)/, os.homedir()) : null,
            timeoutSec: Math.min(Math.max(Number(s.timeoutSec) || 60, 5), 3600),
            parallel: Math.min(Math.max(Number(s.parallel) || 10, 1), 50),
            allowCustom: s.allowCustomCommands !== false,
            presets: Array.isArray(s.presets) ? s.presets.filter(p => p && typeof p.name === 'string' && typeof p.command === 'string')
                .map(p => ({ name: p.name.slice(0, 40), command: p.command.slice(0, 4000) })) : []
        };
        this.authConfigured = !!d.auth;
        this.knownHosts = path.join(this.dataDir, 'ssh_known_hosts');
        this.logFile = path.join(this.dataDir, 'ssh-log.jsonl');
        this.runsFile = path.join(this.dataDir, 'ssh-runs.json');
        this.runs = [];
        this.queue = [];
        this.active = 0;
        this.load();
    }

    // why remote commands can't be used right now (null = they can)
    disabledReason() {
        if (!this.cfg.enabled) return 'Remote commands are off. Set "ssh": { "enabled": true } in config.local.json and restart.';
        if (!this.authConfigured) return 'Remote commands need a dashboard login: set dashboard.auth ("user:password") in config.local.json and restart.';
        return null;
    }

    publicKey() {
        let candidates = this.cfg.identityFile ? [this.cfg.identityFile + '.pub']
            : ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub'].map(f => path.join(os.homedir(), '.ssh', f));
        for (let f of candidates) {
            try { return fs.readFileSync(f, 'utf8').trim().slice(0, 2000); } catch (e) {}
        }
        return null;
    }

    info() {
        return {
            enabled: !this.disabledReason(),
            reason: this.disabledReason(),
            user: this.cfg.user,
            port: this.cfg.port,
            timeoutSec: this.cfg.timeoutSec,
            allowCustom: this.cfg.allowCustom,
            presets: this.cfg.presets,
            publicKey: this.disabledReason() ? null : this.publicKey(),
            proxyUser: os.userInfo().username,
            runs: this.runs.slice(0, KEEP_RUNS).map(r => this.summary(r))
        };
    }

    summary(r) {
        let c = { ok: 0, failed: 0, running: 0 };
        for (let t of r.targets) {
            if (t.state === 'ok') c.ok++;
            else if (t.state === 'queued' || t.state === 'running') c.running++;
            else c.failed++;
        }
        return { id: r.id, t: r.t, by: r.by, command: r.command, preset: r.preset, count: r.targets.length, ...c, done: c.running === 0 };
    }

    get(id) { return this.runs.find(r => r.id === id) || null; }

    // targets: [{ name, ip }] resolved by the caller from live stats
    start({ targets, command, preset, by }) {
        let reason = this.disabledReason();
        if (reason) return { ok: false, error: reason };
        if (preset !== undefined && preset !== null) {
            let p = this.cfg.presets.find(x => x.name === preset);
            if (!p) return { ok: false, error: 'unknown preset' };
            command = p.command;
        } else {
            if (!this.cfg.allowCustom) return { ok: false, error: 'only saved commands are allowed (ssh.allowCustomCommands is false)' };
            if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'empty command' };
            if (command.length > 4000) return { ok: false, error: 'command too long' };
        }
        if (!Array.isArray(targets) || targets.length === 0) return { ok: false, error: 'no devices selected' };
        if (targets.length > 500) return { ok: false, error: 'too many devices' };
        let run = {
            id: crypto.randomBytes(6).toString('hex'),
            t: Date.now(),
            by: by || null,
            command,
            preset: preset || null,
            targets: targets.map(t => ({ name: t.name, ip: t.ip, state: 'queued', exit: null, ms: null, out: '', err: '', note: null }))
        };
        this.runs.unshift(run);
        while (this.runs.length > KEEP_RUNS) this.runs.pop();
        for (let tg of run.targets) this.queue.push([run, tg]);
        this.pump();
        return { ok: true, id: run.id };
    }

    pump() {
        while (this.active < this.cfg.parallel && this.queue.length) {
            let [run, tg] = this.queue.shift();
            this.active++;
            this.exec(run, tg).then(() => {
                this.active--;
                if (run.targets.every(t => t.state !== 'queued' && t.state !== 'running')) this.finish(run);
                this.pump();
            });
        }
    }

    exec(run, tg) {
        return new Promise(resolve => {
            tg.state = 'running';
            let started = Date.now();
            let validIp = typeof tg.ip === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(tg.ip) && !tg.ip.startsWith('-');
            if (!validIp) {
                Object.assign(tg, { state: 'error', note: 'Device address unknown (it has never connected to the proxy).', ms: 0 });
                return resolve();
            }
            let args = [
                '-p', String(this.cfg.port),
                '-o', 'BatchMode=yes',                       // never prompt for a password
                '-o', 'ConnectTimeout=10',
                '-o', 'ServerAliveInterval=15',
                '-o', 'StrictHostKeyChecking=accept-new',    // trust on first use ...
                '-o', 'UserKnownHostsFile=' + this.knownHosts,
                '-o', 'HostKeyAlias=verusproxy-' + tg.name.replace(/[^a-zA-Z0-9._@-]/g, '_'), // ... per device, not per (DHCP) IP
                '-o', 'LogLevel=ERROR'
            ];
            if (this.cfg.identityFile) args.push('-i', this.cfg.identityFile, '-o', 'IdentitiesOnly=yes');
            args.push(`${this.cfg.user}@${tg.ip}`, run.command);

            let child;
            try {
                fs.mkdirSync(this.dataDir, { recursive: true });
                child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                Object.assign(tg, { state: 'error', note: e.message, ms: 0 });
                return resolve();
            }
            let timedOut = false;
            // on timeout: kill ssh and finish right away - don't wait for the pipes to close,
            // something it started may still be holding them open
            let timer = setTimeout(() => {
                timedOut = true;
                try { child.kill('SIGKILL'); } catch (e) {}
                try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) {}
                finish(null);
            }, this.cfg.timeoutSec * 1000);
            let collect = (key) => (d) => { if (tg[key].length < OUTPUT_CAP) tg[key] += d.toString('utf8'); };
            child.stdout.on('data', collect('out'));
            child.stderr.on('data', collect('err'));
            let done = false;
            let finish = (code, spawnErr) => {
                if (done) return; done = true;
                clearTimeout(timer);
                tg.ms = Date.now() - started;
                tg.out = tg.out.replace(ANSI, '').slice(0, OUTPUT_CAP);
                tg.err = tg.err.replace(ANSI, '').slice(0, OUTPUT_CAP);
                if (spawnErr) {
                    tg.state = 'error';
                    tg.note = spawnErr.code === 'ENOENT' ? 'The `ssh` command is not installed on the proxy machine (sudo apt install openssh-client).' : spawnErr.message;
                } else if (timedOut) {
                    tg.state = 'timeout';
                    tg.note = `Stopped after ${this.cfg.timeoutSec} s (ssh.timeoutSec).`;
                } else {
                    tg.exit = code;
                    tg.state = code === 0 ? 'ok' : (code === 255 ? 'error' : 'failed');
                    tg.note = code === 0 ? null : hint(tg.err, code);
                }
                resolve();
            };
            child.on('error', e => finish(null, e));
            child.on('close', code => finish(code));
        });
    }

    finish(run) {
        let s = this.summary(run);
        console.log(`ssh: "${run.command.slice(0, 80)}" on ${s.count} device(s) by ${run.by || '?'}: ${s.ok} ok, ${s.failed} failed`);
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            let lines = run.targets.map(t => JSON.stringify({
                t: new Date(run.t).toISOString(), run: run.id, by: run.by, device: t.name, ip: t.ip,
                command: run.command, state: t.state, exit: t.exit, ms: t.ms,
                out: t.out.slice(0, 4000), err: t.err.slice(0, 2000), note: t.note
            }));
            fs.appendFileSync(this.logFile, lines.join('\n') + '\n');
            this.rotateLog();
        } catch (e) {
            console.log('ssh: unable to write log', e.message);
        }
        this.save();
    }

    // keep the log under ~5 MB
    rotateLog() {
        try {
            if (fs.statSync(this.logFile).size > 5 * 1024 * 1024) fs.renameSync(this.logFile, this.logFile + '.1');
        } catch (e) {}
    }

    save() {
        try {
            let done = this.runs.filter(r => r.targets.every(t => t.state !== 'queued' && t.state !== 'running'));
            let slim = done.map(r => Object.assign({}, r, { targets: r.targets.map(t => Object.assign({}, t, { out: t.out.slice(0, 16384), err: t.err.slice(0, 4096) })) }));
            fs.writeFileSync(this.runsFile + '.tmp', JSON.stringify(slim));
            fs.renameSync(this.runsFile + '.tmp', this.runsFile);
        } catch (e) {}
    }

    load() {
        try {
            if (fs.existsSync(this.runsFile)) this.runs = JSON.parse(fs.readFileSync(this.runsFile, 'utf8')).slice(0, KEEP_RUNS);
        } catch (e) {
            console.log('ssh: unable to load run history', e.message);
        }
    }
}

exports.SshRunner = SshRunner;
