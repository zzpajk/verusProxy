// Fleet statistics aggregator (runs in the cluster master).
// Sources:
//   1. share deltas from the stratum workers   -> pool-side ("effective") hashrate
//   2. ccminer API polled over the LAN (:4068)  -> device-reported hashrate, CPU temp/freq, cores
//   3. optional agent reports (POST /api/report) -> make, model, Android/OS, battery, plus ccminer data

const fs = require('fs');
const path = require('path');
const net = require('net');
const { parseWorkerName } = require('./stats_worker.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function addBucket(list, t, work, shares) {
    let m = Math.floor(t / MINUTE) * MINUTE;
    let last = list[list.length - 1];
    if (last && last[0] === m) {
        last[1] += work;
        last[2] = (last[2] === undefined ? 1 : last[2]) + shares;
    } else {
        list.push([m, work, shares]);
    }
}

function now() { return Date.now(); }

function cleanStr(v, max) {
    if (v === undefined || v === null) return null;
    let s = String(v).replace(/[\u0000-\u001f<>"'`\\]/g, '').trim();
    return s.length ? s.slice(0, max || 80) : null;
}
function num(v) {
    if (v === undefined || v === null || v === '') return null;
    let n = Number(v);
    return isFinite(n) ? n : null;
}

// "A=1;B=x|C=2;D=y|" -> [{A:'1',B:'x'},{C:'2',D:'y'}]
function parseCcminer(raw) {
    if (!raw) return [];
    return raw.toString().replace(/\0/g, '').split('|').filter(s => s.trim()).map(sec => {
        let o = {};
        sec.split(';').forEach(kv => {
            let i = kv.indexOf('=');
            if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
        });
        return o;
    });
}

// normalise ccminer summary/hwinfo/pool/threads replies into one object
function minerFromCcminer(summaryRaw, hwRaw, poolRaw, threadsRaw) {
    let s = parseCcminer(summaryRaw)[0];
    if (!s || s.KHS === undefined) return null;
    let hw = parseCcminer(hwRaw)[0] || {};
    let pl = parseCcminer(poolRaw)[0] || {};
    let th = parseCcminer(threadsRaw);
    let cpuTemp = num(hw.CPUTEMP);
    return {
        hashrate: (num(s.KHS) || 0) * 1000,
        accepted: num(s.ACC),
        rejected: num(s.REJ),
        uptime: num(s.UPTIME),
        software: cleanStr((s.NAME || 'ccminer') + ' ' + (s.VER || ''), 40),
        algo: cleanStr(s.ALGO, 20),
        cpuTemp: cpuTemp && cpuTemp > 0 && cpuTemp < 150 ? cpuTemp : null,
        cpuFreq: num(hw.CPUFREQ) || null,         // MHz
        cores: num(hw.CPUS) || null,
        kernel: cleanStr(hw.OS, 60),
        poolUser: cleanStr(pl.USER, 120),
        poolUrl: cleanStr(pl.URL, 120),
        poolDiff: num(pl.DIFF),
        ping: num(pl.PING),
        lastShareAgo: num(pl.LAST),
        threads: th.length ? th.map(t => (num(t.KHS) || 0) * 1000) : null
    };
}

function queryCcminer(host, port, cmd, timeoutMs) {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        let finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
        let sock = net.createConnection({ host, port }, () => sock.write(cmd));
        sock.setTimeout(timeoutMs || 2500);
        sock.on('data', d => { data += d.toString(); if (data.length > 65536) finish(null); });
        sock.on('end', () => finish(data));
        sock.on('close', () => finish(data || null));
        sock.on('timeout', () => finish(data || null));
        sock.on('error', () => finish(null));
    });
}

