// Farm setup check (runs in the cluster master): compares each phone with its farm profile
// (config "farm": defaults -> group -> device, see lib/config.js) and reports in sync / drifted /
// not set up. Strictly read-only on the phones: one ADB shell script that only reads files,
// properties and dumpsys output. Fixing drift is a separate step.

const { parseKv } = require('./adb.js');
const { farmProfile } = require('./config.js');
const { isLan } = require('./registry.js');

const MINUTE = 60000;

// everything in one round trip, KEY=value lines; run through su when ADB has root, else as shell.
// Kept short so adb.shell pipes it (a long one would be copied to /data/local/tmp first).
const CHECK_SCRIPT = String.raw`
H=/data/data/com.termux/files/home; B=$H/.termux/boot
echo "uid=$(id -u)"
L=$(pm list packages 2>/dev/null)
for p in com.termux com.termux.boot; do echo "$L" | grep -qx "package:$p" && echo "pkg_$p=1" || echo "pkg_$p=0"; done
echo "termux_ver=$(dumpsys package com.termux 2>/dev/null | grep -m 1 versionName= | cut -d= -f2)"
if [ -d "$B" ]; then echo "boot_dir=1"; echo "boot_files=$(ls "$B" 2>/dev/null | tr '\n' ' ')"
elif [ -d "$H" ]; then echo "boot_dir=0"; else echo "boot_dir=?"; fi
if [ -f "$B/$NAME" ]; then echo "boot_script=1"; echo "boot_stamp=$(grep -m 1 -o 'verusproxy-profile: [0-9a-f]*' "$B/$NAME" | cut -d' ' -f2)"; fi
echo "idle=$(dumpsys deviceidle whitelist 2>/dev/null | grep -c ',com.termux,')"
echo "cpuset=$(cat /dev/cpuset/foreground/cpus 2>/dev/null)"
echo "adbprop=$(getprop service.adb.tcp.port)"
D=$(dumpsys battery 2>/dev/null)
echo "bat_stopped=$(echo "$D" | grep -c 'UPDATES STOPPED')"
echo "$D" | awk -F': ' '/^ *AC powered:/ {print "bat_ac=" $2} /^ *USB powered:/ {print "bat_usb=" $2} /^ *level:/ {print "bat_level=" $2} /^ *status:/ {print "bat_status=" $2}'
echo "miners=$(ps -A -o NAME 2>/dev/null | grep -c '^ccminer')"
echo "termux_uid=$(stat -c %u /data/data/com.termux 2>/dev/null)"
command -v magisk >/dev/null 2>&1 && echo "pol=$(magisk --sqlite 'SELECT uid,policy,until FROM policies' 2>/dev/null | tr '\n' ' ')"
echo "farm_done=1"
`;

function cleanScriptName(s) { return String(s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) || 'verusproxy-setup'; }

// root policies from `magisk --sqlite`: "policy=2|uid=10154|until=0 ..." -> { uid: {policy, until} }
function parsePolicies(s) {
    let out = {};
    for (let row of String(s || '').trim().split(/\s+/)) {
        let o = {};
        for (let kv of row.split('|')) { let i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1); }
        if (o.uid) out[o.uid] = { policy: Number(o.policy), until: Number(o.until) };
    }
    return out;
}

