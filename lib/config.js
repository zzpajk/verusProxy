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
            // farm.groups / farm.devices are keyed by group / device name; each entry takes farm.defaults keys
            if ((full === 'farm.groups' || full === 'farm.devices') && isObj(local[k]) && isObj(defaults.defaults)) {
                for (let n of Object.keys(local[k])) {
                    if (isObj(local[k][n])) checkKeys(defaults.defaults, local[k][n], full + '.' + n + '.', out);
                    else out.push(`config.local.json: "${full}.${n}" should be an object like { "cpuset": "0-7" }, ignored.`);
                }
                continue;
            }
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

// ---- farm profile ------------------------------------------------------------
// what every phone should look like: farm.defaults, then farm.groups[<dashboard group>], then
// farm.devices[<device name>]; later ones win key by key
const PROFILE_KEYS = ['termuxVersion', 'termuxApk', 'bootApk', 'bootScript', 'batteryOptimisationOff', 'magiskAutoGrant', 'cpuset', 'batterySpoof', 'adbWifiPort', 'minerBuild', 'minerEnv', 'minerArgs', 'agent', 'retireBootScripts', 'cronWatchdog', 'klusterOff', 'userlandOff'];

function farmProfile(config, group, device) {
    let f = (config && config.farm) || {};
    let pick = (o) => { let r = {}; if (isObj(o)) for (let k of PROFILE_KEYS) if (k in o) r[k] = o[k]; return r; };
    let layers = [f.defaults, group && isObj(f.groups) ? f.groups[group] : null, device && isObj(f.devices) ? f.devices[device] : null];
    let profile = {};
    for (let l of layers) Object.assign(profile, pick(l));
    return { profile, stamp: profileStamp(profile), from: { group: !!(group && isObj(f.groups) && isObj(f.groups[group])), device: !!(device && isObj(f.devices) && isObj(f.devices[device])) } };
}

// short version stamp of a merged profile: same settings = same stamp, on any machine
function profileStamp(profile) {
    let canon = {};
    for (let k of PROFILE_KEYS) if (k in profile) canon[k] = profile[k];
    canon._boot = require('./farm_boot.js').BOOT_VERSION;     // a new boot script counts as a profile change
    return require('crypto').createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 8);
}

// one line per feature, printed at startup so it's easy to see what is switched on
function summary(config) {
    let d = config.dashboard || {}, s = config.ssh || {}, a = config.adb || {};
    let pools = (Array.isArray(config.pools) && config.pools.length ? config.pools : [config.pool]).filter(Boolean);
    return [
        `Settings: config.json + ${config._hasLocal ? 'config.local.json' : 'NO config.local.json (defaults only)'}`,
        `  pools: ${pools.map(p => p.name || p.host + ':' + p.port).join(', ')}`,
        `  dashboard: ${d.enabled === false ? 'off' : 'port ' + (d.port || 8080)}, login ${d.auth ? 'ON (user "' + String(d.auth).split(':')[0] + '")' : 'off'}`,
        `  pool control from dashboard: ${d.auth ? 'on' : 'off (needs dashboard.auth)'}`,
        `  remote commands (ssh): ${s.enabled !== true ? 'off (ssh.enabled is not true)' : (d.auth ? 'ON, ' + (s.password ? 'password login' : 'key login') + (s.hostKeyCheck === 'off' ? ', host keys not checked' : '') : 'off (needs dashboard.auth)')}`,
        `  miner updates: ${s.enabled === true && d.auth ? 'ON (over SSH), source ' + String((config.miner || {}).repo || '').replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '') + ' @ ' + ((config.miner || {}).branch || 'variants') : 'off (needs ssh.enabled and dashboard.auth)'}`,
        `  device registry over ADB: ${a.enabled !== true ? 'off (adb.enabled is not true)' : (d.auth ? 'ON, port ' + (a.port || 5555) + ', device info every ' + (a.inventoryEveryMin || 10) + ' min' : 'off (needs dashboard.auth)')}`,
        `  farm setup check: ${a.enabled === true && d.auth ? 'ON (read-only, over ADB) every ' + ((config.farm || {}).checkEveryMin || 60) + ' min' : 'off (needs adb.enabled and dashboard.auth)'}, profile ${farmProfile(config).stamp}, ${Object.keys((config.farm || {}).groups || {}).length} group and ${Object.keys((config.farm || {}).devices || {}).length} device overrides`
    ];
}

module.exports = { load, summary, farmProfile, profileStamp, PROFILE_KEYS, merge, diff, legacyPool, readJson, DEFAULTS, LOCAL };
