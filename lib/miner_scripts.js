// Shell scripts the proxy runs on the phones (over SSH, in Termux or UserLAnd) to check, install,
// roll back and build the miner: lib/phone/*.sh, plain POSIX sh (Termux's sh is dash). Each prints
// KEY=value lines the proxy reads. Everything they keep lives in ~/.verusproxy on the phone.

const fs = require('fs');
const path = require('path');
const read = (n) => fs.readFileSync(path.join(__dirname, 'phone', n + '.sh'), 'utf8');
const COMMON = read('common'), INFO = read('info'), INSTALL = read('install'), ROLLBACK = read('rollback'), BUILD = read('build'), BUILD_STATUS = read('build-status');

function q(v) { return "'" + String(v).replace(/'/g, "'\\''") + "'"; }

// one SSH command: write the script to ~/.verusproxy and run it with settings in the environment.
// detach: start it in the background and return right away (builds)
function command(name, body, vars, detach) {
    let script = '#!/bin/sh\nset -u\n' + Object.entries(vars || {}).map(([k, v]) => `${k}=${q(v)}`).join('\n') + '\n' + COMMON + body;
    let b64 = Buffer.from(script).toString('base64');
    let file = `"$HOME/.verusproxy/vp-${name}.sh"`;
    let write = `mkdir -p "$HOME/.verusproxy" && echo ${b64} | base64 -d > ${file}`;
    if (!detach) return `${write} && sh ${file}`;
    return `${write} && { if command -v setsid >/dev/null 2>&1; then setsid nohup sh ${file} >/dev/null 2>&1 < /dev/null & else nohup sh ${file} >/dev/null 2>&1 < /dev/null & fi; } && echo started=1`;
}

function parseKv(text) {
    let o = {};
    for (let line of String(text || '').split('\n')) {
        let i = line.indexOf('=');
        if (i > 0 && /^[a-z_0-9]+$/i.test(line.slice(0, i))) o[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, '');
    }
    return o;
}

module.exports = { COMMON, INFO, INSTALL, ROLLBACK, BUILD, BUILD_STATUS, command, parseKv, q };