// compare the phone's answers with the profile. item.ok: true | false | null (could not tell)
function evaluate(kv, profile, stamp, w) {
    let items = [];
    let add = (key, label, ok, want, have) => items.push({ key, label, ok, want: want === undefined ? null : String(want), have: have === undefined || have === null ? null : String(have) });
    let root = kv.uid === '0';
    let needRoot = root ? null : 'needs root over ADB';

    let termux = kv['pkg_com.termux'] === '1', boot = kv['pkg_com.termux.boot'] === '1';
    add('termux', 'Termux installed', termux, 'installed', termux ? kv.termux_ver || 'installed' : 'missing');
    if (profile.termuxVersion) add('termuxVersion', 'Termux version', termux ? kv.termux_ver === profile.termuxVersion : false, profile.termuxVersion, kv.termux_ver || (termux ? '?' : 'missing'));
    add('termuxBoot', 'Termux:Boot installed', boot, 'installed', boot ? 'installed' : 'missing');

    let name = cleanScriptName(profile.bootScript);
    if (kv.boot_dir === '1' || kv.boot_dir === '0') {
        let present = kv.boot_script === '1';
        add('bootScript', 'Boot script ~/.termux/boot/' + name, present, 'present', present ? 'present' : (kv.boot_dir === '1' ? 'missing (boot dir has: ' + ((kv.boot_files || '').trim() || 'nothing') + ')' : 'missing (no ~/.termux/boot)'));
        if (present) add('bootStamp', 'Boot script profile stamp', kv.boot_stamp === stamp, stamp, kv.boot_stamp || 'no stamp');
    } else {
        add('bootScript', 'Boot script ~/.termux/boot/' + name, null, 'present', needRoot || 'unreadable');
    }

    if (profile.batteryOptimisationOff) add('batteryOptimisation', 'Battery optimisation off for Termux', Number(kv.idle) > 0, 'com.termux whitelisted', Number(kv.idle) > 0 ? 'whitelisted' : 'not whitelisted');

    if (profile.magiskAutoGrant) {
        let want = 'Termux + Shell allowed forever';
        // without root the policy list can't be read, but su having failed already says Shell isn't allowed
        if (!root) add('magiskGrant', 'Magisk root granted to Termux and Shell', w && w.inv && w.inv.root && w.inv.root.su ? false : null, want, 'Shell not granted (Termux: needs root over ADB to read)');
        else if (kv.pol === undefined) add('magiskGrant', 'Magisk root granted to Termux and Shell', false, want, 'no magisk tool');
        else {
            let pol = parsePolicies(kv.pol);
            let okUid = (u) => pol[u] && pol[u].policy === 2 && pol[u].until === 0;
            let tu = kv.termux_uid || '';
            let missing = [tu && !okUid(tu) ? 'Termux (uid ' + tu + ')' : null, !okUid('2000') ? 'Shell' : null].filter(Boolean);
            add('magiskGrant', 'Magisk root granted to Termux and Shell', !!tu && missing.length === 0, want, missing.length ? 'not granted: ' + missing.join(', ') : 'granted');
        }
    }

    if (profile.cpuset) add('cpuset', 'Foreground cpuset', kv.cpuset ? kv.cpuset === String(profile.cpuset) : null, profile.cpuset, kv.cpuset || 'unreadable');

    if (profile.adbWifiPort) {
        let open = !!(w && w.conn && w.conn.adbPort);
        add('adbWifiPort', 'ADB over WiFi port', kv.adbprop === String(profile.adbWifiPort), profile.adbWifiPort, (kv.adbprop || 'not set') + (open ? ', open' : ''));
    }

    if (profile.batterySpoof !== undefined && profile.batterySpoof !== '') {
        let spoofed = Number(kv.bat_stopped) > 0;
        let have = spoofed ? 'spoofed (level ' + (kv.bat_level || '?') + ', status ' + (kv.bat_status || '?') + ')' : 'real battery (AC ' + (kv.bat_ac || '?') + ', USB ' + (kv.bat_usb || '?') + ', level ' + (kv.bat_level || '?') + ')';
        add('batterySpoof', 'Battery spoof', spoofed === !!profile.batterySpoof, profile.batterySpoof ? 'spoofed' : 'real', have);
    }

    let n = kv.miners === undefined || kv.miners === '' ? null : Number(kv.miners);
    add('ccminer', 'ccminer running once', n === null ? null : n === 1, '1 process', n === null ? 'unknown' : n === 0 ? 'not running' : n === 1 ? 'running once' : 'running ' + n + ' times');

    if (profile.minerBuild) {
        let mb = w && w.minerBin;
        let want = String(profile.minerBuild);
        if (!mb || !mb.ts || mb.error) add('minerBuild', 'Miner build', null, want, mb && mb.error ? 'unknown: ' + mb.error : 'not checked yet (miner check over SSH)');
        else {
            let c = (mb.build && mb.build.commit) || '', sha = mb.sha || '';
            let ok = (c && c.startsWith(want)) || (sha && sha.startsWith(want)) || mb.variant === want;
            add('minerBuild', 'Miner build', !!ok, want, [mb.variant, c ? c.slice(0, 10) : null, sha ? 'sha ' + sha.slice(0, 10) : null].filter(Boolean).join(', ') || 'unknown');
        }
    }

    let bad = items.filter(i => i.ok === false);
    let notSetUp = !termux || !boot || items.some(i => i.key === 'bootScript' && i.ok === false);
    let status = notSetUp ? 'not set up' : bad.length ? 'drifted' : 'in sync';
    return { status, root, items, drift: bad.map(i => i.key), unknown: items.filter(i => i.ok === null).map(i => i.key) };
}

