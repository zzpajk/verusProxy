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

// settings in config.local.json that the proxy doesn't know: almost always a typo or a
// setting at the wrong level (e.g. "auth" instead of "dashboard": { "auth": ... })
function checkKeys(defaults, local, prefix, out) {
    for (let k of Object.keys(local)) {
        let full = prefix + k;
        if (k in defaults) {
            if (isObj(defaults[k]) && isObj(local[k])) checkKeys(defaults[k], local[k], full + '.', out);
            else if (typeof defaults[k] === 'boolean' && typeof local[k] !== 'boolean') {
                out.push(`config.local.json: "${full}" should be true or false without quotes (it is ${JSON.stringify(local[k])}), so it is treated as off.`);
            } else if (typeof defaults[k] === 'number' && typeof local[k] !== 'number') {
                out.push(`config.local.json: "${full}" should be a number without quotes (it is ${JSON.stringify(local[k])}).`);
            }
            continue;
        }
        if (prefix === '' && k === 'pool') continue;            // old single-pool format
        let hint = '';
        if (k.includes('.')) {
            let [a, b] = k.split('.');
            hint = ` Write it nested: "${a}": { "${b}": ... }`;
        } else {
            let owner = Object.keys(defaults).find(o => isObj(defaults[o]) && k in defaults[o]);
            if (owner) hint = ` Did you mean "${owner}": { "${k}": ... }?`;
        }
        out.push(`config.local.json: unknown setting "${full}", ignored.${hint}`);
    }
    return out;
}

function load() {
    let defaults = readJson(DEFAULTS);
    let hasLocal = fs.existsSync(LOCAL);
    let raw = hasLocal ? readJson(LOCAL) : {};
    let config = merge(defaults, legacyPool(raw));
    Object.defineProperty(config, '_hasLocal', { value: hasLocal, enumerable: false });
    Object.defineProperty(config, '_warnings', { value: checkKeys(defaults, raw, '', []), enumerable: false });
    return config;
}

// one line per feature, printed at startup so it's easy to see what is switched on
function summary(config) {
    let d = config.dashboard || {}, s = config.ssh || {};
    let pools = (Array.isArray(config.pools) && config.pools.length ? config.pools : [config.pool]).filter(Boolean);
    return [
        `Settings: config.json + ${config._hasLocal ? 'config.local.json' : 'NO config.local.json (defaults only)'}`,
        `  pools: ${pools.map(p => p.name || p.host + ':' + p.port).join(', ')}`,
        `  dashboard: ${d.enabled === false ? 'off' : 'port ' + (d.port || 8080)}, login ${d.auth ? 'ON (user "' + String(d.auth).split(':')[0] + '")' : 'off'}`,
        `  pool control from dashboard: ${d.auth ? 'on' : 'off (needs dashboard.auth)'}`,
        `  remote commands (ssh): ${s.enabled !== true ? 'off (ssh.enabled is not true)' : (d.auth ? 'ON' : 'off (needs dashboard.auth)')}`
    ];
}

module.exports = { load, summary, merge, diff, legacyPool, readJson, DEFAULTS, LOCAL };
