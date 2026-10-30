// Form + cookie login for the dashboard, for browsers that can't show the standard
// password prompt (in-app / built-in browsers). The standard prompt keeps working too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'vp_session';
const MAX_AGE = 30 * 24 * 3600;          // stay logged in for 30 days

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEqual(a, b) {
    let x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Login {
    constructor(config) {
        let d = config.dashboard || {};
        this.auth = d.auth || '';
        this.file = path.resolve(__dirname, '..', d.dataDir || 'data', 'sessions.json');
        this.sessions = new Map();     // sha256(token) -> { user, expires }
        this.fails = new Map();        // ip -> { n, until }
        this.load();
    }

    enabled() { return !!this.auth; }

    check(user, password) { return safeEqual(`${user}:${password}`, this.auth); }

    // too many wrong passwords from one address: wait a minute
    blocked(ip) {
        let f = this.fails.get(ip);
        return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
    }
    failed(ip) {
        let f = this.fails.get(ip) || { n: 0, until: 0 };
        f.n++;
        if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
        this.fails.set(ip, f);
    }

    create(user) {
        let token = crypto.randomBytes(24).toString('base64url');
        this.sessions.set(sha(token), { user, expires: Date.now() + MAX_AGE * 1000 });
        this.save();
        return token;
    }

    // the session behind a request's cookie, if valid
    session(req) {
        let m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]+)').exec(req.headers.cookie || '');
        if (!m) return null;
        let key = sha(m[1]);
        let s = this.sessions.get(key);
        if (!s) return null;
        if (s.expires < Date.now()) { this.sessions.delete(key); this.save(); return null; }
        return Object.assign({ key }, s);
    }

    destroy(req) {
        let s = this.session(req);
        if (s) { this.sessions.delete(s.key); this.save(); }
    }

    cookie(token) {
        return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}`;
    }
    clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`; }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            let out = {};
            let now = Date.now();
            for (let [k, s] of this.sessions) if (s.expires > now) out[k] = s;
            // a changed dashboard.auth logs everyone out: sessions are tied to it
            fs.writeFileSync(this.file, JSON.stringify({ auth: sha(this.auth), sessions: out }), { mode: 0o600 });
        } catch (e) {}
    }
    load() {
        try {
            if (!fs.existsSync(this.file)) return;
            let d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (d.auth !== sha(this.auth)) return;
            for (let [k, s] of Object.entries(d.sessions || {})) if (s.expires > Date.now()) this.sessions.set(k, s);
        } catch (e) {}
    }
}

function page(message) {
    let msg = message ? `<p class="msg">${message}</p>` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verus Fleet · Log in</title>
<style>
:root { color-scheme: light; --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --ring:rgba(11,11,11,.12); --accent:#2a78d6; --bad:#d03b3b; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --page:#0d0d0d; --surface:#1a1a19; --ink:#f0efec; --ink-2:#c3c2b7; --ring:rgba(255,255,255,.12); --accent:#3987e5; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--page); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
form { width: 100%; max-width: 320px; background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px var(--ring); padding: 22px 20px; }
h1 { font-size: 18px; margin: 0 0 14px; }
label { display: block; color: var(--ink-2); font-size: 13px; margin: 10px 0 4px; }
input { width: 100%; font: inherit; color: var(--ink); background: var(--page); border: 0; box-shadow: inset 0 0 0 1px var(--ring); border-radius: 8px; height: 36px; padding: 0 10px; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { margin-top: 16px; width: 100%; height: 36px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.msg { color: var(--bad); margin: 0 0 6px; font-size: 13px; }
</style></head>
<body><form method="post" action="login">
<h1>Verus fleet</h1>
${msg}
<label for="u">User</label><input id="u" name="user" autocomplete="username" autocapitalize="off" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Log in</button>
</form></body></html>`;
}

module.exports = { Login, page };
