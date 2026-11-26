// Key sync: which ADB and SSH public keys every phone accepts, managed from the box.
//
// Lists: farm profile adbKeys / sshKeys (config.local.json, per group or device too) plus
// data/keys/adb_keys.txt and data/keys/authorized_keys.txt (one key per line, # comments).
// The box's own keys (~/.android/adbkey.pub, ~/.ssh/id_*.pub) are always added, so a bad or
// empty list can never lock the box out.
//
// On the phone:
//   /data/misc/adb/adb_keys (root): keys the box added last time are listed in
//     ~/.verusproxy/adb_keys.managed; those are replaced by the current list, anything else in
//     the file (keys accepted on the screen) stays. adbd reads the file at every new connection,
//     so no restart is needed. No comment lines are written into adb_keys.
//   ~/.ssh/authorized_keys (Termux): a block between "# BEGIN verusproxy keys" and
//     "# END verusproxy keys"; lines outside it stay.
// Keys are pushed by the box (Apply over ADB root / SSH), never pulled by the phones: a phone
// fetching keys over plain HTTP could be fed someone else's key.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ADB_RE = /^[A-Za-z0-9+/]{100,}={0,2}(\s+\S.*)?$/;
const SSH_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(\s+\S.*)?$/;
const BEGIN = '# BEGIN verusproxy keys', END = '# END verusproxy keys';

// a list may be an array of lines or one string with a key per line (both shapes are used in config.local.json)
function asLines(v) { return (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []).map(l => String(l).trim()).filter(l => l && !l.startsWith('#')); }

function readList(file) {
    try { return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); } catch (e) { return []; }
}
function blobOf(line, kind) { let f = String(line).trim().split(/\s+/); return kind === 'adb' ? f[0] : f[1]; }
function fp(blob) { return crypto.createHash('md5').update(blob).digest('hex').slice(0, 10); }

function boxKeys() {
    let adb = readList(path.join(os.homedir(), '.android', 'adbkey.pub'));
    let ssh = [];
    for (let f of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) ssh = ssh.concat(readList(path.join(os.homedir(), '.ssh', f)));
    return { adb, ssh };
}

// the wanted keys for a profile; invalid lines are dropped (and reported)
function wantedKeys(profile, dataDir) {
    let box = boxKeys(), bad = [];
    let take = (kind, lines, re) => {
        let seen = new Set(), out = [];
        for (let l of lines) {
            l = String(l || '').trim().replace(/\s+/g, ' ');
            if (!l) continue;
            if (!re.test(l)) { bad.push(kind + ': ' + l.slice(0, 40) + '…'); continue; }
            let b = blobOf(l, kind);
            if (seen.has(b)) continue;
            seen.add(b); out.push(l);
        }
        return out;
    };
    let adb = take('adb', box.adb.concat(asLines(profile.adbKeys), readList(path.join(dataDir, 'keys', 'adb_keys.txt'))), ADB_RE);
    let ssh = take('ssh', box.ssh.concat(asLines(profile.sshKeys), readList(path.join(dataDir, 'keys', 'authorized_keys.txt'))), SSH_RE);
    let sshBlock = BEGIN + '\n' + ssh.join('\n') + (ssh.length ? '\n' : '') + END + '\n';
    return {
        adb, ssh, bad,
        boxAdb: box.adb.map(l => blobOf(l, 'adb')), boxSsh: box.ssh.map(l => blobOf(l, 'ssh')),
        adbFps: adb.map(l => fp(blobOf(l, 'adb'))).sort(),
        sshHash: crypto.createHash('md5').update(sshBlock).digest('hex').slice(0, 10),
        sshBlock
    };
}

// read-only, as root over ADB: fingerprints of the keys on the phone
const KEYS_CHECK = String.raw`
F=/data/misc/adb/adb_keys; M=/data/data/com.termux/files/home/.verusproxy/adb_keys.managed; A=/data/data/com.termux/files/home/.ssh/authorized_keys
[ -r $F ] && echo "adb_fp=$(cut -d' ' -f1 $F | while read k; do [ -n "$k" ] && echo "$k" | tr -d '\n' | md5sum | cut -c1-10; done | sort | tr '\n' ' ')"
[ -r $M ] && echo "adb_managed=$(while read k; do [ -n "$k" ] && echo "$k" | tr -d '\n' | md5sum | cut -c1-10; done < $M | sort | tr '\n' ' ')"
[ -r $A ] && echo "ssh_block=$(sed -n '/^# BEGIN verusproxy keys$/,/^# END verusproxy keys$/p' $A | md5sum | cut -c1-10)"
echo "keys_done=1"
`;

