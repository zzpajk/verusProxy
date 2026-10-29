#!/usr/bin/env node
// Used by the watchdog: exits 0 when the proxy is healthy, 1 (with the reason) when not.
// Reads the dashboard port/host from your settings, so it follows config.local.json.
const http = require('http');
let config;
try {
    config = require('../lib/config.js').load();
} catch (e) {
    console.log('healthcheck: ' + e.message);
    process.exit(1);
}
let d = config.dashboard || {};
if (d.enabled === false) { console.log('healthcheck: dashboard disabled, nothing to check'); process.exit(0); }
let host = !d.host || d.host === '0.0.0.0' || d.host === '::' ? '127.0.0.1' : d.host;
let port = d.port || 8080;
let req = http.get({ host, port, path: '/api/health', timeout: 10000 }, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
        if (res.statusCode === 200) process.exit(0);
        console.log(`healthcheck: http://${host}:${port}/api/health answered ${res.statusCode} ${body.slice(0, 200)}`);
        process.exit(1);
    });
});
req.on('timeout', () => { console.log(`healthcheck: no answer from http://${host}:${port} within 10 s`); req.destroy(); process.exit(1); });
req.on('error', e => { console.log(`healthcheck: cannot reach http://${host}:${port}: ${e.code || e.message}`); process.exit(1); });
