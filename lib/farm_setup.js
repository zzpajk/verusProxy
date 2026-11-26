// "Set up phone": everything a fresh rooted phone needs to end up on the farm profile, in order.
// For now this only plans: each step says how it would run and whether the phone already has it
// (from the device info read over ADB, the connection state, the miner check and the setup check).
// Steps that need a person (the first Magisk grant, apps not on the proxy yet) are marked manual.

const fs = require('fs');
const path = require('path');

const T = '/data/data/com.termux/files';
// F-Droid APKs kept on the proxy in data/apks, named as in the F-Droid repo (com.termux_1022.apk);
// the newest version code wins
const APPS = [
    { pkg: 'com.termux', name: 'Termux', key: 'termuxApk', inv: 'termux' },
    { pkg: 'com.termux.boot', name: 'Termux:Boot', key: 'bootApk', inv: 'termuxBoot' },
    { pkg: 'com.termux.api', name: 'Termux:API', key: 'apiApk', inv: 'termuxApi' }
];
function apkFor(files, pkg) {
    let re = new RegExp('^' + pkg.replace(/\./g, '\\.') + '_(\\d+)\\.apk$');
    return files.filter(f => re.test(f)).sort((a, b) => Number(re.exec(b)[1]) - Number(re.exec(a)[1]))[0] || null;
}
const PACKAGES = 'openssh termux-services termux-api screen procps cronie';

function setupPlan(ctx) {
    let { w, profile, config } = ctx;
    let inv = w.inv || {}, farm = w.farm || {}, conn = w.conn || {}, mb = w.minerBin || {};
    let items = farm.items || [];
    let ok = (key) => { let i = items.find(x => x.key === key); return i ? i.ok === true : null; };
    let steps = [];
    let add = (key, what, via, cmd, done, note) => steps.push({ key, what, via, cmd: cmd || null, done: !!done, note: note || null });
    let sshPort = (config.ssh || {}).port || 8022;
    let apkDir = ctx.apkDir;
    let apks = (() => { try { return fs.readdirSync(apkDir); } catch (e) { return []; } })();

    let adbState = conn.adb && typeof conn.adb === 'object' ? conn.adb.state : conn.adb;
    add('adb', 'ADB over WiFi connected', 'adb', null, adbState === 'device',
        adbState === 'device' ? null : 'Plug the phone in by USB and use "Enable WiFi ADB" under Find phones, or enable wireless debugging on the phone.');
    let rootOk = !!(inv.root && inv.root.adbGranted);
    add('rootShell', 'Magisk allows root for Shell (ADB)', 'adb', 'su -c id', rootOk,
        rootOk ? null : inv.root && inv.root.su ? 'Run once and tap "Grant" (forever) in the Magisk prompt on the phone.' : 'The phone is not rooted with Magisk.');

    for (let a of APPS) {
        if (a.pkg === 'com.termux.api' && profile.findSound !== true && profile.statusLed === false) continue;
        let have = !!inv[a.inv];
        let file = apkFor(apks, a.pkg);
        add('app:' + a.pkg, 'Install ' + a.name, 'host', file ? 'adb -s <phone> install -r ' + path.join(apkDir, file) : null, have,
            have ? inv[a.inv] : file ? null : 'No ' + a.name + ' APK on the proxy: put it in ' + apkDir + ' (source: ' + (profile[a.key] || 'github') + '; Termux and its add-ons must all come from the same source).');
    }
    let termuxUp = !!inv.termux && (farm.termuxUid || ok('termux'));
    add('termuxFirst', 'Open Termux once (installs its base system)', 'adb', 'am start -n com.termux/.HomeActivity; until [ -x ' + T + '/usr/bin/sh ]; do sleep 2; done', termuxUp && farm.status && farm.status !== 'error');
    add('bootFirst', 'Open Termux:Boot once (Android only runs its boot scripts after that)', 'adb', 'am start -n com.termux.boot/.BootActivity', ok('bootScript') === true || (farm.bootFiles || []).length > 0);
    add('grantTermux', 'Magisk allows root forever for Termux', 'adb-root',
        'magisk --sqlite "REPLACE INTO policies (uid,policy,until,logging,notification) VALUES($(stat -c %u /data/data/com.termux),2,0,1,1)"', ok('magiskGrant') === true);
    add('battery', 'Battery optimisation off for Termux, Termux:Boot, Termux:API', 'adb',
        'for p in com.termux com.termux.boot com.termux.api; do dumpsys deviceidle whitelist +$p; done', ok('batteryOptimisation') === true);
    let sshUp = !!(conn.ports && conn.ports[sshPort]);
    add('packages', 'Termux packages: ' + PACKAGES, 'adb-root',
        'su $(stat -c %u /data/data/com.termux) -c "PATH=' + T + '/usr/bin:$PATH HOME=' + T + '/home pkg install -y ' + PACKAGES + '"', sshUp && ok('cronWatchdog') !== false && (farm.hw || []).includes('termux-api'));
    add('sshLogin', 'SSH login for the proxy (' + ((config.ssh || {}).password ? 'password from ssh.password' : 'key') + ')', 'adb-root',
        (config.ssh || {}).password ? 'su $(stat -c %u /data/data/com.termux) -c "printf \'%s\\n%s\\n\' <ssh.password> <ssh.password> | ' + T + '/usr/bin/passwd"' : 'append the proxy\'s public key to ' + T + '/home/.ssh/authorized_keys',
        sshUp && !!mb.ts && !mb.error);
    add('services', 'Start sshd and crond with Termux (termux-services)', 'adb-root',
        'su $(stat -c %u /data/data/com.termux) -c "PATH=' + T + '/usr/bin:$PATH PREFIX=' + T + '/usr SVDIR=' + T + '/usr/var/service sv-enable sshd; sv-enable crond"', sshUp && ok('cronWatchdog') === true);
    let lib = (ctx.library || []).find(b => b.sha256 && (!profile.minerBuild || (b.commit || '').startsWith(profile.minerBuild) || b.sha256.startsWith(profile.minerBuild))) || null;
    add('miner', 'Miner program in ~/ccminer' + (lib ? ' (library build ' + (lib.label || lib.sha256.slice(0, 12)) + ')' : ''), 'ssh',
        lib ? 'Miner updates: install ' + lib.sha256.slice(0, 12) + ' to ' + ((config.miner || {}).path || '~/ccminer/ccminer-verus') : null, !!mb.sha,
        mb.sha ? 'has ' + mb.sha.slice(0, 12) : lib ? null : 'No build in the miner library: use "Build newest" (builds on the phone).');
    let wname = ctx.workerName || w.name;
    add('minerConf', 'Miner settings ~/ccminer/verus.conf (worker ' + wname + ', pool ' + ((ctx.poolHost || 'proxy') + ':' + (config.stratumPort || 8000)) + ', threads = cores)', 'ssh',
        'write verus.conf as on .141 (pool stratum+tcp://' + (ctx.poolHost || '<proxy>') + ':' + (config.stratumPort || 8000) + ', user <wallet>.' + wname + ', threads ' + (inv.cores || 8) + ', retry-pause 5, api 0.0.0.0:4068, no cpu-priority)',
        ok('ccminer') === true && ok('minerEnv') !== false);
    add('profile', 'Apply the farm profile (boot script, watchdog, LED, keep in front, ...)', 'apply', 'Apply profile', farm.status === 'in sync',
        farm.status && farm.status !== 'in sync' ? 'now ' + farm.status + ((farm.drift || []).length ? ': ' + farm.drift.join(', ') : '') : null);
    let todo = steps.filter(s => !s.done);
    return { steps, todo: todo.length, manual: todo.filter(s => s.note && !s.cmd).length, ready: todo.length === 0 };
}