function evaluateKeys(kv, want) {
    if (kv.keys_done !== '1' || kv.adb_fp === undefined) return { ok: null, have: 'unreadable' };
    let present = new Set(String(kv.adb_fp).trim().split(/\s+/).filter(Boolean));
    let managed = String(kv.adb_managed || '').trim().split(/\s+/).filter(Boolean);
    let missing = want.adbFps.filter(f => !present.has(f));
    let stale = managed.filter(f => !want.adbFps.includes(f) && present.has(f));
    let sshOk = kv.ssh_block === want.sshHash;
    let parts = [];
    if (missing.length) parts.push(missing.length + ' ADB key' + (missing.length > 1 ? 's' : '') + ' missing');
    if (stale.length) parts.push(stale.length + ' old ADB key' + (stale.length > 1 ? 's' : '') + ' to remove');
    if (!sshOk) parts.push(kv.ssh_block === undefined ? 'no authorized_keys' : 'SSH keys differ');
    return { ok: !parts.length, have: parts.length ? parts.join(', ') : want.adb.length + ' ADB + ' + want.ssh.length + ' SSH keys' };
}

// Apply: root script for adb_keys (wanted lines and the box's key blobs given base64-encoded)
function adbKeysScript(want) {
    let b64 = (t) => Buffer.from(t).toString('base64');
    return [
        'set -e',
        'F=/data/misc/adb/adb_keys; M=/data/data/com.termux/files/home/.verusproxy/adb_keys.managed; T=/data/local/tmp/vp-adbkeys.$$',
        'echo ' + b64(want.adb.join('\n') + '\n') + ' | base64 -d > $T.want',
        'cut -d" " -f1 $T.want > $T.wblobs',
        // safety: the box's own key must be in the new list
        'for k in ' + want.boxAdb.map(k => "'" + k + "'").join(' ') + '; do grep -q -F "$k" $T.wblobs || { echo "box key missing from the list, nothing changed"; rm -f $T.*; exit 1; }; done',
        '[ -f $F ] && cp -p $F $F.vp-backup || : > $F',
        // keep lines not added by the box before; then add the wanted ones not already there
        '{ if [ -s $M ]; then grep -v -F -f $M $F || true; else cat $F; fi; } > $T.keep',
        'grep -v -F -f $T.wblobs $T.keep > $T.new || true',
        'cat $T.want >> $T.new',
        'grep -q . $T.new || { echo "empty result, nothing changed"; rm -f $T.*; exit 1; }',
        'cat $T.new > $F && chown system:shell $F && chmod 640 $F && (restorecon $F 2>/dev/null || chcon u:object_r:adb_keys_file:s0 $F)',
        'cp $T.wblobs $M && chown $(stat -c %u:%g /data/data/com.termux/files/home) $M && chmod 600 $M',
        'echo "adb_keys: $(grep -c . $F) keys, $(grep -c . $T.want) from the box list"; rm -f $T.*'
    ].join('\n');
}

// Apply: Termux-user command for authorized_keys
function sshKeysCommand(want) {
    let b64 = Buffer.from(want.sshBlock).toString('base64');
    return 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && A=~/.ssh/authorized_keys && touch $A && cp -p $A ~/.verusproxy/authorized_keys.before-keysync' +
        " && { sed '/^# BEGIN verusproxy keys$/,/^# END verusproxy keys$/d' $A; echo " + b64 + ' | base64 -d; } > $A.vp && mv -f $A.vp $A && chmod 600 $A && echo "authorized_keys: $(grep -c "^[a-z]" $A) keys"';
}

module.exports = { asLines, wantedKeys, evaluateKeys, adbKeysScript, sshKeysCommand, KEYS_CHECK, boxKeys, fp };