class FleetStats {
    constructor(config) {
        let d = config.dashboard || {};
        this.cfg = {
            window: (d.hashrateWindowSec || 600) * 1000,
            staleAfter: (d.staleAfterSec || 300) * 1000,
            forgetAfter: (d.forgetOfflineAfterDays || 14) * 24 * 3600 * 1000,
            dataDir: path.resolve(__dirname, '..', d.dataDir || 'data'),
            poll: d.ccminerApi === undefined ? true : d.ccminerApi !== false,
            pollPort: (d.ccminerApiPort || 4068),
            pollEvery: (d.ccminerPollSec || 30) * 1000,
            pollHosts: Array.isArray(d.ccminerHosts) ? d.ccminerHosts : [],
            minuteKeep: 24 * 60,          // 24h at 1-minute resolution
            longEvery: 15 * MINUTE,       // then 15-minute buckets
            longKeep: 30 * 24 * 4         // 30 days
        };
        this.poolHost = config.pool ? `${config.pool.host}:${config.pool.port}` : '';
        this.stratumPort = config.stratumPort || 8000;
        this.startedAt = now();
        this.workers = new Map();
        this.fleetBuckets = [];     // [minuteStart, work, shares] for the whole fleet
        this.procs = new Map();     // pid -> {time, conns, pools}
        this.minute = [];           // [{t, tot:[eff,rep], w:{name:[eff,rep]}}]
        this.long = [];
        this.lastLong = 0;
        this.load();
        setInterval(() => this.sample(), MINUTE).unref();
        setInterval(() => this.save(), 5 * MINUTE).unref();
        if (this.cfg.poll) {
            setTimeout(() => this.pollAll(), 8000).unref();
            setInterval(() => this.pollAll(), this.cfg.pollEvery).unref();
        }
    }

    worker(name) {
        let w = this.workers.get(name);
        if (!w) {
            w = {
                name, address: null, firstSeen: now(), lastSeen: 0,
                accepted: 0, rejected: 0, lastShare: 0, lastRejReason: null,
                buckets: [], miner: null, device: null, ip: null, software: null,
                connectedSince: null, xnsub: null
            };
            this.workers.set(name, w);
        }
        return w;
    }

    // ---- source 1: stratum workers -------------------------------------
    onWorkerMessage(msg) {
        if (!msg || msg.type !== 'vp-stats') return;
        let t = now();
        this.procs.set(msg.pid, { time: t, conns: msg.conns || [], pools: msg.pools || [] });
        for (let s of msg.shares || []) {
            let w = this.worker(s.worker);
            w.accepted += s.acc || 0;
            w.rejected += s.rej || 0;
            if (s.acc && s.work) {
                addBucket(w.buckets, t, s.work, s.acc);
                addBucket(this.fleetBuckets, t, s.work, s.acc);
            }
            if (s.last) w.lastShare = Math.max(w.lastShare, s.last);
            if (s.lastRejReason) w.lastRejReason = s.lastRejReason;
        }
        for (let c of msg.conns || []) {
            let w = this.worker(c.worker);
            w.lastSeen = t;
            w.ip = c.ip;
            if (c.address) w.address = c.address;
            if (c.software) w.software = c.software;
            w.xnsub = c.xnsub;
        }
    }
    onWorkerExit(pid) { this.procs.delete(pid); }

    // healthy = every stratum worker process has checked in recently (they report every 5 s)
    health() {
        let t = now(), fresh = 0, stale = 0;
        for (let [, p] of this.procs) (t - p.time < 30000 ? fresh++ : stale++);
        let starting = t - this.startedAt < 30000;
        return { ok: fresh > 0 && stale === 0 || (starting && stale === 0), workers: fresh, staleWorkers: stale, uptimeSec: Math.round((t - this.startedAt) / 1000) };
    }

    liveConns() {
        let out = [];
        let t = now();
        for (let [, p] of this.procs) {
            if (t - p.time > 20000) continue;   // stale process snapshot
            out.push(...p.conns);
        }
        return out;
    }

