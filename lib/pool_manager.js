// Pool failover + manual switching (runs in the cluster master).
//
// A pool is considered unhealthy only when it stops talking to us:
//   - connections fail / get no answer to subscribe (N times in a row)
//   - shares are submitted but nothing comes back for submitTimeoutSec
// Block time / time since the last job is never used: Verus blocks have no upper time limit.
// Rejected shares do not trigger a switch (the pool is up; that is a config/miner problem).

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { poolList } = require('./pool_select.js');

class PoolManager {
    constructor(config, broadcast, getProbeLogin) {
        let f = config.failover || {};
        let d = config.dashboard || {};
        this.cfg = {
            enabled: f.enabled !== false,
            connectFailures: f.connectFailures || 2,
            connectTimeout: (f.connectTimeoutSec || 15) * 1000,
            probeEvery: (f.probeEverySec || 60) * 1000,
            failbackAfter: (f.failbackAfterSec || 300) * 1000,
            failback: f.failback !== false,
            window: (d.hashrateWindowSec || 600) * 1000,
            dataFile: path.resolve(__dirname, '..', d.dataDir || 'data', 'pools.json')
        };
        this.version = config.version;
        this.forcedWallet = typeof config.wallet === 'string' && config.wallet ? config.wallet : null;
        this.broadcast = broadcast;
        this.getProbeLogin = getProbeLogin || (() => null);
        this.pools = poolList(config).map(p => Object.assign(p, {
            status: 'unknown', statusSince: Date.now(), upSince: null, lastError: null, lastErrorAt: null,
            failStreak: 0, pingMs: null, lastOkAt: null, lastProbeAt: null, lastJob: 0,
            accepted: 0, rejected: 0, buckets: [], activeSince: null
        }));
        this.auto = this.cfg.enabled;
        this.pinned = null;
        this.events = [];
        this.procPools = new Map(); // pid -> pools[] from latest stats flush
        this.load();
        this.active = this.preferred();
        this.pools[this.active].activeSince = Date.now();
        if (this.pools.length > 1) {
            setTimeout(() => this.probeCycle(), 5000).unref();
            setInterval(() => this.probeCycle(), this.cfg.probeEvery).unref();
        }
    }

    preferred() { return this.pinned !== null && this.pools[this.pinned] ? this.pinned : 0; }
    activeConfig() { return this.pools[this.active]; }

    log(entry) {
        this.events.unshift(Object.assign({ t: Date.now() }, entry));
        this.events.length = Math.min(this.events.length, 50);
        this.save();
    }

    setStatus(p, status, error) {
        if (p.status !== status) {
            p.status = status;
            p.statusSince = Date.now();
            p.upSince = status === 'up' ? Date.now() : null;
        }
        if (error) { p.lastError = error; p.lastErrorAt = Date.now(); }
    }

    // ---- events from stratum workers -------------------------------------
    onWorkerEvent(msg) {
        let p = this.pools[msg.index];
        if (!p) return;
        switch (msg.event) {
            case 'ok':
                p.failStreak = 0;
                p.pingMs = msg.ms;
                p.lastOkAt = Date.now();
                this.setStatus(p, 'up');
                break;
            case 'lost':
                // dropped after working: the reconnect attempt tells us whether it's really down
                p.lastError = msg.reason; p.lastErrorAt = Date.now();
                break;
            case 'fail':
                p.failStreak++;
                p.lastError = msg.reason; p.lastErrorAt = Date.now();
                if (p.failStreak >= this.cfg.connectFailures) {
                    this.setStatus(p, 'down', `${msg.reason} (${p.failStreak} attempts)`);
                    if (msg.index === this.active) this.failover(`${p.name}: ${msg.reason}, ${p.failStreak} failed attempts`);
                }
                break;
            case 'timeout':
                this.setStatus(p, 'down', msg.reason);
                if (msg.index === this.active) this.failover(`${p.name}: ${msg.reason}`);
                break;
        }
    }

    onStats(msg) {
        let t = Date.now();
        this.procPools.set(msg.pid, { time: t, pools: msg.pools || [] });
        for (let s of msg.poolShares || []) {
            let p = this.pools[s.index];
            if (!p) continue;
            p.accepted += s.acc || 0;
            p.rejected += s.rej || 0;
            if (s.work) p.buckets.push([t, s.work]);
            if (s.lastJob) p.lastJob = Math.max(p.lastJob, s.lastJob);
        }
    }
    onWorkerExit(pid) { this.procPools.delete(pid); }

