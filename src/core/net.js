'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const files = require('./files');

const DEFAULT_PORT = 47474;
const ONLINE_WINDOW = 35 * 1000;
const TICK_MS = 2000;
const SYNC_EVERY_TICKS = 5;
const MAX_DOWNLOADS = 3;
const MAX_BODY = 64 * 1024 * 1024;

// Shelf code -> the secret peers present on every request, and a short public
// id advertised over mDNS so computers on different shelves ignore each other.
function codeKeys(code) {
  const norm = normalizeCode(code);
  return {
    token: crypto.createHash('sha256').update('shelf-token:' + norm).digest('hex'),
    sid: crypto.createHash('sha256').update('shelf-id:' + norm).digest('hex').slice(0, 12),
  };
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function newCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function cleanAddr(a) {
  return String(a || '').replace(/^::ffff:/, '');
}

function isIPv4(a) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(a);
}

// Talks to the other computers: an HTTP server they sync with and download
// from, mDNS to find them, and a download queue that pulls every item this
// computer doesn't have a copy of yet.
class Net extends EventEmitter {
  constructor({ shelf, self, code, port = DEFAULT_PORT, mdns = true, onPairRequest, tickMs = TICK_MS }) {
    super();
    this.tickMs = tickMs;
    this.shelf = shelf;
    this.self = self;
    this.preferredPort = port;
    this.useMdns = mdns;
    this.onPairRequest = onPairRequest || (async () => false);
    this.peers = new Map(); // same shelf
    this.nearby = new Map(); // Shelf apps on a different shelf
    this.active = new Map(); // id -> AbortController
    this.backoff = new Map(); // id -> retry-after ms
    this.pairing = false;
    this._setCode(code);

    shelf.on('change', ({ sync }) => {
      if (sync) this.scheduleSync();
      this.pump();
    });
    shelf.on('dropped', (id) => {
      const ac = this.active.get(id);
      if (ac) ac.abort();
    });
  }

