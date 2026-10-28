// Per-process share accounting.
// Runs inside each cluster worker (where miner sockets live) and flushes
// batched deltas to the master process, which aggregates and serves the dashboard.

const TWO_256 = 2n ** 256n;
const workCache = new Map();

// expected hashes needed to find one share at this target
function workForTarget(targetHex) {
    if (!targetHex) return 0;
    let w = workCache.get(targetHex);
    if (w !== undefined) return w;
    try {
        let t = BigInt('0x' + targetHex.toString().replace(/^0x/, ''));
        w = t > 0n ? Number(TWO_256 / (t + 1n)) : 0;
    } catch (e) {
        w = 0;
    }
    if (workCache.size > 1000) workCache.clear();
    workCache.set(targetHex, w);
    return w;
}

function cleanIp(ip) {
    return (ip || '').toString().replace(/^::ffff:/, '');
}

// "Raddress.worker" / "Raddress/worker" / "Raddress#worker" -> "worker"
function parseWorkerName(login, ip) {
    let s = (login || '').toString().replace(/[^a-zA-Z0-9._\-\/\@=#]+/g, '');
    let m = s.match(/^[^.\/#]+[.\/#](.+)$/);
    let name = m ? m[1] : '';
    name = name.replace(/[^a-zA-Z0-9._\-@]+/g, '').slice(0, 64);
    return name || cleanIp(ip) || 'unknown';
}

const conns = new Map();   // minerId -> connection info
let deltas = new Map();    // worker -> {acc, rej, work, last}

function delta(worker) {
    let d = deltas.get(worker);
    if (!d) {
        d = { acc: 0, rej: 0, work: 0, last: 0, lastRejReason: null };
        deltas.set(worker, d);
    }
    return d;
}

exports.workForTarget = workForTarget;
exports.parseWorkerName = parseWorkerName;

exports.connected = function (socket) {
    conns.set(socket.minerId, {
        id: socket.minerId,
        ip: cleanIp(socket.remoteAddress),
        since: Date.now(),
        worker: null,
        address: null,
        software: null,
        xnsub: false
    });
};

exports.authorized = function (socket, login, address) {
    let c = conns.get(socket.minerId);
    if (!c) return;
    c.worker = parseWorkerName(login, c.ip);
    c.address = address || null;
    socket.statsWorker = c.worker;
};

exports.subscribed = function (socket, software) {
    let c = conns.get(socket.minerId);
    if (c) c.software = software;
};

exports.extraNonceSubscribed = function (socket) {
    let c = conns.get(socket.minerId);
    if (c) c.xnsub = true;
};

// called when a share is forwarded to the pool; remember the target it was mined at
exports.submitted = function (socket) {
    if (!socket.pendingShareTargets) socket.pendingShareTargets = [];
    let t = socket.shareTargetObject && socket.shareTargetObject.params ? socket.shareTargetObject.params[0] : null;
    socket.pendingShareTargets.push(t);
    if (socket.pendingShareTargets.length > 256) socket.pendingShareTargets.shift();
};

// returns true if this pool response was the answer to a share
exports.shareResult = function (socket, accepted, error) {
    if (!socket.pendingShareTargets || socket.pendingShareTargets.length === 0) {
        return false; // e.g. the response to mining.authorize
    }
    let target = socket.pendingShareTargets.shift();
    let worker = socket.statsWorker;
    if (!worker) return true;
    let d = delta(worker);
    if (accepted) {
        d.acc++;
        d.work += workForTarget(target);
        d.last = Date.now();
    } else {
        d.rej++;
        if (error) d.lastRejReason = Array.isArray(error) ? String(error[1] || error[0]) : String(error);
    }
    return true;
};

// share refused locally by the proxy (no pool, not subscribed, ...)
exports.localReject = function (socket, reason) {
    let worker = socket.statsWorker;
    if (!worker) return;
    let d = delta(worker);
    d.rej++;
    d.lastRejReason = reason;
};

exports.disconnected = function (socket) {
    conns.delete(socket.minerId);
};

exports.start = function (getPools) {
    if (typeof process.send !== 'function') return; // not running under cluster
    setInterval(() => {
        let pools = [];
        try {
            for (let [addr, p] of getPools()) {
                pools.push({ address: addr, connected: p.getIsConnected() !== false, miners: p.miners ? p.miners.size : 0 });
            }
        } catch (e) {}
        let shares = [];
        for (let [worker, d] of deltas) shares.push(Object.assign({ worker }, d));
        deltas = new Map();
        try {
            process.send({
                type: 'vp-stats',
                pid: process.pid,
                time: Date.now(),
                conns: Array.from(conns.values()).filter(c => c.worker),
                shares,
                pools
            });
        } catch (e) {}
    }, 5000).unref();
};
