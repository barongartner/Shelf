'use strict';

// The browser client: what a phone (or any computer without the app) talks
// to. Served by every computer on the shelf, over http on the peer port and
// over https on the next one. A phone gets in by scanning the QR code shown
// on a computer; it is then remembered on every computer of the shelf until
// someone removes it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const files = require('./files');
const zip = require('./zip');
const { send, readJson, sendFile, contentDisposition, mimeFor, kindOfName, sha256, safeEqual } = require('./httpu');

const PAIR_TTL = 10 * 60 * 1000;
const PAIR_MAX_TRIES = 6;
const PAIR_LOCK_MS = 60 * 1000;
const PAIR_LOCK_AFTER = 8;
const TEXT_LIMIT = 256 * 1024;
const MAX_THUMBS = 400;
const MANIFEST_LIMIT = 2000;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

function randomPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function nameFromUa(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Browser';
}

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

class Web {
  // shelf: the Shelf; self: { id, name } of this computer
  // thumb(item, localPath) -> { buf, type } | null (optional, Electron only)
  // lingerMs() -> ms | null; caDer() -> Buffer | null
  constructor({ shelf, self, webDir, version = '0', thumb = null, lingerMs = () => null, caDer = () => null, ports = () => ({}) }) {
    this.shelf = shelf;
    this.self = self;
    this.webDir = webDir || path.join(__dirname, '..', 'web');
    this.version = version;
    this.thumb = thumb;
    this.lingerMs = lingerMs;
    this.caDer = caDer;
    this.ports = ports;
    this.pair = null;
    this.fails = new Map(); // ip -> { n, until }
    this.clients = new Set(); // SSE responses
    this.statics = new Map();
    this.thumbs = new Map(); // id -> { buf, type } | null
    this.thumbPending = new Map();
    this.listeners = [];
    this._onChange = () => this.broadcast();
    this._onDropped = (id) => {
      this.thumbs.delete(id);
      this.thumbPending.delete(id);
    };
    shelf.on('change', this._onChange);
    shelf.on('dropped', this._onDropped);
    this.onPaired = () => {};
  }

  stop() {
    this.shelf.off('change', this._onChange);
    this.shelf.off('dropped', this._onDropped);
    clearTimeout(this._broadcastTimer);
    clearInterval(this._heart);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  // ---- pairing ----

  // A fresh code for the QR (long) and for typing by hand (six digits). One
  // use, ten minutes.
  newPair() {
    this.pair = { code: randomCode(20), pin: randomPin(), expiresAt: Date.now() + PAIR_TTL, tries: 0 };
    return this.pairInfo();
  }

  pairInfo() {
    if (!this.pair || this.pair.expiresAt <= Date.now()) {
      this.pair = null;
      return null;
    }
    return { code: this.pair.code, pin: this.pair.pin, expiresAt: this.pair.expiresAt };
  }

  _pairAttempt(ip, body) {
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && f.until > now) return { status: 429, error: 'Too many tries. Wait a minute and try again.' };
    const p = this.pairInfo() && this.pair;
    const code = normCode(body.code);
    const pin = String(body.pin || '').replace(/\D/g, '');
    const ok = p && ((code && safeEqual(code, p.code)) || (pin && safeEqual(pin, p.pin)));
    if (!ok) {
      const recent = f && now - f.last < PAIR_LOCK_MS * 10;
      const next = { n: (recent ? f.n : 0) + 1, last: now, until: 0 };
      if (next.n >= PAIR_LOCK_AFTER) {
        next.until = now + PAIR_LOCK_MS;
        next.n = 0;
      }
      this.fails.set(ip, next);
      if (p && ++p.tries >= PAIR_MAX_TRIES) this.pair = null;
      return { status: 403, error: p ? 'That code is not right.' : 'That code has expired. Show the QR code again on your computer.' };
    }
    this.pair = null;
    this.fails.delete(ip);
    return { status: 200 };
  }

  // ---- auth ----

