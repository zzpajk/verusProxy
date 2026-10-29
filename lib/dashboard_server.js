// Small dependency-free HTTP server for the dashboard and its JSON API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Groups } = require('./groups.js');
const { SshRunner } = require('./ssh_runner.js');

const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };

function safeEqual(a, b) {
    let x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
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

    // optional basic auth for viewing the dashboard ("user:pass")
    let viewAuthOk = (req) => {
        if (!d.auth) return true;
        let h = req.headers.authorization || '';
        if (!h.startsWith('Basic ')) return false;
        return safeEqual(Buffer.from(h.slice(6), 'base64').toString(), d.auth);
    };
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
        if (!controlEnabled) return 'Pool control is disabled: set dashboard.auth ("user:password") in config.json and restart.';
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
    let authUser = (req) => {
        let h = req.headers.authorization || '';
        if (!h.startsWith('Basic ')) return null;
        return Buffer.from(h.slice(6), 'base64').toString().split(':')[0].slice(0, 40) || null;
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

        if (!viewAuthOk(req)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="verusProxy"' });
            return res.end('auth required');
        }

        if (p === '/' || p === '/index.html') {
            return fs.readFile(page, (err, buf) => err ? send(res, 500, 'dashboard page missing', 'text/plain') : send(res, 200, buf, 'text/html; charset=utf-8'));
        }
        if (p === '/api/stats') {
            let snap = stats.snapshot();
            for (let w of snap.workers) w.group = groups.of(w.name);
            snap.groups = groups.list();
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
                send(res, 200, ssh.start({ targets, command: body.command, preset: body.preset, by: authUser(req) }));
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
        if (p === '/api/forget' && req.method === 'POST') {
            return readBody(req, (err, body) => {
                if (err || !body.worker) return send(res, 400, { ok: false });
                send(res, 200, { ok: stats.forget(String(body.worker)) });
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