  _setCode(code) {
    this.code = code;
    const { token, sid } = codeKeys(code);
    this.token = token;
    this.sid = sid;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
        else res.destroy();
      });
    });
    this.port = await listen(this.server, this.preferredPort);
    if (this.useMdns) this._startMdns();
    this._ticks = 0;
    this._timer = setInterval(() => this._tick(), this.tickMs);
  }

  async stop() {
    clearInterval(this._timer);
    clearTimeout(this._syncTimer);
    for (const ac of this.active.values()) ac.abort();
    if (this.bonjour) {
      await new Promise((r) => this.bonjour.unpublishAll(r));
      this.bonjour.destroy();
    }
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((r) => this.server.close(r));
    }
  }

  // ---- shelf membership ----

  setCode(code) {
    this._setCode(code);
    for (const p of this.peers.values()) this.nearby.set(p.id, { id: p.id, name: p.name, sid: p.sid, addr: p.addr, port: p.port });
    this.peers.clear();
    for (const n of [...this.nearby.values()]) if (n.sid === this.sid) this._seen(n);
    this._republish();
    this.emit('peers');
    this.syncNow();
  }

  setName(name) {
    this.self.name = name;
    this._republish();
    this.syncNow();
  }

  peerList() {
    const now = Date.now();
    return [...this.peers.values()]
      .map((p) => ({ id: p.id, name: p.name, online: now - p.lastOk < ONLINE_WINDOW, addr: p.addr, port: p.port }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  nearbyList() {
    return [...this.nearby.values()]
      .filter((n) => !this.peers.has(n.id))
      .map((n) => ({ id: n.id, name: n.name, addr: n.addr }));
  }

  // Asks a nearby computer to let this one join its shelf. The other computer
  // shows a prompt; if accepted it answers with its shelf code.
  async requestJoin(nearbyId) {
    const n = this.nearby.get(nearbyId);
    if (!n) throw new Error('That computer is no longer nearby');
    const body = { id: this.self.id, name: this.self.name, port: this.port };
    const r = await request('POST', `http://${n.addr}:${n.port}/pair`, { body, timeout: 70 * 1000 });
    if (r.status === 403) throw new Error(`${n.name} said no`);
    if (r.status !== 200 || !r.json || !r.json.code) throw new Error(`${n.name} didn't answer`);
    this.setCode(r.json.code);
    this._seen({ ...n, sid: this.sid });
    return r.json.code;
  }

  // Adds a computer by IP address, for networks where mDNS doesn't get through.
  async addAddress(host, port = DEFAULT_PORT) {
    const r = await request('GET', `http://${host}:${port}/hello`, { timeout: 4000 });
    if (r.status !== 200 || !r.json || r.json.app !== 'shelf') throw new Error(`No Shelf app at ${host}:${port}`);
    const h = r.json;
    if (h.id === this.self.id) throw new Error("That's this computer");
    this._seen({ id: h.id, name: h.name, sid: h.sid, addr: host, port: h.port || port });
    return h.sid === this.sid ? 'peer' : 'nearby';
  }

  // ---- sync ----

  scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this.syncNow(), 40);
  }

  syncNow() {
    return Promise.all([...this.peers.values()].map((p) => this._syncPeer(p)));
  }

  _payload() {
    return {
      from: { id: this.self.id, name: this.self.name, port: this.port },
      items: this.shelf.payload(),
      have: this.shelf.have(),
    };
  }

  async _syncPeer(p) {
    if (p.syncing) {
      p.again = true;
      return;
    }
    p.syncing = true;
    try {
      const r = await request('POST', `http://${p.addr}:${p.port}/sync`, {
        body: this._payload(),
        headers: { 'x-shelf-token': this.token },
        timeout: 8000,
      });
      if (r.status === 401) {
        // They moved to a different shelf.
        this.peers.delete(p.id);
        this.nearby.set(p.id, { ...p, sid: '?' });
        this.emit('peers');
        return;
      }
      if (r.status !== 200 || !r.json) throw new Error('sync failed');
      p.lastOk = Date.now();
      if (r.json.from?.name && r.json.from.name !== p.name) {
        p.name = r.json.from.name;
        this.emit('peers');
      }
      p.have = new Set(r.json.have || []);
      this.shelf.merge(r.json.items);
      this.pump();
    } catch {
      // Stays offline until a sync gets through; _refreshOnline reports it.
    } finally {
      this._refreshOnline();
      p.syncing = false;
      if (p.again) {
        p.again = false;
        this._syncPeer(p);
      }
    }
  }

  // Emits 'peers' whenever a computer comes online or drops off.
  _refreshOnline() {
    const now = Date.now();
    let flipped = false;
    for (const p of this.peers.values()) {
      const online = now - p.lastOk < ONLINE_WINDOW;
      if (online !== p.online) {
        p.online = online;
        flipped = true;
      }
    }
    if (flipped) this.emit('peers');
  }

  _tick() {
    this.shelf.sweep();
    this._refreshOnline();
    if (++this._ticks % SYNC_EVERY_TICKS === 0) {
      this.syncNow();
      if (this.browser && this._ticks % (SYNC_EVERY_TICKS * 3) === 0) this.browser.update();
    }
    this.pump();
  }

  // Records a computer we heard from (mDNS, an incoming sync, or a manual add).
  _seen({ id, name, sid, addr, port }) {
    if (!id || id === this.self.id || !addr || !port) return null;
    if (sid === this.sid) {
      let p = this.peers.get(id);
      const isNew = !p;
      if (!p) p = { id, lastOk: 0, have: new Set() };
      Object.assign(p, { name: name || p.name || 'Computer', addr, port: Number(port), sid });
      this.peers.set(id, p);
      this.nearby.delete(id);
      if (isNew) {
        this.emit('peers');
        this._syncPeer(p);
      }
      return p;
    }
    const known = this.nearby.get(id);
    this.nearby.set(id, { id, name: name || 'Computer', sid, addr, port: Number(port) });
    if (!known) this.emit('peers');
    return null;
  }

  // ---- downloads ----

  pump() {
    if (this.active.size >= MAX_DOWNLOADS) return;
    const now = Date.now();
    for (const it of this.shelf.needsDownload()) {
      if (this.active.size >= MAX_DOWNLOADS) break;
      if (this.active.has(it.id) || (this.backoff.get(it.id) || 0) > now) continue;
      const source = this._sourceFor(it.id);
      if (!source) continue;
      this._download(it, source);
    }
  }

  _sourceFor(id) {
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (now - p.lastOk < ONLINE_WINDOW && p.have.has(id)) return p;
    }
    return null;
  }

  async _download(it, peer) {
    const ac = new AbortController();
    this.active.set(it.id, ac);
    const dest = this.shelf.storePath(it);
    const tmp = path.join(path.dirname(dest), '.partial-' + path.basename(dest));
    const base = `http://${peer.addr}:${peer.port}/blob/${it.id}`;
    const headers = { 'x-shelf-token': this.token };
    let got = 0;
    let lastReport = 0;
    const progress = (n) => {
      got += n;
      const now = Date.now();
      if (now - lastReport > 150) {
        lastReport = now;
        this.shelf.setLocal(it.id, { got });
      }
    };
    this.shelf.setLocal(it.id, { state: 'downloading', got: 0, path: dest });
    try {
      await fs.promises.rm(path.dirname(dest), { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      if (it.kind === 'folder') {
        await fs.promises.mkdir(tmp, { recursive: true });
        for (const d of it.dirs || []) await fs.promises.mkdir(files.safeJoin(tmp, d), { recursive: true });
        for (const f of it.files || []) {
          const out = files.safeJoin(tmp, f.p);
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await fetchToFile(`${base}?p=${encodeURIComponent(f.p)}`, headers, out, progress, ac.signal);
        }
      } else {
        await fetchToFile(base, headers, tmp, progress, ac.signal);
      }
      await fs.promises.rename(tmp, dest);
      this.backoff.delete(it.id);
      this.active.delete(it.id);
      if (!this.shelf.items.get(it.id) || this.shelf.items.get(it.id).removed) {
        await fs.promises.rm(path.dirname(dest), { recursive: true, force: true });
        return;
      }
      this.shelf.setLocal(it.id, { state: 'ready', got, path: dest });
    } catch (err) {
      this.active.delete(it.id);
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (ac.signal.aborted) return;
      this.backoff.set(it.id, Date.now() + 4000);
      if (this.shelf.local.has(it.id)) this.shelf.setLocal(it.id, { state: 'missing', got: 0 });
    }
  }

  // ---- server ----

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const from = cleanAddr(req.socket.remoteAddress);

    if (req.method === 'GET' && url.pathname === '/hello') {
      return send(res, 200, { app: 'shelf', v: 1, id: this.self.id, name: this.self.name, sid: this.sid, port: this.port });
    }

    if (req.method === 'POST' && url.pathname === '/pair') {
      const body = await readJson(req, 4096);
      if (!body || !body.id || !body.name) return send(res, 400, { error: 'bad request' });
      if (this.pairing) return send(res, 429, { error: 'busy' });
      this.pairing = true;
      try {
        const ok = await this.onPairRequest({ id: String(body.id), name: String(body.name).slice(0, 80) });
        if (!ok) return send(res, 403, { error: 'declined' });
        // The joiner switches to our code and syncs to us right after this,
        // which is when it becomes a peer here.
        return send(res, 200, { code: this.code });
      } finally {
        this.pairing = false;
      }
    }

    if (!safeEqual(req.headers['x-shelf-token'], this.token)) return send(res, 401, { error: 'not on this shelf' });

    if (req.method === 'POST' && url.pathname === '/sync') {
      const body = await readJson(req, MAX_BODY);
      if (!body || !body.from) return send(res, 400, { error: 'bad request' });
      const p = this._seen({ ...body.from, sid: this.sid, addr: from });
      if (p) {
        p.lastOk = Date.now();
        p.have = new Set(body.have || []);
        this._refreshOnline();
      }
      this.shelf.merge(body.items);
      this.pump();
      return send(res, 200, this._payload());
    }

    const m = url.pathname.match(/^\/blob\/([a-f0-9]{16,64})$/);
    if (req.method === 'GET' && m) {
      const it = this.shelf.items.get(m[1]);
      const l = this.shelf.local.get(m[1]);
      if (!it || it.removed || !l || l.state !== 'ready') return send(res, 404, { error: 'not here' });
      const file = it.kind === 'folder' ? files.safeJoin(l.path, url.searchParams.get('p') || '') : l.path;
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch {
        if (it.kind !== 'folder') this.shelf.setLocal(it.id, { state: 'missing' });
        return send(res, 404, { error: 'gone' });
      }
      if (!st.isFile()) return send(res, 404, { error: 'not a file' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    send(res, 404, { error: 'not found' });
  }

  // ---- mDNS ----

  _startMdns() {
    const { Bonjour } = require('bonjour-service');
    this.bonjour = new Bonjour({}, () => {});
    this._publish();
    this.browser = this.bonjour.find({ type: 'shelf' }, (svc) => this._fromService(svc));
    this.browser.on('down', (svc) => {
      const id = svc.txt && svc.txt.id;
      if (id && this.nearby.delete(id)) this.emit('peers');
    });
  }

  _publish() {
    this.service = this.bonjour.publish({
      name: `Shelf ${this.self.id.slice(0, 10)}`,
      type: 'shelf',
      port: this.port,
      txt: { id: this.self.id, name: this.self.name, sid: this.sid },
      disableIPv6: true,
    });
    this.service.on('error', () => {});
  }

  _republish() {
    if (!this.bonjour) return;
    const old = this.service;
    const done = () => {
      this._publish();
      if (this.browser) this.browser.update();
    };
    if (old) old.stop(done);
    else done();
  }

  _fromService(svc) {
    const txt = svc.txt || {};
    const addrs = (svc.addresses || []).filter(isIPv4);
    const addr = addrs.find((a) => !a.startsWith('169.254.')) || addrs[0] || svc.referer?.address;
    this._seen({ id: txt.id, name: txt.name, sid: txt.sid, addr, port: svc.port });
  }
}

// ---- small HTTP helpers ----

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (port !== 0 && err.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        listen(server, 0).then(resolve, reject);
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function request(method, url, { body, headers = {}, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      timeout,
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {}
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    if (data) req.write(data);
    req.end();
  });
}

function fetchToFile(url, headers, dest, onBytes, signal) {
  return new Promise((resolve, _reject) => {
    let out = null;
    const reject = (err) => {
      if (out) out.destroy();
      _reject(err);
    };
    const req = http.get(url, { headers, signal, timeout: 30000 });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const expected = Number(res.headers['content-length']);
      let got = 0;
      out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        onBytes(c.length);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (Number.isFinite(expected) && got !== expected) reject(new Error('transfer cut short'));
        else resolve();
      });
      res.pipe(out);
    });
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { Net, newCode, normalizeCode, codeKeys, DEFAULT_PORT };
