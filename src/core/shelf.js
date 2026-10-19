'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const files = require('./files');

const TEXT_LIMIT = 256 * 1024;
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

// The shelf's contents. Every computer holds a copy of the item list and
// merges what the others send it. Each item carries a version stamp so the
// latest change wins, except removal, which is final: once anyone removes an
// item (or its linger time runs out) it stays removed everywhere.
//
// Separately, each computer tracks where its own copy of an item's bytes is
// (`local`). Items dropped here point at the original file; items from other
// computers are downloaded into storeDir.
class Shelf extends EventEmitter {
  constructor({ dataDir, self }) {
    super();
    this.self = self; // { id, name }
    this.dataDir = dataDir;
    this.storeDir = path.join(dataDir, 'store');
    this.outboxDir = path.join(dataDir, 'outbox');
    this.statePath = path.join(dataDir, 'shelf.json');
    this.items = new Map();
    this.local = new Map(); // id -> { path, state: 'ready'|'missing'|'downloading', got }
    this._saveTimer = null;
  }

  async load() {
    await fs.promises.mkdir(this.storeDir, { recursive: true });
    await fs.promises.mkdir(this.outboxDir, { recursive: true });
    let saved = { items: [], local: {} };
    try {
      saved = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8'));
    } catch {}
    for (const it of saved.items || []) this.items.set(it.id, it);
    for (const it of this.items.values()) {
      if (it.removed || it.kind === 'text') continue;
      const p = (saved.local || {})[it.id] || this.storePath(it);
      this.local.set(it.id, { path: p, state: (await files.exists(p)) ? 'ready' : 'missing', got: 0 });
    }
    await this._cleanStore();
    await fs.promises.rm(this.outboxDir, { recursive: true, force: true });
    await fs.promises.mkdir(this.outboxDir, { recursive: true });
  }

  storePath(it) {
    return path.join(this.storeDir, it.id, files.safeName(it.name));
  }

  // ---- reading ----

  visible() {
    return [...this.items.values()]
      .filter((it) => !it.removed)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  payload() {
    return [...this.items.values()];
  }

  have() {
    const ids = [];
    for (const [id, l] of this.local) if (l.state === 'ready') ids.push(id);
    return ids;
  }

  needsDownload() {
    return this.visible().filter((it) => {
      if (it.kind === 'text') return false;
      const l = this.local.get(it.id);
      return !l || l.state === 'missing';
    });
  }

  // ---- local changes ----

  async addPath(p) {
    const desc = await files.describe(p);
    const it = this._newItem(desc);
    this.local.set(it.id, { path: path.resolve(p), state: 'ready', got: 0 });
    this._put(it, true);
    return it;
  }

  async addBuffer(name, buf) {
    const it = this._newItem({ kind: 'file', name, size: buf.length });
    const dst = this.storePath(it);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.writeFile(dst, buf);
    this.local.set(it.id, { path: dst, state: 'ready', got: 0 });
    this._put(it, true);
    return it;
  }

  addText(text) {
    text = String(text);
    if (Buffer.byteLength(text) > TEXT_LIMIT) throw new Error('Text is too long for the shelf');
    const firstLine = text.trim().split(/\r?\n/)[0].slice(0, 80) || 'Text';
    const it = this._newItem({ kind: 'text', name: firstLine, size: Buffer.byteLength(text), text });
    this._put(it, true);
    return it;
  }

  // Starts the linger countdown after something was dragged or saved out.
  // Taking it again doesn't push the deadline back.
  take(id, lingerMs) {
    const it = this.items.get(id);
    if (!it || it.removed || it.expiresAt) return;
    this._update(it, { expiresAt: Date.now() + lingerMs });
  }

  keep(id) {
    const it = this.items.get(id);
    if (!it || it.removed || !it.expiresAt) return;
    this._update(it, { expiresAt: null });
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it || it.removed) return;
    this._tombstone(it);
  }