// one device: run the script over ADB (as root when the phone gives the ADB shell root)
async function checkDevice(adb, w, prof) {
    let serial = adb.serial(w.ip);
    let script = 'NAME=' + cleanScriptName(prof.profile.bootScript) + '\n' + CHECK_SCRIPT;
    let wantRoot = !(w.inv && w.inv.root) || w.inv.root.adbGranted !== false;
    let r = await adb.shell(serial, script, { root: wantRoot, timeoutMs: 45000 });
    let kv = parseKv(r.out);
    if (kv.farm_done !== '1' && wantRoot) { r = await adb.shell(serial, script, { root: false, timeoutMs: 45000 }); kv = parseKv(r.out); }
    let base = { ts: Date.now(), stamp: prof.stamp, profileFrom: prof.from };
    if (kv.farm_done !== '1') return Object.assign(base, { status: 'error', error: r.error || (r.timedOut ? 'timed out' : (r.err || r.out || 'no answer').trim().slice(0, 200)), items: [] });
    return Object.assign(base, evaluate(kv, prof.profile, prof.stamp, w), { error: null });
}

class Farm {
    constructor(config, stats, registry, groups) {
        this.config = config;
        this.stats = stats;
        this.registry = registry;
        this.groups = groups;
        this.everyMin = Math.max(Number((config.farm || {}).checkEveryMin) || 60, 5);
        this.busy = new Set();
        setTimeout(() => this.cycle(), 90 * 1000).unref();      // after the registry has connected ADB
        setInterval(() => this.cycle(), MINUTE).unref();
    }

    profileFor(name) { return farmProfile(this.config, this.groups ? this.groups.of(name) : null, name); }

    async checkOne(name) {
        let w = this.stats.workers.get(name);
        if (!w || !w.ip || !isLan(w.ip)) return { ok: false, error: 'no local address known for this device' };
        if (this.busy.has(name)) return { ok: false, error: 'busy' };
        this.busy.add(name);
        try {
            w.farm = await checkDevice(this.registry.adb, w, this.profileFor(name));
            return { ok: w.farm.status !== 'error', farm: w.farm };
        } finally { this.busy.delete(name); }
    }

    // every minute: devices with a working ADB connection whose last check is older than checkEveryMin
    async cycle() {
        if (this.cycling || this.registry.adbDisabledReason()) return;
        this.cycling = true;
        try {
            let t = Date.now(), due = [];
            for (let [name, w] of this.stats.workers) {
                if (!w.conn || !w.conn.adb || w.conn.adb.state !== 'device' || this.busy.has(name)) continue;
                let stampChanged = w.farm && w.farm.stamp !== this.profileFor(name).stamp;
                if (!w.farm || stampChanged || t - w.farm.ts > (this.everyMin - 1) * MINUTE) due.push(name);
            }
            let i = 0, n = this.registry.adb.cfg.parallel;
            await Promise.all(Array.from({ length: Math.min(n, due.length) }, async () => { while (i < due.length) await this.checkOne(due[i++]).catch(() => {}); }));
            if (due.length) {
                let c = {};
                for (let name of due) { let f = this.stats.workers.get(name).farm; if (f) c[f.status] = (c[f.status] || 0) + 1; }
                console.log('farm: checked ' + due.length + ' devices: ' + Object.entries(c).map(([k, v]) => v + ' ' + k).join(', '));
                this.stats.save();
            }
        } catch (e) {
            console.log('farm: check failed', e.message);
        }
        this.cycling = false;
    }
}

module.exports = { Farm, checkDevice, evaluate, parsePolicies, CHECK_SCRIPT };
