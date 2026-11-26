// Farm setup check (runs in the cluster master): compares each phone with its farm profile
// (config "farm": defaults -> group -> device, see lib/config.js) and reports in sync / drifted /
// not set up. Strictly read-only on the phones: one ADB shell script that only reads files,
// properties and dumpsys output. Fixing drift is a separate step.

const { parseKv } = require('./adb.js');
const { farmProfile } = require('./config.js');
const { isLan } = require('./registry.js');
const boot = require('./farm_boot.js');
const q = boot.q;

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
echo "miner_users=$(ps -A -o USER,NAME 2>/dev/null | awk '$2 ~ /^ccminer/ {print $1}' | tr '\n' ' ')"
TU=$(stat -c %u /data/data/com.termux 2>/dev/null); echo "termux_uid=$TU"
C=/data/data/com.termux/files/usr/var/spool/cron/u0_a$((TU - 10000))
[ -r "$C" ] && echo "cron_wd=$(grep -c '^[^#].*verusproxy-setup loop' "$C")" && echo "cron_kl=$(grep -c '^[^#].*kluster/' "$C")"
echo "crond=$(ps -A -o NAME 2>/dev/null | grep -c '^crond')"
echo "ula=$(pidof tech.ula >/dev/null 2>&1 && echo 1 || echo 0)"
command -v magisk >/dev/null 2>&1 && echo "pol=$(magisk --sqlite 'SELECT uid,policy,until FROM policies' 2>/dev/null | tr '\n' ' ')"
echo "farm_done=1"
`;

// second round trip (each script must stay short enough to be piped in): screen, focus, old keep-alive cron
const CHECK_SCRIPT2 = String.raw`
TU=$(stat -c %u /data/data/com.termux 2>/dev/null)
C=/data/data/com.termux/files/usr/var/spool/cron/u0_a$((TU - 10000))
[ -r "$C" ] && echo "cron_ka=$(grep -c '^[^#].*keep-alive.sh' "$C")"
echo "screen=$(dumpsys nfc 2>/dev/null | sed -n 's/.*mScreenState=//p' | head -n 1)"
echo "wake=$(dumpsys power 2>/dev/null | sed -n 's/.*mWakefulness=//p' | head -n 1)"
echo "focus=$(dumpsys window 2>/dev/null | grep -m 1 mCurrentFocus | grep -o 'com\.termux/[A-Za-z.]*' | head -n 1)"
F=/data/data/com.termux/files/home/.verusproxy
[ -f $F/led.conf ] && echo "led_hash=$(grep -v -E '^(TARGET_KHS|FINDME_UNTIL)=' $F/led.conf | md5sum | cut -c1-8)" && echo "led_target=$(sed -n 's/^TARGET_KHS=//p' $F/led.conf)"
echo "led_state=$(cat $F/led.state 2>/dev/null)"
P=$(cat $F/led.lock/pid 2>/dev/null); [ -n "$P" ] && kill -0 $P 2>/dev/null && echo led_run=1
echo "hw=$({ [ -e /sys/class/sec/led/led_blink ] && echo led-sec; [ -e /sys/class/leds/led_r ] && echo led-rgb; ls /sys/class/leds | grep -m 1 -i -E 'torch|flash'; [ -e /sys/class/camera/flash/rear_torch_flash ] && echo torch-cam; [ -e /sys/class/timed_output/vibrator/enable ] && echo vib; cmd -l 2>/dev/null | grep -q -x '  vibrator' && echo vib-cmd; pm list packages com.termux.api | grep -q api && echo termux-api; } | tr '\n' ' ')"
for p in com.termux com.termux.boot com.termux.api; do echo "sig_$p=$(dumpsys package $p 2>/dev/null | grep -m 1 -o 'signatures:\[[0-9a-f, ]*\]' | sed 's/signatures:\[//; s/[] ,]//g')"; done
echo "farm2_done=1"
`;

// signing certificates as Android shows them (Signature.hashCode in dumpsys package): who built the app.
// All Termux apps must come from the same source, and switching source means reinstalling Termux, which
// deletes everything in Termux (its home, packages and the miner).
const TERMUX_SIGNERS = { '7c3fcce': 'fdroid', 'db86cf3c': 'github' };

// third round trip: the benchmark job runner
const CHECK_SCRIPT3 = String.raw`
H=/data/data/com.termux/files/home; [ -f $H/.verus-runner.conf ] && echo "runner_conf=$(sed -n 's/^PHONE=//p' $H/.verus-runner.conf)"; [ -f $H/phone-runner.sh ] && echo "runner_ver=$(sed -n 's/^RUNNER_VERSION=//p' $H/phone-runner.sh)"
RP=$(cat $H/.verus-runner.pid 2>/dev/null); [ -n "$RP" ] && kill -0 $RP 2>/dev/null && echo runner_run=1; [ -f $H/.ssh/verus_jobs_key.pub ] && echo "runner_key=$(cut -d' ' -f2 $H/.ssh/verus_jobs_key.pub | cut -c1-16)"; [ -d $H/verus-phone-jobs/.git ] && echo runner_repo=1
echo "farm3_done=1"
`;

// ---- status LED / find me ------------------------------------------------------
function hexColor(v, d) { v = String(v || '').replace(/^#|^0x/i, ''); return /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : d; }
// what the phone's LED loop reads (~/.verusproxy/led.conf); FINDME_UNTIL and TARGET_KHS change without
// counting as drift
function ledConf(profile, targetKhs, findUntil) {
    let lines = [
        'LED=' + (profile.statusLed === false ? 0 : 1),
        'OK_PCT=' + (Number(profile.ledOkPct) || 90),
        'SLOW_PCT=' + (Number(profile.ledSlowPct) || 70),
        'COLOR_OK=' + hexColor(profile.ledColorOk, '0000FF'),
        'COLOR_BAD=' + hexColor(profile.ledColorBad, 'FF3000'),
        'COLOR_FIND=' + (String(profile.ledColorFind).toLowerCase() === 'cycle' ? 'CYCLE' : hexColor(profile.ledColorFind, 'FF00FF')),
        'FIND_TORCH=' + (profile.findTorch === false ? 0 : 1),
        'FIND_VIBRATE=' + (profile.findVibrate === false ? 0 : 1),
        'FIND_SOUND=' + (profile.findSound === true ? 1 : 0)
    ];
    let hash = require('crypto').createHash('md5').update(lines.join('\n') + '\n').digest('hex').slice(0, 8);
    let text = lines.slice(0, 1).concat(['TARGET_KHS=' + Math.round(targetKhs || 0)], lines.slice(1), ['FINDME_UNTIL=' + Math.floor((findUntil || 0) / 1000)]).join('\n') + '\n';
    return { text, hash };
}

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
function evaluate(kv, profile, stamp, w, opts) {
    // (opts.runnerName: the phone's name in verus-phone-jobs, its short worker name)
    opts = opts || {};
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

    if (profile.minerEnv && profile.minerEnv !== 'none' && n) {
        // Termux's user is u0_a<uid-10000>; anything else running ccminer is another app (UserLAnd)
        let tu = Number(kv.termux_uid) >= 10000 ? 'u0_a' + (Number(kv.termux_uid) - 10000) : null;
        let users = String(kv.miner_users || '').trim().split(/\s+/).filter(Boolean);
        let where = tu ? Array.from(new Set(users.map(u => (u === tu ? 'termux' : 'userland')))) : [];
        add('minerEnv', 'Miner runs in', where.length ? where.length === 1 && where[0] === profile.minerEnv : null, profile.minerEnv, where.length ? where.join(' + ') : 'unknown');
    }

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

    // backups for the boot script's watchdog and the old Kluster setup (Termux miners only)
    let termuxMiner = profile.minerEnv === 'termux';
    if (profile.cronWatchdog && termuxMiner) {
        let crond = Number(kv.crond) > 0;
        if (kv.cron_wd === undefined) add('cronWatchdog', 'Watchdog backup in crontab', root ? false : null, 'every 5 min, crond running', root ? 'no crontab yet' + (crond ? '' : ', crond not running') : needRoot);
        else add('cronWatchdog', 'Watchdog backup in crontab', Number(kv.cron_wd) > 0 && crond, 'every 5 min, crond running', (Number(kv.cron_wd) > 0 ? 'in crontab' : 'missing') + (crond ? '' : ', crond not running'));
    }
    if (profile.keepForeground && termuxMiner && kv.farm2_done === '1') {
        // Termux in front with the screen on and unlocked: Android then gives it the big cores at full speed
        let front = /^com\.termux\//.test(kv.focus || '');
        let on = kv.screen ? kv.screen === 'ON_UNLOCKED' : kv.wake === 'Awake';
        add('foreground', 'Termux in front, screen on and unlocked', front && on, 'Termux in front, ON_UNLOCKED',
            (kv.screen || (kv.wake ? 'screen ' + kv.wake : 'screen ?')) + ', in front: ' + (front ? 'Termux' : 'another window'));
    }
    if (profile.klusterOff && termuxMiner) {
        let files = String(kv.boot_files || '').split(/\s+/);
        let lines = kv.cron_kl === undefined ? null : Number(kv.cron_kl) + (profile.keepForeground ? Number(kv.cron_ka || 0) : 0);
        let bootKl = files.includes('start-kluster.sh');
        let have = [lines ? lines + ' Kluster/keep-alive cron line' + (lines > 1 ? 's' : '') + ' active' : null, bootKl ? 'start-kluster.sh in boot' : null].filter(Boolean).join(', ');
        add('kluster', 'Old Kluster / keep-alive setup off', lines === null && !bootKl ? null : !lines && !bootKl, 'no Kluster cron lines or boot script', have || (lines === null ? needRoot || 'crontab unreadable' : 'off'));
    }
    if (profile.statusLed !== false && termuxMiner && kv.farm2_done === '1' && opts.led) {
        let want = opts.led.hash, tgt = Number(kv.led_target) || 0, wantT = opts.led.target || 0;
        let tOk = !wantT || (tgt > 0 && Math.abs(tgt - wantT) / wantT < 0.1);
        let st = String(kv.led_state || '').split(' ')[0] || null;
        let ok = root ? kv.led_hash === want && tOk && kv.led_run === '1' : null;
        add('statusLed', 'Status LED', ok, 'running, settings up to date', !kv.led_hash ? 'not set up' : kv.led_hash !== want ? 'old settings' : !tOk ? 'target ' + tgt + ' kH/s, want ~' + Math.round(wantT) : kv.led_run !== '1' ? (root ? 'loop not running' : needRoot) : 'showing ' + (st || '?'));
    }
    if (profile.termuxSource && kv.farm2_done === '1') {
        let src = {};
        for (let [p, label] of [['com.termux', 'Termux'], ['com.termux.boot', 'Termux:Boot'], ['com.termux.api', 'Termux:API']]) {
            let s = kv['sig_' + p];
            if (s) src[label] = TERMUX_SIGNERS[s] || 'other (' + s + ')';
        }
        let vals = Object.values(src);
        let all = vals.length && vals.every(v => v === profile.termuxSource);
        add('termuxSource', 'Termux apps from ' + profile.termuxSource, vals.length ? !!all : null, 'all ' + profile.termuxSource,
            vals.length ? (new Set(vals).size === 1 ? 'all ' + vals[0] : 'mixed: ' + Object.entries(src).map(([k, v]) => k + ' ' + v).join(', ')) : 'not installed');
    }
    if (profile.runner !== false && termuxMiner && kv.farm3_done === '1' && opts.runnerName) {
        let ok = kv.runner_conf === opts.runnerName && !!kv.runner_ver && kv.runner_repo === '1' && kv.runner_run === '1';
        add('runner', 'Benchmark job runner', root ? ok : null, 'running as ' + opts.runnerName,
            !kv.runner_ver ? 'not installed' : kv.runner_conf !== opts.runnerName ? 'set up as ' + (kv.runner_conf || 'nothing') : kv.runner_repo !== '1' ? 'waiting for its deploy key on GitHub' : kv.runner_run !== '1' ? 'not running' : 'running (v' + kv.runner_ver + ')');
    }
    if (profile.userlandOff && termuxMiner) add('userland', 'UserLAnd app stopped', kv.ula === '0', 'not running', kv.ula === '1' ? 'running' : 'stopped');

    let bad = items.filter(i => i.ok === false);
    let notSetUp = !termux || !boot || items.some(i => i.key === 'bootScript' && i.ok === false);
    let status = notSetUp ? 'not set up' : bad.length ? 'drifted' : 'in sync';
    return { status, root, items, drift: bad.map(i => i.key), unknown: items.filter(i => i.ok === null).map(i => i.key),
        runnerKey: kv.runner_key || null,
        hw: String(kv.hw || '').trim().split(/\s+/).filter(Boolean), led: kv.led_state ? { state: kv.led_state.split(' ')[0], khs: Number(kv.led_state.split(' ')[1]) || 0, ts: Number(kv.led_state.split(' ')[2]) * 1000 || null } : null,
        termuxUid: Number(kv.termux_uid) || null, bootFiles: String(kv.boot_files || '').trim().split(/\s+/).filter(Boolean), miners: n };
}

// one device: run the script over ADB (as root when the phone gives the ADB shell root)
async function checkDevice(adb, w, prof, led, runnerName) {
    let serial = adb.serial(w.ip);
    let script = 'NAME=' + cleanScriptName(prof.profile.bootScript) + '\n' + CHECK_SCRIPT;
    // try root whenever the phone has su: a grant given since the last device-info read counts at once
    let wantRoot = !(w.inv && w.inv.root && w.inv.root.su === false);
    let r = await adb.shell(serial, script, { root: wantRoot, timeoutMs: 45000 });
    let kv = parseKv(r.out);
    if (kv.farm_done !== '1' && wantRoot) { wantRoot = false; r = await adb.shell(serial, script, { root: false, timeoutMs: 45000 }); kv = parseKv(r.out); }
    if (kv.farm_done === '1') {
        let r2 = await adb.shell(serial, CHECK_SCRIPT2, { root: wantRoot, timeoutMs: 30000 });
        Object.assign(kv, parseKv(r2.out));
        let r3 = await adb.shell(serial, CHECK_SCRIPT3, { root: wantRoot, timeoutMs: 20000 });
        Object.assign(kv, parseKv(r3.out));
    }
    let base = { ts: Date.now(), stamp: prof.stamp, profileFrom: prof.from };
    if (kv.farm_done !== '1') return Object.assign(base, { status: 'error', error: r.error || (r.timedOut ? 'timed out' : (r.err || r.out || 'no answer').trim().slice(0, 200)), items: [] });
    return Object.assign(base, evaluate(kv, prof.profile, prof.stamp, w, { led, runnerName }), { error: null });
}

// ---- fixing drift ------------------------------------------------------------
// Only items the last check found drifted get a step. Each step runs over:
//   adb      ADB shell (no root needed)
//   root     ADB shell through su when the ADB shell has root, else Termux's su over SSH
//   ssh      SSH as the Termux user (files in Termux's home keep the right owner and SELinux label)
// Things that need a person or another feature are listed as manual, never attempted.
function planFixes(farm, profile, stamp, opts) {
    opts = opts || {};
    let steps = [], manual = [];
    let rootVia = farm.root ? 'adb-root' : 'ssh-su';
    let bad = new Set((farm.items || []).filter(i => i.ok === false).map(i => i.key));
    let name = boot.generate ? String(profile.bootScript || 'verusproxy-setup').replace(/[^A-Za-z0-9._-]/g, '') || 'verusproxy-setup' : '';
    let step = (key, via, what, cmd) => steps.push({ key, via, what, cmd });

    if (bad.has('termux')) manual.push({ key: 'termux', what: 'Install Termux (' + (profile.termuxApk || 'github') + ')' });
    if (bad.has('termuxVersion')) manual.push({ key: 'termuxVersion', what: 'Install Termux ' + profile.termuxVersion + ' (' + (profile.termuxApk || 'github') + ')' });
    if (bad.has('termuxBoot')) manual.push({ key: 'termuxBoot', what: 'Install Termux:Boot (' + (profile.bootApk || 'github') + ') and open it once' });
    let termuxOk = !bad.has('termux');

    // a boot script for the wrong miner environment would start a second miner (or none): fix the profile first
    if (termuxOk && bad.has('minerEnv') && (bad.has('bootScript') || bad.has('bootStamp'))) {
        manual.push({ key: 'bootScript', what: 'Not writing the boot script: the miner runs in ' + ((farm.items.find(i => i.key === 'minerEnv') || {}).have || '?') + ' but the profile says ' + profile.minerEnv + '. Set "minerEnv" for this group or device first.' });
    } else if (termuxOk && (bad.has('bootScript') || bad.has('bootStamp'))) {
        let text = boot.generate(profile, stamp, { minerPath: opts.minerPath, proxyUrl: opts.proxyUrl });
        let b64 = Buffer.from(text).toString('base64');
        step('bootScript', 'ssh', 'Write ~/.termux/boot/' + name + ' (profile ' + stamp + ', ' + text.length + ' bytes)',
            'mkdir -p ~/.termux/boot && echo ' + b64 + ' | base64 -d > ~/.termux/boot/.' + name + '.tmp && chmod 700 ~/.termux/boot/.' + name + '.tmp && mv -f ~/.termux/boot/.' + name + '.tmp ~/.termux/boot/' + name + ' && echo written');
        // a copy already running from an older script: replace its watchdog (no boot steps, ADB stays up)
        if (bad.has('bootStamp')) step('bootScript', 'ssh', 'Restart the running watchdog with the new script',
            'P=' + q('termux/boot/' + name + ' (run|loop-run)') + '; pkill -f "$P"; i=0; while pgrep -f "$P" >/dev/null && [ $i -lt 70 ]; do sleep 1; i=$((i+1)); done; pkill -9 -f "$P"; rm -rf ~/.verusproxy/boot.lock; ' +
            // the LED loop runs as root: only root can stop it; the new watchdog starts the new one
            // (the [x] keeps the pattern from matching this command line itself)
            'su -c ' + q('pkill -f "termux/boot/' + name.slice(0, -1) + '[' + name.slice(-1) + '] led-run"') + ' >/dev/null 2>&1; sh ~/.termux/boot/' + name + ' loop && echo restarted');
        if (bad.has('bootStamp')) steps[steps.length - 1].timeoutMs = 100000;   // an old copy may take up to a minute to stop
        let retire = (Array.isArray(profile.retireBootScripts) ? profile.retireBootScripts : []).map(f => String(f).replace(/[^A-Za-z0-9._-]/g, '')).filter(f => f && f !== name && (farm.bootFiles || []).includes(f));
        if (retire.length) step('bootScript', 'ssh', 'Move replaced boot scripts to ~/.verusproxy/retired-boot: ' + retire.join(', '),
            'mkdir -p ~/.verusproxy/retired-boot && for f in ' + retire.map(q).join(' ') + '; do [ -f ~/.termux/boot/"$f" ] && mv -f ~/.termux/boot/"$f" ~/.verusproxy/retired-boot/"$f" && echo "retired $f"; done; true');
    }
    // crontab: back it up, comment out Kluster lines, add the watchdog backup (after the boot script exists)
    let klusterCron = bad.has('kluster') && (farm.items.find(i => i.key === 'kluster') || {}).have && /cron line/.test(farm.items.find(i => i.key === 'kluster').have);
    if (termuxOk && (bad.has('cronWatchdog') || klusterCron)) {
        let T = '/data/data/com.termux/files';
        let line = '*/5 * * * * PREFIX=' + T + '/usr PATH=' + T + '/usr/bin:/system/bin HOME=' + T + '/home ' + T + '/usr/bin/sh ' + T + '/home/.termux/boot/' + name + ' loop >/dev/null 2>&1';
        let parts = [klusterCron ? 'comment out Kluster lines' : null, bad.has('cronWatchdog') ? 'add the watchdog backup (every 5 min)' : null].filter(Boolean).join(', ');
        step(bad.has('cronWatchdog') ? 'cronWatchdog' : 'kluster', 'ssh', 'Crontab: ' + parts + ' (backup in ~/.verusproxy)',
            'mkdir -p ~/.verusproxy && B=~/.verusproxy/crontab.before-farm-$(date +%Y%m%d-%H%M%S) && { crontab -l > "$B" 2>/dev/null || : > "$B"; } && { ' +
            (klusterCron ? "sed -e 's|^\\([^#].*kluster/.*\\)$|# disabled by verusProxy (Kluster replaced by the farm profile): \\1|'" +
                (profile.keepForeground ? " -e 's|^\\([^#].*keep-alive\\.sh.*\\)$|# disabled by verusProxy (the watchdog keeps Termux in front): \\1|'" : '') + " \"$B\"" : 'cat "$B"') +
            (bad.has('cronWatchdog') ? '; grep -q "verusproxy-setup loop" "$B" || echo ' + q(line) : '') + '; } | crontab - && echo "crontab updated, backup $B"' +
            (bad.has('cronWatchdog') ? ' && { pgrep -x crond >/dev/null || pgrep -f "crond " >/dev/null || { command -v sv >/dev/null && sv up crond; } || crond; } ; true' : ''));
    }
    if (bad.has('kluster') && !bad.has('bootScript') && !bad.has('bootStamp') && (farm.bootFiles || []).includes('start-kluster.sh'))
        step('kluster', 'ssh', 'Move start-kluster.sh to ~/.verusproxy/retired-boot', 'mkdir -p ~/.verusproxy/retired-boot && mv -f ~/.termux/boot/start-kluster.sh ~/.verusproxy/retired-boot/start-kluster.sh && echo retired');
    if (bad.has('foreground')) step('foreground', 'adb', 'Wake and unlock the screen, bring Termux to the front',
        'settings put system screen_off_timeout ' + Math.max(1, Number(profile.screenTimeoutMin) || 60) * 60000 + '; S=$(dumpsys nfc | sed -n "s/.*mScreenState=//p" | head -n 1); ' +
        'case "$S" in OFF_*) input keyevent 224; sleep 1;; esac; S=$(dumpsys nfc | sed -n "s/.*mScreenState=//p" | head -n 1); ' +
        '[ "$S" = ON_LOCKED ] && { wm dismiss-keyguard 2>/dev/null || input keyevent 82; sleep 1; }; am start -n com.termux/com.termux.HomeActivity >/dev/null && echo "front ($S)"');
    if (bad.has('statusLed') && opts.ledConf) {
        step('statusLed', 'ssh', 'Write the status LED settings (target ' + Math.round(opts.ledTarget || 0) + ' kH/s) and start the LED loop',
            'mkdir -p ~/.verusproxy && echo ' + Buffer.from(opts.ledConf).toString('base64') + ' | base64 -d > ~/.verusproxy/led.conf && echo written');
        step('statusLed', 'ssh-su', 'Start the LED loop (root)', 'nohup sh /data/data/com.termux/files/home/.termux/boot/' + name + ' led-run >/dev/null 2>&1 < /dev/null & echo started');
    }
    if (bad.has('runner') && opts.runnerScript && opts.runnerName) {
        let nm = opts.runnerName.replace(/[^a-z0-9-]/g, '');
        step('runner', 'ssh', 'Benchmark runner: install phone-runner.sh, set it up as ' + nm + ', make its deploy key, start it when GitHub accepts the key',
            'echo ' + Buffer.from(opts.runnerScript).toString('base64') + ' | base64 -d > ~/phone-runner.sh.new && bash -n ~/phone-runner.sh.new && mv -f ~/phone-runner.sh.new ~/phone-runner.sh && chmod +x ~/phone-runner.sh' +
            " && printf 'PHONE=%s\\nDEVICE=%s\\n' " + nm + ' ' + nm + ' > ~/.verus-runner.conf' +
            ' && mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -f ~/.ssh/verus_jobs_key ] || ssh-keygen -q -t ed25519 -N "" -C verus-jobs-' + nm + ' -f ~/.ssh/verus_jobs_key; }' +
            ' && export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/verus_jobs_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"' +
            ' && if timeout 40 git ls-remote ' + (opts.runnerRepo || 'git@github.com:zzpajk/verus-phone-jobs.git') + ' >/dev/null 2>&1; then { [ -d ~/verus-phone-jobs/.git ] || { rm -rf ~/verus-phone-jobs; git clone -q ' + (opts.runnerRepo || 'git@github.com:zzpajk/verus-phone-jobs.git') + ' ~/verus-phone-jobs; }; }; bash ~/phone-runner.sh stop >/dev/null 2>&1; bash ~/phone-runner.sh start; else echo "deploy key not on GitHub yet: $(cat ~/.ssh/verus_jobs_key.pub)"; fi; true');
        steps[steps.length - 1].timeoutMs = 120000;
    }
    if (bad.has('userland')) step('userland', 'adb', 'Stop the UserLAnd app (no longer mining there)', 'am force-stop tech.ula');
    if (bad.has('batteryOptimisation')) step('batteryOptimisation', 'adb', 'Turn battery optimisation off for Termux', 'dumpsys deviceidle whitelist +com.termux');
    if (bad.has('magiskGrant')) {
        let tu = farm.termuxUid ? String(farm.termuxUid) : (rootVia === 'ssh-su' ? '$(id -u)' : null);
        let sql = (uid) => 'magisk --sqlite "REPLACE INTO policies (uid,policy,until,logging,notification) VALUES(' + uid + ',2,0,1,1)"';
        if (rootVia === 'ssh-su') step('magiskGrant', 'ssh', 'Allow root forever for Shell (ADB) and Termux in Magisk (through Termux\'s su)', 'su -c ' + q(sql(2000)) + ' && su -c ' + q(sql('UID')).replace('UID', "'\"$(id -u)\"'") + ' && echo granted');
        else if (tu) step('magiskGrant', rootVia, 'Allow root forever for Termux (uid ' + tu + ') and Shell in Magisk', sql(tu) + '; ' + sql(2000));
        else manual.push({ key: 'magiskGrant', what: 'Grant root to Termux and Shell in the Magisk app' });
    }
    if (bad.has('cpuset') && /^[0-9,-]+$/.test(String(profile.cpuset))) step('cpuset', rootVia, 'Set the foreground cpuset to ' + profile.cpuset, 'echo ' + profile.cpuset + ' > /dev/cpuset/foreground/cpus');
    if (bad.has('batterySpoof')) step('batterySpoof', 'adb', profile.batterySpoof ? 'Spoof the battery (unplugged, not charging, 100%)' : 'Back to the real battery',
        profile.batterySpoof ? 'dumpsys battery unplug; dumpsys battery set status 4; dumpsys battery set level 100' : 'dumpsys battery reset');
    if (bad.has('ccminer')) {
        if (farm.miners === 0 && profile.minerEnv === 'termux') {
            let bin = String(opts.minerPath || '~/ccminer/ccminer-verus');
            step('ccminer', 'ssh', 'Start ccminer in screen "ccminer"', '[ -x ' + bin + ' ] || { echo "no miner at ' + bin + '"; exit 1; }; screen -wipe >/dev/null 2>&1; screen -dmS ccminer sh -c ' + q('exec ' + bin + ' ' + (profile.minerArgs || '')) + ' && echo started');
        } else manual.push({ key: 'ccminer', what: farm.miners > 1 ? 'ccminer runs ' + farm.miners + ' times: stop the extra one' : 'Start the miner (' + profile.minerEnv + ')' });
    }
    if (bad.has('termuxSource')) manual.push({ key: 'termuxSource', what: 'Termux apps are ' + ((farm.items.find(i => i.key === 'termuxSource') || {}).have || '?') + ', want ' + profile.termuxSource + '. Not done automatically: switching means uninstalling and reinstalling Termux, which deletes everything in Termux. Use "Set up phone" once its real run is switched on.' });
    if (bad.has('minerEnv')) manual.push({ key: 'minerEnv', what: 'Miner runs in the wrong environment: move it, or set minerEnv for this group/device' });
    if (bad.has('minerBuild')) manual.push({ key: 'minerBuild', what: 'Install miner build ' + profile.minerBuild + ' (Miner updates -> Build)' });
    // last: restarting adbd drops the ADB connection, so it goes through SSH, detached
    if (bad.has('adbWifiPort') && Number(profile.adbWifiPort) > 0) step('adbWifiPort', 'ssh-su', 'Listen for ADB over WiFi on ' + Number(profile.adbWifiPort) + ' (restarts adbd)',
        'setprop service.adb.tcp.port ' + Number(profile.adbWifiPort) + '; (sleep 3; stop adbd; start adbd) >/dev/null 2>&1 &');
    return { steps, manual };
}

class Farm {
    constructor(config, stats, registry, groups, ssh, miner) {
        this.config = config;
        this.miner = miner || null;
        this.ssh = ssh || null;
        this.stats = stats;
        this.registry = registry;
        this.groups = groups;
        this.everyMin = Math.max(Number((config.farm || {}).checkEveryMin) || 60, 5);
        this.busy = new Set();
        setTimeout(() => this.cycle(), 90 * 1000).unref();      // after the registry has connected ADB
        setInterval(() => this.cycle(), MINUTE).unref();
    }

    // farm settings are re-read when config.local.json changes, so a profile edit needs no restart
    farmConfig() {
        try {
            let m = require('fs').statSync(require('./config.js').LOCAL).mtimeMs;
            if (m !== this.localMtime) { this.config.farm = require('./config.js').load().farm; this.localMtime = m; }
        } catch (e) { console.log('farm: could not re-read the farm settings: ' + e.message); }
        return this.config;
    }

    profileFor(name) { return farmProfile(this.farmConfig(), this.groups ? this.groups.of(name) : null, name); }

    // expected hashrate in kH/s: farm expectedMHs, else the device's own 24 h median (refreshed hourly)
    ledTarget(name, profile) {
        if (Number(profile.expectedMHs) > 0) return Number(profile.expectedMHs) * 1000;
        let t = Date.now();
        if (!this.medians || t - this.medians.ts > 60 * MINUTE) {
            let m = {};
            try {
                let h = this.stats.history(24 * 3600, 'rep');
                for (let [n, vals] of Object.entries(h.workers || {})) {
                    let a = vals.filter(v => v > 0).sort((x, y) => x - y);
                    if (a.length >= 30) m[n] = a[Math.floor(a.length / 2)] / 1000;
                }
            } catch (e) {}
            this.medians = { ts: t, m };
        }
        return this.medians.m[name] || 0;
    }
    ledFor(name, prof) {
        let w = this.stats.workers.get(name) || {};
        let target = this.ledTarget(name, prof.profile);
        let c = ledConf(prof.profile, target, w.findUntil && w.findUntil > Date.now() ? w.findUntil : 0);
        return { hash: c.hash, text: c.text, target };
    }

    // the phone's name in verus-phone-jobs: its short worker name (or its device name)
    runnerName(name) {
        let w = this.stats.workers.get(name);
        if (!w) return null;
        let others = Array.from(this.stats.workers.values()).map(o => ({ name: o.name, serial: o.inv && o.inv.serial }));
        let wn = require('./farm_setup.js').workerName(this.profileFor(name).profile.workerName, w.inv, others);
        return String(wn || name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
    }

    // a renamed device keeps its farm settings: rename its key in config.local.json farm.devices
    renameDevice(from, to) {
        let file = require('./config.js').LOCAL;
        try {
            let text = require('fs').readFileSync(file, 'utf8');
            let key = JSON.stringify(from) + ':';
            if (text.split(key).length === 2) { require('fs').writeFileSync(file, text.replace(key, JSON.stringify(to) + ':')); console.log(`farm: settings of ${from} now under ${to}`); }
        } catch (e) { console.log('farm: could not rename ' + from + ' in config.local.json: ' + e.message); }
    }

    // "Set up phone": the full plan for a fresh phone, with what this phone already has (plan only for now)
    setupPlan(name) {
        let w = this.stats.workers.get(name);
        if (!w) return { ok: false, error: 'unknown device' };
        let prof = this.profileFor(name);
        let host = (this.proxyUrl().match(/^https?:\/\/([^:/]+)/) || [])[1] || null;
        let apkDir = require('path').resolve(__dirname, '..', (this.config.dashboard || {}).dataDir || 'data', 'apks');
        let others = Array.from(this.stats.workers.values()).map(o => ({ name: o.name, serial: o.inv && o.inv.serial }));
        let wn = require('./farm_setup.js').workerName(prof.profile.workerName, w.inv, others);
        let plan = require('./farm_setup.js').setupPlan({ w, profile: prof.profile, config: this.farmConfig(), library: this.miner ? this.miner.library : [], apkDir, poolHost: host, workerName: wn });
        plan.workerName = wn;
        return Object.assign({ ok: true, dryRun: true, name, stamp: prof.stamp }, plan);
    }

    // find me on or off for some devices: writes led.conf right away over SSH
    async findMe(names, on, minutes, by) {
        if (!this.ssh || this.ssh.disabledReason('ssh')) return { ok: false, error: 'Find me needs SSH: ' + (this.ssh ? this.ssh.disabledReason('ssh') : 'off') };
        let mins = Math.min(Math.max(Number(minutes) || Number((this.farmConfig().farm.defaults || {}).findMeMin) || 10, 1), 120);
        let results = [];
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
            while (i < names.length) {
                let name = names[i++], w = this.stats.workers.get(name);
                if (!w || !w.ip || !isLan(w.ip)) { results.push({ name, ok: false, error: 'no local address' }); continue; }
                let prof = this.profileFor(name);
                w.findUntil = on ? Date.now() + (Number(minutes) || Number(prof.profile.findMeMin) || mins) * MINUTE : 0;
                let c = this.ledFor(name, prof);
                let r = await this.ssh.sshRaw(name, w.ip, (this.config.ssh || {}).port || 8022, 'mkdir -p ~/.verusproxy && echo ' + Buffer.from(c.text).toString('base64') + ' | base64 -d > ~/.verusproxy/led.conf && echo ok', { timeoutMs: 20000 });
                let ok = /ok/.test(r.out || '');
                let loop = w.farm && (w.farm.items || []).find(x => x.key === 'statusLed');
                results.push({ name, ok, until: w.findUntil || null, error: ok ? (loop && loop.ok === false ? 'settings written, but the LED loop is not running yet (Apply profile)' : null) : (r.error || r.err || 'no answer').toString().trim().slice(0, 200) });
            }
        }));
        console.log(`farm: find me ${on ? 'ON' : 'off'} for ${names.length} device(s) by ${by || '?'}`);
        return { ok: results.some(r => r.ok), results };
    }

    async checkOne(name) {
        let w = this.stats.workers.get(name);
        if (!w || !w.ip || !isLan(w.ip)) return { ok: false, error: 'no local address known for this device' };
        // the hourly check may be reading this phone right now: wait for it (up to 90 s)
        for (let i = 0; this.busy.has(name) && i < 90; i++) await new Promise(r => setTimeout(r, 1000));
        if (this.busy.has(name)) return { ok: false, error: 'busy' };
        this.busy.add(name);
        try {
            let prof = this.profileFor(name);
            w.farm = await checkDevice(this.registry.adb, w, prof, this.ledFor(name, prof), this.runnerName(name));
            return { ok: w.farm.status !== 'error', farm: w.farm };
        } finally { this.busy.delete(name); }
    }

    proxyUrl() {
        let f = this.config.farm || {}, d = this.config.dashboard || {};
        if (f.proxyUrl) return String(f.proxyUrl);
        for (let addrs of Object.values(require('os').networkInterfaces())) for (let a of addrs || []) {
            if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isLan(a.address)) return 'http://' + a.address + ':' + (d.port || 8080);
        }
        return '';
    }

    // fix the drifted items of one device (dryRun: only say what would run). Re-checks first and after.
    async apply(name, dryRun, by) {
        let w = this.stats.workers.get(name);
        if (!w || !w.ip || !isLan(w.ip)) return { ok: false, error: 'no local address known for this device' };
        let c = await this.checkOne(name);
        if (!c.ok) return { ok: false, error: 'Setup check failed: ' + ((w.farm && w.farm.error) || c.error) };
        let prof = this.profileFor(name);
        let led = this.ledFor(name, prof);
        let runnerScript = null;
        try { runnerScript = require('fs').readFileSync(require('path').resolve(__dirname, '..', (this.config.dashboard || {}).dataDir || 'data', 'runner', 'phone-runner.sh'), 'utf8'); } catch (e) {}
        let plan = planFixes(w.farm, prof.profile, prof.stamp, { minerPath: (this.config.miner || {}).path, proxyUrl: this.proxyUrl(), ledConf: led.text, ledTarget: led.target,
            runnerName: this.runnerName(name), runnerScript, runnerRepo: prof.profile.runnerRepo });
        let out = { ok: true, dryRun: !!dryRun, status: w.farm.status, stamp: prof.stamp, steps: plan.steps, manual: plan.manual };
        if (dryRun || !plan.steps.length) return out;
        if (plan.steps.some(s => s.via === 'ssh' || s.via === 'ssh-su') && (!this.ssh || this.ssh.disabledReason('ssh'))) return { ok: false, error: 'Needs SSH: ' + (this.ssh ? this.ssh.disabledReason('ssh') : 'off') };
        this.busy.add(name);
        try {
            for (let s of plan.steps) {
                let r;
                if (s.via === 'adb' || s.via === 'adb-root') r = await this.registry.adb.shell(this.registry.adb.serial(w.ip), s.cmd, { root: s.via === 'adb-root', timeoutMs: 30000 });
                else r = await this.ssh.sshRaw(name, w.ip, (this.config.ssh || {}).port || 8022, s.via === 'ssh-su' ? 'su -c ' + q(s.cmd) : s.cmd, { timeoutMs: s.timeoutMs || 40000 });
                s.result = { code: r.code, out: String(r.out || '').trim().slice(0, 500), err: String(r.err || r.error || '').trim().slice(0, 500) || null, timedOut: !!r.timedOut };
                s.ok = r.code === 0 && !r.timedOut;
                console.log(`farm: apply ${name} by ${by || '?'}: ${s.what}: ${s.ok ? 'ok' : 'FAILED ' + (s.result.err || s.result.code)}`);
            }
        } finally { this.busy.delete(name); }
        if (plan.steps.some(s => s.key === 'adbWifiPort')) await new Promise(r => setTimeout(r, 8000));
        await this.checkOne(name);
        this.stats.save();
        return Object.assign(out, { ok: plan.steps.every(s => s.ok), after: w.farm });
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

module.exports = { Farm, checkDevice, evaluate, planFixes, parsePolicies, ledConf, CHECK_SCRIPT, CHECK_SCRIPT2, CHECK_SCRIPT3 };
