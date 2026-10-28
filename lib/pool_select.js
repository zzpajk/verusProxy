// Which pool this stratum worker process should connect to.
// The master process (lib/pool_manager.js) decides; workers only report health
// events and follow switch orders, so multiple worker threads never disagree.

let pools = [];
let active = 0;
const liveSockets = new Set();   // every pool connection of this process
let onSwitchHooks = [];

function poolList(config) {
    let list = Array.isArray(config.pools) && config.pools.length ? config.pools : (config.pool ? [config.pool] : []);
    return list.map((p, i) => ({
        index: i,
        name: p.name || `${p.host}:${p.port}`,
        host: p.host,
        port: p.port,
        ssl: p.ssl === true,
        rejectUnauthorized: p.rejectUnauthorized === true
    }));
}
exports.poolList = poolList;

exports.init = function (config) {
    pools = poolList(config);
    let fromMaster = Number(process.env.VP_ACTIVE_POOL);
    active = Number.isInteger(fromMaster) && pools[fromMaster] ? fromMaster : 0;
};

exports.activeIndex = () => active;
exports.poolConfig = (i) => pools[i === undefined ? active : i];
exports.count = () => pools.length;

exports.register = function (sock) {
    liveSockets.add(sock);
    sock.once('close', () => liveSockets.delete(sock));
};

// event: 'ok' (subscribed, with ms), 'fail' (could not connect / no answer),
//        'timeout' (connected but stopped answering shares), 'lost' (dropped after working)
exports.report = function (index, event, detail) {
    if (typeof process.send !== 'function') return;
    try { process.send(Object.assign({ type: 'vp-pool-event', pid: process.pid, index, event, time: Date.now() }, detail || {})); } catch (e) {}
};

exports.onSwitch = function (fn) { onSwitchHooks.push(fn); };

// master told us to move to another pool: drop every connection to other pools,
// miners then reconnect through the normal lost-pool path to the new active pool
exports.handleMasterMessage = function (msg) {
    if (!msg || msg.type !== 'vp-pool-switch') return false;
    if (!pools[msg.index] || msg.index === active) return true;
    let from = active;
    active = msg.index;
    console.log(`Switching pool ${pools[from].name} -> ${pools[active].name}${msg.reason ? ' (' + msg.reason + ')' : ''}`);
    for (let fn of onSwitchHooks) { try { fn(active); } catch (e) {} }
    for (let s of Array.from(liveSockets)) {
        if (s.poolIndex !== active) {
            s.switchingAway = true;
            try { s.destroy(); } catch (e) {}
        }
    }
    return true;
};
