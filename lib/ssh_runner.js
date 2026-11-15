// Run shell commands on devices from the dashboard: over SSH (Termux sshd 8022, UserLAnd 2022, ...)
// or over ADB (shell or root shell, via the device registry's adb connection).
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

function hint(text, code, usingPassword) {
    let t = text || '';
    if (/Permission denied/i.test(t)) return usingPassword
        ? 'Password not accepted: check ssh.password, and that this device\'s Termux password is the same (set it with `passwd`).'
        : 'Key not accepted: install the proxy\'s public key on this device (see Remote commands → Setup).';
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
            // optional, for a trusted LAN: log in with a password instead of a key
            password: typeof s.password === 'string' && s.password.length ? s.password : null,
            // "accept-new" (remember each device's key, refuse if it changes) or "off" (never check)
            hostKeyCheck: s.hostKeyCheck === 'off' ? 'off' : 'accept-new',
            user: /^[a-zA-Z0-9._-]{1,32}$/.test(s.user || '') ? s.user : 'eek',
            port: Number(s.port) > 0 && Number(s.port) < 65536 ? Number(s.port) : 8022,
            identityFile: s.identityFile ? s.identityFile.replace(/^~(?=\/)/, os.homedir()) : null,
            timeoutSec: Math.min(Math.max(Number(s.timeoutSec) || 60, 5), 3600),
            parallel: Math.min(Math.max(Number(s.parallel) || 10, 1), 50),
            allowCustom: s.allowCustomCommands !== false,
            ports: null,   // filled below
            presets: Array.isArray(s.presets) ? s.presets.filter(p => p && typeof p.name === 'string' && typeof p.command === 'string')
                .map(p => ({ name: p.name.slice(0, 40), command: p.command.slice(0, 4000) })) : []
        };
        // ports to choose from in the panel: [8022, 2022] or [{ port, name, user, password }, ...];
        // the default ssh.port is always first. A port's own user/password override the global ones.
        let validPort = (p) => Number(p) > 0 && Number(p) < 65536;
        let list = [{ port: this.cfg.port }].concat(Array.isArray(s.ports) ? s.ports : []).map(e => {
            let o = typeof e === 'object' && e ? e : { port: e };
            if (!validPort(o.port)) return null;
            return {
                port: Number(o.port),
                name: typeof o.name === 'string' ? o.name.slice(0, 30) : null,
                user: /^[a-zA-Z0-9._-]{1,32}$/.test(o.user || '') ? o.user : null,
                password: typeof o.password === 'string' && o.password.length ? o.password : null
            };
        }).filter(Boolean);
        this.cfg.ports = [];
        for (let e of list) {
            let have = this.cfg.ports.find(x => x.port === e.port);
            if (have) { for (let k of ['name', 'user', 'password']) if (e[k]) have[k] = e[k]; }
            else this.cfg.ports.push(e);
        }
        this.authConfigured = !!d.auth;
        this.knownHosts = path.join(this.dataDir, 'ssh_known_hosts');
        this.logFile = path.join(this.dataDir, 'ssh-log.jsonl');
        this.runsFile = path.join(this.dataDir, 'ssh-runs.json');
        this.runs = [];
        this.queue = [];
        this.active = 0;
        this.load();
    }

    // ADB channels ("ADB shell", "ADB root shell") come from the device registry
    attachAdb(adb, reasonFn) { this.adb = adb; this.adbReason = reasonFn; }

    // why remote commands can't be used right now on a channel (null = they can);
    // without a channel: null if any channel can be used
    disabledReason(channel) {
        if (channel === 'adb' || channel === 'adbroot') return this.adb ? this.adbReason() : 'ADB is not available.';
        let sshReason = null;
        if (!this.cfg.enabled) sshReason = 'Remote commands over SSH are off. Set "ssh": { "enabled": true } in config.local.json and restart.';
        else if (!this.authConfigured) sshReason = 'Remote commands need a dashboard login: set dashboard.auth ("user:password") in config.local.json and restart.';
        if (channel === 'ssh' || !this.adb || !sshReason) return sshReason;
        return this.adbReason() ? sshReason : null;
    }

    // what the panel can send commands through
    channels() {
        let out = this.cfg.ports.map(e => ({ id: 'ssh:' + e.port, kind: 'ssh', port: e.port, name: this.portName(e.port) + ' SSH (' + e.port + ')', reason: this.disabledReason('ssh') }));
        if (this.adb) {
            out.push({ id: 'adb', kind: 'adb', name: 'ADB shell', reason: this.disabledReason('adb') });
            out.push({ id: 'adbroot', kind: 'adb', name: 'ADB root shell', reason: this.disabledReason('adbroot') });
        }
        return out;
    }

    // tiny script ssh runs to get the password; answers password prompts only
    askpassHelper() {
        let file = path.join(this.dataDir, 'ssh-askpass.sh');
        let body = '#!/bin/sh\n' +
            '# written by verusProxy: gives ssh the password from ssh.password (via the environment)\n' +
            'case "$1" in *assword*|*PIN*) printf \'%s\\n\' "$VP_SSH_PASSWORD" ;; *) exit 1 ;; esac\n';
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o700 });
            fs.chmodSync(file, 0o700);
        } catch (e) {}
        return file;
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
            sshEnabled: !this.disabledReason('ssh'),
            channels: this.channels(),
            user: this.cfg.user,
            port: this.cfg.port,
            timeoutSec: this.cfg.timeoutSec,
            allowCustom: this.cfg.allowCustom,
            authMode: this.cfg.password ? 'password' : 'key',      // the password itself never leaves the proxy
            ports: this.cfg.ports.map(e => ({ port: e.port, name: e.name, user: this.login(e.port).user, authMode: this.login(e.port).password ? 'password' : 'key' })),
            hostKeyCheck: this.cfg.hostKeyCheck,
            presets: this.cfg.presets,
            publicKey: this.disabledReason('ssh') ? null : this.publicKey(),
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
        return { id: r.id, t: r.t, by: r.by, command: r.command, preset: r.preset, channel: r.channel || 'ssh', port: r.port || this.cfg.port, via: this.channelName(r), count: r.targets.length, ...c, done: c.running === 0 };
    }

    // user/password for a port: the port's own, else the global ones
    login(port) {
        let e = this.cfg.ports.find(x => x.port === port) || {};
        return { user: e.user || this.cfg.user, password: e.password || this.cfg.password };
    }

    get(id) { return this.runs.find(r => r.id === id) || null; }

    // "Termux" / "UserLAnd" / the name from ssh.ports
    portName(port) {
        let e = this.cfg.ports.find(x => x.port === port);
        return (e && e.name) || (port === 8022 ? 'Termux' : port === 2022 ? 'UserLAnd' : 'SSH');
    }

    channelName(r) {
        if (r.channel === 'adb') return 'ADB';
        if (r.channel === 'adbroot') return 'ADB root';
        let p = r.port || this.cfg.port;
        return this.portName(p) + ' ' + p;
    }

    // targets: [{ name, ip }] resolved by the caller from live stats
    // internal: a command built by the proxy itself (e.g. "Install ADB key"), shown under that name
    start({ targets, command, preset, by, port, channel, internal }) {
        channel = channel === 'adb' || channel === 'adbroot' ? channel : 'ssh';
        let reason = this.disabledReason(channel);
        if (reason) return { ok: false, error: reason };
        if (channel === 'ssh') {
            port = port === undefined || port === null ? this.cfg.port : Number(port);
            // only ports from the settings, never one typed into the page
            if (!this.cfg.ports.some(e => e.port === port)) return { ok: false, error: `port ${port} is not in ssh.ports` };
        } else {
            port = null;
        }
        if (preset !== undefined && preset !== null) {
            let p = this.cfg.presets.find(x => x.name === preset);
            if (!p) return { ok: false, error: 'unknown preset' };
            command = p.command;
        } else if (internal) {
            preset = String(internal);
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
            channel,
            port,
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
            (run.channel === 'adb' || run.channel === 'adbroot' ? this.execAdb(run, tg) : this.exec(run, tg)).then(() => {
                this.active--;
                if (run.targets.every(t => t.state !== 'queued' && t.state !== 'running')) this.finish(run);
                this.pump();
            });
        }
    }

    // ssh options for one device + port (host key alias, password helper, key): shared by commands and miner updates
    sshSetup(name, port) {
        let { user, password } = this.login(port);
        let args = ['-p', String(port), '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'LogLevel=ERROR'];
        if (this.cfg.hostKeyCheck === 'off') {
            // accept any host key, remember nothing (no "host key changed" errors after a reinstall)
            args.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null');
        } else {
            args.push('-o', 'StrictHostKeyChecking=accept-new',            // trust on first use ...
                '-o', 'UserKnownHostsFile=' + this.knownHosts,
                // ... per device (not per DHCP address) and per port: two SSH servers on one phone have different keys
                '-o', 'HostKeyAlias=verusproxy-' + name.replace(/[^a-zA-Z0-9._@-]/g, '_') + (port === this.cfg.port ? '' : '-' + port));
        }
        let env = process.env;
        if (password) {
            // ssh only reads passwords from a terminal or an "askpass" helper; the helper hands it
            // the password from an environment variable, so it never appears on a command line
            args.push('-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1',
                '-o', 'PreferredAuthentications=publickey,keyboard-interactive,password');
            env = Object.assign({}, process.env, {
                SSH_ASKPASS: this.askpassHelper(),
                SSH_ASKPASS_REQUIRE: 'force',     // OpenSSH 8.4+
                DISPLAY: process.env.DISPLAY || ':0',   // older OpenSSH only uses askpass when DISPLAY is set
                VP_SSH_PASSWORD: password
            });
        } else {
            args.push('-o', 'BatchMode=yes');      // keys only, never prompt
        }
        if (this.cfg.identityFile) args.push('-i', this.cfg.identityFile, '-o', 'IdentitiesOnly=yes');
        return { args, env, password, user };
    }

    // run one command on one device; stdin from a file and stdout to a file are optional (binary transfers).
    // Never throws. Result: { code, out, err, timedOut, error, note }
    sshRaw(name, ip, port, command, opts) {
        opts = opts || {};
        return new Promise(resolve => {
            if (!(typeof ip === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(ip) && !ip.startsWith('-'))) return resolve({ code: null, error: 'Device address unknown.', out: '', err: '' });
            let { args, env, password, user } = this.sshSetup(name, port);
            args.push(`${user}@${ip}`, command);
            let child, out = '', err = '', done = false, outFile = null;
            try {
                fs.mkdirSync(this.dataDir, { recursive: true });
                child = spawn('ssh', args, { stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'], env, detached: !!password });
            } catch (e) { return resolve({ code: null, error: e.message, out: '', err: '' }); }
            let finish = (r) => {
                if (done) return; done = true;
                clearTimeout(timer);
                if (outFile) { try { outFile.end(); } catch (e) {} }
                r.out = out.replace(ANSI, ''); r.err = err.replace(ANSI, '');
                if (r.code !== 0 && !r.error && !r.timedOut) r.note = hint(r.err, r.code, !!password);
                resolve(r);
            };
            let timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (e) {}
                try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) {}
                finish({ code: null, timedOut: true });
            }, opts.timeoutMs || this.cfg.timeoutSec * 1000);
            if (opts.stdoutFile) {
                outFile = fs.createWriteStream(opts.stdoutFile, { mode: 0o600 });
                child.stdout.pipe(outFile);
            } else child.stdout.on('data', d => { if (out.length < 256 * 1024) out += d; });
            child.stderr.on('data', d => { if (err.length < 64 * 1024) err += d; });
            if (opts.stdinFile) {
                let rs = fs.createReadStream(opts.stdinFile);
                rs.on('error', e => finish({ code: null, error: e.message }));
                child.stdin.on('error', () => {});
                rs.pipe(child.stdin);
            }
            child.on('error', e => finish({ code: null, error: e.code === 'ENOENT' ? 'The `ssh` command is not installed on the proxy machine (sudo apt install openssh-client).' : e.message }));
            child.on('close', code => {
                if (outFile) outFile.on('finish', () => finish({ code })); else finish({ code });
                if (outFile) setTimeout(() => finish({ code }), 2000);
            });
        });
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
            let port = run.port || this.cfg.port;
            let { args, env, password } = this.sshSetup(tg.name, port);
            args.push(`${this.login(port).user}@${tg.ip}`, run.command);

            let child;
            try {
                fs.mkdirSync(this.dataDir, { recursive: true });
                // detached: own session without a terminal, so ssh can't try to prompt on one
                child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: !!password });
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
                    tg.note = code === 0 ? null : hint(tg.err, code, !!password);
                }
                resolve();
            };
            child.on('error', e => finish(null, e));
            child.on('close', code => finish(code));
        });
    }

    // the same over ADB (phone-ip:5555), as the shell user or through su
    async execAdb(run, tg) {
        tg.state = 'running';
        let started = Date.now();
        if (!(typeof tg.ip === 'string' && /^[0-9.]{7,15}$/.test(tg.ip))) {
            Object.assign(tg, { state: 'error', note: 'Device address unknown.', ms: 0 });
            return;
        }
        if (!require('./registry.js').isLan(tg.ip)) {
            Object.assign(tg, { state: 'error', note: tg.ip + ' is not a local network address; ADB is only used on the LAN.', ms: 0 });
            return;
        }
        let c = await this.adb.connect(tg.ip);
        if (!c.ok) {
            Object.assign(tg, { state: 'error', note: c.msg, ms: Date.now() - started });
            return;
        }
        let r = await this.adb.shell(c.serial, run.command, { root: run.channel === 'adbroot', timeoutMs: this.cfg.timeoutSec * 1000 });
        tg.ms = Date.now() - started;
        tg.out = (r.out || '').replace(ANSI, '').slice(0, OUTPUT_CAP);
        tg.err = (r.err || '').replace(ANSI, '').slice(0, OUTPUT_CAP);
        if (r.error) Object.assign(tg, { state: 'error', note: r.error });
        else if (r.timedOut) Object.assign(tg, { state: 'timeout', note: `Stopped after ${this.cfg.timeoutSec} s (ssh.timeoutSec).` });
        else {
            tg.exit = r.code;
            tg.state = r.code === 0 ? 'ok' : 'failed';
            if (r.code !== 0 && run.channel === 'adbroot' && /not found|permission denied|not allowed/i.test(tg.err + tg.out)) tg.note = 'No root for ADB: in Magisk, allow root for "Shell" (com.android.shell), or the phone is not rooted.';
        }
    }

    finish(run) {
        let s = this.summary(run);
        console.log(`remote: "${run.command.slice(0, 80)}" via ${s.via} on ${s.count} device(s) by ${run.by || '?'}: ${s.ok} ok, ${s.failed} failed`);
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            let lines = run.targets.map(t => JSON.stringify({
                t: new Date(run.t).toISOString(), run: run.id, by: run.by, via: s.via, device: t.name, ip: t.ip,
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
