// Hashrate history, kept apart from stats.json so it scales to hundreds of devices.
//
// In memory each point is compact: the time, the fleet totals and one Float64Array per metric
// (pool-side, device-reported) indexed by a device number; NaN means "not there". On disk it is
// append-only: one small JSON line per point in a file per day (data/history/minute-2026-11-26.ndjson,
// long-...), so a sample costs one append instead of rewriting everything. Device numbers are listed
// in names.json. Files older than what is kept are deleted.

const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600 * 1000;

function day(t) { return new Date(t).toISOString().slice(0, 10); }

class Series {
    constructor(store, kind, keepMs) {
        this.store = store; this.kind = kind; this.keepMs = keepMs;
        this.pts = [];
    }
    get length() { return this.pts.length; }
    first() { return this.pts[0] || null; }
    since(from) { let i = this.lowerBound(from); return this.pts.slice(i); }
    lowerBound(t) { let lo = 0, hi = this.pts.length; while (lo < hi) { let m = (lo + hi) >> 1; if (this.pts[m].t < t) lo = m + 1; else hi = m; } return lo; }

    // point from {t, tot:[eff,rep], w:{name:[eff,rep]}}
    make(t, tot, w) {
        for (let name of Object.keys(w)) this.store.idx(name);
        let n = this.store.names.length;
        let e = new Float64Array(n).fill(NaN), r = new Float64Array(n).fill(NaN);
        for (let [name, v] of Object.entries(w)) {
            let i = this.store.idx(name);
            if (v[0] !== null && v[0] !== undefined) e[i] = v[0];
            if (v[1] !== null && v[1] !== undefined) r[i] = v[1];
        }
        return { t, tot: [tot[0] ?? null, tot[1] ?? null], e, r };
    }

    push(p, write) {
        this.pts.push(p);
        let cut = p.t - this.keepMs;
        let drop = 0;
        while (drop < this.pts.length && this.pts[drop].t < cut) drop++;
        if (drop) this.pts.splice(0, drop);
        if (write !== false) this.store.append(this.kind, p);
    }
}

class HistoryStore {
    constructor(dir, opts) {
        opts = opts || {};
        this.dir = dir;
        this.names = [];
        this.index = new Map();
        this.minute = new Series(this, 'minute', opts.minuteKeepMs || DAY);
        this.long = new Series(this, 'long', opts.longKeepMs || 30 * DAY);
        this.pending = Promise.resolve();
        this.lastPrune = 0;
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }

    idx(name) {
        let i = this.index.get(name);
        if (i !== undefined) return i;
        i = this.names.length;
        this.names.push(name); this.index.set(name, i);
        this.namesDirty = true;
        return i;
    }

    // value of one device in a point: [eff, rep] (null where missing), or undefined when absent
    get(p, name) {
        let i = this.index.get(name);
        if (i === undefined) return undefined;
        let e = i < p.e.length ? p.e[i] : NaN, r = i < p.r.length ? p.r[i] : NaN;
        if (Number.isNaN(e) && Number.isNaN(r)) return undefined;
        return [Number.isNaN(e) ? null : e, Number.isNaN(r) ? null : r];
    }
    // device numbers present in a point
    present(p) {
        let out = [];
        let n = Math.max(p.e.length, p.r.length);
        for (let i = 0; i < n; i++) if (!Number.isNaN(p.e[i]) || !Number.isNaN(p.r[i])) out.push(i);
        return out;
    }

    // one line per point; only present devices are written
    line(p) {
        let i = this.present(p);
        let num = (v) => (Number.isNaN(v) || v === undefined ? null : Math.round(v));
        return JSON.stringify({ t: p.t, tot: p.tot, i, e: i.map(k => num(p.e[k])), r: i.map(k => num(p.r[k])) }) + '\n';
    }
    parse(text) {
        let o = JSON.parse(text);
        let n = o.i.length ? Math.max(...o.i) + 1 : 0;
        let e = new Float64Array(n).fill(NaN), r = new Float64Array(n).fill(NaN);
        o.i.forEach((k, j) => { if (o.e[j] !== null) e[k] = o.e[j]; if (o.r[j] !== null) r[k] = o.r[j]; });
        return { t: o.t, tot: o.tot, e, r };
    }
    file(kind, t) { return path.join(this.dir, kind + '-' + day(t) + '.ndjson'); }