    // Pool-side hashrate = work credited by the pool / time.
    // Shares are random, so few shares = a noisy number: the window grows from
    // `window` (10 min) up to 60 min until `wantShares` shares are in it.
    // It never starts before the earliest evidence of mining (connection start or
    // oldest share kept), so a reconnect or restart can't inflate the number.
    poolSideRate(buckets, t, opts) {
        let minSpan = this.cfg.window;
        let maxSpan = Math.max(minSpan, HOUR);
        while (buckets.length && buckets[0][0] < t - maxSpan) buckets.shift();
        let work = 0, n = 0, spanStart = null;
        for (let i = buckets.length - 1; i >= 0; i--) {
            let b = buckets[i];
            if (n >= opts.wantShares && b[0] < t - minSpan) break;
            work += b[1];
            n += b[2] === undefined ? 1 : b[2];
            spanStart = b[0];
        }
        let start = n >= opts.wantShares ? Math.min(spanStart, t - minSpan) : t - maxSpan;
        let earliest = Math.min(opts.connectedSince || Infinity, buckets.length ? buckets[0][0] : Infinity);
        if (isFinite(earliest)) start = Math.max(start, earliest);
        let span = Math.max(MINUTE, t - start);
        return { rate: n ? work / (span / 1000) : 0, shares: n, spanSec: Math.round(span / 1000) };
    }

    effHashrate(w, t) {
        return this.poolSideRate(w.buckets, t, { wantShares: 30, connectedSince: w.connectedSince });
    }

    // ---- source 2: ccminer API polling ---------------------------------
    async pollAll() {
        if (this.polling) return;
        this.polling = true;
        try {
            let targets = new Map(); // "host:port" -> {host, port, name?}
            let live = this.liveConns();
            for (let c of live) {
                if (c.ip) targets.set(`${c.ip}:${this.cfg.pollPort}`, { host: c.ip, port: this.cfg.pollPort, hint: c.worker });
            }
            // also ask devices seen in the last 24 h that aren't connected: is ccminer
            // still running, and on which pool? (e.g. it failed over to a backup pool)
            let liveNames = new Set(live.map(c => c.worker));
            for (let [name, w] of this.workers) {
                if (!w.ip || liveNames.has(name) || Date.now() - (w.lastSeen || 0) > 24 * HOUR) continue;
                let key = `${w.ip}:${this.cfg.pollPort}`;
                if (!targets.has(key)) targets.set(key, { host: w.ip, port: this.cfg.pollPort, hint: name });
            }
            for (let h of this.cfg.pollHosts) {
                let o = typeof h === 'string' ? { host: h } : h;
                let [host, port] = (o.host || '').split(':');
                if (!host) continue;
                port = Number(port || o.port || this.cfg.pollPort);
                targets.set(`${host}:${port}`, { host, port, name: o.name });
            }
            let list = Array.from(targets.values());
            let i = 0;
            let run = async () => {
                while (i < list.length) {
                    let tg = list[i++];
                    let summary = await queryCcminer(tg.host, tg.port, 'summary');
                    if (!summary) continue;
                    let [hw, pool, threads] = await Promise.all([
                        queryCcminer(tg.host, tg.port, 'hwinfo'),
                        queryCcminer(tg.host, tg.port, 'pool'),
                        queryCcminer(tg.host, tg.port, 'threads')
                    ]);
                    let m = minerFromCcminer(summary, hw, pool, threads);
                    if (!m) continue;
                    let name = tg.name || (m.poolUser ? parseWorkerName(m.poolUser, '') : null);
                    if (!name || name === 'unknown') name = tg.hint || tg.host;
                    this.applyMiner(name, m, 'api', tg.host);
                }
            };
            await Promise.all(Array.from({ length: Math.min(32, list.length) }, run));
        } catch (e) {
            console.log('dashboard: ccminer poll error', e.message);
        }
        this.polling = false;
    }

    applyMiner(name, m, source, ip) {
        let w = this.worker(name);
        w.miner = Object.assign({ ts: now(), source }, m);
        if (ip && !w.ip) w.ip = ip;
        if (w.miner.uptime !== null) w.minerStarted = now() - w.miner.uptime * 1000;
    }