  deviceFor(req, url) {
    const h = req.headers.authorization;
    let token = null;
    if (h && /^Bearer\s+/i.test(h)) token = h.replace(/^Bearer\s+/i, '').trim();
    if (!token) token = url.searchParams.get('t');
    if (!token || token.length > 200) return null;
    const d = this.shelf.deviceByTokenHash(sha256(token));
    if (d) this.shelf.touchDevice(d.id);
    return d;
  }

  // ---- state ----

  itemView(it) {
    const l = this.shelf.local.get(it.id);
    const ready = it.kind === 'text' || (!!l && l.state === 'ready');
    const type = it.kind === 'file' ? kindOfName(it.name) : it.kind;
    const view = {
      id: it.id,
      kind: it.kind,
      name: it.name,
      size: it.size || 0,
      addedAt: it.addedAt,
      expiresAt: it.expiresAt || null,
      from: it.addedByName || null,
      fromId: it.addedBy || null,
      ready,
      progress: l && l.state === 'downloading' && it.size ? Math.min(1, l.got / it.size) : null,
      type,
      mime: it.kind === 'file' ? mimeFor(it.name) : it.kind === 'text' ? 'text/plain' : 'application/zip',
      thumb: ready && !!this.thumb && it.kind === 'file' && ['image', 'video', 'pdf'].includes(type),
    };
    if (it.kind === 'text') view.text = it.text;
    if (it.kind === 'folder') {
      view.count = (it.files || []).length;
      view.files = (it.files || []).slice(0, MANIFEST_LIMIT).map((f) => ({ p: f.p, s: f.s }));
      view.truncated = (it.files || []).length > MANIFEST_LIMIT;
    }
    return view;
  }

