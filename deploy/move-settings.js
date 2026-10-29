#!/usr/bin/env node
// One-time move of your settings out of config.json into config.local.json.
//
//   node deploy/move-settings.js <your old config.json copy>
//
// Writes only the settings that differ from the current defaults, so future
// `git pull`s never touch them. Prints what it wrote.

const fs = require('fs');
const path = require('path');
const { readJson, diff, legacyPool, merge, DEFAULTS, LOCAL } = require('../lib/config.js');

let src = process.argv[2];
if (!src) {
    console.log('usage: node deploy/move-settings.js <copy of your old config.json>');
    process.exit(1);
}
src = path.resolve(src);
if (src === DEFAULTS) {
    console.log('Give the path of the copy you made of your old config.json, not config.json itself.');
    process.exit(1);
}

let old, defaults;
try {
    old = readJson(src);
    defaults = readJson(DEFAULTS);
} catch (e) {
    console.log(e.message);
    process.exit(1);
}

let mine = legacyPool(diff(defaults, old));
// keep anything already in config.local.json, your old file wins where both set something
if (fs.existsSync(LOCAL)) {
    mine = merge(readJson(LOCAL), mine);
    console.log('config.local.json already existed; your old settings were merged into it.');
}

if (Object.keys(mine).length === 0) {
    console.log('Your old config.json had no changes from the defaults; nothing to move.');
    process.exit(0);
}
fs.writeFileSync(LOCAL, JSON.stringify(mine, null, 4) + '\n');
console.log('Wrote ' + path.relative(process.cwd(), LOCAL) + ':\n');
console.log(JSON.stringify(mine, null, 4));
console.log('\nFrom now on, change settings in config.local.json only. Restart the proxy to apply.');
