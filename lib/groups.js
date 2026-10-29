// Persistent device groups (runs in the cluster master).
// Each device (worker name) belongs to at most one group, so group totals never double count.
// Stored in data/groups.json so groups survive restarts and are the same in every browser.

const fs = require('fs');
const path = require('path');

const MAX_GROUPS = 100;

function cleanName(v) {
    if (typeof v !== 'string') return null;
    let s = v.replace(/[\u0000-\u001f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return s.length ? s : null;
}

class Groups {
    constructor(config) {
        let d = config.dashboard || {};
        this.file = path.resolve(__dirname, '..', d.dataDir || 'data', 'groups.json');
        this.names = [];            // ordered list of group names (empty groups are kept)
        this.members = new Map();   // worker -> group name
        this.load();
    }

    of(worker) { return this.members.get(worker) || null; }

    list() {
        let counts = new Map(this.names.map(n => [n, 0]));
        for (let g of this.members.values()) counts.set(g, (counts.get(g) || 0) + 1);
        return this.names.map(name => ({ name, members: counts.get(name) || 0 }));
    }

    create(name) {
        name = cleanName(name);
        if (!name) return { ok: false, error: 'invalid group name' };
        if (this.names.includes(name)) return { ok: true, name };
        if (this.names.length >= MAX_GROUPS) return { ok: false, error: 'too many groups' };
        this.names.push(name);
        this.save();
        return { ok: true, name };
    }

    // group null/"" = remove from any group
    assign(workers, group) {
        if (!Array.isArray(workers) || workers.length === 0 || workers.length > 5000) return { ok: false, error: 'no devices given' };
        let name = null;
        if (group !== null && group !== undefined && group !== '') {
            let c = this.create(group);
            if (!c.ok) return c;
            name = c.name;
        }
        let n = 0;
        for (let w of workers) {
            if (typeof w !== 'string' || !w || w.length > 64) continue;
            if (name) this.members.set(w, name); else this.members.delete(w);
            n++;
        }
        this.save();
        return { ok: true, group: name, changed: n };
    }

    rename(from, to) {
        to = cleanName(to);
        if (!this.names.includes(from)) return { ok: false, error: 'unknown group' };
        if (!to) return { ok: false, error: 'invalid group name' };
        if (to === from) return { ok: true, name: to };
        if (this.names.includes(to)) {
            // renaming onto an existing group merges them
            this.names = this.names.filter(n => n !== from);
        } else {
            this.names = this.names.map(n => (n === from ? to : n));
        }
        for (let [w, g] of this.members) if (g === from) this.members.set(w, to);
        this.save();
        return { ok: true, name: to };
    }

    remove(name) {
        if (!this.names.includes(name)) return { ok: false, error: 'unknown group' };
        this.names = this.names.filter(n => n !== name);
        for (let [w, g] of this.members) if (g === name) this.members.delete(w);
        this.save();
        return { ok: true };
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            let members = {};
            for (let [w, g] of this.members) members[w] = g;
            fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, groups: this.names, members }, null, 1));
            fs.renameSync(this.file + '.tmp', this.file);
        } catch (e) {
            console.log('groups: unable to save', e.message);
        }
    }

    load() {
        try {
            if (!fs.existsSync(this.file)) return;
            let d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.names = (Array.isArray(d.groups) ? d.groups : []).map(cleanName).filter(Boolean).slice(0, MAX_GROUPS);
            for (let [w, g] of Object.entries(d.members || {})) {
                g = cleanName(g);
                if (!g) continue;
                if (!this.names.includes(g)) this.names.push(g);
                this.members.set(w, g);
            }
        } catch (e) {
            console.log('groups: unable to load', e.message);
        }
    }
}

exports.Groups = Groups;
