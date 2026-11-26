// ADB access to the phones, using the proxy machine's `adb` tool (Debian/Raspberry Pi OS:
// sudo apt install adb). Phones listen on TCP 5555 (e.g. set at boot by Termux:Boot with
// `su -c setprop service.adb.tcp.port 5555; su -c stop adbd; su -c start adbd`).
//
// Scripts are sent base64-encoded and piped into sh (or su for root), so quoting can't break them.

const { spawn } = require('child_process');

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\r/g;

// everything the registry wants to know, in one round trip; prints KEY=value lines
const INVENTORY_SCRIPT = String.raw`
p() { v=$(getprop "$2" 2>/dev/null); echo "$1=$v"; }
p make ro.product.manufacturer
p brand ro.product.brand
p model ro.product.model
p marketname ro.product.marketname
p marketname2 ro.product.vendor.marketname
p marketname3 ro.config.marketing_name
p device ro.product.device
p android ro.build.version.release
p sdk ro.build.version.sdk
p patch ro.build.version.security_patch
p build ro.build.display.id
p abi ro.product.cpu.abi
p socmfr ro.soc.manufacturer
p socmodel ro.soc.model
p platform ro.board.platform
p hardware ro.hardware
p serial ro.serialno
p serial2 ro.boot.serialno
p adbport service.adb.tcp.port
echo "androidid=$(settings get secure android_id 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "cores=$(grep -c ^processor /proc/cpuinfo 2>/dev/null)"
echo "memkb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
echo "datafreekb=$(df -k /data 2>/dev/null | awk 'NR==2 {print $4}')"
echo "datatotalkb=$(df -k /data 2>/dev/null | awk 'NR==2 {print $2}')"
echo "wlanip=$(ip -f inet addr show wlan0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n 1)"
echo "wlanmac=$(cat /sys/class/net/wlan0/address 2>/dev/null)"
dumpsys battery 2>/dev/null | awk -F': ' '/^ *level:/ {print "batlevel=" $2} /^ *temperature:/ {print "battemp=" $2} /^ *status:/ {print "batstatus=" $2} /^ *AC powered:/ {print "batac=" $2} /^ *USB powered:/ {print "batusb=" $2}'
for pkg in com.termux com.termux.boot com.termux.api tech.ula; do
  v=$(dumpsys package "$pkg" 2>/dev/null | grep -m 1 versionName= | cut -d= -f2)
  echo "pkg_$pkg=$v"
done
echo "ccminer_proc=$(ps -A -o ARGS 2>/dev/null | grep -m 1 '[c]cminer' | cut -c1-300)"
su_bin=$(command -v su 2>/dev/null)
echo "su_path=$su_bin"
if [ -n "$su_bin" ]; then
  echo "su_version=$(timeout 5 su -v 2>/dev/null | head -n 1)"
  echo "su_id=$(timeout 8 su -c id 2>/dev/null | head -n 1)"
fi
echo "inv_done=1"
`;

// hottest CPU sensor: thermal service first (Android 10+), else thermal zones named like CPU clusters
const TEMP_SCRIPT = String.raw`
TAB=$(printf '\t')
h=$(dumpsys thermalservice 2>/dev/null | sed -n "/Current temperatures from HAL/,/^[^ $TAB]/p" | grep 'mType=0' | sed -n 's/.*mValue=\([0-9.]*\).*/\1/p' | sort -n | tail -n 1)
echo "hal=$h"
best=""; bt=""; n=0
for z in /sys/class/thermal/thermal_zone*; do
  ty=$(cat "$z/type" 2>/dev/null) || continue
  case "$ty" in mngs*|APOLLO*|*[Cc][Pp][Uu]*|*[Bb][Ii][Gg]*|*[Ll][Ii][Tt][Tt][Ll][Ee]*|*[Mm][Ii][Dd]*|mtktscpu*|*[Ss][Oo][Cc]*|AP|*[Aa][Pp]_*|*[Tt][Ss][Ee][Nn][Ss]*) ;; *) continue;; esac
  v=$(cat "$z/temp" 2>/dev/null) || continue
  case "$v" in ''|*[!0-9-]*) continue;; esac
  n=$((n+1))
  [ "$v" -gt 1000 ] && v=$((v/1000))
  [ "$v" -gt 5 ] && [ "$v" -lt 130 ] || continue
  if [ -z "$best" ] || [ "$v" -gt "$best" ]; then best=$v; bt=$ty; fi
done
echo "zone=$best"; echo "zonetype=$bt"; echo "readable=$n"
`;