// pool worker name from the farm workerName pattern: {model} = short model (s8, s10, ...), {serial} = the
// last 6 characters of ro.serialno, 8 when 6 would clash with another device. The full serial stays the
// device's ID in the dashboard.
const MODELS = { 'SM-G950': 's8', 'SM-G955': 's8plus', 'SM-G960': 's9', 'SM-G965': 's9plus', 'SM-G970': 's10e', 'SM-G973': 's10', 'SM-G975': 's10plus', 'SM-G980': 's20', 'SM-G981': 's20', 'SM-G985': 's20plus', 'SM-G986': 's20plus', 'SM-G988': 's20ultra', 'SM-N950': 'note8', 'SM-N960': 'note9' };
function shortModel(inv) {
    let m = String((inv && inv.model) || '').toUpperCase();
    for (let [k, v] of Object.entries(MODELS)) if (m.startsWith(k)) return v;
    let s = String((inv && (inv.marketName || inv.model)) || 'phone').toLowerCase().replace(/^(samsung|galaxy)\s+/g, '').replace(/[^a-z0-9]+/g, '');
    return s.slice(0, 10) || 'phone';
}
function workerName(pattern, inv, others) {
    let serial = String((inv && inv.serial) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!serial) return null;
    let make = (n) => String(pattern || '{model}-{serial}').replace('{model}', shortModel(inv)).replace('{serial}', serial.slice(-n)).replace(/[^A-Za-z0-9._-]/g, '');
    let norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let clash = (n) => (others || []).some(o => o.serial && norm(o.serial) !== serial && norm(o.serial).slice(-n) === serial.slice(-n));
    let n = clash(6) ? 8 : 6;
    while (n < serial.length && clash(n)) n++;
    let name = make(n);
    return (others || []).some(o => o.name === name && norm(o.serial) !== serial) ? null : name;
}

// ~/ccminer/verus.conf exactly as on .141 (the best-running phone), only the worker name differs
function minerConf(opts) {
    let c = {
        pools: [{ name: opts.poolName || 'verus.io', url: 'stratum+tcp://' + opts.poolHost + ':' + (opts.poolPort || 8000), timeout: 150 }],
        user: opts.wallet + '.' + opts.worker,
        algo: 'verus',
        threads: Number(opts.threads) || 8,
        'retry-pause': 5,
        'api-allow': '0/0',
        'api-bind': '0.0.0.0:4068'
    };
    return JSON.stringify(c, null, 2) + '\n';
}

module.exports = { setupPlan, minerConf, workerName, shortModel, apkFor, APPS, PACKAGES };