  snapshot() {
    return {
      computer: { id: this.self.id, name: this.self.name },
      version: this.version,
      linger: this.lingerMs(),
      items: this.shelf.visible().map((it) => this.itemView(it)),
      devices: this.shelf.devices().map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen || d.addedAt, addedAt: d.addedAt })),
    };
  }

  broadcast() {
    if (!this.clients.size || this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      if (!this.clients.size) return;
      const data = JSON.stringify(this.snapshot());
      for (const c of this.clients) c.write(`event: state\ndata: ${data}\n\n`);
    }, 80);
  }

  _sse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`: shelf\nretry: 3000\n\nevent: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    this.clients.add(res);
    if (!this._heart) {
      // A real event, not a comment: the page uses it to notice a stream iOS
      // killed without saying so.
      this._heart = setInterval(() => {
        for (const c of this.clients) c.write('event: ping\ndata: 1\n\n');
      }, 20000);
    }
    const drop = () => {
      this.clients.delete(res);
      if (!this.clients.size) {
        clearInterval(this._heart);
        this._heart = null;
      }
    };
    req.on('close', drop);
    res.on('close', drop);
  }

  // ---- thumbnails ----

  async thumbFor(it, localPath) {
    if (!this.thumb) return null;
    if (this.thumbs.has(it.id)) return this.thumbs.get(it.id);
    if (this.thumbPending.has(it.id)) return this.thumbPending.get(it.id);
    const p = (async () => {
      let t = null;
      try {
        t = await this.thumb(it, localPath);
      } catch {}
      if (this.thumbs.size >= MAX_THUMBS) this.thumbs.delete(this.thumbs.keys().next().value);
      this.thumbs.set(it.id, t || null);
      this.thumbPending.delete(it.id);
      return t || null;
    })();
    this.thumbPending.set(it.id, p);
    return p;
  }

  // ---- static files ----

  _static(name) {
    if (process.env.SHELF_DEV) {
      try {
        return fs.readFileSync(path.join(this.webDir, name));
      } catch {
        return null;
      }
    }
    if (!this.statics.has(name)) {
      let body = null;
      try {
        body = fs.readFileSync(path.join(this.webDir, name));
      } catch {}
      this.statics.set(name, body);
    }
    return this.statics.get(name);
  }

  _serveStatic(req, res, [name, type]) {
    const body = this._static(name);
    if (!body) return send(res, 404, { error: 'not found' });
    const isHtml = type.startsWith('text/html');
    const headers = {
      'content-type': type,
      'content-length': body.length,
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    };
    if (isHtml) {
      headers['content-security-policy'] = CSP;
      headers['referrer-policy'] = 'no-referrer';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---- request handling ----

  // Returns true when the request was one of ours (handled), false to let
  // the peer protocol have it.
  async handle(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const get = method === 'GET' || method === 'HEAD';

    if (STATIC[p]) {
      if (!get) return send(res, 405, { error: 'method' }), true;
      this._serveStatic(req, res, STATIC[p]);
      return true;
    }

    if (p === '/cert') {
      const der = this.caDer();
      if (!der) return send(res, 404, { error: 'no certificate' }), true;
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-length': der.length,
        'content-disposition': contentDisposition('attachment', 'Shelf Certificate.cer'),
        'cache-control': 'no-store',
      });
      res.end(get && method === 'HEAD' ? undefined : der);
      return true;
    }

    const mine = p.startsWith('/api/') || p.startsWith('/d/') || p.startsWith('/v/') || p.startsWith('/t/');
    if (!mine) return false;

    if (p === '/api/pair' && method === 'POST') {
      const body = (await readJson(req, 4096)) || {};
      const r = this._pairAttempt(clientIp(req), body);
      if (r.status !== 200) return send(res, r.status, { error: r.error }), true;
      const token = crypto.randomBytes(32).toString('base64url');
      const ua = String(req.headers['user-agent'] || '');
      const name = String(body.name || '').trim().slice(0, 60) || nameFromUa(ua);
      const d = this.shelf.addDevice({ name, tokenHash: sha256(token), ua });
      this.onPaired(d);
      return send(res, 200, { token, device: { id: d.id, name: d.name }, computer: { id: this.self.id, name: this.self.name } }), true;
    }

    const device = this.deviceFor(req, url);

    if (p === '/api/me') {
      if (method === 'POST') {
        if (!device) return send(res, 401, { error: 'not paired' }), true;
        const body = (await readJson(req, 4096)) || {};
        this.shelf.renameDevice(device.id, body.name);
        const d = this.shelf.items.get(device.id);
        return send(res, 200, { device: { id: d.id, name: d.name } }), true;
      }
      return send(res, 200, {
        paired: !!device,
        device: device ? { id: device.id, name: device.name } : null,
        computer: { id: this.self.id, name: this.self.name },
        version: this.version,
        secure: !!req.socket.encrypted,
        ports: this.ports(),
      }), true;
    }

    if (!device) return send(res, 401, { error: 'not paired' }), true;

    if (p === '/api/state' && get) return send(res, 200, this.snapshot()), true;
    if (p === '/api/events' && get) return this._sse(req, res), true;

    if (p === '/api/upload' && (method === 'PUT' || method === 'POST')) {
      const name = url.searchParams.get('name');
      if (!name) return send(res, 400, { error: 'name is required' }), true;
      const size = Number(url.searchParams.get('size')) || Number(req.headers['content-length']) || 0;
      const mtime = Number(url.searchParams.get('mtime')) || null;
      try {
        const it = await this.shelf.addUpload({ name, size, stream: req, by: { id: device.id, name: device.name }, mtime });
        return send(res, 201, { item: this.itemView(it) }), true;
      } catch (err) {
        if (!res.headersSent) send(res, 500, { error: err.message || 'upload failed' });
        else res.destroy();
        return true;
      }
    }

    if (p === '/api/text' && method === 'POST') {
      const body = await readJson(req, TEXT_LIMIT + 4096);
      const text = body && typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return send(res, 400, { error: 'nothing to add' }), true;
      try {
        const it = this.shelf.addText(text, { id: device.id, name: device.name });
        return send(res, 201, { item: this.itemView(it) }), true;
      } catch (err) {
        return send(res, 400, { error: err.message }), true;
      }
    }

    const act = /^\/api\/items\/([a-f0-9]{16,64})\/(remove|keep|take)$/.exec(p);
    if (act && method === 'POST') {
      const [, id, what] = act;
      const it = this.shelf.items.get(id);
      if (!it || it.removed || it.kind === 'device') return send(res, 404, { error: 'not on the shelf' }), true;
      if (what === 'remove') this.shelf.remove(id);
      else if (what === 'keep') this.shelf.keep(id);
      else this.shelf.take(id, this.lingerMs());
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/zip' && get) return this._zipMany(req, res, url), true;

    const m = /^\/(d|v|t)\/([a-f0-9]{16,64})$/.exec(p);
    if (m && get) {
      const [, mode, id] = m;
      const it = this.shelf.items.get(id);
      if (!it || it.removed || it.kind === 'device') return send(res, 404, { error: 'not on the shelf' }), true;
      if (mode === 't') return this._thumbRoute(req, res, it), true;
      if (it.kind === 'text') {
        const body = Buffer.from(it.text || '', 'utf8');
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': body.length,
          'content-disposition': contentDisposition(mode === 'v' ? 'inline' : 'attachment', files.safeName(it.name.slice(0, 40)) + '.txt'),
          'cache-control': 'private, no-cache',
          'x-content-type-options': 'nosniff',
        });
        return res.end(method === 'HEAD' ? undefined : body), true;
      }
      const l = this.shelf.local.get(id);
      if (!l || l.state !== 'ready') return send(res, 409, { error: 'still arriving on this computer' }), true;
      if (it.kind === 'folder') {
        const rel = url.searchParams.get('p');
        if (!rel) return this._zipFolder(req, res, it, l), true;
        const file = await files.manifestFile(it, l.path, rel);
        if (!file) return send(res, 404, { error: 'not in this folder' }), true;
        const base = rel.split('/').pop();
        await sendFile(req, res, file, { name: base, inline: mode === 'v', cache: 'private, max-age=3600' });
        return true;
      }
      await sendFile(req, res, l.path, { name: it.name, inline: mode === 'v', cache: 'private, max-age=3600' });
      return true;
    }

    send(res, 404, { error: 'not found' });
    return true;
  }

  async _thumbRoute(req, res, it) {
    const l = this.shelf.local.get(it.id);
    if (it.kind !== 'file' || !l || l.state !== 'ready') return send(res, 404, { error: 'no thumbnail' });
    const t = await this.thumbFor(it, l.path);
    if (!t) return send(res, 404, { error: 'no thumbnail' });
    res.writeHead(200, {
      'content-type': t.type || 'image/jpeg',
      'content-length': t.buf.length,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : t.buf);
  }

  _sendZip(req, res, entries, name) {
    const { length, stream } = zip.zipOf(entries);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': length,
      'content-disposition': contentDisposition('attachment', name),
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async _zipFolder(req, res, it, l) {
    try {
      const entries = await zip.entriesForDir(it.name, l.path);
      this._sendZip(req, res, entries, `${it.name}.zip`);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.destroy();
    }
  }

  async _zipMany(req, res, url) {
    const ids = String(url.searchParams.get('ids') || '').split(',').filter((s) => /^[a-f0-9]{16,64}$/.test(s));
    const used = new Set();
    const unique = (name) => {
      let n = name;
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      for (let i = 2; used.has(n.toLowerCase()); i++) n = `${stem} (${i})${ext}`;
      used.add(n.toLowerCase());
      return n;
    };
    const entries = [];
    try {
      for (const id of ids) {
        const it = this.shelf.items.get(id);
        const l = this.shelf.local.get(id);
        if (!it || it.removed || it.kind === 'device') continue;
        if (it.kind === 'text') continue;
        if (!l || l.state !== 'ready') continue;
        if (it.kind === 'folder') entries.push(...(await zip.entriesForDir(unique(it.name), l.path)));
        else entries.push(await zip.entryForFile(unique(files.safeName(it.name)), l.path));
      }
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
    if (!entries.length) return send(res, 404, { error: 'nothing to download' });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    this._sendZip(req, res, entries, `Shelf ${stamp}.zip`);
  }
}

module.exports = { Web, nameFromUa, PAIR_TTL };
