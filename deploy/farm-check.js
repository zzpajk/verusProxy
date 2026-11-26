#!/usr/bin/env node
// Dry run of the farm setup check, without the proxy: compares phones with their farm profile
// over ADB and prints the result. Read-only on the phones and on the proxy (saves nothing).
//
//   node deploy/farm-check.js s8tx 192.168.1.21 ...     (device names or addresses)
//   node deploy/farm-check.js --json s8tx               (raw result)
//   node deploy/farm-check.js --plan s8tx               (also: the commands "Apply profile" would run; runs none)
//   node deploy/farm-check.js --plan --set minerEnv=userland s8tx   (what if the device had this profile setting)

const fs = require('fs');
const path = require('path');
const configLib = require('../lib/config.js');
const { Adb } = require('../lib/adb.js');
const { Groups } = require('../lib/groups.js');
const { checkDevice, planFixes } = require('../lib/farm.js');

let args = process.argv.slice(2);
let json = args.includes('--json'), plan = args.includes('--plan'), setup = args.includes('--setup');
let sets = {};
for (let i = args.indexOf('--set'); i >= 0; i = args.indexOf('--set')) {
    let [k, ...v] = String(args[i + 1] || '').split('='); v = v.join('=');
    sets[k] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
    args.splice(i, 2);
}
args = args.filter(a => a !== '--json' && a !== '--plan' && a !== '--setup');
if (!args.length) { console.log('usage: node deploy/farm-check.js [--json] <device name or ip> ...'); process.exit(1); }

const config = configLib.load();
// --set: a what-if override on top of every named device's profile (only in this run)
if (Object.keys(sets).length) {
    config.farm = Object.assign({}, config.farm, { devices: Object.assign({}, (config.farm || {}).devices) });
    for (let a of args) config.farm.devices[a] = Object.assign({}, config.farm.devices[a], sets);
}
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
        let others = workers.map(o => ({ name: o.name, serial: o.inv && o.inv.serial }));
        let runnerName = String(require('../lib/farm_setup.js').workerName(prof.profile.workerName, w.inv, others) || w.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
        let r = await checkDevice(adb, w, prof, null, runnerName);
        if (json) { console.log(JSON.stringify(Object.assign({ name: w.name, ip: w.ip }, r), null, 2)); continue; }
        console.log(`\n${w.name} (${w.ip})  group ${groups.of(w.name) || '-'}  profile ${r.stamp}  ->  ${r.status.toUpperCase()}${r.root ? '' : '  (no root over ADB)'}  [${Date.now() - t0} ms]`);
        if (r.error) console.log('  error: ' + r.error);
        for (let i of r.items) {
            let mark = i.ok === true ? 'ok   ' : i.ok === false ? 'DRIFT' : '  ?  ';
            console.log(`  ${mark} ${i.label.padEnd(42)} ${i.have || '?'}${i.ok === false && i.want ? '   (want ' + i.want + ')' : ''}`);
        }
        if (setup) {
            let lib = []; try { lib = JSON.parse(fs.readFileSync(path.join(dataDir, 'miners', 'index.json'), 'utf8')); } catch (e) {}
            let sp = require('../lib/farm_setup.js').setupPlan({ w: Object.assign({}, w, { farm: r }), profile: prof.profile, config, library: lib, apkDir: path.join(dataDir, 'apks'), poolHost: '192.168.1.12' });
            console.log(`\n  Set up phone (plan only): ${sp.todo} of ${sp.steps.length} step(s) to do`);
            for (let s of sp.steps) console.log(`   ${s.done ? 'done ' : 'TODO '} [${s.via}] ${s.what}${s.note ? '\n          ' + s.note : ''}${!s.done && s.cmd ? '\n          $ ' + s.cmd : ''}`);
        }
        if (plan && !r.error) {
            let f = config.farm || {};
            let proxyUrl = f.proxyUrl || ('http://' + (Object.values(require('os').networkInterfaces()).flat().find(a => a && (a.family === 'IPv4' || a.family === 4) && !a.internal) || {}).address + ':' + ((config.dashboard || {}).port || 8080));
            let runnerScript = null; try { runnerScript = fs.readFileSync(path.join(dataDir, 'runner', 'phone-runner.sh'), 'utf8'); } catch (e) {}
            let p = planFixes(r, prof.profile, prof.stamp, { minerPath: (config.miner || {}).path, proxyUrl, runnerName, runnerScript, runnerRepo: prof.profile.runnerRepo });
            console.log(`\n  Apply profile (dry run, nothing was run): ${p.steps.length} step(s)`);
            for (let s of p.steps) {
                let cmd = s.cmd.replace(/echo [A-Za-z0-9+\/=]{200,} \|/, m => 'echo <' + (m.length - 7) + ' chars of base64> |');
                console.log(`   [${s.via}] ${s.what}\n      $ ${s.via === 'ssh-su' ? 'su -c ' + JSON.stringify(cmd) : cmd}`);
            }
            for (let m of p.manual) console.log(`   [manual] ${m.what}`);
        }
    }
})();
