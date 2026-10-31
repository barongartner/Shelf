'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const files = require('./files');

const TEXT_LIMIT = 256 * 1024;
// Tombstones are tiny, so they are kept for years: a computer that was away
// for however long cannot bring back what was removed.
const TOMBSTONE_TTL = 10 * 365 * 24 * 60 * 60 * 1000;
const DEVICE_TOUCH_EVERY = 10 * 60 * 1000;
// A computer that did not set an item's linger time waits this long past it
// before giving up on hearing the removal from the one that did, so a fast
// clock on one computer cannot throw things away early everywhere.
const LINGER_GRACE = 60 * 60 * 1000;
const CLOCK_SLACK = 5 * 60 * 1000;
const KINDS = new Set(['file', 'folder', 'text', 'device']);

// The shelf's contents. Every computer holds a copy of the item list and
// merges what the others send it. Each item carries a version stamp so the
// latest change wins, except removal, which is final: once anyone removes an
// item (or its linger time runs out) it stays removed everywhere.
//
// Separately, each computer tracks where its own copy of an item's bytes is
// (`local`). Items dropped here point at the original file; items from other
// computers are downloaded into storeDir.
//
// Phones and browsers that were let in through a QR code are kept on the
// same list as items of kind 'device', so every computer on the shelf
// accepts them and removing one removes it everywhere.
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
    this._saveChain = Promise.resolve();
    this._saveSeq = 0;
  }

  async load() {
    await fs.promises.mkdir(this.storeDir, { recursive: true });
    await fs.promises.mkdir(this.outboxDir, { recursive: true });
    let saved = { items: [], local: {} };
    let unreadable = false;
    let raw = null;
    try {
      raw = await fs.promises.readFile(this.statePath, 'utf8');
    } catch {}
    if (raw !== null) {
      try {
        saved = JSON.parse(raw);
      } catch {
        // Keep the broken file for inspection and, above all, do not treat an
        // unreadable list as an empty one: the store stays untouched.
        unreadable = true;
        await fs.promises.rename(this.statePath, `${this.statePath}.bad-${Date.now()}`).catch(() => {});
      }
    }
    for (const it of saved.items || []) {
      const clean = sanitizeRemote(it, { trustTime: true });
      if (clean) this.items.set(clean.id, clean);
    }
    const savedLocal = saved.local || {};
    for (const it of [...this.items.values()]) {
      if (it.removed || it.kind === 'text' || it.kind === 'device') continue;
      const entry = savedLocal[it.id];
      const rec = typeof entry === 'string' ? { path: entry } : entry || {};
      const p = rec.path || this.storePath(it);
      const present = await files.exists(p);
      if (rec.uploading && !present) {
        // The app died while a phone was sending this; it can never finish.
        this._tombstone(it);
        continue;
      }
      this.local.set(it.id, { path: p, state: present ? 'ready' : 'missing', got: 0 });
    }
    if (unreadable) await this._rebuildFromStore();
    else await this._cleanStore();
    for (const name of await fs.promises.readdir(this.dataDir).catch(() => [])) {
      if (/^shelf\.json\..*\.tmp$/.test(name)) await fs.promises.rm(path.join(this.dataDir, name), { force: true }).catch(() => {});
    }
    await fs.promises.rm(this.outboxDir, { recursive: true, force: true });
    await fs.promises.mkdir(this.outboxDir, { recursive: true });
  }

  storePath(it) {
    return path.join(this.storeDir, it.id, files.safeName(it.name));
  }

  // ---- reading ----

  visible() {
    return [...this.items.values()]
      .filter((it) => !it.removed && it.kind !== 'device')
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
    await this._putLocal(it);
    return it;
  }

  async addBuffer(name, buf) {
    const it = this._newItem({ kind: 'file', name, size: buf.length });
    const dst = this.storePath(it);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.writeFile(dst, buf);
    this.local.set(it.id, { path: dst, state: 'ready', got: 0 });
    await this._putLocal(it);
    return it;
  }

  addText(text, by) {
    text = String(text);
    if (Buffer.byteLength(text) > TEXT_LIMIT) throw new Error('Text is too long for the shelf');
    const firstLine = text.trim().split(/\r?\n/)[0].slice(0, 80) || 'Text';
    const it = this._newItem({ kind: 'text', name: firstLine, size: Buffer.byteLength(text), text }, by);
    this._putLocal(it);
    if (by) this.emit('arrived', it);
    return it;
  }

  // Receives a file streamed in by a phone or browser. The item shows up on
  // every shelf right away, with progress, and becomes downloadable by the
  // other computers once the whole file is here. A failed or abandoned
  // upload is removed again everywhere.
  async addUpload({ name, size, stream, by, mtime }) {
    const it = this._newItem({ kind: 'file', name: files.safeName(name), size: Math.max(0, Math.floor(Number(size)) || 0) }, by);
    const dst = this.storePath(it);
    const dir = path.dirname(dst);
    const tmp = path.join(dir, '.partial-' + path.basename(dst));
    await fs.promises.mkdir(dir, { recursive: true });
    this.local.set(it.id, { path: dst, state: 'downloading', got: 0, uploading: true });
    await this._putLocal(it);
    if (by) this.emit('arrived', it);
    let got = 0;
    let last = 0;
    const count = new Transform({
      transform: (chunk, _enc, cb) => {
        got += chunk.length;
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          this.setLocal(it.id, { got });
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, count, fs.createWriteStream(tmp));
      if (it.size && got !== it.size) throw new Error('upload cut short');
      if (mtime) await fs.promises.utimes(tmp, new Date(mtime), new Date(mtime)).catch(() => {});
      await fs.promises.rename(tmp, dst);
    } catch (err) {
      this.local.delete(it.id);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      const cur = this.items.get(it.id);
      if (cur && !cur.removed) this._tombstone(cur);
      throw err;
    }
    const cur = this.items.get(it.id);
    if (!cur || cur.removed) {
      this.local.delete(it.id);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new Error('removed while uploading');
    }
    if (cur.size !== got) this._update(cur, { size: got });
    this.setLocal(it.id, { state: 'ready', got, path: dst, uploading: false });
    return this.items.get(it.id);
  }

  // Starts the linger countdown after something was dragged or saved out.
  // Taking it again doesn't push the deadline back.
  take(id, lingerMs) {
    const it = this.items.get(id);
    if (!it || it.removed || it.expiresAt || !lingerMs) return;
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

  // Leaves everything behind: used when this computer starts a new shelf.
  // Tombstones are kept so the old items cannot come back through a peer
  // that is still on the old code.
  forgetAll() {
    for (const it of [...this.items.values()]) if (!it.removed) this._tombstone(it);
  }

  // ---- phones and browsers ----

  devices() {
    return [...this.items.values()]
      .filter((it) => !it.removed && it.kind === 'device')
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  addDevice({ name, tokenHash, ua }) {
    const it = this._newItem({
      kind: 'device',
      name: String(name || 'Phone').trim().slice(0, 60) || 'Phone',
      tokenHash: String(tokenHash),
      ua: String(ua || '').slice(0, 200),
      lastSeen: Date.now(),
    });
    this._putLocal(it);
    return it;
  }

  deviceByTokenHash(hash) {
    if (typeof hash !== 'string' || !hash) return null;
    for (const it of this.items.values()) {
      if (it.removed || it.kind !== 'device' || typeof it.tokenHash !== 'string') continue;
      if (it.tokenHash.length === hash.length && crypto.timingSafeEqual(Buffer.from(it.tokenHash), Buffer.from(hash))) return it;
    }
    return null;
  }

  // Remembers when a phone was last here, without chattering: at most one
  // synced update every ten minutes per device.
  touchDevice(id) {
    const it = this.items.get(id);
    if (!it || it.removed || it.kind !== 'device') return;
    if (Date.now() - (it.lastSeen || 0) < DEVICE_TOUCH_EVERY) return;
    this._update(it, { lastSeen: Date.now() });
  }

  renameDevice(id, name) {
    const it = this.items.get(id);
    const clean = String(name || '').trim().slice(0, 60);
    if (!it || it.removed || it.kind !== 'device' || !clean) return;
    this._update(it, { name: clean });
  }

  removeDevice(id) {
    const it = this.items.get(id);
    if (!it || it.removed || it.kind !== 'device') return;
    this._tombstone(it);
  }

  // ---- remote changes ----

  // Merges another computer's item list. Returns true if anything changed.
  // Everything coming in is rebuilt from whitelisted fields first.
  merge(remoteItems) {
    let changed = false;
    const now = Date.now();
    for (const raw of Array.isArray(remoteItems) ? remoteItems : []) {
      const r = sanitizeRemote(raw);
      if (!r) continue;
      const l = this.items.get(r.id);
      if (!l) {
        if (!r.removed && r.expiresAt && r.expiresAt <= now) continue;
        this.items.set(r.id, r);
        if (!r.removed && r.kind !== 'device') this.emit('arrived', r);
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
    this._sweeps = (this._sweeps || 0) + 1;
    if (this._sweeps % 5 === 0) this._reprobe().catch(() => {});
    for (const it of [...this.items.values()]) {
      if (!it.removed && it.expiresAt) {
        const grace = it.vBy === this.self.id ? 0 : LINGER_GRACE;
        if (it.expiresAt + grace <= now) this._tombstone(it);
      } else if (it.removed && now - it.v > TOMBSTONE_TTL) {
        this.items.delete(it.id);
        this._save();
      }
    }
  }

  // Refreshes a folder's manifest after something inside it changed on disk
  // here (a file was deleted or renamed), so the others stop asking for it.
  async redescribe(id) {
    const it = this.items.get(id);
    const l = this.local.get(id);
    if (!it || it.removed || it.kind !== 'folder' || !l || l.state !== 'ready') return;
    try {
      const desc = await files.describe(l.path);
      this._update(this.items.get(id), { files: desc.files, dirs: desc.dirs, size: desc.size });
    } catch {
      this.setLocal(id, { state: 'missing' });
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

  _newItem(desc, by) {
    const now = Date.now();
    return {
      id: crypto.randomBytes(12).toString('hex'),
      ...desc,
      addedBy: by ? by.id : this.self.id,
      addedByName: by ? by.name : this.self.name,
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

  // Something that started here is written to disk before the others hear
  // about it, so a crash in between cannot leave an item that no computer
  // can supply.
  _putLocal(it) {
    this.items.set(it.id, it);
    this.emit('change', { sync: false });
    return this.saveNow().then(() => this.emit('change', { sync: true }));
  }

  _update(it, patch) {
    const v = Math.max(Date.now(), it.v + 1);
    this._put({ ...it, ...patch, v, vBy: this.self.id }, true);
  }

  _tombstone(it) {
    const v = Math.max(Date.now(), it.v + 1);
    this._dropLocal(it.id);
    this._put({ id: it.id, kind: it.kind, removed: true, addedAt: it.addedAt, v, vBy: this.self.id }, true);
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
      const keep = it && !it.removed && l && (l.state === 'ready' || l.state === 'missing') && files.isInside(l.path, this.storeDir);
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

  // Writes are chained so two never share a temp file, and each uses its
  // own temp name.
  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveChain = this._saveChain.then(() => this._writeState()).catch(() => {});
    return this._saveChain;
  }

  async _writeState() {
    const local = {};
    for (const [id, l] of this.local) if (l.path) local[id] = { path: l.path, state: l.state, uploading: !!l.uploading };
    const data = JSON.stringify({ items: [...this.items.values()], local });
    const tmp = `${this.statePath}.${process.pid}.${++this._saveSeq}.tmp`;
    const fh = await fs.promises.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, this.statePath);
  }

  // A file dropped in place that went missing (an unplugged drive) is
  // looked for again, so plugging it back in is enough.
  async _reprobe() {
    for (const [id, l] of this.local) {
      if (l.state !== 'missing' || !l.path || files.isInside(l.path, this.storeDir)) continue;
      if (await files.exists(l.path)) this.setLocal(id, { state: 'ready', got: 0 });
    }
  }

  // With the item list lost, whatever the store still holds becomes items
  // again, so nothing a phone sent is thrown away.
  async _rebuildFromStore() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.storeDir);
    } catch {}
    for (const id of entries) {
      if (!/^[a-f0-9]{16,64}$/.test(id) || this.items.has(id)) continue;
      const dir = path.join(this.storeDir, id);
      let names = [];
      try {
        names = (await fs.promises.readdir(dir)).filter((n) => !n.startsWith('.partial-'));
      } catch {
        continue;
      }
      if (names.length !== 1) continue;
      try {
        const p = path.join(dir, names[0]);
        const desc = await files.describe(p);
        this.items.set(id, { ...this._newItem(desc), id });
        this.local.set(id, { path: p, state: 'ready', got: 0 });
      } catch {}
    }
    if (entries.length) this._save();
  }
}

function newer(a, b) {
  if (a.v !== b.v) return a.v > b.v;
  return String(a.vBy) > String(b.vBy);
}

// Rebuilds an item from another computer (or from disk) out of the fields
// the shelf understands, with every one bounded. Returns null for anything
// that cannot be an item.
function sanitizeRemote(r, { trustTime = false } = {}) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(r.id)) return null;
  const maxTime = trustTime ? Number.MAX_SAFE_INTEGER : Date.now() + CLOCK_SLACK;
  const num = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : null);
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const v = num(r.v, maxTime);
  const addedAt = num(r.addedAt, maxTime);
  if (v === null || addedAt === null) return null;
  const kind = KINDS.has(r.kind) ? r.kind : null;
  if (r.removed) return { id: r.id, kind: kind || undefined, removed: true, addedAt, v, vBy: str(r.vBy, 64) };
  if (!kind) return null;
  const out = {
    id: r.id,
    kind,
    name: str(r.name, 255) || 'item',
    size: num(r.size, Number.MAX_SAFE_INTEGER) ?? 0,
    addedBy: str(r.addedBy, 64),
    addedByName: str(r.addedByName, 80),
    addedAt,
    expiresAt: r.expiresAt == null ? null : num(r.expiresAt, Number.MAX_SAFE_INTEGER),
    removed: false,
    v,
    vBy: str(r.vBy, 64),
  };
  if (kind === 'text') {
    if (typeof r.text !== 'string' || Buffer.byteLength(r.text) > TEXT_LIMIT) return null;
    out.text = r.text;
  } else if (kind === 'folder') {
    if (!Array.isArray(r.files) || !Array.isArray(r.dirs) || r.files.length + r.dirs.length > files.MAX_ENTRIES) return null;
    out.files = r.files
      .filter((f) => f && typeof f.p === 'string' && f.p && f.p.length <= 1024 && typeof f.s === 'number' && Number.isFinite(f.s) && f.s >= 0)
      .map((f) => ({ p: f.p, s: Math.floor(f.s) }));
    out.dirs = r.dirs.filter((d) => typeof d === 'string' && d && d.length <= 1024);
  } else if (kind === 'device') {
    if (typeof r.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.tokenHash)) return null;
    out.tokenHash = r.tokenHash;
    out.ua = str(r.ua, 200);
    out.lastSeen = num(r.lastSeen, maxTime) ?? addedAt;
  }
  return out;
}

module.exports = { Shelf, sanitizeRemote, TEXT_LIMIT, TOMBSTONE_TTL, LINGER_GRACE };
