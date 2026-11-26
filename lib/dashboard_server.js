// Small dependency-free HTTP server for the dashboard and its JSON API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Groups } = require('./groups.js');
const { SshRunner } = require('./ssh_runner.js');
const { Registry } = require('./registry.js');
const { MinerManager } = require('./miner_manager.js');
const { Farm } = require('./farm.js');
const { Login, page: loginPage } = require('./login.js');

const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };

function safeEqual(a, b) {
    let x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// only private / local network addresses can be added by hand
function lanAddressProblem(ip) {
    let m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (m) {
        let o = m.slice(1).map(Number);
        if (o.some(x => x > 255)) return `"${ip}" is not a valid IP address`;
        let [a, b] = o;
        let lan = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
        return lan ? null : `${ip} is not a local network address (10.x, 172.16-31.x, 192.168.x, 100.64-127.x)`;
    }
    if (/^(fd|fc)[0-9a-f]{2}:[0-9a-f:]+$/i.test(ip) || /^fe80:[0-9a-f:]+$/i.test(ip)) return null;
    return ip ? `"${ip}" is not an IP address` : 'IP address missing';
}

exports.start = function (config, stats, pools) {
    let d = config.dashboard || {};
    if (d.enabled === false) return;
    let port = d.port || 8080;
    let host = d.host || '0.0.0.0';
    let page = path.resolve(__dirname, '..', 'public', 'index.html');

    let send = (res, code, body, type) => {
        res.writeHead(code, {
            'Content-Type': type || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // optional login for the dashboard ("user:pass"): the browser's own password prompt
    // (Basic auth), or the login page + cookie for browsers that can't show that prompt
    const login = new Login(config);
    let basicOk = (req) => {
        let h = req.headers.authorization || '';
        if (!h.startsWith('Basic ')) return false;
        return safeEqual(Buffer.from(h.slice(6), 'base64').toString(), d.auth);
    };
    let viewAuthOk = (req) => !d.auth || basicOk(req) || !!login.session(req);
    // optional shared token for device agents
    let agentAuthOk = (req, url) => {
        if (!d.reportToken) return true;
        let tok = req.headers['x-token'] || url.searchParams.get('token') || '';
        return safeEqual(tok, d.reportToken);
    };

    // pool control redirects all hashrate, so it needs: a dashboard login configured,
    // and a custom header + same-origin request (blocks cross-site requests riding on saved credentials)
    let controlEnabled = !!d.auth;
    let controlCheck = (req) => {
        if (!controlEnabled) return 'Pool control is disabled: set dashboard.auth ("user:password") in config.local.json and restart.';
        if (req.headers['x-vp-control'] !== '1') return 'missing control header';
        let origin = req.headers.origin;
        if (origin) {
            try { if (new URL(origin).host !== req.headers.host) return 'cross-origin request refused'; } catch (e) { return 'bad origin'; }
        }
        return null;
    };

    // editing groups is allowed for anyone who can view the dashboard, but only from the
    // page itself (custom header + same origin), so other websites can't change them
    let sameOriginCheck = (req) => {
        if (req.headers['x-vp-control'] !== '1') return 'missing control header';
        let origin = req.headers.origin;
        if (origin) {
            try { if (new URL(origin).host !== req.headers.host) return 'cross-origin request refused'; } catch (e) { return 'bad origin'; }
        }
        return null;
    };
    const groups = new Groups(config);
    const ssh = new SshRunner(config);
    const registry = new Registry(config, stats);
    ssh.attachAdb(registry.adb, () => registry.adbDisabledReason());
    const miner = new MinerManager(config, stats, ssh);
    const farm = new Farm(config, stats, registry, groups, ssh, miner);
    let authUser = (req) => {
        let h = req.headers.authorization || '';
        if (h.startsWith('Basic ')) return Buffer.from(h.slice(6), 'base64').toString().split(':')[0].slice(0, 40) || null;
        let s = login.session(req);
        return s ? s.user : null;
    };
    let readForm = (req, cb) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
        req.on('end', () => cb(new URLSearchParams(body)));
    };

    let readBody = (req, cb) => {
        let body = '';
        req.on('data', c => {
            body += c;
            if (body.length > 64 * 1024) { req.destroy(); }
        });
        req.on('end', () => {
            try { cb(null, JSON.parse(body || '{}')); } catch (e) { cb(e); }
        });
    };

    let server = http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
        let p = url.pathname;

        // device agents
        if (p === '/api/report' && req.method === 'POST') {
            if (!agentAuthOk(req, url)) return send(res, 401, { ok: false, error: 'bad token' });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                send(res, 200, stats.report(body, req.socket.remoteAddress));
            });
        }

        // the device agent script, so phones can fetch it straight from the proxy
        // for watchdogs (systemd timer, uptime monitors): 200 when healthy, 503 when stalled
        if (p === '/api/health') {
            let h = stats.health();
            return send(res, h.ok ? 200 : 503, h);
        }

        if (p === '/agent.sh') {
            return fs.readFile(path.resolve(__dirname, '..', 'agent', 'verus-agent.sh'), (err, buf) =>
                err ? send(res, 404, 'missing', 'text/plain') : send(res, 200, buf, 'text/x-shellscript; charset=utf-8'));
        }

        // ---- login page / logout ----
        if (p === '/login' && req.method === 'POST' && d.auth) {
            let ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            let wait = login.blocked(ip);
            if (wait) return send(res, 429, loginPage(`Too many wrong passwords. Try again in ${wait} s.`), 'text/html; charset=utf-8');
            return readForm(req, (form) => {
                let user = String(form.get('user') || ''), pass = String(form.get('password') || '');
                if (!login.check(user, pass)) {
                    login.failed(ip);
                    console.log(`dashboard: failed login from ${ip}`);
                    return send(res, 401, loginPage('Wrong user or password.'), 'text/html; charset=utf-8');
                }
                res.writeHead(303, { 'Set-Cookie': login.cookie(login.create(user.slice(0, 40))), 'Location': './', 'Cache-Control': 'no-store' });
                res.end();
            });
        }
        if (p === '/login' && req.method === 'GET') {
            if (!d.auth || viewAuthOk(req)) { res.writeHead(303, { Location: './' }); return res.end(); }
            return send(res, 200, loginPage(), 'text/html; charset=utf-8');
        }
        if (p === '/logout') {
            login.destroy(req);
            res.writeHead(303, { 'Set-Cookie': login.clearCookie(), 'Location': d.auth ? 'login' : './', 'Cache-Control': 'no-store' });
            return res.end();
        }

        if (!viewAuthOk(req)) {
            if (p.startsWith('/api/')) {
                res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                return res.end(JSON.stringify({ ok: false, error: 'login required' }));
            }
            // every browser goes to the login form (works in in-app / built-in browsers that never
            // show a password prompt); scripts can still send the login as Basic auth
            res.writeHead(303, { 'Location': (p.split('/').length > 2 ? '/' : '') + 'login', 'Cache-Control': 'no-store' });
            return res.end();
        }

        if (p === '/' || p === '/index.html') {
            return fs.readFile(page, (err, buf) => err ? send(res, 500, 'dashboard page missing', 'text/plain') : send(res, 200, buf, 'text/html; charset=utf-8'));
        }
        if (p === '/api/stats') {
            let snap = stats.snapshot();
            for (let w of snap.workers) w.group = groups.of(w.name);
            snap.groups = groups.list();
            // lets the page offer "Log out" when it was logged in with the login form
            snap.loggedIn = d.auth ? { user: authUser(req), viaForm: !basicOk(req) } : null;
            snap.registry = registry.info();
            return send(res, 200, snap);
        }
        // ---- remote commands over SSH (off unless ssh.enabled and dashboard.auth are set) ----
        if (p === '/api/ssh' && req.method === 'GET') return send(res, 200, ssh.info());
        if (p === '/api/ssh/run' && req.method === 'GET') {
            if (ssh.disabledReason()) return send(res, 403, { ok: false, error: ssh.disabledReason() });
            let run = ssh.get(url.searchParams.get('id') || '');
            return run ? send(res, 200, Object.assign({}, run, { summary: ssh.summary(run) })) : send(res, 404, { ok: false, error: 'unknown run' });
        }
        if (p === '/api/ssh/run' && req.method === 'POST') {
            if (ssh.disabledReason()) return send(res, 403, { ok: false, error: ssh.disabledReason() });
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                let names = Array.isArray(body.workers) ? Array.from(new Set(body.workers.filter(n => typeof n === 'string'))) : [];
                // only devices the proxy knows; their address comes from the proxy, never from the request
                let targets = names.map(n => {
                    let w = stats.workers.get(n);
                    return { name: n, ip: w ? w.ip : null };
                });
                send(res, 200, ssh.start({ targets, command: body.command, preset: body.preset, port: body.port, channel: body.channel, by: authUser(req) }));
            });
        }
        // ---- device registry: ADB actions (off unless adb.enabled and dashboard.auth are set) ----
        if (p === '/api/registry' && req.method === 'GET') return send(res, 200, registry.info());
        // farm setup check: read-only on the phones, so it runs whenever ADB is usable
        if (p === '/api/farm/check' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, async (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                let reason = registry.adbDisabledReason();
                if (reason) return send(res, 200, { ok: false, error: reason });
                let names = Array.isArray(body.workers) ? Array.from(new Set(body.workers.filter(n => typeof n === 'string'))).slice(0, 100) : [];
                let results = [];
                for (let n of names) results.push(Object.assign({ name: n }, await farm.checkOne(n)));
                stats.save();
                send(res, 200, { ok: results.some(r => r.ok), results });
            });
        }
        // set up a fresh phone: plan only for now (a real run is not enabled yet)
        if (p === '/api/farm/setup' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                if (body.dryRun === false) return send(res, 200, { ok: false, error: 'Setting up a phone for real is not switched on yet; this shows the plan only.' });
                send(res, 200, farm.setupPlan(typeof body.worker === 'string' ? body.worker : ''));
            });
        }
        // find me on/off for devices (one, or a whole group): LED colour, torch, vibration, sound
        if (p === '/api/farm/find' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, async (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                let names = Array.isArray(body.workers) ? Array.from(new Set(body.workers.filter(n => typeof n === 'string'))).slice(0, 200) : [];
                try { send(res, 200, await farm.findMe(names, body.on !== false, body.minutes, authUser(req))); }
                catch (e) { send(res, 200, { ok: false, error: e.message }); }
            });
        }
        // fix only the drifted items of one device; dryRun: true only lists the commands
        if (p === '/api/farm/apply' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, async (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                let reason = registry.adbDisabledReason();
                if (reason) return send(res, 200, { ok: false, error: reason });
                try { send(res, 200, await farm.apply(typeof body.worker === 'string' ? body.worker : '', body.dryRun !== false, authUser(req))); }
                catch (e) { send(res, 200, { ok: false, error: e.message }); }
            });
        }
        if (p.startsWith('/api/registry/') && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, async (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                let name = typeof body.worker === 'string' ? body.worker : '';
                let names = Array.isArray(body.workers) ? Array.from(new Set(body.workers.filter(n => typeof n === 'string'))).slice(0, 500) : [];
                try {
                    if (p === '/api/registry/refresh') return send(res, 200, await registry.refresh(names));
                    if (p === '/api/registry/reconnect') return send(res, 200, await registry.reconnect(name));
                    if (p === '/api/registry/reboot') return send(res, 200, await registry.reboot(name, authUser(req)));
                    if (p === '/api/registry/scan') return send(res, 200, await registry.scan());
                    if (p === '/api/registry/usb-enable') {
                        let r = await registry.usbEnable(String(body.serial || ''), String(body.name || ''));
                        if (r.ok && body.group) groups.assign([r.name], body.group);
                        return send(res, 200, r);
                    }
                    if ((p === '/api/registry/add-found' || p === '/api/registry/install-key') && registry.adbDisabledReason()) return send(res, 200, { ok: false, error: registry.adbDisabledReason() });
                    if (p === '/api/registry/add-found') {
                        // add phones found by a scan: only addresses from the last scan, never typed ones
                        let found = (registry.lastScan && registry.lastScan.found) || [];
                        let added = [], results = [];
                        for (let e of Array.isArray(body.devices) ? body.devices.slice(0, 200) : []) {
                            let f = found.find(x => x.ip === e.ip);
                            let nm = String(e.name || '').trim();
                            if (!f) { results.push({ ip: e.ip, ok: false, error: 'not in the last scan' }); continue; }
                            if (!/^[a-zA-Z0-9._@-]{1,64}$/.test(nm)) { results.push({ ip: e.ip, ok: false, error: 'name may only use letters, digits and . _ - @' }); continue; }
                            stats.addManual(nm, f.ip);
                            if (f.androidId) stats.workers.get(nm).androidId = f.androidId;
                            f.knownAs = nm;
                            added.push(nm);
                            results.push({ ip: e.ip, name: nm, ok: true });
                        }
                        if (added.length && body.group) groups.assign(added, body.group);
                        for (let n of added) registry.checkOne(n);
                        return send(res, 200, { ok: added.length > 0, added: added.length, results });
                    }
                    if (p === '/api/registry/install-key') {
                        // over Termux SSH + su: let this proxy's ADB key in, and (re)start ADB on TCP
                        let key = registry.adbPublicKey();
                        if (!key) return send(res, 200, { ok: false, error: 'This proxy has no ADB key yet: run `adb start-server` once on the proxy machine (it creates ~/.android/adbkey.pub).' });
                        if (!/^[A-Za-z0-9+\/=]+( [A-Za-z0-9._@-]+)?$/.test(key)) return send(res, 200, { ok: false, error: 'unexpected format in ~/.android/adbkey.pub' });
                        let f = '/data/misc/adb/adb_keys';
                        let cmd = `K='${key}'; su -c "mkdir -p /data/misc/adb && touch ${f} && (grep -qF '$K' ${f} || echo '$K' >> ${f}) && chown system:shell ${f} && chmod 640 ${f}; restorecon ${f} 2>/dev/null; settings put global adb_enabled 1; setprop service.adb.tcp.port ${registry.adb.cfg.port}; stop adbd; start adbd; echo ADB key installed, adbd restarted on port ${registry.adb.cfg.port}"`;
                        let targets = names.map(n => ({ name: n, ip: (stats.workers.get(n) || {}).ip || null }));
                        return send(res, 200, ssh.start({ targets, command: cmd, preset: null, internal: 'Install ADB key', channel: 'ssh', by: authUser(req) }));
                    }
                    send(res, 404, { ok: false, error: 'unknown action' });
                } catch (e) {
                    send(res, 500, { ok: false, error: e.message });
                }
            });
        }
        // ---- miner updates (needs ssh.enabled + dashboard.auth, like remote commands) ----
        if (p === '/api/miner' && req.method === 'GET') return send(res, 200, miner.info());
        if (p === '/api/miner/job' && req.method === 'GET') {
            let j = miner.job(url.searchParams.get('id') || '');
            return j ? send(res, 200, j) : send(res, 404, { ok: false, error: 'unknown job' });
        }
        if (p.startsWith('/api/miner/') && req.method === 'POST') {
            let refused = sameOriginCheck(req) || miner.disabledReason();
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, async (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                try {
                    let action = p.slice('/api/miner/'.length);
                    if (['check', 'install', 'build', 'rollback'].includes(action)) {
                        return send(res, 200, miner.start({ action, workers: body.workers, sha256: body.sha256, restart: body.restart, stopMining: body.stopMining, branch: body.branch, port: body.port, by: authUser(req) }));
                    }
                    if (action === 'latest') return send(res, 200, Object.assign({ ok: true }, await miner.refreshLatest(typeof body.branch === 'string' && /^[\w./-]{1,100}$/.test(body.branch) ? body.branch : undefined)));
                    if (action === 'add-url') return send(res, 200, await miner.addUrl(body.url, body.label));
                    if (action === 'add-device') return send(res, 200, await miner.addFromDevice(String(body.worker || ''), body.port ? Number(body.port) : undefined));
                    if (action === 'delete') return send(res, 200, miner.remove(String(body.sha256 || '')));
                    if (action === 'rename') return send(res, 200, miner.rename(String(body.sha256 || ''), body.label));
                    send(res, 404, { ok: false, error: 'unknown action' });
                } catch (e) {
                    send(res, 500, { ok: false, error: e.message });
                }
            });
        }
        if (p === '/api/devices/notes' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                send(res, 200, registry.setNotes(String(body.worker || ''), body.notes));
            });
        }
        if (p.startsWith('/api/groups/') && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                if (p === '/api/groups/assign') return send(res, 200, groups.assign(body.workers, body.group));
                if (p === '/api/groups/create') return send(res, 200, groups.create(body.name));
                if (p === '/api/groups/rename') return send(res, 200, groups.rename(String(body.from || ''), body.to));
                if (p === '/api/groups/delete') return send(res, 200, groups.remove(String(body.name || '')));
                send(res, 404, { ok: false, error: 'unknown action' });
            });
        }
        if (p === '/api/history') {
            let r = RANGES[url.searchParams.get('range')] || RANGES['6h'];
            return send(res, 200, stats.history(r, url.searchParams.get('metric')));
        }
        if (p === '/api/devices/rename' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                let from = String(body.from || ''), to = String(body.to || '').replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 64);
                let r = stats.rename(from, to);
                if (r.ok) { let g = groups.of(from); if (g) groups.assign([to], g); farm.renameDevice(from, to); try { ssh.renameHost(from, to); } catch (e) {} }
                send(res, 200, r);
            });
        }
        if (p === '/api/forget' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err || !body.worker) return send(res, 400, { ok: false });
                send(res, 200, { ok: stats.forget(String(body.worker)) });
            });
        }
        // add devices by hand (name + LAN address), e.g. to reach them over SSH before they mine
        if (p === '/api/devices/add' && req.method === 'POST') {
            let refused = sameOriginCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err || !Array.isArray(body.devices)) return send(res, 400, { ok: false, error: 'bad request' });
                if (body.devices.length > 200) return send(res, 400, { ok: false, error: 'at most 200 devices at a time' });
                let results = [], added = [];
                let byIp = new Map();
                for (let [n, w] of stats.workers) if (w.manual && w.ip) byIp.set(w.ip, n);
                for (let d of body.devices) {
                    let ip = String((d && d.ip) || '').trim();
                    let name = String((d && d.name) || '').trim() || ip;
                    let bad = lanAddressProblem(ip);
                    if (bad) { results.push({ name, ip, ok: false, error: bad }); continue; }
                    if (!/^[a-zA-Z0-9._@-]{1,64}$/.test(name)) { results.push({ name, ip, ok: false, error: 'name may only use letters, digits and . _ - @' }); continue; }
                    if (byIp.has(ip) && byIp.get(ip) !== name) { results.push({ name, ip, ok: false, error: `${ip} is already added as "${byIp.get(ip)}"` }); continue; }
                    stats.addManual(name, ip);
                    registry.checkOne(name);
                    byIp.set(ip, name);
                    added.push(name);
                    results.push({ name, ip, ok: true });
                }
                if (added.length && body.group) groups.assign(added, body.group);
                send(res, 200, { ok: added.length > 0, added: added.length, results });
            });
        }
        if (p === '/api/pools' && req.method === 'GET') {
            return send(res, 200, pools ? pools.snapshot(controlEnabled) : { pools: [] });
        }
        if (p.startsWith('/api/pools/') && req.method === 'POST') {
            if (!pools) return send(res, 404, { ok: false });
            let refused = controlCheck(req);
            if (refused) return send(res, 403, { ok: false, error: refused });
            return readBody(req, (err, body) => {
                if (err) return send(res, 400, { ok: false, error: 'bad json' });
                if (p === '/api/pools/switch') return send(res, 200, pools.manualSwitch(Number(body.index)));
                if (p === '/api/pools/auto') return send(res, 200, pools.setAuto(body.enabled === true));
                if (p === '/api/pools/reset-preferred') return send(res, 200, pools.clearPreferred());
                send(res, 404, { ok: false, error: 'unknown action' });
            });
        }
        send(res, 404, { error: 'not found' });
    });
    server.on('error', e => console.log('dashboard: http error', e.message));
    server.listen(port, host, () => console.log(`Dashboard on http://${host}:${port}/`));
    return server;
};
