const net = require('net');
const tls = require('tls');
const fs = require('fs');
const stats = require('./stats_worker.js');
const poolSelect = require('./pool_select.js');


// TODO more stratum protocol support ???
//      handle too many rejected shares for pool connection


// global functions used by both miner_listener.js and this file
var getSafeString = function getSafeString(s) {
    return (s||"").toString().replace(/[^a-zA-Z0-9._\-\/\@=#]+/g, '');
}
var getSafeAddress = function getSafeAddress(s) {
    return getSafeString(s).split("/")[0].split("#")[0].split(".")[0];
}
var getSafeNumber = function getSafeNumber(value) {
  let num = Number(value);
  return isNaN(num) ? 0 : num;
}

exports.getSafeString = getSafeString;
exports.getSafeAddress = getSafeAddress;
exports.getSafeNumber = getSafeNumber;

exports.newPoolConnection = function poolConnection(config) {
    let poolSocket;
    // the pool to use is decided by the master process (failover / manual switch)
    const poolIndex = poolSelect.activeIndex();
    const poolCfg = poolSelect.poolConfig(poolIndex);
    const failover = config.failover || {};
    const connectTimeoutMs = (failover.connectTimeoutSec || 15) * 1000;
    const submitTimeoutMs = (failover.submitTimeoutSec || 60) * 1000;
    const startedAt = Date.now();
    
    let subscribeObject = { id: 0,
        method: 'mining.subscribe',
        params: [ `VP/${config.version}`, null ]
    };
    
    let handleConnected = function () {
        poolSocket.rejects = 0;
        poolSocket.isConnected = true;

        poolSocket.peerEndpoint = poolSocket.remoteAddress + " " + poolSocket.remotePort.toString();

        poolSocket.setEncoding('ascii');
        poolSocket.setNoDelay(true);
        // detect half-open connections at the TCP level, independent of mining activity
        poolSocket.setKeepAlive(true, 15000);

        poolSocket.SendMessage(subscribeObject);
        poolSocket.sendExtraNonceSubscribe();

        // if present, force all miners to auth with specified proxy wallet
        if (config.wallet && typeof config.wallet === 'string' && config.wallet.length > 0) {
            let forcedAuthorizeObject = { id: 0,
                method: 'mining.authorize',
                params: [ getSafeAddress(config.wallet), getSafeString(config.password?config.password:"x") ]
            };
            poolSocket.setAuthorizeObject(forcedAuthorizeObject);
            poolSocket.SendMessage(poolSocket.getAuthorizeObject());
            console.log(`Connected to ${poolCfg.name} for ${poolSocket.getMinerAddress()}`);

        } else {
            // if we already know the authorize from miner, send it ...
            if (poolSocket.getAuthorizeObject()) {
                poolSocket.SendMessage(poolSocket.getAuthorizeObject());
                console.log(`Connected to ${poolCfg.name} for ${poolSocket.getMinerAddress()}`);
            } else {
                console.log(`Connected to ${poolCfg.name} needs authorization from miner`);
            }
        }
    };
    
    if (poolCfg.ssl === true) {
        let TLSoptions = {
            port: poolCfg.port,
            host: poolCfg.host,
            servername: poolCfg.host,
            allowHalfOpen: false,
            rejectUnauthorized: (poolCfg.rejectUnauthorized === true)
        };
        poolSocket = tls.connect(TLSoptions, handleConnected);

    } else {
        poolSocket = net.createConnection({
            port: poolCfg.port,
            host: poolCfg.host,
            allowHalfOpen: false,
        }, handleConnected);
    }
    
    poolSocket.poolIndex = poolIndex;
    poolSelect.register(poolSocket);

    poolSocket.on('error', function(err) {
        poolSocket.lastErrorCode = err.code || err.message;
        console.log(poolSocket.getPoolFriendlyName(), "pool socket error", err.code);
    });

    // health: the pool must answer subscribe within connectTimeout ...
    let connectTimer = setTimeout(() => {
        if (!poolSocket.subscribeResponseObject && !poolSocket.destroyed) {
            poolSocket.lastErrorCode = poolSocket.isConnected ? 'no answer to subscribe' : 'connect timeout';
            console.log(poolSocket.getPoolFriendlyName(), "pool did not answer in", connectTimeoutMs / 1000, "s");
            poolSocket.destroy();
        }
    }, connectTimeoutMs);

    // ... and, once mining, must keep answering submitted shares.
    // (Time between blocks / jobs is never used: Verus blocks have no upper time limit.)
    // awaitingSince = time of the first share sent after the pool's last share reply
    poolSocket.awaitingSince = null;
    poolSocket.noteSubmit = function () {
        if (poolSocket.awaitingSince === null) poolSocket.awaitingSince = Date.now();
    };
    poolSocket.noteShareReply = function () {
        poolSocket.awaitingSince = null;
    };
    let healthTimer = setInterval(() => {
        if (poolSocket.awaitingSince !== null && Date.now() - poolSocket.awaitingSince > submitTimeoutMs && !poolSocket.destroyed) {
            poolSocket.hung = true;
            poolSocket.lastErrorCode = `no reply to shares for ${Math.round(submitTimeoutMs / 1000)} s`;
            console.log(poolSocket.getPoolFriendlyName(), 'WARN,', poolSocket.lastErrorCode);
            poolSocket.destroy();
        }
    }, 5000);
    
    poolSocket.miners = new Map();
    
    poolSocket.minerAdd = function(minerId, socket) {
        if (poolSocket.closingTimeout) {
            clearTimeout(poolSocket.closingTimeout);
        }
        poolSocket.miners.set(minerId, socket);
        console.log("miner", minerId, "added to pool", poolSocket.getPoolFriendlyName());
    }
    poolSocket.minerDel = function(minerId) {
        if (poolSocket.miners.has(minerId)) {
            poolSocket.miners.delete(minerId);
            console.log("miner", minerId, "removed from pool", poolSocket.getPoolFriendlyName());
            if (poolSocket.miners.size == 0) {
                if (poolSocket.closingTimeout) {
                    clearTimeout(poolSocket.closingTimeout);
                }
                poolSocket.closingTimeout = setTimeout(()=>{
                    if (poolSocket.getIsConnected() !== false) {
                        console.log(poolSocket.getPoolFriendlyName(), "closing connection, no miners connected for 15 seconds");
                        poolSocket.closingIdle = true;
                        try {
                            poolSocket.destroy();
                        } catch (e) {
                        }
                    }
                }, 15000);
            }
        }
    }
    poolSocket.hasMiner = function(minerId) {
        return poolSocket.miners.has(minerId);
    };
    poolSocket.minerDelAll = function() {
        // notify all miner objects this pool is down
        for (let miner of poolSocket.miners.values()){
            miner.lostPool();
        }
        return poolSocket.miners.clear();
    };
    
    poolSocket.getPoolFriendlyName = function() {
        let connectedStr = poolSocket.getIsConnected()===false?" (disconnected)":"";
        if (poolSocket.miner) {
            return poolSocket.miner + connectedStr;
        }
        return poolCfg.name + connectedStr;
    }
    
    poolSocket.getIsConnected = function () {
        return poolSocket.isConnected;
    }
    poolSocket.getMinerAddress = function () {
        return poolSocket.miner;
    }
    poolSocket.getAuthorizeObject = function () {
        return poolSocket.authorizeObject;
    }
    poolSocket.setAuthorizeObject = function (object) {
        poolSocket.authorizeObject = object;
        poolSocket.miner = getSafeAddress(object.params[0]);
    }
    poolSocket.getSubscribeObjectResponse = function () {
        return poolSocket.subscribeResponseObject;
    }
    poolSocket.getShareTargetObject = function () {
        return poolSocket.setTargetObject;
    }
    poolSocket.getNotifyObject = function () {
        return poolSocket.notifyObject;
    }
    poolSocket.getExtraNonce = function () {
        return poolSocket.extraNonce;
    }
    poolSocket.isExtraNonceSubscribed = function() {
        return poolSocket.extraNonceSubscribed;
    };
    poolSocket.sendExtraNonceSubscribe = function () {
        if (!poolSocket.extraNonceSubscribed) {
            poolSocket.extraNonceSubscribed = true;
            poolSocket.SendMessage({ id: 0, method: 'mining.extranonce.subscribe', params: [] });
        }
    }
    poolSocket.sendPBaasSubscribe = function () {
        if (!poolSocket.pbaasSubscribed) {
            poolSocket.pbaasSubscribed = true;
            poolSocket.SendMessage({ id: 0, method: 'mining.pbaas.subscribe', params: [] });
        }
    }
    poolSocket.SendMessage = function (obj) {
        //console.log("to pool", obj);
        return poolSocket.write(JSON.stringify(obj) + "\n");
    }
    
    // main pool socket
    let data = "";
    poolSocket.on('data', (chunk) => {
        if (typeof chunk !== 'string') {
            return;
        }
        data += chunk;
        let di = data.indexOf('\n');
        while (di > -1) {
            let message = data.substr(0,di);
            data = data.substr(di+1);
            di = data.indexOf('\n');
            let obj;
            try {
                obj = JSON.parse(message);
            } catch(e) {
                console.log(poolSocket.getPoolFriendlyName(), "error parsing message from pool", e);
                return;
            }
            // process messages
            if (obj.id || obj.id === 0) {
                // forward to specific miner
                let miner = undefined;
                let minerId = obj.id;
                if (minerId && poolSocket.miners.has(minerId)) {
                    miner = poolSocket.miners.get(minerId);
                    // get message id used by miner
                    let msgId = miner.getMsgId();
                    if (msgId) {
                        obj.id = msgId;
                        miner.write(JSON.stringify(obj) + '\n');
                        //console.log("forward to miner:", minerId, obj);
                    }
                }
                // check for mining.subscribe response
                if (Array.isArray(obj.result) && obj.result.length == 2) {
                    if (!poolSocket.subscribeResponseObject) {
                        clearTimeout(connectTimer);
                        poolSelect.report(poolIndex, 'ok', { ms: Date.now() - startedAt });
                    }
                    poolSocket.extraNonce = obj.result[1];
                    poolSocket.subscribeResponseObject = obj;
                    // forward data to all miners of this pool
                    for (let miner of poolSocket.miners.values()){
                        miner.sendExtraNonce();
                    }
                    console.log(poolSocket.getPoolFriendlyName(), "pool assigned nonce", poolSocket.extraNonce);
                    
                } else if (obj.id) {
                    // check accepted share result
                    let isShare = miner ? stats.shareResult(miner, obj.result === true && !obj.error, obj.error) : false;
                    if (isShare) {
                        poolSocket.noteShareReply();
                        stats.poolShare(poolIndex, obj.result === true && !obj.error, miner);
                    }
                    if (obj.error && isShare) {
                        console.log('miner', minerId, 'share rejected id', obj.id, obj.error, "on pool", poolSocket.getPoolFriendlyName(), "from ip", miner?miner.peerEndpoint:"unknown");
                        poolSocket.rejects++;
                        if (poolSocket.rejects > 10) {
                            console.log(poolSocket.getPoolFriendlyName(), 'WARN, too many consecutive rejected shares !!!');
                            poolSocket.rejects = 0;
                        }
                        if (miner) {
                            if (!miner.isExtraNonceSubscribed() && poolSocket.rejects > 3) {
                                console.log('miner', minerId, "WARN, miner software may not be supported (", miner.getMinerSoftware(), ") from ip", miner.peerEndpoint);
                            }
                        }
                    } else if (obj.error) {
                        console.log('miner', minerId, 'pool error', obj.error, "on pool", poolSocket.getPoolFriendlyName());
                    } else if (obj.result === true && isShare) {
                        //console.log ('miner', minerId, 'share accepted id', obj.id, miner?miner.peerEndpoint:"", "on pool", poolSocket.getPoolFriendlyName());
                        poolSocket.rejects = 0;
                    }
                }

            } else if (obj.method === "mining.set_target" || obj.method === "mining.notify") {
                // cache job and target
                if (obj.method === 'mining.notify') {
                    poolSocket.notifyObject = obj;
                    stats.poolJob(poolIndex);
                    let now = Date.now();
                    // forward data to all miners of this pool
                    for (let miner of poolSocket.miners.values()){
                        miner.setNotifyObject(obj, now);
                    }
                }
                else {
                    if (!poolSocket.setTargetObject || poolSocket.setTargetObject.params[0] !== obj.params[0]) stats.poolTarget(poolIndex, obj.params[0]);
                    poolSocket.setTargetObject = obj;
                    // forward data to all miners of this pool
                    for (let miner of poolSocket.miners.values()){
                        miner.setShareTargetObject(obj);
                    }
                }
            } else if (obj.method === "mining.set_extranonce") {
                poolSocket.extraNonce = obj.params[0];
                // forward data to all miners of this pool
                for (let miner of poolSocket.miners.values()){
                    miner.sendExtraNonce();
                }
                
            } else {
                
                console.log(poolSocket.getPoolFriendlyName(), "unknown response from pool", obj);
                
            }
        }
    });
    poolSocket.on('close', function() {
        clearTimeout(connectTimer);
        clearInterval(healthTimer);
        if (poolSocket.switchingAway || poolSocket.closingIdle) {
            // closed on purpose, not a health event
        } else if (poolSocket.hung) {
            poolSelect.report(poolIndex, 'timeout', { reason: poolSocket.lastErrorCode });
        } else if (!poolSocket.subscribeResponseObject) {
            poolSelect.report(poolIndex, 'fail', { reason: poolSocket.lastErrorCode || 'connection closed' });
        } else {
            poolSelect.report(poolIndex, 'lost', { reason: poolSocket.lastErrorCode || 'connection closed by pool' });
        }
        console.log(poolSocket.getPoolFriendlyName(), "pool connection lost");
        poolSocket.rejects = 0;
        poolSocket.isConnected = false;
        poolSocket.extraNonce = undefined;
        poolSocket.authorizeObject = undefined;
        poolSocket.subscribeResponseObject = undefined;
        poolSocket.minerDelAll();
    });
	return poolSocket;
};