    writeNames(sync) {
        if (!this.namesDirty) return;
        this.namesDirty = false;
        let f = path.join(this.dir, 'names.json'), text = JSON.stringify(this.names);
        if (sync) { fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); return; }
        this.pending = this.pending.then(() => fs.promises.writeFile(f + '.tmp', text).then(() => fs.promises.rename(f + '.tmp', f))).catch(e => console.log('history: names not saved', e.message));
    }

    // append without blocking (writes are queued so lines never interleave)
    append(kind, p) {
        this.writeNames(false);
        let f = this.file(kind, p.t), text = this.line(p);
        this.pending = this.pending.then(() => fs.promises.appendFile(f, text)).catch(e => console.log('history: point not saved', e.message));
        if (p.t - this.lastPrune > 3600 * 1000) { this.lastPrune = p.t; this.prune(p.t); }
    }

    prune(t) {
        let keep = { minute: this.minute.keepMs + DAY, long: this.long.keepMs + DAY };
        fs.promises.readdir(this.dir).then(files => {
            for (let f of files) {
                let m = /^(minute|long)-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
                if (m && t - Date.parse(m[2] + 'T00:00:00Z') > keep[m[1]]) fs.promises.unlink(path.join(this.dir, f)).catch(() => {});
            }
        }).catch(() => {});
    }

    hasFiles() { try { return fs.readdirSync(this.dir).some(f => f.endsWith('.ndjson')); } catch (e) { return false; } }

    load(t) {
        try { let n = JSON.parse(fs.readFileSync(path.join(this.dir, 'names.json'), 'utf8')); this.names = n; this.index = new Map(n.map((x, i) => [x, i])); } catch (e) {}
        let files;
        try { files = fs.readdirSync(this.dir).filter(f => /\.ndjson$/.test(f)).sort(); } catch (e) { files = []; }
        let bad = 0;
        for (let f of files) {
            let m = /^(minute|long)-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
            if (!m) continue;
            let s = m[1] === 'minute' ? this.minute : this.long;
            if (t - Date.parse(m[2] + 'T00:00:00Z') > s.keepMs + DAY) continue;
            for (let line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
                if (!line) continue;
                try { let p = this.parse(line); if (t - p.t <= s.keepMs) s.pts.push(p); } catch (e) { bad++; }   // a line cut off by a crash
            }
        }
        for (let s of [this.minute, this.long]) s.pts.sort((a, b) => a.t - b.t);
        return { points: this.minute.length + this.long.length, bad };
    }

    // old stats.json history ({t, tot, w:{name:[eff,rep]}} arrays) -> files, once
    migrate(minute, long) {
        let n = 0;
        for (let [s, src] of [[this.minute, minute || []], [this.long, long || []]]) {
            let byFile = new Map();
            for (let o of src) {
                let p = s.make(o.t, o.tot || [null, null], o.w || {});
                s.pts.push(p); n++;
                let f = this.file(s.kind, o.t);
                if (!byFile.has(f)) byFile.set(f, []);
                byFile.get(f).push(this.line(p));
            }
            for (let [f, lines] of byFile) fs.appendFileSync(f, lines.join(''));
            s.pts.sort((a, b) => a.t - b.t);
        }
        this.writeNames(true);
        return n;
    }

    flush() { return this.pending; }
}

// average a run of points into one (pool-side: a device missing from a point counts as 0, as before;
// device-reported: missing points are skipped)
function averagePoints(store, pts, t) {
    let n = 0;
    for (let p of pts) n = Math.max(n, p.e.length, p.r.length);
    let e = new Float64Array(n).fill(NaN), r = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        let seen = false, es = 0, rs = 0, rc = 0;
        for (let p of pts) {
            let ev = i < p.e.length ? p.e[i] : NaN, rv = i < p.r.length ? p.r[i] : NaN;
            if (!Number.isNaN(ev) || !Number.isNaN(rv)) seen = true;
            if (!Number.isNaN(ev)) es += ev;
            if (!Number.isNaN(rv)) { rs += rv; rc++; }
        }
        if (!seen) continue;
        e[i] = Math.round(es / pts.length);
        if (rc) r[i] = Math.round(rs / rc);
    }
    let avg = (vals) => { let v = vals.filter(x => x !== null && x !== undefined); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    return { t, tot: [avg(pts.map(p => p.tot[0])), avg(pts.map(p => p.tot[1]))], e, r };
}

module.exports = { HistoryStore, averagePoints };
