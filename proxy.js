const cluster = require("cluster");
const totalCPUs = require("os").cpus().length;
const minerListener = require('./lib/miner_listener.js');
const { FleetStats } = require('./lib/stats_master.js');
const dashboard = require('./lib/dashboard_server.js');
const { PoolManager } = require('./lib/pool_manager.js');
const poolSelect = require('./lib/pool_select.js');

// defaults from config.json, your settings from config.local.json (see lib/config.js)
let config;
try {
    config = require('./lib/config.js').load();
} catch (e) {
    console.error('Settings error:', e.message);
    process.exit(1);
}

config.version = "0.3.0";

// TODO, stratumProxy/poolConnection engine (50%)
//       api/stats engine (dashboard: lib/stats_master.js)
//       validate config

if (cluster.isMaster) {
    console.log(`VerusProxy v${config.version} by hellcatz`);

    // fleet stats + web dashboard live in the master, fed by every worker thread
    const stats = new FleetStats(config);

    // pool failover / manual switching: the master decides, every worker follows
    const pools = new PoolManager(config, function broadcast(msg) {
        for (const id in cluster.workers) {
            try { cluster.workers[id].send(msg); } catch (e) {}
        }
    }, function probeLogin() {
        for (const w of stats.workers.values()) if (w.address) return w.address;
        return null;
    });
    stats.poolNameFn = () => pools.activeConfig().name;

    dashboard.start(config, stats, pools);
    let shutdown = function() {
        stats.save();
        pools.save();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    //console.log(`Master ${process.pid} is running`);

    let my_fork = function() {
        // new workers start on whichever pool is active right now
        let worker = cluster.fork({ VP_ACTIVE_POOL: String(pools.active) });

        // example fork inter-process communications
        worker.on('message', function(msg){
            if (msg && msg.type === 'vp-stats') {
                stats.onWorkerMessage(msg);
                pools.onStats(msg);
                return;
            }
            if (msg && msg.type === 'vp-pool-event') {
                pools.onWorkerEvent(msg);
                return;
            }
            console.log('from worker:', msg);
            //worker.send({chat: "Master got worker message"});
        });
        return worker;
    };

    // allow multithreading for big farms with 1000's of workers
    let numThreads = 1; // default to 1, simple home proxy mode
    if (config.threads && typeof config.threads === 'string') {
        // assume string is "auto", leave 1 thread idle
        numThreads = totalCPUs - 1;
    } else if (config.threads && typeof config.threads === 'number') {
        numThreads = Math.min(Math.max(config.threads, 1), totalCPUs);
    }
    
    console.log(`Using ${numThreads} out of ${totalCPUs} total threads`);
    
    // fork the threads!
    for (let i = 0; i < numThreads; i++) {
        my_fork();
    }

    cluster.on("exit", (worker, code, signal) => {
        stats.onWorkerExit(worker.process.pid);
        pools.onWorkerExit(worker.process.pid);
        console.log(`worker ${worker.process.pid} died, forking again`);
        my_fork();
    });

} else {

    //console.log(`Worker ${process.pid} is running`);

    // example fork inter-process communications
    process.on('message', function(msg) {
        if (poolSelect.handleMasterMessage(msg)) return;
        console.log('from master:', msg);
    });
    //process.send({chat: "Hello master from worker!"});

    if (!config.notifyTimeoutMs) {
        config.notifyTimeoutMs = 15000;
    }

    // start stratum mining server for this fork
    minerListener.createMiningListener(config);
    
    // TODO, monitor ssl certificates for updates and udpdate our listener's TLS options ...
}