    // ---- switching ---------------------------------------------------------
    failover(reason) {
        if (!this.auto) {
            if (!this.lastNoAutoLog || Date.now() - this.lastNoAutoLog > 60000) {
                this.lastNoAutoLog = Date.now();
                this.log({ type: 'down', pool: this.active, reason: reason + ' — auto failover is off, staying' });
            }
            return;
        }
        if (this.pools.length < 2) return;
        let pref = this.preferred();
        let order = [pref].concat(this.pools.map(p => p.index).filter(i => i !== pref));
        let next = order.find(i => i !== this.active && this.pools[i].status !== 'down');
        if (next === undefined) {
            // everything looks down: keep rotating so we notice whichever comes back first
            next = (this.active + 1) % this.pools.length;
            reason += ' — all pools look down, trying next';
        }
        this.switchTo(next, reason, 'auto');
    }

    switchTo(index, reason, by) {
        if (!this.pools[index] || index === this.active) return false;
        let from = this.active;
        this.pools[from].activeSince = null;
        this.active = index;
        this.pools[index].activeSince = Date.now();
        this.pools[index].failStreak = 0;
        console.log(`Pool switch (${by}): ${this.pools[from].name} -> ${this.pools[index].name}: ${reason}`);
        this.log({ type: 'switch', from, to: index, reason, by });
        this.broadcast({ type: 'vp-pool-switch', index, reason });
        return true;
    }

    // ---- dashboard controls --------------------------------------------------
    manualSwitch(index) {
        if (!this.pools[index]) return { ok: false, error: 'unknown pool' };
        this.pinned = index;
        if (index === this.active) { this.save(); return { ok: true, active: this.active }; }
        this.switchTo(index, `switched to ${this.pools[index].name} from the dashboard`, 'manual');
        return { ok: true, active: this.active };
    }
    setAuto(on) {
        this.auto = !!on;
        this.log({ type: 'setting', reason: `auto failover turned ${this.auto ? 'on' : 'off'}`, by: 'manual' });
        return { ok: true, auto: this.auto };
    }
    clearPreferred() {
        this.pinned = null;
        this.log({ type: 'setting', reason: `preferred pool reset to priority order (${this.pools[0].name})`, by: 'manual' });
        return { ok: true };
    }

    // ---- probes + failback ---------------------------------------------------
    activeHasConnections() {
        let t = Date.now();
        for (let [, pp] of this.procPools) {
            if (t - pp.time > 20000) continue;
            if (pp.pools.some(p => p.index === this.active && p.connected)) return true;
        }
        return false;
    }

    async probeCycle() {
        if (this.probing) return;
        this.probing = true;
        try {
            let targets = this.pools.filter(p => p.index !== this.active || !this.activeHasConnections());
            await Promise.all(targets.map(async p => {
                let r = await this.probe(p);
                p.lastProbeAt = Date.now();
                if (r.ok) {
                    p.pingMs = r.ms;
                    p.lastOkAt = Date.now();
                    p.failStreak = 0;
                    this.setStatus(p, 'up');
                } else if (p.index !== this.active) {
                    // the active pool's health comes from real mining traffic, not probes
                    this.setStatus(p, 'down', r.error);
                } else {
                    p.lastError = r.error; p.lastErrorAt = Date.now();
                }
            }));
            let pref = this.pools[this.preferred()];
            if (this.auto && this.cfg.failback && this.active !== pref.index && pref.status === 'up'
                && pref.upSince && Date.now() - pref.upSince >= this.cfg.failbackAfter) {
                this.switchTo(pref.index, `failback: ${pref.name} healthy for ${Math.round((Date.now() - pref.upSince) / 60000)} min`, 'auto');
            }
        } catch (e) {
            console.log('pool probe error', e.message);
        }
        this.probing = false;
    }