  clearAll() {
    for (const it of this.visible()) this._tombstone(it);
  }

  // ---- remote changes ----

  // Merges another computer's item list. Returns true if anything changed.
  merge(remoteItems) {
    let changed = false;
    for (const r of remoteItems || []) {
      if (!r || typeof r.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(r.id)) continue;
      const l = this.items.get(r.id);
      if (!l) {
        if (!r.removed && r.expiresAt && r.expiresAt <= Date.now()) continue;
        this.items.set(r.id, r);
        if (!r.removed) this.emit('arrived', r);
        changed = true;
        continue;
      }
      if (l.removed) continue;
      if (r.removed || newer(r, l)) {
        this.items.set(r.id, r);
        changed = true;
      }
      if (r.removed) this._dropLocal(r.id);
    }
    if (changed) this._changed(true);
    return changed;
  }

  // Expires lingering items and forgets old tombstones. Run every few seconds.
  sweep() {
    const now = Date.now();
    for (const it of [...this.items.values()]) {
      if (!it.removed && it.expiresAt && it.expiresAt <= now) this._tombstone(it);
      else if (it.removed && now - it.v > TOMBSTONE_TTL) {
        this.items.delete(it.id);
        this._save();
      }
    }
  }

  // ---- download bookkeeping (driven by the network layer) ----

  setLocal(id, patch) {
    const cur = this.local.get(id) || { path: null, state: 'missing', got: 0 };
    const next = { ...cur, ...patch };
    this.local.set(id, next);
    const becameReady = patch.state === 'ready' && cur.state !== 'ready';
    if (becameReady) this._save();
    this.emit('change', { sync: becameReady });
  }

  // ---- internals ----

  _newItem(desc) {
    const now = Date.now();
    return {
      id: crypto.randomBytes(12).toString('hex'),
      ...desc,
      addedBy: this.self.id,
      addedByName: this.self.name,
      addedAt: now,
      expiresAt: null,
      removed: false,
      v: now,
      vBy: this.self.id,
    };
  }

  _put(it, sync) {
    this.items.set(it.id, it);
    this._changed(sync);
  }

  _update(it, patch) {
    const v = Math.max(Date.now(), it.v + 1);
    this._put({ ...it, ...patch, v, vBy: this.self.id }, true);
  }

  _tombstone(it) {
    const v = Math.max(Date.now(), it.v + 1);
    this._dropLocal(it.id);
    this._put({ id: it.id, removed: true, addedAt: it.addedAt, v, vBy: this.self.id }, true);
  }

  // Deletes this computer's copy, but only if it lives in the store. Files
  // dropped on this computer are referenced in place and never touched.
  _dropLocal(id) {
    const l = this.local.get(id);
    this.local.delete(id);
    this.emit('dropped', id);
    const dir = path.join(this.storeDir, id);
    if (l && l.path && !files.isInside(l.path, this.storeDir)) return;
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  async _cleanStore() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.storeDir);
    } catch {}
    for (const name of entries) {
      const it = this.items.get(name);
      const l = this.local.get(name);
      const keep = it && !it.removed && l && l.state === 'ready' && files.isInside(l.path, this.storeDir);
      if (!keep) await fs.promises.rm(path.join(this.storeDir, name), { recursive: true, force: true });
    }
  }

  _changed(sync) {
    this._save();
    this.emit('change', { sync });
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow().catch(() => {}), 300);
  }

  async saveNow() {
    clearTimeout(this._saveTimer);
    const local = {};
    for (const [id, l] of this.local) if (l.path && l.state === 'ready') local[id] = l.path;
    const data = JSON.stringify({ items: [...this.items.values()], local });
    const tmp = this.statePath + '.tmp';
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, this.statePath);
  }
}

function newer(a, b) {
  if (a.v !== b.v) return a.v > b.v;
  return String(a.vBy) > String(b.vBy);
}

module.exports = { Shelf, TEXT_LIMIT };