    // ---- source 3: agent report ----------------------------------------
    report(body, remoteIp) {
        if (!body || typeof body !== 'object') return { ok: false, error: 'bad json' };
        let name = cleanStr(body.worker, 64);
        if (name) name = name.replace(/[^a-zA-Z0-9._\-@]+/g, '');
        let ip = cleanStr(body.ip, 45) || (remoteIp || '').replace(/^::ffff:/, '');
        let m = null;
        if (body.ccminer && typeof body.ccminer === 'object') {
            m = minerFromCcminer(body.ccminer.summary, body.ccminer.hwinfo, body.ccminer.pool, body.ccminer.threads);
        }
        if (!name && m && m.poolUser) name = parseWorkerName(m.poolUser, '');
        if (!name) {
            // fall back to matching a live stratum connection by IP
            let c = this.liveConns().find(c => c.ip === ip);
            name = c ? c.worker : ip;
        }
        if (!name) return { ok: false, error: 'no worker name' };
        let w = this.worker(name);
        w.device = {
            ts: now(),
            make: titleCase(cleanStr(body.make, 40)),
            model: cleanStr(body.model, 60),
            soc: cleanStr(body.soc, 60),
            os: cleanStr(body.os, 60),
            kernel: cleanStr(body.kernel, 60),
            arch: cleanStr(body.arch, 20),
            cores: num(body.cores),
            ramMB: num(body.ramMB),
            cpuTemp: num(body.cpuTemp),
            batteryTemp: num(body.batteryTemp),
            batteryLevel: num(body.batteryLevel),
            charging: cleanStr(body.charging, 20),
            load: num(body.load),
            uptime: num(body.uptime),
            agent: cleanStr(body.agent, 20),
            ip
        };
        if (m) this.applyMiner(name, m, 'agent', ip);
        if (!w.ip) w.ip = ip;
        return { ok: true, worker: name };
    }

    forget(name) {
        let w = this.workers.get(name);
        if (!w) return false;
        if (this.liveConns().some(c => c.worker === name)) return false;
        this.workers.delete(name);
        return true;
    }

    // ---- snapshot ---------------------------------------------------------
    repHashrate(w, t) {
        if (!w.miner) return null;
        let maxAge = Math.max(this.cfg.pollEvery * 3, 3 * MINUTE);
        return (t - w.miner.ts) < maxAge ? w.miner.hashrate : null;
    }

