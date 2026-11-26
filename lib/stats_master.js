// Fleet statistics aggregator (runs in the cluster master).
// Sources:
//   1. share deltas from the stratum workers   -> pool-side ("effective") hashrate
//   2. ccminer API polled over the LAN (:4068)  -> device-reported hashrate, CPU temp/freq, cores
//   3. optional agent reports (POST /api/report) -> make, model, Android/OS, battery, plus ccminer data

const fs = require('fs');
const { HistoryStore, averagePoints } = require('./history_store.js');
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

// info (optional) gets .error: 'refused' (nothing listening), 'closed' (connected, no answer:
// ccminer's --api-allow doesn't include the proxy), 'timeout', or another error code
function queryCcminer(host, port, cmd, timeoutMs, info) {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        let finish = (v, err) => { if (!done) { done = true; if (info && v === null) info.error = err; try { sock.destroy(); } catch (e) {} resolve(v); } };
        let sock = net.createConnection({ host, port }, () => sock.write(cmd));
        sock.setTimeout(timeoutMs || 2500);
        sock.on('data', d => { data += d.toString(); if (data.length > 65536) finish(null, 'too much data'); });
        sock.on('end', () => finish(data || null, 'closed'));
        sock.on('close', () => finish(data || null, 'closed'));
        sock.on('timeout', () => finish(data || null, 'timeout'));
        sock.on('error', (e) => finish(null, e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'unreachable' : (e.code || e.message)));
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
            // a CPU temperature read over ADB counts as current for two read intervals
            tempFresh: Math.min(Math.max(Number((config.adb || {}).tempEveryMin) || 3, 1), 60) * 2 * MINUTE + MINUTE,
            minuteKeep: 24 * 60,          // 24h at 1-minute resolution
            longEvery: 15 * MINUTE,       // then 15-minute buckets
            longKeep: 30 * 24 * 4         // 30 days
        };
        this.poolHost = config.pool ? `${config.pool.host}:${config.pool.port}` : '';
        this.stratumPort = config.stratumPort || 8000;
        this.sshPort = (config.ssh && Number(config.ssh.port)) || 8022;
        this.startedAt = now();
        this.workers = new Map();
        this.fleetBuckets = [];     // [minuteStart, work, shares] for the whole fleet
        this.procs = new Map();     // pid -> {time, conns, pools}
        // hashrate history: compact, in its own append-only files (lib/history_store.js)
        this.hist = new HistoryStore(path.join(this.cfg.dataDir, 'history'), { minuteKeepMs: this.cfg.minuteKeep * MINUTE, longKeepMs: this.cfg.longKeep * this.cfg.longEvery });
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
        // a late update from the stratum process is logged: it explains devices flickering
        let prev = this.procs.get(msg.pid);
        if (prev && t - prev.time > 15000) {
            console.log(`dashboard: stratum process ${msg.pid} was silent for ${Math.round((t - prev.time) / 1000)} s (normally reports every 5 s)`);
        }
        this.procs.set(msg.pid, { time: t, conns: msg.conns || [], pools: msg.pools || [] });
        this.liveConns();     // decide which device each connection is before counting its shares
        for (let s of msg.shares || []) {
            let w = this.worker(this.recordFor(s.worker, s.ip));
            w.accepted += s.acc || 0;
            w.rejected += s.rej || 0;
            if (s.acc && s.work) {
                addBucket(w.buckets, t, s.work, s.acc);
                addBucket(this.fleetBuckets, t, s.work, s.acc);
            }
            if (s.last) w.lastShare = Math.max(w.lastShare, s.last);
            if (s.lastRejReason) w.lastRejReason = s.lastRejReason;
            // rejects per minute with their likely cause, kept for an hour
            if (s.rej) {
                let m = Math.floor(t / MINUTE) * MINUTE;
                w.rejBuckets = w.rejBuckets || [];
                let last = w.rejBuckets[w.rejBuckets.length - 1];
                if (!last || last[0] !== m) { last = [m, {}]; w.rejBuckets.push(last); }
                for (let [c, n] of Object.entries(s.causes || {})) last[1][c] = (last[1][c] || 0) + n;
                w.rejReasons = w.rejReasons || {};
                for (let [r, n] of Object.entries(s.reasons || {})) {
                    if (w.rejReasons[r] !== undefined || Object.keys(w.rejReasons).length < 12) w.rejReasons[r] = (w.rejReasons[r] || 0) + n;
                }
            }
        }
        for (let c of msg.conns || []) {
            let w = this.worker(c.rec || c.worker);
            w.lastSeen = t;
            w.baseName = c.rec && c.rec !== c.worker ? c.worker : null;
            w.ip = c.ip;
            if (c.address) w.address = c.address;
            if (c.software) w.software = c.software;
            w.xnsub = c.xnsub;
        }
    }
    onWorkerExit(pid) { this.procs.delete(pid); }

    // healthy = every stratum worker process has checked in recently (they report every 5 s)
    // accepted / rejected shares in the last hour, rejects split by likely cause
    lastHour(w, t) {
        let from = t - HOUR, acc = 0, rej = 0, causes = {};
        for (let b of w.buckets || []) if (b[0] >= from) acc += (b[2] === undefined ? 1 : b[2]);
        if (w.rejBuckets) {
            while (w.rejBuckets.length && w.rejBuckets[0][0] < from) w.rejBuckets.shift();
            for (let [, c] of w.rejBuckets) for (let [k, n] of Object.entries(c)) { causes[k] = (causes[k] || 0) + n; rej += n; }
        }
        return { acc1h: acc, rej1h: rej, rejCauses1h: causes };
    }

    // seconds since the stratum process(es) last reported (normally < 5)
    stratumLag() {
        let t = now(), lag = 0;
        for (let [, p] of this.procs) lag = Math.max(lag, t - p.time);
        return Math.round(lag / 1000);
    }

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
            // keep using a late snapshot for a while: a delayed update must not make
            // every device look disconnected (the miners' sockets didn't go anywhere)
            if (t - p.time > 90000) continue;
            out.push(...p.conns);
        }
        return this.resolveConns(out);
    }

    // Which device a miner connection belongs to (c.rec). Normally its worker name. When one name is
    // logged in from two or more addresses at once, those are different devices: the address the name
    // already had keeps it, the others become "name@address". Connections from the SAME address are one
    // device running the miner more than once (flagged in the table, not split).
    resolveConns(conns) {
        let byName = new Map();
        for (let c of conns) { if (!c.worker) continue; if (!byName.has(c.worker)) byName.set(c.worker, []); byName.get(c.worker).push(c); }
        let map = new Map();
        for (let [name, cs] of byName) {
            let ips = Array.from(new Set(cs.map(c => c.ip)));
            let plain = this.workers.get(name);
            let plainIp = null;
            if (plain && ips.includes(plain.ip)) plainIp = plain.ip;
            else {
                // e.g. a new device, or the device got a new address: the earliest connection without a "name@address" of its own
                let free = cs.filter(c => !this.workers.has(name + '@' + c.ip)).sort((a, b) => (a.since || 0) - (b.since || 0));
                if (free.length) plainIp = free[0].ip;
            }
            for (let ip of ips) map.set(name + '\u0001' + ip, ip === plainIp ? name : name + '@' + ip);
        }
        for (let c of conns) c.rec = map.get(c.worker + '\u0001' + c.ip) || c.worker;
        this.recMap = map;
        return conns;
    }
    // the device for a worker name seen at an address (shares, ccminer API, agent reports)
    recordFor(name, ip) {
        if (!name) return name;
        if (!ip) return name;
        let r = this.recMap && this.recMap.get(name + '\u0001' + ip);
        if (r) return r;
        let plain = this.workers.get(name);
        return this.workers.has(name + '@' + ip) && (!plain || plain.ip !== ip) ? name + '@' + ip : name;
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
                if (c.ip) targets.set(`${c.ip}:${this.cfg.pollPort}`, { host: c.ip, port: this.cfg.pollPort, hint: c.rec });
            }
            // also ask devices seen in the last 24 h that aren't connected: is ccminer
            // still running, and on which pool? (e.g. it failed over to a backup pool)
            let liveNames = new Set(live.map(c => c.rec));
            for (let [name, w] of this.workers) {
                if (!w.ip || liveNames.has(name)) continue;
                if (!w.manual && Date.now() - (w.lastSeen || 0) > 24 * HOUR) continue;
                let key = `${w.ip}:${this.cfg.pollPort}`;
                // a manually added device keeps its own name even if ccminer logs in under another one
                if (!targets.has(key) || w.manual) targets.set(key, { host: w.ip, port: this.cfg.pollPort, hint: name, manual: !!w.manual });
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
                    let info = {};
                    let summary = await queryCcminer(tg.host, tg.port, 'summary', undefined, info);
                    let hw0 = tg.hint && this.workers.get(tg.hint);
                    if (!summary) {
                        // remembered so the dashboard can say why there is no device-reported hashrate
                        if (hw0) hw0.apiErr = { ts: now(), host: tg.host, port: tg.port, reason: info.error || 'no answer' };
                        if (tg.manual) await this.probeManual(tg.hint);
                        continue;
                    }
                    if (hw0) hw0.apiErr = null;
                    let [hw, pool, threads] = await Promise.all([
                        queryCcminer(tg.host, tg.port, 'hwinfo'),
                        queryCcminer(tg.host, tg.port, 'pool'),
                        queryCcminer(tg.host, tg.port, 'threads')
                    ]);
                    let m = minerFromCcminer(summary, hw, pool, threads);
                    if (!m) continue;
                    let name = tg.manual ? tg.hint : (tg.name || (m.poolUser ? this.recordFor(parseWorkerName(m.poolUser, ''), tg.host) : null));
                    if (!name || name === 'unknown') name = tg.hint || tg.host;
                    if (tg.manual) this.workers.get(tg.hint).reach = { ok: true, ts: now() };
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
            name = c ? c.rec : ip;
        } else name = this.recordFor(name, ip);
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

    // ---- devices added by hand (e.g. to reach them over SSH before they mine) ----
    addManual(name, ip) {
        let w = this.worker(name);
        w.manual = true;
        w.manualIp = ip;
        w.ip = ip;
        w.reach = null;
        this.save();
        this.probeManual(name);     // status shows within a few seconds
        return { ok: true, name };
    }

    // is anything listening on the device's SSH port? (cheap "is it switched on" check)
    probeManual(name) {
        let w = this.workers.get(name);
        if (!w || !w.ip) return Promise.resolve();
        return new Promise(resolve => {
            let sock = net.createConnection({ host: w.ip, port: this.sshPort });
            let done = (ok) => {
                if (sock.destroyed && done.called) return;
                done.called = true;
                try { sock.destroy(); } catch (e) {}
                w.reach = { ok, ts: now() };
                resolve();
            };
            sock.setTimeout(3000);
            sock.on('connect', () => done(true));
            sock.on('timeout', () => done(false));
            sock.on('error', () => done(false));
        });
    }

    forget(name) {
        let w = this.workers.get(name);
        if (!w) return false;
        if (this.liveConns().some(c => c.rec === name)) return false;
        this.workers.delete(name);
        this.save();
        return true;
    }

    // ---- snapshot ---------------------------------------------------------
    repHashrate(w, t) {
        if (!w.miner) return null;
        let maxAge = Math.max(this.cfg.pollEvery * 3, 3 * MINUTE);
        return (t - w.miner.ts) < maxAge ? w.miner.hashrate : null;
    }

    // did the device answer on ADB or SSH in the last few minutes?
    reachable(w, t) {
        let fresh = (ts) => ts && t - ts < Math.max(this.cfg.pollEvery * 3, 3 * MINUTE);
        if (w.reach && w.reach.ok && fresh(w.reach.ts)) return true;
        let c = w.conn;
        if (!c || !fresh(c.ts)) return false;
        return !!(c.adbPort || (c.adb && c.adb.state === 'device') || Object.values(c.ports || {}).some(Boolean));
    }

    snapshot() {
        let t = now();
        let conns = this.liveConns();
        // the same phone under two names (same Android ID), e.g. renamed worker or added twice
        let byAid = new Map();
        for (let [n, w] of this.workers) if (w.androidId) byAid.set(w.androidId, (byAid.get(w.androidId) || []).concat(n));
        let byWorker = new Map();
        for (let c of conns) {
            if (!byWorker.has(c.rec)) byWorker.set(c.rec, []);
            byWorker.get(c.rec).push(c);
        }
        // worker names logged in from more than one address right now
        let nameUsers = new Map();
        for (let c of conns) { if (!nameUsers.has(c.worker)) nameUsers.set(c.worker, new Set()); nameUsers.get(c.worker).add(c.rec); }
        // How long a device normally goes between shares depends on its speed and the pool's
        // share difficulty (set for the proxy's one connection, i.e. the whole fleet), so
        // "No shares" uses a per-device limit instead of a fixed 5 minutes.
        let wps = 0, nShares = 0;
        for (let b of this.fleetBuckets) if (b[0] >= t - HOUR) { wps += b[1]; nShares += (b[2] === undefined ? 1 : b[2]); }
        let workPerShare = nShares ? wps / nShares : null;
        let onlineNow = new Set(conns.map(c => c.rec)).size || 1;
        let fleetRate = this.poolSideRate(this.fleetBuckets.map(b => b.slice()), t, { wantShares: 100, connectedSince: this.startedAt }).rate;
        let list = [];
        let tot = { acc1h: 0, rej1h: 0, causes1h: {}, eff: 0, rep: 0, online: 0, offline: 0, stale: 0, elsewhere: 0, reconnecting: 0, idle: 0, acc: 0, rej: 0, temps: [] };
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
                // expected seconds between shares for this device (null if not known yet)
                let speed = rep || (eff > 0 ? eff : null) || (fleetRate ? fleetRate / onlineNow : null);
                w._expectedShareSec = workPerShare && speed ? workPerShare / speed : null;
                // flag only when the gap is very unlikely to be bad luck: chance of no share in
                // 6x the expected time is 0.25%; never less than staleAfterSec, never more than 6 h
                let limit = Math.min(6 * HOUR, Math.max(this.cfg.staleAfter, w._expectedShareSec ? 6 * w._expectedShareSec * 1000 : 0));
                let quietFor = t - Math.max(w.lastShare || 0, w.connectedSince || t);
                status = quietFor > limit ? 'stale' : 'online';
            } else if (rep !== null && !viaProxy) {
                status = 'elsewhere';     // ccminer is mining, but on another pool (not this proxy)
            } else if (w.lastSeen && t - w.lastSeen < MINUTE) {
                status = 'reconnecting';  // dropped less than a minute ago; ccminer usually reconnects within seconds
            } else {
                // switched on and reachable (ADB or SSH answers) but not mining here, or not reachable at all
                status = this.reachable(w, t) ? 'idle' : 'offline';
            }
            let dev = w.device && (t - w.device.ts < 30 * MINUTE) ? w.device : (w.device ? Object.assign({}, w.device, { old: true }) : null);
            let m = w.miner || {};
            // CPU temperature: device agent, ccminer (only where it can read one), or over ADB
            let adbT = w.adbTemp && t - w.adbTemp.ts < this.cfg.tempFresh ? w.adbTemp : null;
            let cpuTemp = (dev && !dev.old && dev.cpuTemp) || (rep !== null ? m.cpuTemp : null) || (adbT ? adbT.temp : null) || null;
            let cpuTempSrc = cpuTemp === null ? null : (dev && !dev.old && dev.cpuTemp) ? 'agent' : (rep !== null && m.cpuTemp) ? 'ccminer' : 'ADB, ' + adbT.source;
            // facts read over ADB (registry); live values only while recent
            let inv = w.inv || {};
            let invFresh = w.invTs && t - w.invTs < 30 * MINUTE;
            let agentLive = dev && !dev.old;
            let row = {
                name,
                status,
                // counts toward the fleet totals only while it mines through this proxy
                viaProxy: online,
                address: w.address,
                ip: (cs[0] && cs[0].ip) || w.ip,
                connections: cs.length,
                // each miner connection of this device; two from one address = the miner runs twice there
                connList: cs.map(c => ({ ip: c.ip, since: c.since, acc: c.acc || 0, rej: c.rej || 0, lastShare: c.lastShare || 0, software: c.software, login: c.worker })),
                minersTwice: cs.length > new Set(cs.map(c => c.ip)).size ? cs.length : 0,
                // other devices logged in with the same worker name right now
                sameName: (() => { let base = (cs[0] && cs[0].worker) || w.baseName || name; let u = nameUsers.get(base); return u && u.size > 1 ? Array.from(u).filter(n => n !== name) : null; })(),
                baseName: w.baseName || null,
                apiErr: w.apiErr && t - w.apiErr.ts < Math.max(this.cfg.pollEvery * 3, 3 * MINUTE) ? w.apiErr : null,
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
                ...(({ acc1h, rej1h, rejCauses1h }) => ({ accepted1h: acc1h, rejected1h: rej1h, rejCauses1h }))(this.lastHour(w, t)),
                rejReasons: w.rejReasons || {},
                minerAccepted: m.accepted ?? null,
                minerRejected: m.rejected ?? null,
                minerUptime: rep !== null ? m.uptime : null,
                minerSource: m.source || null,
                minerPoolUrl: rep !== null ? (m.poolUrl || null) : null,
                expectedShareSec: online && w._expectedShareSec ? Math.round(w._expectedShareSec) : null,
                manual: !!w.manual,
                threads: rep !== null ? m.threads : null,
                cpuFreq: rep !== null ? m.cpuFreq : null,
                ping: rep !== null ? m.ping : null,
                cpuTemp,
                cpuTempSrc,
                cpuTempWhy: cpuTemp === null ? (w.adbTempErr && t - w.adbTempErr.ts < this.cfg.tempFresh ? w.adbTempErr.error : null) : null,
                make: (dev && dev.make) || inv.make || null,
                model: (dev && dev.model) || inv.model || null,
                marketName: inv.marketName || null,
                soc: (dev && dev.soc) || inv.soc || null,
                os: (dev && dev.os) || (inv.android ? 'Android ' + inv.android : null),
                kernel: (dev && dev.kernel) || inv.kernel || m.kernel || null,
                arch: (dev && dev.arch) || inv.abi || null,
                cores: (dev && dev.cores) || inv.cores || m.cores || null,
                ramMB: (dev && dev.ramMB) || inv.ramMB || null,
                batteryTemp: agentLive && dev.batteryTemp != null ? dev.batteryTemp : (invFresh ? inv.batteryTemp : null),
                batteryLevel: agentLive && dev.batteryLevel != null ? dev.batteryLevel : (invFresh ? inv.batteryLevel : null),
                charging: agentLive && dev.charging != null ? dev.charging : (invFresh ? inv.powered : null),
                load: agentLive ? dev.load : null,
                deviceUptime: agentLive ? dev.uptime : (invFresh && inv.uptimeSec ? inv.uptimeSec + Math.round((t - w.invTs) / 1000) : null),
                agentSeen: w.device ? w.device.ts : null,
                // registry
                android: inv.android || null,
                sdk: inv.sdk || null,
                root: w.inv ? (inv.root && inv.root.adbGranted ? 'yes' : inv.root && inv.root.su ? 'su' : 'no') : null,
                rootKind: (inv.root && inv.root.kind) || null,
                termux: inv.termux || null,
                userland: inv.userland || null,
                dataFreeMB: inv.dataFreeMB || null,
                androidId: w.androidId || null,
                dupOf: w.androidId && byAid.get(w.androidId).length > 1 ? byAid.get(w.androidId).filter(n => n !== name) : null,
                notes: w.notes || '',
                conn: w.conn ? { adb: w.conn.adb ? w.conn.adb.state : null, adbMsg: w.conn.adb ? w.conn.adb.msg : null, adbPort: !!w.conn.adbPort, ports: w.conn.ports || {}, ts: w.conn.ts } : null,
                invTs: w.invTs || null,
                invError: w.invError || null,
                inv: w.inv || null,
                minerBin: w.minerBin || null,
                farm: w.farm || null,
                findUntil: w.findUntil && w.findUntil > t ? w.findUntil : null
            };
            list.push(row);
            if (status === 'idle') tot.idle++;
            else if (online || status === 'reconnecting') tot.online++;
            else if (status === 'elsewhere') tot.elsewhere++;
            else tot.offline++;
            if (status === 'reconnecting') tot.reconnecting++;
            if (status === 'stale') tot.stale++;
            if (online) tot.rep += rep || 0;     // not devices mining on another pool
            tot.acc += w.accepted;
            tot.rej += w.rejected;
            let lh = this.lastHour(w, t);
            tot.acc1h += lh.acc1h; tot.rej1h += lh.rej1h;
            for (let [c, n] of Object.entries(lh.rejCauses1h)) tot.causes1h[c] = (tot.causes1h[c] || 0) + n;
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
            stratumLagSec: this.stratumLag(),
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
                idle: tot.idle,
                devices: list.length,
                accepted: tot.acc,
                rejected: tot.rej,
                accepted1h: tot.acc1h,
                rejected1h: tot.rej1h,
                rejCauses1h: tot.causes1h,
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
            if ((r.status === 'offline' || r.status === 'idle') && !r.effHashrate && r.repHashrate === null) continue;
            // device-reported speed is recorded only while the device mines through the proxy
            w[r.name] = [Math.round(r.effHashrate), r.repHashrate === null || !r.viaProxy ? null : Math.round(r.repHashrate)];
        }
        let anyRep = snap.workers.some(r => r.repHashrate !== null && r.viaProxy);
        let h = this.hist;
        h.minute.push(h.minute.make(t, [Math.round(snap.totals.effHashrate), anyRep ? Math.round(snap.totals.repHashrate) : null], w));

        if (t - this.lastLong >= this.cfg.longEvery) {
            let pts = h.minute.since(t - this.cfg.longEvery + 1);
            if (pts.length) h.long.push(averagePoints(h, pts, t));
            this.lastLong = t;
        }
        // drop long-gone devices
        for (let [name, wk] of this.workers) {
            let last = Math.max(wk.lastSeen || 0, wk.lastShare || 0, wk.miner ? wk.miner.ts : 0, wk.device ? wk.device.ts : 0, wk.firstSeen);
            if (!wk.manual && snap.time - last > this.cfg.forgetAfter) this.workers.delete(name);
        }
    }

    history(rangeSec, metric) {
        let t = now();
        let from = t - rangeSec * 1000;
        let long = rangeSec > 24 * 3600;
        let h = this.hist;
        let src = long ? h.long : h.minute;
        let pts = src.since(from);
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
                .map(([k, chunk]) => averagePoints(h, chunk, (k + 1) * slot));
        }
        let k = metric === 'rep' ? 1 : 0;
        let present = new Set();
        for (let p of pts) for (let i of h.present(p)) present.add(i);
        let workers = {};
        for (let i of present) {
            let arr = new Array(pts.length);
            for (let j = 0; j < pts.length; j++) {
                let a = k ? pts[j].r : pts[j].e, v = i < a.length ? a[i] : NaN;
                // a device seen in a point but without this metric is null; not seen: null too (as before)
                arr[j] = Number.isNaN(v) ? null : v;
            }
            workers[h.names[i]] = arr;
        }
        return {
            metric: k ? 'rep' : 'eff',
            now: t,
            from,
            step: slot,               // expected spacing between points; bigger jumps are gaps
            since: src.length ? src.first().t : null,
            t: pts.map(p => p.t),
            total: pts.map(p => p.tot[k]),
            workers
        };
    }

    // ---- persistence ------------------------------------------------------
    save(sync) {
        try {
            fs.mkdirSync(this.cfg.dataDir, { recursive: true });
            let workers = [];
            for (let [, w] of this.workers) {
                let o = Object.assign({}, w);
                workers.push(o);
            }
            let file = path.join(this.cfg.dataDir, 'stats.json');
            // history lives in data/history; this file now holds only the devices (small)
            let text = JSON.stringify({ v: 2, saved: now(), workers, fleetBuckets: this.fleetBuckets, lastLong: this.lastLong });
            if (sync) { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); this.hist.writeNames(true); return; }
            if (this.saving) return;
            this.saving = true;
            fs.promises.writeFile(file + '.tmp', text).then(() => fs.promises.rename(file + '.tmp', file))
                .catch(e => console.log('dashboard: unable to save stats', e.message)).finally(() => { this.saving = false; });
        } catch (e) {
            console.log('dashboard: unable to save stats', e.message);
        }
    }
    load() {
        try {
            let file = path.join(this.cfg.dataDir, 'stats.json');
            if (!fs.existsSync(file)) { let l = this.hist.load(now()); if (l.points) console.log(`dashboard: restored ${l.points} history points`); return; }
            let d = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (let w of d.workers || []) {
                w.connectedSince = null;
                this.workers.set(w.name, w);
            }
            this.fleetBuckets = d.fleetBuckets || [];
            let h = this.hist, l;
            if ((Array.isArray(d.minute) || Array.isArray(d.long)) && !h.hasFiles()) {
                // first start with the history store: move the history out of stats.json, keeping it all
                try { fs.copyFileSync(file, file + '.before-history'); } catch (e) {}
                let n = h.migrate(d.minute, d.long);
                console.log(`dashboard: moved ${n} history points from stats.json to ${h.dir}`);
                l = { points: n, bad: 0 };
            } else l = h.load(now());
            this.lastLong = d.lastLong || (h.long.length ? h.long.pts[h.long.length - 1].t : 0);
            console.log(`dashboard: restored ${this.workers.size} devices and ${l.points} history points` + (l.bad ? ` (${l.bad} damaged lines skipped)` : ''));
        } catch (e) {
            console.log('dashboard: unable to load saved stats', e.message);
        }
    }
}

// "samsung" -> "Samsung", leave "OnePlus"/"HMD Global" alone
function titleCase(s) {
    return s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}


exports.FleetStats = FleetStats;
exports.parseCcminer = parseCcminer;
exports.minerFromCcminer = minerFromCcminer;
