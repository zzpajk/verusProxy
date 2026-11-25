#!/usr/bin/env node
// Dry run of the farm setup check, without the proxy: compares phones with their farm profile
// over ADB and prints the result. Read-only on the phones and on the proxy (saves nothing).
//
//   node deploy/farm-check.js s8tx 192.168.1.21 ...     (device names or addresses)
//   node deploy/farm-check.js --json s8tx               (raw result)

const fs = require('fs');
const path = require('path');
const configLib = require('../lib/config.js');
const { Adb } = require('../lib/adb.js');
const { Groups } = require('../lib/groups.js');
const { checkDevice } = require('../lib/farm.js');

let args = process.argv.slice(2);
let json = args.includes('--json');
args = args.filter(a => a !== '--json');
if (!args.length) { console.log('usage: node deploy/farm-check.js [--json] <device name or ip> ...'); process.exit(1); }

const config = configLib.load();
const dataDir = path.resolve(__dirname, '..', (config.dashboard || {}).dataDir || 'data');
let workers = [];
try { workers = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf8')).workers || []; } catch (e) {}
const groups = new Groups(config);
const adb = new Adb(config);

(async () => {
    for (let a of args) {
        let w = workers.find(x => x.name === a) || workers.find(x => x.ip === a) || (/^\d+\.\d+\.\d+\.\d+$/.test(a) ? { name: a, ip: a } : null);
        if (!w) { console.log(`\n${a}: unknown device`); continue; }
        let prof = configLib.farmProfile(config, groups.of(w.name), w.name);
        let c = await adb.connect(w.ip);
        if (!c.ok) { console.log(`\n${w.name} (${w.ip}): ADB ${c.state}: ${c.msg}`); continue; }
        let t0 = Date.now();
        let r = await checkDevice(adb, w, prof);
        if (json) { console.log(JSON.stringify(Object.assign({ name: w.name, ip: w.ip }, r), null, 2)); continue; }
        console.log(`\n${w.name} (${w.ip})  group ${groups.of(w.name) || '-'}  profile ${r.stamp}  ->  ${r.status.toUpperCase()}${r.root ? '' : '  (no root over ADB)'}  [${Date.now() - t0} ms]`);
        if (r.error) console.log('  error: ' + r.error);
        for (let i of r.items) {
            let mark = i.ok === true ? 'ok   ' : i.ok === false ? 'DRIFT' : '  ?  ';
            console.log(`  ${mark} ${i.label.padEnd(42)} ${i.have || '?'}${i.ok === false && i.want ? '   (want ' + i.want + ')' : ''}`);
        }
    }
})();
