// Settings = config.json (defaults, part of the repo) + config.local.json (your settings, never in git).
// Only put what you change into config.local.json; everything else comes from the defaults, so
// `git pull` never conflicts with your settings and new options appear with sensible values.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = path.join(ROOT, 'config.json');
const LOCAL = path.join(ROOT, 'config.local.json');

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// objects merge key by key; arrays and plain values replace
function merge(base, over) {
    let out = Object.assign({}, base);
    for (let k of Object.keys(over)) {
        out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    }
    return out;
}

// what differs from the defaults: only these need to be in config.local.json
function diff(def, cur) {
    let out = {};
    for (let k of Object.keys(cur)) {
        if (isObj(def[k]) && isObj(cur[k])) {
            let d = diff(def[k], cur[k]);
            if (Object.keys(d).length) out[k] = d;
        } else if (JSON.stringify(def[k]) !== JSON.stringify(cur[k])) {
            out[k] = cur[k];
        }
    }
    return out;
}

function readJson(file) {
    let text = fs.readFileSync(file, 'utf8');
    try {
        return JSON.parse(text);
    } catch (e) {
        // point at the line, the usual hand-editing mistakes are a missing or extra comma
        let m = /position (\d+)/.exec(e.message);
        let where = '';
        if (m) {
            let line = text.slice(0, Number(m[1])).split('\n').length;
            where = ` (around line ${line})`;
        }
        throw new Error(`${path.basename(file)} is not valid JSON${where}: ${e.message}. Check for a missing or extra comma or quote.`);
    }
}

// an old-style single "pool" in your settings means "use this pool"
function legacyPool(local) {
    if (local && isObj(local.pool) && !Array.isArray(local.pools)) {
        local = Object.assign({}, local, { pools: [local.pool] });
        delete local.pool;
    }
    return local;
}

function load() {
    let defaults = readJson(DEFAULTS);
    let local = fs.existsSync(LOCAL) ? legacyPool(readJson(LOCAL)) : {};
    let config = merge(defaults, local);
    Object.defineProperty(config, '_hasLocal', { value: fs.existsSync(LOCAL), enumerable: false });
    return config;
}

module.exports = { load, merge, diff, legacyPool, readJson, DEFAULTS, LOCAL };
