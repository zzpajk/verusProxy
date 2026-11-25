// The managed Termux:Boot script, ~/.termux/boot/verusproxy-setup, generated from a phone's merged
// farm profile. It carries the profile stamp ("# verusproxy-profile: <stamp>"), which the setup
// check compares. Plain POSIX sh (Termux's sh is dash). Everything it keeps is in ~/.verusproxy.
//
// At boot: wake lock, one instance only, Termux services + sshd, then as root: ADB over WiFi,
// battery spoof, cpuset. Then it keeps ccminer running in screen "ccminer" (Termux miners only),
// restarting it with a 10 s / 30 s / 120 s backoff when it keeps dying, re-applies the cpuset when
// Android resets it, and starts the device agent if ~/verus-agent.sh is there.

function q(v) { return "'" + String(v === undefined || v === null ? '' : v).replace(/'/g, "'\\''") + "'"; }

const BODY = require('fs').readFileSync(require('path').join(__dirname, 'phone', 'farm-boot.sh'), 'utf8');

// expand a leading ~ the way the phone's shell would, for the miner path from the settings
function phonePath(p) { p = String(p || '~/ccminer/ccminer-verus'); return p.startsWith('~/') ? '$HOME/' + p.slice(2) : p; }

function generate(profile, stamp, opts) {
    opts = opts || {};
    let cpuset = /^[0-9,-]+$/.test(String(profile.cpuset || '')) ? String(profile.cpuset) : '';
    let port = Number(profile.adbWifiPort) > 0 && Number(profile.adbWifiPort) < 65536 ? String(Number(profile.adbWifiPort)) : '';
    let env = ['termux', 'userland', 'none'].includes(profile.minerEnv) ? profile.minerEnv : 'termux';
    let spoof = profile.batterySpoof === true ? '1' : profile.batterySpoof === false ? '0' : '';
    let bin = phonePath(opts.minerPath);
    let head = [
        '#!/data/data/com.termux/files/usr/bin/sh',
        '# verusproxy-profile: ' + stamp,
        '# Written by verusProxy from the farm profile. "Apply profile" in the dashboard rewrites it:',
        '# change the farm settings on the proxy instead of editing this file.',
        'STAMP=' + q(stamp),
        'CPUSET=' + q(cpuset),
        'ADB_PORT=' + q(port),
        'BATTERY_SPOOF=' + q(spoof),
        'MINER_ENV=' + q(env),
        // the path stays unquoted-expandable ($HOME), the arguments are word-split by sh -c on purpose
        'MINER_BIN="' + bin.replace(/["\\`]/g, '') + '"',
        'MINER_ARGS=' + q(profile.minerArgs || ''),
        'AGENT=' + q(profile.agent === false ? '0' : '1'),
        'PROXY_URL=' + q(opts.proxyUrl || '')
    ];
    return head.join('\n') + '\n' + BODY;
}

module.exports = { generate, q };