    // connect, subscribe and (when we know an address) authorize; then hang up
    probe(p) {
        return new Promise(resolve => {
            let started = Date.now(), buf = '', done = false, sock, subMs = null;
            let login = this.forcedWallet || this.getProbeLogin();
            let finish = (r) => {
                if (done) return; done = true;
                clearTimeout(timer);
                try { sock.destroy(); } catch (e) {}
                resolve(r);
            };
            let timer = setTimeout(() => finish({ ok: false, error: sock && sock.connecting === false ? 'no answer to subscribe' : 'connect timeout' }), this.cfg.connectTimeout);
            let onConnect = () => {
                sock.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: [`VP-probe/${this.version}`, null] }) + '\n');
            };
            try {
                sock = p.ssl
                    ? tls.connect({ host: p.host, port: p.port, servername: p.host, rejectUnauthorized: p.rejectUnauthorized }, onConnect)
                    : net.createConnection({ host: p.host, port: p.port }, onConnect);
            } catch (e) {
                return finish({ ok: false, error: e.message });
            }
            sock.setEncoding('utf8');
            sock.on('error', e => finish({ ok: false, error: e.code || e.message }));
            sock.on('close', () => finish({ ok: false, error: 'closed by pool' }));
            sock.on('data', d => {
                buf += d;
                if (buf.length > 65536) return finish({ ok: false, error: 'garbage from pool' });
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    let line = buf.slice(0, i); buf = buf.slice(i + 1);
                    let m; try { m = JSON.parse(line); } catch (e) { return finish({ ok: false, error: 'invalid reply' }); }
                    if (m.id === 1) {
                        if (!Array.isArray(m.result)) return finish({ ok: false, error: 'subscribe refused' });
                        let ms = Date.now() - started;
                        if (!login) return finish({ ok: true, ms });
                        subMs = ms;
                        sock.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: [`${login.split('.')[0]}.proxyprobe`, 'x'] }) + '\n');
                    } else if (m.id === 2) {
                        finish(m.result === true ? { ok: true, ms: subMs } : { ok: false, error: 'login rejected' });
                    }
                }
            });
        });
    }

    // ---- snapshot / persistence ------------------------------------------------
    hashrate(p, t) {
        let from = t - this.cfg.window;
        while (p.buckets.length && p.buckets[0][0] < from) p.buckets.shift();
        if (!p.buckets.length) return 0;
        let work = p.buckets.reduce((a, b) => a + b[1], 0);
        // window starts at the earliest evidence of mining on this pool (not just the
        // latest switch to it, or a failback would count older shares over a short time)
        let start = Math.max(from, Math.min(p.activeSince || Infinity, p.buckets[0][0] - 5000));
        return work / (Math.max(60000, t - start) / 1000);
    }

    snapshot(controlEnabled) {
        let t = Date.now();
        let conns = new Map();
        for (let [, pp] of this.procPools) {
            if (t - pp.time > 20000) continue;
            for (let c of pp.pools) if (c.connected) conns.set(c.index, (conns.get(c.index) || 0) + 1);
        }
        return {
            active: this.active,
            preferred: this.preferred(),
            pinned: this.pinned,
            auto: this.auto,
            failback: this.cfg.failback,
            failbackAfterSec: this.cfg.failbackAfter / 1000,
            controlEnabled: !!controlEnabled,
            pools: this.pools.map(p => ({
                index: p.index, name: p.name, host: p.host, port: p.port, ssl: p.ssl,
                status: p.index === this.active && p.status !== 'down' && conns.get(p.index) ? 'up' : p.status,
                statusSince: p.statusSince, lastError: p.lastError, lastErrorAt: p.lastErrorAt,
                pingMs: p.pingMs, lastOkAt: p.lastOkAt, lastProbeAt: p.lastProbeAt, lastJob: p.lastJob || null,
                accepted: p.accepted, rejected: p.rejected, hashrate: this.hashrate(p, t),
                connections: conns.get(p.index) || 0, activeSince: p.activeSince
            })),
            events: this.events.slice(0, 20)
        };
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.cfg.dataFile), { recursive: true });
            fs.writeFileSync(this.cfg.dataFile, JSON.stringify({
                v: 1, auto: this.auto, pinned: this.pinned,
                pools: this.pools.map(p => p.host + ':' + p.port), events: this.events
            }));
        } catch (e) {
            console.log('pools: unable to save state', e.message);
        }
    }
    load() {
        try {
            if (!fs.existsSync(this.cfg.dataFile)) return;
            let d = JSON.parse(fs.readFileSync(this.cfg.dataFile, 'utf8'));
            let same = Array.isArray(d.pools) && d.pools.join(',') === this.pools.map(p => p.host + ':' + p.port).join(',');
            if (typeof d.auto === 'boolean') this.auto = d.auto;
            // only restore the preferred pool if the pool list hasn't been edited since
            if (same && Number.isInteger(d.pinned) && this.pools[d.pinned]) this.pinned = d.pinned;
            this.events = Array.isArray(d.events) && same ? d.events : [];
        } catch (e) {
            console.log('pools: unable to load saved state', e.message);
        }
    }
}

exports.PoolManager = PoolManager;
