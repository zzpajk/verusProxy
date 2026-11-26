// Device registry (runs in the cluster master): keeps track of every phone's connections
// (ADB over WiFi, Termux SSH, UserLAnd SSH), reads its inventory over ADB, finds phones
// on the network and onboards USB-connected ones. Device facts are stored on the device
// records in stats (data/stats.json), so they survive restarts.

const net = require('net');
const os = require('os');
const { Adb } = require('./adb.js');

const MINUTE = 60000;

function tcpOpen(host, port, timeoutMs) {
    return new Promise(resolve => {
        let sock = net.createConnection({ host, port });
        let done = false;
        let finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(ok); };
        sock.setTimeout(timeoutMs || 2500);
        sock.on('connect', () => finish(true));
        sock.on('timeout', () => finish(false));
        sock.on('error', () => finish(false));
    });
}

// run fn over items with at most n at a time
async function pool(items, n, fn) {
    let i = 0;
    let worker = async () => { while (i < items.length) { let it = items[i++]; try { await fn(it); } catch (e) {} } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// only local network addresses are ever probed or connected to (a miner could connect from anywhere)
function isLan(ip) {
    let m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
    if (!m) return false;
    let [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function cleanName(s) {
    return String(s || '').replace(/[^a-zA-Z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

class Registry {
    constructor(config, stats) {
        this.stats = stats;
        this.adb = new Adb(config);
        this.authConfigured = !!(config.dashboard || {}).auth;
        let ssh = config.ssh || {};
        // the SSH ports to check per device: Termux (ssh.port) plus ssh.ports (e.g. UserLAnd 2022)
        let ports = [{ port: Number(ssh.port) || 8022, name: 'Termux' }];
        for (let e of Array.isArray(ssh.ports) ? ssh.ports : []) {
            let o = typeof e === 'object' && e ? e : { port: e };
            let p = Number(o.port);
            if (!(p > 0 && p < 65536)) continue;
            let have = ports.find(x => x.port === p);
            if (have) { if (o.name) have.name = String(o.name).slice(0, 30); }
            else ports.push({ port: p, name: o.name ? String(o.name).slice(0, 30) : 'SSH ' + p });
        }
        this.sshPorts = ports;
        this.usb = [];
        this.lastScan = null;
        this.busy = new Set();     // device names with an inventory read in progress
        if (this.adb.cfg.enabled) {
            this.adb.checkVersion().then(v => console.log(v ? `registry: adb ${v}` : 'registry: adb not found - install it on the proxy machine (sudo apt install adb)'));
        }
        setTimeout(() => this.cycle(), 10000).unref();
        setInterval(() => this.cycle(), MINUTE).unref();
    }

    // why ADB features can't be used right now (null = they can)
    adbDisabledReason() {
        if (!this.adb.cfg.enabled) return 'ADB is off. Set "adb": { "enabled": true } in config.local.json and restart.';
        if (!this.authConfigured) return 'ADB needs a dashboard login: set dashboard.auth ("user:password") in config.local.json and restart.';
        if (this.adb.missing) return 'The `adb` tool is not installed on the proxy machine (Debian/Raspberry Pi OS: sudo apt install adb), then restart the proxy.';
        return null;
    }

    info() {
        return {
            adb: { enabled: !this.adbDisabledReason(), reason: this.adbDisabledReason(), version: this.adb.version, port: this.adb.cfg.port, inventoryEveryMin: this.adb.cfg.inventoryEveryMin },
            sshPorts: this.sshPorts,
            // USB phones; "registered" when the same phone is already in the list (by serial number)
            usb: this.usb.map(u => Object.assign({}, u, { registered: this.registeredAs(u.serial) })),
            lastScan: this.lastScan
        };
    }

    registeredAs(serial) {
        for (let [n, w] of this.stats.workers) if (w.inv && w.inv.serial && w.inv.serial === serial) return n;
        return null;
    }

    // devices worth checking: anything with an address that was seen in the last 7 days, or added by hand
    candidates() {
        let out = [];
        let t = Date.now();
        for (let [name, w] of this.stats.workers) {
            if (!w.ip || !isLan(w.ip)) continue;
            let seen = Math.max(w.lastSeen || 0, w.reach && w.reach.ok ? w.reach.ts : 0, w.invTs || 0);
            if (w.manual || t - seen < 7 * 24 * 60 * MINUTE) out.push([name, w]);
        }
        return out;
    }

    // every minute: which ports answer, keep ADB connected, refresh stale inventory
    async cycle() {
        if (this.cycling) return;
        this.cycling = true;
        try {
            let list = this.candidates();
            let adbOn = !this.adbDisabledReason();
            await pool(list, 24, ([, w]) => this.probePorts(w));
            if (adbOn) {
                // one `adb devices` per server tells which phones are still connected: only the others
                // need `adb connect` (at hundreds of phones that saves hundreds of adb runs a minute)
                let d = await this.adb.devices();
                let up = new Set(d.ok ? d.list.filter(x => !x.usb && x.state === 'device').map(x => x.serial) : []);
                if (d.ok) this.usb = d.list.filter(x => x.usb);
                let tempEvery = this.adb.cfg.tempEveryMin * MINUTE;
                await pool(list.filter(([, w]) => w.conn && w.conn.adbPort), this.adb.cfg.parallel, async ([name, w]) => {
                    let serial = this.adb.serial(w.ip);
                    let c = up.has(serial) ? { ok: true, state: 'device', msg: null, serial } : await this.adb.connect(w.ip);
                    w.conn.adb = { state: c.state, msg: c.msg || null, ts: Date.now() };
                    let stale = !w.invTs || Date.now() - w.invTs > this.adb.cfg.inventoryEveryMin * MINUTE;
                    if (c.ok && stale) await this.readInventory(name);
                    let tLast = Math.max(w.adbTemp ? w.adbTemp.ts : 0, w.adbTempErr ? w.adbTempErr.ts : 0);
                    if (c.ok && Date.now() - tLast >= tempEvery - 5000) await this.readTemp(w);
                });
            }
        } catch (e) {
            console.log('registry: check failed', e.message);
        }
        this.cycling = false;
    }

    // which of the device's SSH ports and its ADB port answer
    async probePorts(w) {
        let ports = {};
        await Promise.all(this.sshPorts.map(async p => { ports[p.port] = await tcpOpen(w.ip, p.port, 2000); }));
        let adbOpen = await tcpOpen(w.ip, this.adb.cfg.port, 2000);
        w.conn = Object.assign({}, w.conn, { ports, adbPort: adbOpen, ts: Date.now() });
        if (!adbOpen) w.conn.adb = { state: 'closed', msg: 'ADB port ' + this.adb.cfg.port + ' not open', ts: Date.now() };
        if (w.manual) w.reach = { ok: adbOpen || Object.values(ports).some(Boolean), ts: Date.now() };
    }

    // full check of one device right away (e.g. just added): ports, ADB, device info
    async checkOne(name) {
        let w = this.stats.workers.get(name);
        if (!w || !w.ip || !isLan(w.ip)) return;
        await this.probePorts(w);
        if (this.adbDisabledReason() || !w.conn.adbPort) return;
        let c = await this.adb.connect(w.ip);
        w.conn.adb = { state: c.state, msg: c.msg || null, ts: Date.now() };
        if (c.ok) await this.readInventory(name);
        this.stats.save();
    }

    // CPU temperature over ADB (as the shell user; through su if that finds nothing and ADB has root)
    async readTemp(w) {
        let serial = this.adb.serial(w.ip);
        let r = await this.adb.cpuTemp(serial, false);
        if (!r.ok && w.inv && w.inv.root && w.inv.root.adbGranted) r = await this.adb.cpuTemp(serial, true);
        if (r.ok) w.adbTemp = { ts: Date.now(), temp: r.temp, source: r.source };
        else w.adbTempErr = { ts: Date.now(), error: r.error || 'no CPU sensor readable' + (w.inv && w.inv.root && w.inv.root.su && !w.inv.root.adbGranted ? ' (grant root to Shell in Magisk to read it)' : '') };
    }

    async readInventory(name) {
        let w = this.stats.workers.get(name);
        if (!w || !w.ip || this.busy.has(name)) return { ok: false, error: 'busy or unknown device' };
        this.busy.add(name);
        try {
            let serial = this.adb.serial(w.ip);
            let r = await this.adb.inventory(serial);
            if (!r.ok) { w.invError = r.error; return r; }
            w.inv = r.facts;
            w.invTs = Date.now();
            w.invError = null;
            if (r.facts.androidId) w.androidId = r.facts.androidId;
            return { ok: true };
        } finally {
            this.busy.delete(name);
        }
    }

    // ---- actions --------------------------------------------------------------
    async refresh(names) {
        let reason = this.adbDisabledReason();
        if (reason) return { ok: false, error: reason };
        let results = [];
        await pool(names, this.adb.cfg.parallel, async (name) => {
            let w = this.stats.workers.get(name);
            if (!w || !w.ip) return results.push({ name, ok: false, error: 'no address known for this device' });
            if (!isLan(w.ip)) return results.push({ name, ok: false, error: w.ip + ' is not a local network address' });
            await this.probePorts(w);
            let c = await this.adb.connect(w.ip);
            w.conn.adb = { state: c.state, msg: c.msg || null, ts: Date.now() };
            if (!c.ok) return results.push({ name, ok: false, error: c.msg });
            let r = await this.readInventory(name);
            results.push(Object.assign({ name }, r));
        });
        this.stats.save();
        return { ok: results.some(r => r.ok), results };
    }

    async reconnect(name) {
        let reason = this.adbDisabledReason();
        if (reason) return { ok: false, error: reason };
        let w = this.stats.workers.get(name);
        if (!w || !w.ip) return { ok: false, error: 'no address known for this device' };
        if (!isLan(w.ip)) return { ok: false, error: w.ip + ' is not a local network address' };
        let serial = this.adb.serial(w.ip);
        await this.adb.disconnect(serial);
        let c = await this.adb.connect(w.ip);
        w.conn = Object.assign({}, w.conn, { adb: { state: c.state, msg: c.msg || null, ts: Date.now() } });
        return { ok: c.ok, state: c.state, error: c.ok ? null : c.msg };
    }

    async reboot(name, by) {
        let reason = this.adbDisabledReason();
        if (reason) return { ok: false, error: reason };
        let w = this.stats.workers.get(name);
        if (!w || !w.ip) return { ok: false, error: 'no address known for this device' };
        if (!isLan(w.ip)) return { ok: false, error: w.ip + ' is not a local network address' };
        let c = await this.adb.connect(w.ip);
        if (!c.ok) return { ok: false, error: c.msg };
        let r = await this.adb.reboot(this.adb.serial(w.ip));
        console.log(`registry: reboot ${name} (${w.ip}) by ${by || '?'}: ${r.ok ? 'sent' : r.error}`);
        return r;
    }

    setNotes(name, notes) {
        let w = this.stats.workers.get(name);
        if (!w) return { ok: false, error: 'unknown device' };
        w.notes = String(notes || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 500);
        this.stats.save();
        return { ok: true };
    }

    // ---- finding phones -------------------------------------------------------
    // the proxy machine's own LAN /24 networks (or adb.scan from the settings)
    scanRanges() {
        if (this.adb.cfg.scan.length) return this.adb.cfg.scan;
        let out = [];
        for (let addrs of Object.values(os.networkInterfaces())) {
            for (let a of addrs || []) {
                if (a.family !== 'IPv4' && a.family !== 4) continue;
                if (a.internal) continue;
                let o = a.address.split('.').map(Number);
                let lan = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
                if (lan) out.push(o.slice(0, 3).join('.') + '.0/24');
            }
        }
        return Array.from(new Set(out));
    }

    // look for phones with ADB open on the network; known ones get their address updated
    async scan() {
        let reason = this.adbDisabledReason();
        if (reason) return { ok: false, error: reason };
        let hosts = [];
        for (let r of this.scanRanges()) {
            let m = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(r.trim());
            if (!m) continue;
            for (let i = 1; i < 255; i++) hosts.push(`${m[1]}.${m[2]}.${m[3]}.${i}`);
        }
        if (!hosts.length) return { ok: false, error: 'No local network to scan; set adb.scan, e.g. ["192.168.1.0/24"]' };
        let open = [];
        await pool(hosts, 64, async (h) => { if (await tcpOpen(h, this.adb.cfg.port, 800)) open.push(h); });
        let found = [];
        let byAid = new Map(), byIp = new Map();
        for (let [n, w] of this.stats.workers) { if (w.androidId) byAid.set(w.androidId, n); if (w.ip) byIp.set(w.ip, n); }
        await pool(open, this.adb.cfg.parallel, async (ip) => {
            let c = await this.adb.connect(ip);
            let e = { ip, state: c.state, msg: c.msg || null, knownAs: null, moved: false };
            if (c.ok) {
                let r = await this.adb.shell(c.serial, 'echo "aid=$(settings get secure android_id)"; echo "make=$(getprop ro.product.manufacturer)"; echo "model=$(getprop ro.product.model)"; echo "mkt=$(getprop ro.product.marketname)"', { timeoutMs: 10000 });
                let kv = require('./adb.js').parseKv(r.out);
                Object.assign(e, { androidId: kv.aid || null, make: kv.make || null, model: kv.model || null, marketName: kv.mkt || null });
                let known = e.androidId && byAid.get(e.androidId);
                if (known) {
                    let w = this.stats.workers.get(known);
                    if (w.ip !== ip) {
                        console.log(`registry: ${known} moved ${w.ip} -> ${ip}`);
                        w.ip = ip; if (w.manual) w.manualIp = ip;
                        e.moved = true;
                    }
                    e.knownAs = known;
                }
            }
            if (!e.knownAs && byIp.has(ip)) e.knownAs = byIp.get(ip);
            e.suggestedName = cleanName(e.knownAs || e.marketName || e.model || ('phone-' + ip.split('.').pop()));
            found.push(e);
        });
        found.sort((a, b) => a.ip.split('.').map(Number).reduce((x, y) => x * 256 + y) - b.ip.split('.').map(Number).reduce((x, y) => x * 256 + y));
        this.lastScan = { t: Date.now(), ranges: this.scanRanges(), scanned: hosts.length, found };
        if (found.some(f => f.moved)) this.stats.save();
        return Object.assign({ ok: true }, this.lastScan);
    }

    // USB phone -> WiFi ADB, then add it to the registry under `name`
    async usbEnable(serial, name) {
        let reason = this.adbDisabledReason();
        if (reason) return { ok: false, error: reason };
        if (!this.usb.some(u => u.serial === serial)) {
            let d = await this.adb.devices();
            if (d.ok) this.usb = d.list.filter(x => x.usb);
            if (!this.usb.some(u => u.serial === serial)) return { ok: false, error: 'That USB device is not connected any more.' };
        }
        let u = this.usb.find(x => x.serial === serial);
        if (u.state !== 'device') return { ok: false, error: u.state === 'unauthorized' ? 'Accept "Allow USB debugging" on the phone first.' : 'USB device is ' + u.state };
        let r = await this.adb.enableTcp(serial);
        if (!r.ok) return { ok: false, error: r.msg || r.error };
        name = cleanName(name) || cleanName(u.model) || ('phone-' + r.ip.split('.').pop());
        this.stats.addManual(name, r.ip);
        await this.checkOne(name);
        return { ok: true, name, ip: r.ip };
    }

    // ADB public key of this proxy, for installing on rooted phones
    adbPublicKey() {
        let f = require('path').join(os.homedir(), '.android', 'adbkey.pub');
        try { return require('fs').readFileSync(f, 'utf8').trim(); } catch (e) { return null; }
    }
}

module.exports = { Registry, tcpOpen, isLan };