    snapshot() {
        let t = now();
        let conns = this.liveConns();
        let byWorker = new Map();
        for (let c of conns) {
            if (!byWorker.has(c.worker)) byWorker.set(c.worker, []);
            byWorker.get(c.worker).push(c);
        }
        let list = [];
        let tot = { eff: 0, rep: 0, online: 0, offline: 0, stale: 0, elsewhere: 0, reconnecting: 0, acc: 0, rej: 0, temps: [] };
        for (let [name, w] of this.workers) {
            let cs = byWorker.get(name) || [];
            w.connectedSince = cs.length ? Math.min(...cs.map(c => c.since)) : null;
            let effR = this.effHashrate(w, t);
            let eff = effR.rate;
            let rep = this.repHashrate(w, t);
            let online = cs.length > 0;
            let lastActivity = Math.max(w.lastShare || 0, w.miner ? w.miner.ts : 0);
            let m0 = w.miner || {};
            let viaProxy = !m0.poolUrl || m0.poolUrl.includes(':' + this.stratumPort);
            let status;
            if (online) {
                status = (w.connectedSince && t - w.connectedSince > this.cfg.staleAfter && t - (w.lastShare || 0) > this.cfg.staleAfter) ? 'stale' : 'online';
            } else if (rep !== null && !viaProxy) {
                status = 'elsewhere';     // ccminer is mining, but on another pool (not this proxy)
            } else if (w.lastSeen && t - w.lastSeen < MINUTE) {
                status = 'reconnecting';  // dropped less than a minute ago; ccminer usually reconnects within seconds
            } else {
                status = 'offline';
            }
            let dev = w.device && (t - w.device.ts < 30 * MINUTE) ? w.device : (w.device ? Object.assign({}, w.device, { old: true }) : null);
            let m = w.miner || {};
            let cpuTemp = (dev && !dev.old && dev.cpuTemp) || (rep !== null ? m.cpuTemp : null) || null;
            let row = {
                name,
                status,
                address: w.address,
                ip: (cs[0] && cs[0].ip) || w.ip,
                connections: cs.length,
                software: w.software || m.software || null,
                xnsub: w.xnsub,
                connectedSince: w.connectedSince,
                lastShare: w.lastShare || null,
                lastSeen: Math.max(w.lastSeen || 0, lastActivity) || null,
                firstSeen: w.firstSeen,
                effHashrate: eff,
                effShares: effR.shares,      // shares behind the pool-side number
                effSpanSec: effR.spanSec,    // over this many seconds
                repHashrate: rep,
                accepted: w.accepted,
                rejected: w.rejected,
                lastRejReason: w.lastRejReason,
                minerAccepted: m.accepted ?? null,
                minerRejected: m.rejected ?? null,
                minerUptime: rep !== null ? m.uptime : null,
                minerSource: m.source || null,
                minerPoolUrl: rep !== null ? (m.poolUrl || null) : null,
                threads: rep !== null ? m.threads : null,
                cpuFreq: rep !== null ? m.cpuFreq : null,
                ping: rep !== null ? m.ping : null,
                cpuTemp,
                make: dev ? dev.make : null,
                model: dev ? dev.model : null,
                soc: dev ? dev.soc : null,
                os: dev ? dev.os : null,
                kernel: (dev && dev.kernel) || m.kernel || null,
                arch: dev ? dev.arch : null,
                cores: (dev && dev.cores) || m.cores || null,
                ramMB: dev ? dev.ramMB : null,
                batteryTemp: dev && !dev.old ? dev.batteryTemp : null,
                batteryLevel: dev && !dev.old ? dev.batteryLevel : null,
                charging: dev && !dev.old ? dev.charging : null,
                load: dev && !dev.old ? dev.load : null,
                deviceUptime: dev && !dev.old ? dev.uptime : null,
                agentSeen: w.device ? w.device.ts : null
            };
            list.push(row);
            if (online || status === 'reconnecting') tot.online++;
            else if (status === 'elsewhere') tot.elsewhere++;
            else tot.offline++;
            if (status === 'reconnecting') tot.reconnecting++;
            if (status === 'stale') tot.stale++;
            tot.rep += rep || 0;
            tot.acc += w.accepted;
            tot.rej += w.rejected;
            if (cpuTemp && online) tot.temps.push(cpuTemp);
        }
        let pools = [];
        for (let [, p] of this.procs) if (t - p.time < 20000) pools.push(...p.pools);
        let temps = tot.temps;
        // fleet total from all shares together: many more shares, so a much steadier number
        let fleet = this.poolSideRate(this.fleetBuckets, t, { wantShares: 100, connectedSince: this.startedAt });
        tot.eff = fleet.rate;
        return {
            time: t,
            startedAt: this.startedAt,
            pool: this.poolNameFn ? this.poolNameFn() : this.poolHost,
            poolConnections: pools,
            hashrateWindowSec: this.cfg.window / 1000,
            totals: {
                effHashrate: tot.eff,
                effShares: fleet.shares,
                effSpanSec: fleet.spanSec,
                repHashrate: tot.rep,
                online: tot.online,
                offline: tot.offline,
                stale: tot.stale,
                elsewhere: tot.elsewhere,
                reconnecting: tot.reconnecting,
                devices: list.length,
                accepted: tot.acc,
                rejected: tot.rej,
                avgTemp: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
                maxTemp: temps.length ? Math.max(...temps) : null
            },
            workers: list
        };
    }

    // ---- history --------------------------------------------------------
    sample() {
        let snap = this.snapshot();
        let t = Math.floor(snap.time / MINUTE) * MINUTE;
        let w = {};
        for (let r of snap.workers) {
            if (r.status === 'offline' && !r.effHashrate && r.repHashrate === null) continue;
            w[r.name] = [Math.round(r.effHashrate), r.repHashrate === null ? null : Math.round(r.repHashrate)];
        }
        let anyRep = snap.workers.some(r => r.repHashrate !== null);
        this.minute.push({ t, tot: [Math.round(snap.totals.effHashrate), anyRep ? Math.round(snap.totals.repHashrate) : null], w });
        if (this.minute.length > this.cfg.minuteKeep) this.minute.shift();

        if (t - this.lastLong >= this.cfg.longEvery) {
            let from = t - this.cfg.longEvery;
            let pts = this.minute.filter(p => p.t > from);
            if (pts.length) this.long.push(averagePoints(pts, t));
            if (this.long.length > this.cfg.longKeep) this.long.shift();
            this.lastLong = t;
        }
        // drop long-gone devices
        for (let [name, wk] of this.workers) {
            let last = Math.max(wk.lastSeen || 0, wk.lastShare || 0, wk.miner ? wk.miner.ts : 0, wk.device ? wk.device.ts : 0, wk.firstSeen);
            if (snap.time - last > this.cfg.forgetAfter) this.workers.delete(name);
        }
    }

