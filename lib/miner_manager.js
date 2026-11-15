// Miner updates (runs in the cluster master): which ccminer each phone runs, and putting a new one on
// many phones at once - built from source on the phones (the fork's build-verus.sh), or a binary the
// proxy keeps (downloaded from a URL, or copied from a phone that already runs it).
// Works over SSH (Termux 8022 by default, or another port from ssh.ports such as UserLAnd 2022) with the
// same login and safety rules as Remote commands. Phone-side scripts: lib/phone/*.sh.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const S = require('./miner_scripts.js');
const { isLan } = require('./registry.js');

const MINUTE = 60000;
const KEEP_JOBS = 20;
const MAX_BINARY = 64 * 1024 * 1024;

function sha256File(file) {
    return new Promise((resolve, reject) => {
        let h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}
// 64-bit or 32-bit ARM Linux/Android program?
function elfArch(file) {
    try {
        let fd = fs.openSync(file, 'r'), b = Buffer.alloc(20);
        fs.readSync(fd, b, 0, 20, 0); fs.closeSync(fd);
        if (b.readUInt32BE(0) !== 0x7f454c46) return null;
        let m = b.readUInt16LE(18);
        return m === 183 ? 'aarch64' : m === 40 ? 'arm' : m === 62 ? 'x86_64' : 'machine ' + m;
    } catch (e) { return null; }
}
async function pool(items, n, fn) {
    let i = 0;
    let worker = async () => { while (i < items.length) { let it = items[i++]; try { await fn(it); } catch (e) { console.log('miner:', e.message); } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
// "https://github.com/owner/repo(.git)" -> { owner, repo }
function githubRepo(url) {
    let m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url || '');
    return m ? { owner: m[1], repo: m[2] } : null;
}

class MinerManager {
    constructor(config, stats, ssh) {
        let m = config.miner || {};
        let d = config.dashboard || {};
        this.stats = stats;
        this.ssh = ssh;
        this.cfg = {
            repo: typeof m.repo === 'string' && /^(https?:\/\/|git@|file:\/\/)[\w.@:/~-]+$/.test(m.repo) ? m.repo : 'https://github.com/zzpajk/CCminer-ARM-optimized.git',
            branch: typeof m.branch === 'string' && /^[\w./-]{1,100}$/.test(m.branch) ? m.branch : 'variants',
            path: typeof m.path === 'string' && m.path ? m.path.slice(0, 300) : '~/ccminer/ccminer-verus',
            match: typeof m.match === 'string' && /^[\w.-]{2,40}$/.test(m.match) ? m.match : 'ccminer',
            // program types accepted for download/copy (phones: 64-bit or 32-bit ARM)
            archs: Array.isArray(m.archs) && m.archs.length ? m.archs.map(String) : ['aarch64', 'arm'],
            port: Number(m.sshPort) > 0 ? Number(m.sshPort) : ssh.cfg.port,
            buildTimeoutMin: Math.min(Math.max(Number(m.buildTimeoutMin) || 120, 10), 600),
            checkEveryMin: Math.max(Number(m.checkEveryMin) || 60, 5)
        };
        this.dir = path.resolve(__dirname, '..', d.dataDir || 'data', 'miners');
        this.jobsFile = path.resolve(__dirname, '..', d.dataDir || 'data', 'miner-jobs.json');
        this.library = [];
        this.jobs = [];
        this.latest = null;        // newest commit of the branch on GitHub
        this.busy = new Set();     // devices with a job running
        this.load();
        // builds keep running on the phones while the proxy restarts: keep following them
        for (let j of this.jobs) for (let t of j.targets) if (t.state === 'building') this.follow(j, t);
        for (let j of this.jobs) for (let t of j.targets) if (['queued', 'sending', 'installing', 'starting', 'checking'].includes(t.state)) Object.assign(t, { state: 'failed', msg: 'Interrupted by a proxy restart' });
        setTimeout(() => this.refreshLatest().catch(() => {}), 15000).unref();
        setInterval(() => this.refreshLatest().catch(() => {}), 30 * MINUTE).unref();
        // every hour: check what the phones run (quietly, only devices that answer on SSH)
        setInterval(() => this.periodicCheck(), this.cfg.checkEveryMin * MINUTE).unref();
        setTimeout(() => this.periodicCheck(), 3 * MINUTE).unref();
    }

    disabledReason() { return this.ssh.disabledReason('ssh'); }

    vars(extra) { return Object.assign({ HINT: this.cfg.path, MATCH: this.cfg.match, RESTART: '1' }, extra || {}); }

    // devices a job may touch: known to the proxy, on the LAN
    target(name) {
        let w = this.stats.workers.get(name);
        if (!w) return { name, error: 'unknown device' };
        if (!w.ip || !isLan(w.ip)) return { name, error: w.ip ? w.ip + ' is not a local network address' : 'device address unknown' };
        return { name, ip: w.ip, w };
    }
    portOk(port) { return this.ssh.cfg.ports.some(e => e.port === port); }

    // ---- what each phone runs -------------------------------------------------
    async checkOne(name, port) {
        let t = this.target(name);
        if (t.error) return { ok: false, error: t.error };
        let r = await this.ssh.sshRaw(name, t.ip, port || this.cfg.port, S.command('info', S.INFO, this.vars()), { timeoutMs: 40000 });
        let kv = S.parseKv(r.out);
        if (kv.info_done !== '1') {
            let error = r.note || r.error || (r.timedOut ? 'No answer (timed out)' : (r.err || r.out || 'no answer').trim().slice(0, 200));
            t.w.minerBin = Object.assign({}, t.w.minerBin, { error, errorTs: Date.now() });
            return { ok: false, error };
        }
        let info = {
            ts: Date.now(), port: port || this.cfg.port, env: kv.env || null, arch: kv.arch || null,
            running: kv.running === '1', pid: Number(kv.pid) || null, exe: kv.exe || null, cwd: kv.cwd || null, screen: kv.screen || null,
            started: kv.started ? Number(kv.started) * 1000 : null, cmd: kv.cmd ? kv.cmd.trim() : null,
            path: kv.path || null, sha: kv.sha || null, size: Number(kv.size) || null, mtime: kv.mtime ? Number(kv.mtime) * 1000 : null,
            variant: kv.variant || null, old: kv.old || null,
            build: kv.build_commit ? { commit: kv.build_commit, branch: kv.build_branch || null, repo: kv.build_repo || null, built: Number(kv.build_built) * 1000 || null } : null,
            building: kv.b_state === 'running' ? { phase: kv.b_phase, msg: kv.b_msg, since: Number(kv.b_started) * 1000 } : null,
            error: null
        };
        // a binary the proxy keeps: remember where it came from
        if (!info.build && info.sha) { let lib = this.library.find(b => b.sha256 === info.sha); if (lib && lib.commit) info.build = { commit: lib.commit, branch: lib.branch, built: lib.added }; }
        t.w.minerBin = info;
        return { ok: true, info };
    }

    async check(names, port) {
        let results = [];
        await pool(names, this.ssh.cfg.parallel, async (n) => results.push(Object.assign({ name: n }, await this.checkOne(n, port))));
        this.stats.save();
        return { ok: results.some(r => r.ok), results };
    }

    periodicCheck() {
        if (this.disabledReason()) return;
        let t = Date.now();
        let names = [];
        for (let [n, w] of this.stats.workers) {
            if (!w.ip || !isLan(w.ip) || this.busy.has(n)) continue;
            let sshUp = w.conn && w.conn.ports && w.conn.ports[this.cfg.port] && t - (w.conn.ts || 0) < 5 * MINUTE;
            let mining = w.lastSeen && t - w.lastSeen < 5 * MINUTE;
            if (!(sshUp || mining)) continue;
            if (w.minerBin && w.minerBin.ts && t - w.minerBin.ts < (this.cfg.checkEveryMin - 1) * MINUTE) continue;
            names.push(n);
        }
        if (names.length) this.check(names).catch(() => {});
    }

    // ---- newest source -----------------------------------------------------------
    getJson(url) {
        return new Promise((resolve, reject) => {
            let req = https.get(url, { headers: { 'User-Agent': 'verusProxy', 'Accept': 'application/vnd.github+json' }, timeout: 15000 }, res => {
                let body = '';
                res.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(new Error('GitHub answered ' + res.statusCode + (res.statusCode === 403 ? ' (rate limit; try again later)' : '')));
                    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                });
            });
            req.on('timeout', () => req.destroy(new Error('GitHub did not answer')));
            req.on('error', reject);
        });
    }
    gitLsRemote(repo, branch) {
        return new Promise(resolve => {
            let out = '', p;
            try { p = spawn('git', ['ls-remote', repo, 'refs/heads/' + branch], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return resolve(null); }
            let timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 20000);
            p.stdout.on('data', d => out += d);
            p.on('error', () => { clearTimeout(timer); resolve(null); });
            p.on('close', () => { clearTimeout(timer); let m = /^([0-9a-f]{40})/.exec(out); resolve(m ? m[1] : null); });
        });
    }
    async refreshLatest(branch) {
        branch = branch || this.cfg.branch;
        let gh = githubRepo(this.cfg.repo);
        try {
            if (!gh) throw new Error('not GitHub');
            let c = await this.getJson(`https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${encodeURIComponent(branch)}`);
            this.latest = { branch, commit: c.sha, date: Date.parse(c.commit.committer.date) || null, message: String(c.commit.message || '').split('\n')[0].slice(0, 160), checked: Date.now(), error: null };
            try {
                let bs = await this.getJson(`https://api.github.com/repos/${gh.owner}/${gh.repo}/branches?per_page=50`);
                this.branches = bs.map(b => b.name).slice(0, 50);
            } catch (e) {}
        } catch (e) {
            let sha = await this.gitLsRemote(this.cfg.repo, branch);
            this.latest = sha ? { branch, commit: sha, date: null, message: null, checked: Date.now(), error: null }
                : Object.assign({}, this.latest, { branch, checked: Date.now(), error: 'Could not reach ' + this.cfg.repo + ': ' + e.message });
        }
        return this.latest;
    }

    // ---- binaries kept on the proxy ---------------------------------------------------
    fileOf(sha) { return path.join(this.dir, sha + '.bin'); }

    async addFile(tmp, meta) {
        let arch = elfArch(tmp);
        if (!arch) { fs.unlinkSync(tmp); return { ok: false, error: 'That is not a program file (not an ELF binary).' }; }
        if (!this.cfg.archs.includes(arch)) { fs.unlinkSync(tmp); return { ok: false, error: 'That program is for ' + arch + ', not for ARM phones.' }; }
        let sha = await sha256File(tmp);
        let size = fs.statSync(tmp).size;
        fs.renameSync(tmp, this.fileOf(sha));
        let have = this.library.find(b => b.sha256 === sha);
        if (have) return { ok: true, sha256: sha, existing: true, label: have.label };
        let entry = Object.assign({ sha256: sha, size, arch, added: Date.now() }, meta);
        this.library.unshift(entry);
        this.save();
        console.log(`miner: added ${entry.label} (${sha.slice(0, 12)}, ${size} bytes)`);
        return { ok: true, sha256: sha, label: entry.label };
    }

    download(url, file, redirects) {
        return new Promise((resolve, reject) => {
            let u;
            try { u = new URL(url); } catch (e) { return reject(new Error('Not a valid URL')); }
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Only http(s) URLs'));
            let req = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'User-Agent': 'verusProxy' }, timeout: 30000 }, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if ((redirects || 0) >= 5) return reject(new Error('Too many redirects'));
                    return resolve(this.download(new URL(res.headers.location, u).toString(), file, (redirects || 0) + 1));
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('Server answered ' + res.statusCode)); }
                let n = 0, out = fs.createWriteStream(file, { mode: 0o600 });
                res.on('data', d => { n += d.length; if (n > MAX_BINARY) { req.destroy(new Error('File larger than 64 MB')); } });
                res.pipe(out);
                out.on('finish', () => resolve(n));
                res.on('error', reject); out.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Download timed out')));
            req.on('error', reject);
        });
    }

    // pull a program out of a .tar.gz/.tgz/.tar/.zip: the file whose name contains ccminer (or the only program)
    extract(archive, kind) {
        return new Promise(resolve => {
            let dir = archive + '.d';
            fs.mkdirSync(dir, { recursive: true });
            let p = kind === 'zip' ? spawn('unzip', ['-q', '-o', archive, '-d', dir]) : spawn('tar', ['-xf', archive, '-C', dir]);
            p.on('error', () => resolve({ error: (kind === 'zip' ? 'unzip' : 'tar') + ' is not installed on the proxy machine' }));
            p.on('close', code => {
                if (code !== 0) return resolve({ error: 'Could not unpack the archive' });
                let found = [];
                let walk = (d) => { for (let e of fs.readdirSync(d, { withFileTypes: true })) { let f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile() && elfArch(f)) found.push(f); } };
                walk(dir);
                let pick = found.find(f => /ccminer/i.test(path.basename(f))) || (found.length === 1 ? found[0] : null);
                if (!pick) return resolve({ error: found.length ? 'Several programs in the archive and none is called ccminer' : 'No program found in the archive' });
                fs.renameSync(pick, archive + '.bin');
                fs.rmSync(dir, { recursive: true, force: true });
                resolve({ file: archive + '.bin', name: path.basename(pick) });
            });
        });
    }

    async addUrl(url, label) {
        url = String(url || '').trim();
        if (!/^https?:\/\/\S+$/.test(url) || url.length > 1000) return { ok: false, error: 'Give an http(s) link to the miner file' };
        fs.mkdirSync(this.dir, { recursive: true });
        let tmp = path.join(this.dir, 'dl-' + crypto.randomBytes(5).toString('hex'));
        try { await this.download(url, tmp); }
        catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} return { ok: false, error: 'Download failed: ' + e.message }; }
        let file = tmp, inner = null;
        let head = Buffer.alloc(4); let fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
        let kind = head[0] === 0x1f && head[1] === 0x8b ? 'tar' : head.readUInt32BE(0) === 0x504b0304 ? 'zip' : /\.tar$/i.test(url) ? 'tar' : null;
        if (kind) {
            let x = await this.extract(tmp, kind);
            try { fs.unlinkSync(tmp); } catch (e) {}
            if (x.error) return { ok: false, error: x.error };
            file = x.file; inner = x.name;
        }
        let name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
        return this.addFile(file, { label: String(label || '').trim().slice(0, 60) || (inner ? name + ' → ' + inner : name), source: 'url', url });
    }

    // copy the miner a phone runs (or has installed) into the library
    async addFromDevice(name, port) {
        let t = this.target(name);
        if (t.error) return { ok: false, error: t.error };
        port = port || this.cfg.port;
        let c = await this.checkOne(name, port);
        if (!c.ok) return c;
        let info = c.info;
        if (!info.sha) return { ok: false, error: 'No miner found on ' + name + ' (looked for a running ' + this.cfg.match + ' and ' + (info.path || this.cfg.path) + ')' };
        let have = this.library.find(b => b.sha256 === info.sha);
        if (have) return { ok: true, sha256: info.sha, existing: true, label: have.label };
        fs.mkdirSync(this.dir, { recursive: true });
        let tmp = path.join(this.dir, 'pull-' + crypto.randomBytes(5).toString('hex'));
        let r = await this.ssh.sshRaw(name, t.ip, port, 'cat ' + S.q(info.path), { stdoutFile: tmp, timeoutMs: 180000 });
        if (r.code !== 0) { try { fs.unlinkSync(tmp); } catch (e) {} return { ok: false, error: 'Copy failed: ' + (r.note || r.error || r.err.trim().slice(0, 200) || 'ssh exit ' + r.code) }; }
        if ((await sha256File(tmp)) !== info.sha) { fs.unlinkSync(tmp); return { ok: false, error: 'Copy was damaged (checksum differs), try again' }; }
        let b = info.build;
        let label = b && b.commit ? (b.branch || 'build') + ' ' + b.commit.slice(0, 7) + ' (built on ' + name + ')' : 'from ' + name;
        return this.addFile(tmp, { label, source: 'device', device: name, commit: b ? b.commit : null, branch: b ? b.branch : null, variant: info.variant });
    }

    remove(sha) {
        let i = this.library.findIndex(b => b.sha256 === sha);
        if (i < 0) return { ok: false, error: 'unknown binary' };
        if (this.jobs.some(j => j.sha256 === sha && j.targets.some(t => !this.done(t)))) return { ok: false, error: 'A job is still installing it' };
        this.library.splice(i, 1);
        try { fs.unlinkSync(this.fileOf(sha)); } catch (e) {}
        this.save();
        return { ok: true };
    }
    rename(sha, label) {
        let b = this.library.find(x => x.sha256 === sha);
        if (!b) return { ok: false, error: 'unknown binary' };
        b.label = String(label || '').trim().slice(0, 60) || b.label;
        this.save();
        return { ok: true };
    }

    // ---- jobs --------------------------------------------------------------------------
    done(t) { return ['ok', 'failed', 'rolledback', 'skipped'].includes(t.state); }

    // action: check | install | build | rollback
    start({ action, workers, sha256, restart, stopMining, branch, port, by }) {
        let reason = this.disabledReason();
        if (reason) return { ok: false, error: reason };
        if (!['check', 'install', 'build', 'rollback'].includes(action)) return { ok: false, error: 'unknown action' };
        port = port ? Number(port) : this.cfg.port;
        if (!this.portOk(port)) return { ok: false, error: `port ${port} is not in ssh.ports` };
        let names = Array.isArray(workers) ? Array.from(new Set(workers.filter(n => typeof n === 'string'))).slice(0, 500) : [];
        if (!names.length) return { ok: false, error: 'no devices selected' };
        let bin = null;
        if (action === 'install') {
            bin = this.library.find(b => b.sha256 === sha256);
            if (!bin || !fs.existsSync(this.fileOf(bin.sha256))) return { ok: false, error: 'That binary is not on the proxy any more' };
        }
        if (branch !== undefined && branch !== null && !/^[\w./-]{1,100}$/.test(String(branch))) return { ok: false, error: 'bad branch name' };
        let job = {
            id: crypto.randomBytes(6).toString('hex'), t: Date.now(), by: by || null, action, port,
            restart: restart !== false, stopMining: !!stopMining,
            sha256: bin ? bin.sha256 : null, label: bin ? bin.label : null,
            branch: action === 'build' ? (branch || this.cfg.branch) : null, repo: action === 'build' ? this.cfg.repo : null,
            targets: names.map(n => ({ name: n, state: 'queued', msg: null, phase: null, ms: null, started: null, result: null }))
        };
        this.jobs.unshift(job);
        while (this.jobs.length > KEEP_JOBS) this.jobs.pop();
        this.save();
        console.log(`miner: ${action}${bin ? ' ' + bin.label : ''}${job.branch ? ' ' + job.branch : ''} on ${names.length} device(s) by ${by || '?'}`);
        this.runJob(job);
        return { ok: true, id: job.id };
    }

    async runJob(job) {
        let parallel = job.action === 'install' ? Math.min(this.ssh.cfg.parallel, 6) : this.ssh.cfg.parallel;
        await pool(job.targets, parallel, (t) => this.runTarget(job, t));
        this.save();
    }

    async runTarget(job, t) {
        let tg = this.target(t.name);
        t.started = Date.now();
        if (tg.error) return Object.assign(t, { state: 'failed', msg: tg.error });
        if (this.busy.has(t.name) && job.action !== 'check') return Object.assign(t, { state: 'skipped', msg: 'Another miner job is running on this device' });
        this.busy.add(t.name);
        try {
            if (job.action === 'check') {
                t.state = 'checking';
                let r = await this.checkOne(t.name, job.port);
                return Object.assign(t, { state: r.ok ? 'ok' : 'failed', msg: r.ok ? describe(r.info) : r.error });
            }
            if (job.action === 'build') return await this.startBuild(job, t, tg);
            let cmd, opts;
            if (job.action === 'install') {
                t.state = 'sending';
                cmd = S.command('install', S.INSTALL, this.vars({ EXPECT: job.sha256, RESTART: job.restart ? '1' : '0' }));
                opts = { stdinFile: this.fileOf(job.sha256), timeoutMs: 240000 };
            } else {
                t.state = 'installing';
                cmd = S.command('rollback', S.ROLLBACK, this.vars({ RESTART: job.restart ? '1' : '0' }));
                opts = { timeoutMs: 120000 };
            }
            let r = await this.ssh.sshRaw(t.name, tg.ip, job.port, cmd, opts);
            let kv = S.parseKv(r.out);
            this.finishTarget(t, kv, r);
        } finally {
            if (job.action !== 'check' && t.state !== 'building') {
                // read the device again before calling it done, so the dashboard shows the new version
                let fin = { state: t.state, msg: t.msg };
                t.state = 'checking';
                await this.checkOne(t.name, job.port).catch(() => {});
                Object.assign(t, fin);
            }
            if (t.state !== 'building') this.busy.delete(t.name);
            t.ms = Date.now() - t.started;
            this.save();
        }
    }

    finishTarget(t, kv, r) {
        let res = kv.result;
        t.result = res || null;
        if (res === 'restarted' || res === 'installed' || res === 'same') {
            t.state = 'ok';
            t.msg = kv.msg || (res === 'restarted' ? 'Installed and restarted' + (kv.how ? ' ' + kv.how : '') : 'Installed');
        } else if (res === 'rolledback') {
            t.state = 'rolledback'; t.msg = kv.msg;
        } else {
            t.state = 'failed';
            t.msg = kv.msg || r.note || r.error || (r.timedOut ? 'Timed out' : (r.err || r.out || 'no answer').trim().slice(0, 240));
        }
    }

    // builds take minutes: start them in the background on the phone, then look in every 20 s
    async startBuild(job, t, tg) {
        t.state = 'starting';
        let st = await this.ssh.sshRaw(t.name, tg.ip, job.port, S.command('build-status', S.BUILD_STATUS, this.vars()), { timeoutMs: 30000 });
        let skv = S.parseKv(st.out);
        if (st.code !== 0 && !skv.state) return Object.assign(t, { state: 'failed', msg: st.note || st.error || (st.err || 'no answer').trim().slice(0, 200) });
        if (skv.alive === '1') return Object.assign(t, { state: 'skipped', msg: 'A build is already running on this phone' });
        let cmd = S.command('build', S.BUILD, this.vars({ REPO: job.repo, BRANCH: job.branch, STOPMINING: job.stopMining ? '1' : '0', RESTART: job.restart ? '1' : '0' }), true);
        let r = await this.ssh.sshRaw(t.name, tg.ip, job.port, cmd, { timeoutMs: 30000 });
        if (S.parseKv(r.out).started !== '1') return Object.assign(t, { state: 'failed', msg: r.note || r.error || (r.err || r.out || 'could not start').trim().slice(0, 200) });
        Object.assign(t, { state: 'building', phase: 'source', msg: 'Started', buildStarted: Date.now() });
        this.follow(job, t);
    }

    follow(job, t) {
        this.busy.add(t.name);
        let tick = async () => {
            if (t.state !== 'building') return;
            let tg = this.target(t.name);
            if (tg.error) { Object.assign(t, { state: 'failed', msg: tg.error }); return this.endFollow(job, t); }
            let r = await this.ssh.sshRaw(t.name, tg.ip, job.port, S.command('build-status', S.BUILD_STATUS, this.vars()), { timeoutMs: 30000 });
            let kv = S.parseKv(r.out);
            let age = Date.now() - (t.buildStarted || job.t);
            let fresh = kv.started && Number(kv.started) * 1000 >= (t.buildStarted || job.t) - 120000;
            if (kv.state && (kv.state === 'none' || !fresh)) {
                // no status from this build yet: fine for a moment, a failure if the script is gone
                t.lastSeen = Date.now();
                if (kv.alive === '0' && age > 60000) { Object.assign(t, { state: 'failed', msg: 'The build did not start on the phone' + (kv.logtail ? ': ' + kv.logtail : '') }); return this.endFollow(job, t); }
            } else if (kv.state) {
                t.lastSeen = Date.now();
                t.phase = kv.phase || t.phase;
                t.log = kv.logtail || null;
                if (kv.commit) t.commit = kv.commit;
                if (kv.state === 'done') { this.finishTarget(t, { result: kv.phase, msg: kv.msg }, r); return this.endFollow(job, t); }
                if (kv.state === 'failed') { Object.assign(t, { state: kv.phase === 'rolledback' ? 'rolledback' : 'failed', msg: kv.msg }); return this.endFollow(job, t); }
                t.msg = kv.msg;
                if (kv.alive === '0' && kv.state === 'running') { Object.assign(t, { state: 'failed', msg: 'The build stopped unexpectedly (phone restarted or Termux closed?). Last: ' + (kv.logtail || kv.msg) }); return this.endFollow(job, t); }
            } else if (t.lastSeen && Date.now() - t.lastSeen > 15 * MINUTE) {
                Object.assign(t, { state: 'failed', msg: 'Phone not answering for 15 min during the build' }); return this.endFollow(job, t);
            }
            if (age > this.cfg.buildTimeoutMin * MINUTE) { Object.assign(t, { state: 'failed', msg: 'Build took longer than ' + this.cfg.buildTimeoutMin + ' min (miner.buildTimeoutMin); it may still finish on the phone' }); return this.endFollow(job, t); }
            t.timer = setTimeout(tick, 20000);
            if (t.timer.unref) t.timer.unref();
        };
        t.timer = setTimeout(tick, 5000);
        if (t.timer.unref) t.timer.unref();
    }
    async endFollow(job, t) {
        delete t.timer;
        let fin = { state: t.state, msg: t.msg };
        t.state = 'checking';
        await this.checkOne(t.name, job.port).catch(() => {});
        Object.assign(t, fin);
        t.ms = Date.now() - (t.started || job.t);
        this.busy.delete(t.name);
        console.log(`miner: build on ${t.name}: ${t.state}${t.msg ? ' - ' + t.msg : ''}`);
        this.save();
    }

    // ---- views -------------------------------------------------------------------------
    summary(j) {
        let c = { ok: 0, failed: 0, running: 0 };
        for (let t of j.targets) { if (t.state === 'ok' || t.state === 'skipped') c.ok++; else if (t.state === 'failed' || t.state === 'rolledback') c.failed++; else c.running++; }
        return { id: j.id, t: j.t, by: j.by, action: j.action, label: j.label, sha256: j.sha256, branch: j.branch, port: j.port, restart: j.restart, stopMining: j.stopMining, count: j.targets.length, ...c, done: c.running === 0 };
    }
    job(id) {
        let j = this.jobs.find(x => x.id === id);
        if (!j) return null;
        return Object.assign({}, j, { targets: j.targets.map(t => { let o = Object.assign({}, t); delete o.timer; return o; }), summary: this.summary(j) });
    }
    info() {
        let onDevices = {};
        for (let [, w] of this.stats.workers) if (w.minerBin && w.minerBin.sha) onDevices[w.minerBin.sha] = (onDevices[w.minerBin.sha] || 0) + 1;
        return {
            enabled: !this.disabledReason(), reason: this.disabledReason(),
            repo: this.cfg.repo, branch: this.cfg.branch, branches: this.branches || null, path: this.cfg.path, port: this.cfg.port,
            ports: this.ssh.cfg.ports.map(e => ({ port: e.port, name: this.ssh.portName(e.port) })),
            latest: this.latest,
            library: this.library.map(b => Object.assign({}, b, { devices: onDevices[b.sha256] || 0 })),
            jobs: this.jobs.map(j => this.summary(j))
        };
    }

    save() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(path.join(this.dir, 'index.json.tmp'), JSON.stringify(this.library, null, 1));
            fs.renameSync(path.join(this.dir, 'index.json.tmp'), path.join(this.dir, 'index.json'));
            let jobs = this.jobs.map(j => Object.assign({}, j, { targets: j.targets.map(t => { let o = Object.assign({}, t); delete o.timer; return o; }) }));
            fs.writeFileSync(this.jobsFile + '.tmp', JSON.stringify({ jobs, latest: this.latest }));
            fs.renameSync(this.jobsFile + '.tmp', this.jobsFile);
        } catch (e) { console.log('miner: unable to save', e.message); }
    }
    load() {
        try { this.library = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')).filter(b => fs.existsSync(this.fileOf(b.sha256))); } catch (e) {}
        try { let d = JSON.parse(fs.readFileSync(this.jobsFile, 'utf8')); this.jobs = d.jobs || []; this.latest = d.latest || null; } catch (e) {}
    }
}

function describe(i) {
    if (!i.sha) return 'No miner found';
    let s = (i.running ? 'Running' : 'Not running') + (i.build && i.build.commit ? ' · ' + (i.build.branch || '') + ' ' + i.build.commit.slice(0, 7) : '') + ' · ' + i.path;
    return s;
}

module.exports = { MinerManager, elfArch, githubRepo };