function parseKv(text) {
    let o = {};
    for (let line of String(text || '').replace(ANSI, '').split('\n')) {
        let i = line.indexOf('=');
        if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return o;
}

// turn the raw KEY=value output into the registry's device facts
function factsFrom(kv) {
    let s = (v) => (v && v !== 'null' && v !== 'unknown' ? v : null);
    let n = (v) => (v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null);
    let su = s(kv.su_path);
    let rootGranted = /uid=0\b/.test(kv.su_id || '');
    let suv = s(kv.su_version) || '';
    let rootKind = /magisk/i.test(suv) ? 'Magisk' : /kernelsu|ksu/i.test(suv) ? 'KernelSU' : /apatch/i.test(suv) ? 'APatch' : (su ? 'su' : null);
    let pkgs = {};
    for (let [k, v] of Object.entries(kv)) if (k.startsWith('pkg_')) pkgs[k.slice(4)] = s(v);
    let soc = s(kv.socmodel) ? [s(kv.socmfr), s(kv.socmodel)].filter(Boolean).join(' ') : (s(kv.platform) || s(kv.hardware));
    let temp = n(kv.battemp);
    let statusCodes = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not charging', 5: 'full' };
    return {
        make: s(kv.make) ? kv.make.charAt(0).toUpperCase() + kv.make.slice(1) : null,
        brand: s(kv.brand),
        model: s(kv.model),
        marketName: s(kv.marketname) || s(kv.marketname2) || s(kv.marketname3),
        device: s(kv.device),
        android: s(kv.android),
        sdk: n(kv.sdk),
        securityPatch: s(kv.patch),
        build: s(kv.build),
        abi: s(kv.abi),
        soc,
        kernel: s(kv.kernel),
        cores: n(kv.cores),
        ramMB: n(kv.memkb) ? Math.round(n(kv.memkb) / 1024) : null,
        dataFreeMB: n(kv.datafreekb) ? Math.round(n(kv.datafreekb) / 1024) : null,
        dataTotalMB: n(kv.datatotalkb) ? Math.round(n(kv.datatotalkb) / 1024) : null,
        uptimeSec: n(kv.uptime) ? Math.round(n(kv.uptime)) : null,
        androidId: s(kv.androidid),
        serial: s(kv.serial) || s(kv.serial2),
        wlanIp: s(kv.wlanip),
        wlanMac: s(kv.wlanmac),
        adbTcpPort: n(kv.adbport),
        batteryLevel: n(kv.batlevel),
        batteryTemp: temp !== null ? temp / 10 : null,
        batteryStatus: statusCodes[n(kv.batstatus)] || null,
        powered: kv.batac === 'true' || kv.batusb === 'true',
        // root: is there su, which kind, and does the ADB shell actually get root?
        root: { su: !!su, kind: rootKind, version: suv || null, adbGranted: rootGranted },
        termux: pkgs['com.termux'] || null,
        termuxBoot: pkgs['com.termux.boot'] || null,
        termuxApi: pkgs['com.termux.api'] || null,
        userland: pkgs['tech.ula'] || null,
        ccminerProcess: s(kv.ccminer_proc),
        complete: kv.inv_done === '1'
    };
}

class Adb {
    constructor(config) {
        let a = config.adb || {};
        this.cfg = {
            enabled: a.enabled === true,
            bin: typeof a.bin === 'string' && a.bin ? a.bin : 'adb',
            port: Number(a.port) > 0 && Number(a.port) < 65536 ? Number(a.port) : 5555,
            timeoutSec: Math.min(Math.max(Number(a.timeoutSec) || 20, 5), 600),
            inventoryEveryMin: Math.max(Number(a.inventoryEveryMin) || 10, 1),
            parallel: Math.min(Math.max(Number(a.parallel) || 6, 1), 32),
            scan: Array.isArray(a.scan) ? a.scan.filter(x => typeof x === 'string') : [],
            // CPU temperature is read every tempEveryMin (each device on its own schedule)
            tempEveryMin: Math.min(Math.max(Number(a.tempEveryMin) || 3, 1), 60),
            // more than ~100-200 phones on one adb server gets unreliable: spread them over several
            // servers (ports serverPort, serverPort+1, ...); each phone always uses the same one
            servers: Math.min(Math.max(Number(a.servers) || 1, 1), 16),
            serverPort: Number(a.serverPort) > 0 && Number(a.serverPort) < 65000 ? Number(a.serverPort) : 5037
        };
        this.version = null;
        this.missing = false;
    }

    // which adb server a phone (or USB serial) belongs to: stable, by its address
    serverOf(serial) {
        if (this.cfg.servers <= 1 || !serial) return 0;
        let s = String(serial).replace(/:\d+$/, ''), h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % this.cfg.servers;
    }

    // run the adb tool; never throws. With several servers, commands for a phone go to its own server
    // (server: a number to pick one explicitly, e.g. for `adb devices`)
    exec(args, timeoutMs, server) {
        if (this.cfg.servers > 1 || this.cfg.serverPort !== 5037) {
            let serial = args[0] === '-s' || args[0] === 'connect' || args[0] === 'disconnect' ? args[1] : null;
            let k = server !== undefined ? server : this.serverOf(serial);
            args = ['-P', String(this.cfg.serverPort + k)].concat(args);
        }
        return new Promise(resolve => {
            let out = '', err = '', done = false, child;
            let finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ out: out.replace(ANSI, ''), err: err.replace(ANSI, '') }, r)); };
            try {
                child = spawn(this.cfg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                return finish({ code: null, error: e.message });
            }
            let timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (e) {}
                try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) {}
                finish({ code: null, timedOut: true });
            }, timeoutMs || this.cfg.timeoutSec * 1000);
            child.stdout.on('data', d => { if (out.length < 256 * 1024) out += d; });
            child.stderr.on('data', d => { if (err.length < 64 * 1024) err += d; });
            child.on('error', e => {
                if (e.code === 'ENOENT') this.missing = true;
                finish({ code: null, error: e.code === 'ENOENT' ? 'The `adb` tool is not installed on the proxy machine (Debian/Raspberry Pi OS: sudo apt install adb).' : e.message });
            });
            child.on('close', code => finish({ code }));
        });
    }

    async checkVersion() {
        let r = await this.exec(['version'], 10000);
        let m = /Android Debug Bridge version ([\d.]+)/.exec(r.out);
        this.version = m ? m[1] : null;
        this.missing = !!r.error && /not installed/.test(r.error);
        return this.version;
    }

    serial(ip, port) { return `${ip}:${port || this.cfg.port}`; }

    // connect (or confirm the connection); result.state: device | unauthorized | offline | refused | unreachable | error
    async connect(ip, port) {
        let serial = this.serial(ip, port);
        let r = await this.exec(['connect', serial], 12000);
        if (r.error) return { ok: false, state: 'error', msg: r.error, serial };
        let text = (r.out + r.err).trim();
        if (/refused/i.test(text)) return { ok: false, state: 'refused', msg: 'Nothing listening on the ADB port (is TCP ADB enabled on the phone?)', serial };
        if (/authenticate|unauthorized/i.test(text)) return { ok: false, state: 'unauthorized', msg: 'Phone has not allowed this proxy: accept "Allow USB debugging" on the phone, or use "Install ADB key".', serial };
        if (/cannot connect|failed to connect|timed out|No route|unreachable/i.test(text) || r.timedOut) return { ok: false, state: 'unreachable', msg: 'Phone not reachable on the network.', serial };
        let st = await this.state(serial);
        return Object.assign({ serial }, st);
    }

    async state(serial) {
        let r = await this.exec(['-s', serial, 'get-state'], 8000);
        let text = (r.out + ' ' + r.err).trim();
        if (/^device\b/.test(r.out.trim())) return { ok: true, state: 'device', msg: null };
        if (/unauthorized/i.test(text)) return { ok: false, state: 'unauthorized', msg: 'Phone has not allowed this proxy: accept "Allow USB debugging" on the phone, or use "Install ADB key".' };
        if (/offline/i.test(text)) return { ok: false, state: 'offline', msg: 'ADB connection is offline; try Reconnect.' };
        return { ok: false, state: 'error', msg: r.error || text.slice(0, 200) || 'ADB not connected' };
    }

    // `adb devices -l`: TCP ones are ip:port; anything else is USB
    async devices() {
        let list = [], err = null, out = '';
        for (let k = 0; k < this.cfg.servers; k++) {
            let r = await this.exec(['devices', '-l'], 10000, k);
            if (r.error) { err = r.error; continue; }
            out += r.out.split('\n').slice(1).join('\n') + '\n';
        }
        if (err && !out.trim()) return { ok: false, error: err, list: [] };
        for (let line of ('\n' + out).split('\n').slice(1)) {
            let m = /^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader|no permissions)(.*)$/.exec(line.trim());
            if (!m) continue;
            let extra = {};
            for (let kv of m[3].trim().split(/\s+/)) { let i = kv.indexOf(':'); if (i > 0) extra[kv.slice(0, i)] = kv.slice(i + 1); }
            let tcp = /^[\d.]+:\d+$/.test(m[1]);
            list.push({ serial: m[1], state: m[2], usb: !tcp, model: (extra.model || '').replace(/_/g, ' ') || null, product: extra.product || null, device: extra.device || null });
        }
        return { ok: true, list };
    }

    // run a shell script on the phone, as the shell user or as root
    async shell(serial, script, opts) {
        opts = opts || {};
        let b64 = Buffer.from(String(script)).toString('base64');
        if (b64.length <= 2500) {
            let runner = opts.root ? 'su' : 'sh';
            return this.exec(['-s', serial, 'shell', `echo ${b64} | base64 -d | ${runner}`], opts.timeoutMs);
        }
        // long scripts: older Android limits a shell command to ~4 KB, so push it as a file and run that
        let name = 'vp-' + require('crypto').randomBytes(5).toString('hex') + '.sh';
        let local = require('path').join(require('os').tmpdir(), name);
        try { require('fs').writeFileSync(local, String(script), { mode: 0o600 }); } catch (e) { return { code: null, error: e.message, out: '', err: '' }; }
        let remote = '/data/local/tmp/' + name;
        let p = await this.exec(['-s', serial, 'push', local, remote], 20000);
        try { require('fs').unlinkSync(local); } catch (e) {}
        if (p.error || p.code !== 0) return { code: null, error: p.error || ('could not copy the script to the phone: ' + (p.out + p.err).trim().slice(0, 200)), out: '', err: '' };
        let run = opts.root ? `su -c "sh ${remote}"` : `sh ${remote}`;
        return this.exec(['-s', serial, 'shell', `${run}; rc=$?; rm -f ${remote}; exit $rc`], opts.timeoutMs);
    }

    async inventory(serial) {
        let r = await this.shell(serial, INVENTORY_SCRIPT, { timeoutMs: 45000 });
        if (r.error) return { ok: false, error: r.error };
        if (r.timedOut) return { ok: false, error: 'Timed out reading device info.' };
        let kv = parseKv(r.out);
        if (kv.inv_done !== '1') return { ok: false, error: (r.err || r.out || 'no answer').trim().slice(0, 200) };
        return { ok: true, facts: factsFrom(kv) };
    }

    // CPU temperature, read every minute. ccminer can't report it on phones (it only looks at
    // /sys/class/hwmon, which phones don't have) and Android doesn't let Termux read the sensors,
    // but the ADB shell may: Android's thermal service (type 0 = CPU), else the CPU thermal zones.
    async cpuTemp(serial, root) {
        let r = await this.shell(serial, TEMP_SCRIPT, { root: !!root, timeoutMs: 15000 });
        if (r.error || r.timedOut) return { ok: false, error: r.error || 'timed out' };
        let kv = parseKv(r.out);
        let ok = (v) => { v = Number(v); return isFinite(v) && v > 5 && v < 130 ? Math.round(v * 10) / 10 : null; };
        let hal = ok(kv.hal), zone = ok(kv.zone);
        let t = hal !== null ? hal : zone;
        return { ok: t !== null, temp: t, source: hal !== null ? 'thermal service' : zone !== null ? 'thermal zone ' + (kv.zonetype || '') : null, readable: Number(kv.readable) || 0 };
    }

    // USB phone -> WiFi ADB on the configured port; returns its WiFi address
    async enableTcp(serial) {
        let ip = await this.shell(serial, "ip -f inet addr show wlan0 | awk '/inet / {print $2}' | cut -d/ -f1 | head -n 1", { timeoutMs: 10000 });
        let addr = (ip.out || '').trim();
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return { ok: false, error: 'The phone has no WiFi address (is WiFi on and connected?)' };
        let r = await this.exec(['-s', serial, 'tcpip', String(this.cfg.port)], 15000);
        if (r.error) return { ok: false, error: r.error };
        if (!/restarting in TCP mode/i.test(r.out + r.err)) return { ok: false, error: (r.out + r.err).trim().slice(0, 200) || 'adb tcpip failed' };
        await new Promise(res => setTimeout(res, 2500));
        let c = await this.connect(addr);
        return Object.assign({ ip: addr }, c);
    }

    async reboot(serial) {
        let r = await this.exec(['-s', serial, 'reboot'], 15000);
        return r.error ? { ok: false, error: r.error } : (r.code === 0 ? { ok: true } : { ok: false, error: (r.out + r.err).trim().slice(0, 200) || 'reboot failed' });
    }

    async disconnect(serial) { await this.exec(['disconnect', serial], 8000); }
}

module.exports = { Adb, factsFrom, parseKv, INVENTORY_SCRIPT, TEMP_SCRIPT };