    history(rangeSec, metric) {
        let t = now();
        let from = t - rangeSec * 1000;
        let long = rangeSec > 24 * 3600;
        let src = long ? this.long : this.minute;
        let pts = src.filter(p => p.t >= from);
        // keep the payload to ~400 points by averaging into fixed time slots
        // (slots, not point counts, so periods with no data stay empty and show as gaps)
        let srcStep = long ? this.cfg.longEvery : MINUTE;
        let slot = Math.max(srcStep, Math.ceil(rangeSec * 1000 / 400 / srcStep) * srcStep);
        if (slot > srcStep) {
            let groups = new Map();
            for (let p of pts) {
                let k = Math.floor(p.t / slot);
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(p);
            }
            pts = Array.from(groups.entries()).sort((a, b) => a[0] - b[0])
                .map(([k, chunk]) => averagePoints(chunk, (k + 1) * slot));
        }
        let k = metric === 'rep' ? 1 : 0;
        let names = new Set();
        pts.forEach(p => Object.keys(p.w).forEach(n => names.add(n)));
        let workers = {};
        for (let n of names) workers[n] = pts.map(p => (p.w[n] ? p.w[n][k] : null));
        return {
            metric: k ? 'rep' : 'eff',
            now: t,
            from,
            step: slot,               // expected spacing between points; bigger jumps are gaps
            since: src.length ? src[0].t : null,
            t: pts.map(p => p.t),
            total: pts.map(p => p.tot[k]),
            workers
        };
    }

    // ---- persistence ------------------------------------------------------
    save() {
        try {
            fs.mkdirSync(this.cfg.dataDir, { recursive: true });
            let workers = [];
            for (let [, w] of this.workers) {
                let o = Object.assign({}, w);
                workers.push(o);
            }
            let file = path.join(this.cfg.dataDir, 'stats.json');
            fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 1, saved: now(), workers, fleetBuckets: this.fleetBuckets, minute: this.minute, long: this.long, lastLong: this.lastLong }));
            fs.renameSync(file + '.tmp', file);
        } catch (e) {
            console.log('dashboard: unable to save stats', e.message);
        }
    }
    load() {
        try {
            let file = path.join(this.cfg.dataDir, 'stats.json');
            if (!fs.existsSync(file)) return;
            let d = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (let w of d.workers || []) {
                w.connectedSince = null;
                this.workers.set(w.name, w);
            }
            this.fleetBuckets = d.fleetBuckets || [];
            this.minute = d.minute || [];
            this.long = d.long || [];
            this.lastLong = d.lastLong || 0;
            console.log(`dashboard: restored ${this.workers.size} devices and ${this.minute.length + this.long.length} history points`);
        } catch (e) {
            console.log('dashboard: unable to load saved stats', e.message);
        }
    }
}

// "samsung" -> "Samsung", leave "OnePlus"/"HMD Global" alone
function titleCase(s) {
    return s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function averagePoints(pts, t) {
    let avg = (vals) => {
        let v = vals.filter(x => x !== null && x !== undefined);
        return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    };
    let names = new Set();
    pts.forEach(p => Object.keys(p.w).forEach(n => names.add(n)));
    let w = {};
    // a device missing from a minute counts as 0 for the pool-side value
    for (let n of names) w[n] = [avg(pts.map(p => (p.w[n] ? p.w[n][0] : 0))), avg(pts.map(p => (p.w[n] ? p.w[n][1] : null)))];
    return { t, tot: [avg(pts.map(p => p.tot[0])), avg(pts.map(p => p.tot[1]))], w };
}

exports.FleetStats = FleetStats;
exports.parseCcminer = parseCcminer;
exports.minerFromCcminer = minerFromCcminer;
