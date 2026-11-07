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
const UPLOAD_IDLE_MS = 60 * 1000;
const MANIFEST_LIMIT = 2000;
const HANDOFF_TTL = 10 * 60 * 1000;
// Things dropped on the shelf together go out as one notification: it is
// sent once nothing new has turned up for this long (or after the cap).
const NOTIFY_DELAY = 2500;
const NOTIFY_CAP = 10000;

// Safari asks for the home-screen icon at these root paths on its own, with
// no cookies and no token, so they are public like the page itself. The
// manifest is not here: it is made per phone (see _manifest).
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-precomposed.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-180x180.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-167x167.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-152x152.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-120x120.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const COOKIE = 'shelf';
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // the longest browsers keep a cookie

function cookieValue(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function setCookie(token) {
  return `${COOKIE}=${token}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax; HttpOnly`;
}

function clearCookie() {
  return `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly`;
}

// The page may only talk to the computer that served it. Its other
// addresses (the stable name, the secure port) and the other computers on
// the shelf are allowed so the page can check they answer before switching
// to them.
function csp(origins) {
  return [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${origins.join(' ')}`.trim(),
    "style-src 'self'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

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
  // peers() -> [{ name, addr, port, host }]: the other computers on the shelf
  // push: a Push (see push.js) to notify phones of new things, or null
  constructor({ shelf, self, webDir, version = '0', thumb = null, lingerMs = () => null, caDer = () => null, ports = () => ({}), hosts = () => [], peers = () => [], push = null, notifyDelay = NOTIFY_DELAY }) {
    this.shelf = shelf;
    this.self = self;
    this.webDir = webDir || path.join(__dirname, '..', 'web');
    this.version = version;
    this.thumb = thumb;
    this.lingerMs = lingerMs;
    this.caDer = caDer;
    this.ports = ports;
    this.hosts = hosts;
    this.peers = peers;
    this.pair = null;
    this.fails = new Map(); // ip -> { n, until }
    this.handoffs = new Map(); // code -> { token, deviceId, expiresAt }
    this.clients = new Set(); // SSE responses
    this.statics = new Map();
    this.thumbs = new Map(); // id -> { buf, type } | null
    this.thumbPending = new Map();
    this.listeners = [];
    this.push = push;
    this.notifyDelay = notifyDelay;
    // Everything already on the shelf when the computer starts counts as
    // told: a restart must not ring the phone for old things.
    this.told = new Set(shelf.visible().map((it) => it.id));
    this.fresh = []; // ids ready here and not told yet, waiting for the batch
    this._onChange = () => {
      this._dropRevoked();
      this.broadcast();
      this._noticeNew();
    };
    this._onDropped = (id) => {
      this.thumbs.delete(id);
      this.thumbPending.delete(id);
    };
    shelf.on('change', this._onChange);
    shelf.on('dropped', this._onDropped);
    this.onPaired = () => {};
    this.onOnline = () => {}; // the set of phones with an open stream changed
  }

  stop() {
    this.shelf.off('change', this._onChange);
    this.shelf.off('dropped', this._onDropped);
    clearTimeout(this._broadcastTimer);
    clearTimeout(this._notifyTimer);
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
    const codeOk = !!p && code.length === 20 && safeEqual(code, p.code);
    const pinOk = !!p && !p.pinLocked && pin.length === 6 && safeEqual(pin, p.pin);
    if (!codeOk && !pinOk) {
      const recent = f && now - f.last < PAIR_LOCK_MS * 10;
      const next = { n: (recent ? f.n : 0) + 1, last: now, until: 0 };
      if (next.n >= PAIR_LOCK_AFTER) {
        next.until = now + PAIR_LOCK_MS;
        next.n = 0;
      }
      this.fails.set(ip, next);
      // Only the six digits can be guessed, so only real guesses at them count,
      // and they lock the digits alone: the long code on the QR keeps working.
      if (p && pin.length === 6 && ++p.tries >= PAIR_MAX_TRIES) p.pinLocked = true;
      let error = 'That code has expired. Show the QR code again on your computer.';
      if (p) error = p.pinLocked ? 'Too many wrong codes. Scan the QR code instead, or show a new code on your computer.' : 'That code is not right.';
      return { status: 403, error };
    }
    this.pair = null;
    this.fails.delete(ip);
    return { status: 200 };
  }

  // ---- auth ----

  // A handoff code stands in for the phone's token for ten minutes. The page
  // keeps a live one in its address while it is signed in, so that whatever
  // reads the page to make a Home Screen app (Safari, another browser, a
  // system view with no cookies and no script of its own) gets a manifest
  // with the token in it. One live code per phone.
  _newHandoff(device) {
    const now = Date.now();
    for (const [code, h] of this.handoffs) if (h.expiresAt <= now || h.deviceId === device.id) this.handoffs.delete(code);
    const code = randomCode(12);
    const expiresAt = now + HANDOFF_TTL;
    this.handoffs.set(code, { token: device._token, deviceId: device.id, expiresAt });
    return { code, expiresAt };
  }

  _handoff(code) {
    if (typeof code !== 'string' || code.length !== 12) return null;
    const h = this.handoffs.get(normCode(code));
    if (!h) return null;
    if (h.expiresAt <= Date.now()) {
      this.handoffs.delete(normCode(code));
      return null;
    }
    return h;
  }

  // The token can come in a header, in the query string (images, downloads
  // and the event stream cannot set headers), in the cookie the server set
  // when the phone paired, or through a handoff code in the query string.
  // The cookie is what survives Safari throwing away a site's script
  // storage after a week of not being opened.
  deviceFor(req, url) {
    const h = req.headers.authorization;
    let token = null;
    let via = null;
    if (h && /^Bearer\s+/i.test(h)) {
      token = h.replace(/^Bearer\s+/i, '').trim();
      via = 'header';
    }
    if (!token) {
      token = url.searchParams.get('t');
      via = 'query';
    }
    if (!token) {
      token = cookieValue(req, COOKIE);
      via = 'cookie';
    }
    if (!token) {
      const hand = this._handoff(url.searchParams.get('h'));
      token = hand ? hand.token : null;
      via = 'handoff';
    }
    if (!token || token.length > 200) return null;
    const d = this.shelf.deviceByTokenHash(sha256(token));
    if (!d) return null;
    this.shelf.touchDevice(d.id);
    // A copy: the token must never land on the record the shelf saves and syncs.
    return { ...d, _token: token, _via: via };
  }

  // Phones with a live event stream open to this computer right now.
  onlineDeviceIds() {
    return [...new Set([...this.clients].map((c) => c.shelfDevice))];
  }

  // The other computers a phone could open the shelf through.
  peerView() {
    let list = [];
    try {
      list = this.peers() || [];
    } catch {}
    return list
      .filter((p) => p && p.port && (p.addr || p.host) && p.online !== false)
      .map((p) => ({ name: String(p.name || 'Computer'), addr: p.addr || null, port: p.port, host: p.host || null }));
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
    const online = new Set(this.onlineDeviceIds());
    return {
      computer: { id: this.self.id, name: this.self.name },
      version: this.version,
      linger: this.lingerMs(),
      items: this.shelf.visible().map((it) => this.itemView(it)),
      devices: this.shelf.devices().map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen || d.addedAt, addedAt: d.addedAt, online: online.has(d.id) })),
      peers: this.peerView(),
    };
  }

  // A phone that was removed is cut off, open stream or not.
  _dropRevoked() {
    for (const c of [...this.clients]) {
      const d = this.shelf.items.get(c.shelfDevice);
      if (!d || d.removed) {
        this.clients.delete(c);
        c.end();
      }
    }
  }

  broadcast() {
    if (!this.clients.size || this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      this._dropRevoked();
      if (!this.clients.size) return;
      const data = JSON.stringify(this.snapshot());
      for (const c of this.clients) c.write(`event: state\ndata: ${data}\n\n`);
    }, 80);
  }

  _sse(req, res, device) {
    res.shelfDevice = device.id;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const wasOnline = this.onlineDeviceIds().includes(device.id);
    this.clients.add(res);
    res.write(`: shelf\nretry: 3000\n\nevent: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    if (!wasOnline) this._onlineChanged();
    if (!this._heart) {
      // A real event, not a comment: the page uses it to notice a stream iOS
      // killed without saying so.
      this._heart = setInterval(() => {
        this._dropRevoked();
        for (const c of this.clients) c.write('event: ping\ndata: 1\n\n');
      }, 20000);
    }
    const drop = () => {
      if (!this.clients.delete(res)) return;
      if (!this.clients.size) {
        clearInterval(this._heart);
        this._heart = null;
      }
      if (!this.onlineDeviceIds().includes(device.id)) this._onlineChanged();
    };
    req.on('close', drop);
    res.on('close', drop);
  }

  _onlineChanged() {
    this.broadcast();
    try {
      this.onOnline(this.onlineDeviceIds());
    } catch {}
  }

  // ---- notifications ----

  // Called on every change: anything that is now ready on this computer and
  // that the phones were not told about yet joins the next notification.
  _noticeNew() {
    if (!this.push) return;
    const visible = this.shelf.visible();
    const live = new Set(visible.map((it) => it.id));
    for (const id of this.told) if (!live.has(id) && !this.shelf.items.has(id)) this.told.delete(id);
    let added = false;
    for (const it of visible) {
      if (this.told.has(it.id) || it.kind === 'device') continue;
      const l = this.shelf.local.get(it.id);
      if (it.kind !== 'text' && !(l && l.state === 'ready')) continue;
      this.told.add(it.id);
      this.fresh.push(it.id);
      added = true;
    }
    if (!added) return;
    if (!this._notifyFirst) this._notifyFirst = Date.now();
    clearTimeout(this._notifyTimer);
    const wait = Math.max(0, Math.min(this.notifyDelay, this._notifyFirst + NOTIFY_CAP - Date.now()));
    this._notifyTimer = setTimeout(() => this._sendFresh().catch(() => {}), wait);
  }

  async _sendFresh() {
    const ids = this.fresh;
    this.fresh = [];
    this._notifyFirst = 0;
    this._notifyTimer = null;
    const phones = new Set(this.shelf.devices().map((d) => d.id));
    this.push.keepOnly([...phones]);
    for (const deviceId of this.push.devices()) {
      // What the phone put on the shelf itself is not news to it.
      const its = ids.map((id) => this.shelf.items.get(id)).filter((it) => it && !it.removed && it.addedBy !== deviceId);
      if (!its.length) continue;
      await this.push.send(deviceId, this.message(its));
    }
  }

  // The notification for a batch of new things. Kept short: the whole
  // message has to fit in one push (4 KB).
  //
  // iOS draws a web app's notification as the title, then "from Shelf",
  // then the body. So the title says what arrived (never "Shelf"), and the
  // body says who sent it and what a tap does.
  message(its) {
    const from = [...new Set(its.map((it) => it.addedByName).filter(Boolean))];
    const sender = from.length === 1 ? from[0] : null;
    const types = its.map((it) => (it.kind === 'file' ? kindOfName(it.name) : it.kind));
    const media = types.every((t) => t === 'image' || t === 'video');
    const n = its.length;
    let title;
    let body;
    if (n === 1 && its[0].kind === 'text') {
      title = sender ? `Text from ${sender}` : 'New text';
      body = String(its[0].text || its[0].name).trim().slice(0, 160);
    } else if (n === 1) {
      title = its[0].name.slice(0, 80);
      body = `${sender ? `Sent from ${sender}. ` : ''}Tap to open it.`;
    } else {
      const noun = types.every((t) => t === 'image') ? 'photos' : types.every((t) => t === 'video') ? 'videos' : media ? 'photos and videos' : its.every((it) => it.kind === 'file') ? 'files' : 'items';
      title = `${n} ${noun}`;
      const names = its.slice(0, 3).map((it) => it.name.slice(0, 40)).join(', ');
      body = `${sender ? `Sent from ${sender}: ` : ''}${names}${n > 3 ? `, and ${n - 3} more` : ''}. ${media ? 'Tap to save them.' : 'Tap to see them.'}`;
    }
    const ids = its.slice(0, 60).map((it) => it.id);
    return { title, body, tag: 'shelf-new', url: `/?n=${ids.join(',')}` };
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

  _dataUri(name) {
    const buf = this._static(name);
    return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
  }

  // The page is always revalidated (cheaply, by ETag) so an update reaches
  // the phone on its next open; the script and stylesheet are referenced
  // with the version in their URL, so they can be cached hard.
  _serveStatic(req, res, [name, type], device = null) {
    let body = this._static(name);
    if (!body) return send(res, 404, { error: 'not found' });
    const isHtml = type.startsWith('text/html');
    if (isHtml) {
      // A phone the cookie already knows gets its token in the manifest link
      // straight from the markup, before any script runs.
      const manifest = device ? `/manifest.webmanifest?t=${encodeURIComponent(device._token)}` : '/manifest.webmanifest';
      body = Buffer.from(body.toString('utf8').split('__SHELF_V__').join(encodeURIComponent(this.version)).split('__SHELF_MANIFEST__').join(manifest), 'utf8');
    }
    const etag = `"${sha256(body).slice(0, 32)}"`;
    const isWorker = name === 'sw.js';
    const versioned = !isWorker && (name.endsWith('.js') || name.endsWith('.css'));
    const headers = {
      'content-type': type,
      etag,
      'cache-control': process.env.SHELF_DEV ? 'no-store' : isHtml || isWorker ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    };
    if (isWorker) headers['service-worker-allowed'] = '/';
    if (isHtml) {
      const ports = this.ports();
      const origins = [];
      // The address the phone used (often a bare IP) has a secure twin too;
      // the page checks it answers before moving there to save photos.
      const asked = String(req.headers.host || '').replace(/:\d+$/, '');
      const own = /^[A-Za-z0-9.-]+$/.test(asked) ? [asked] : [];
      for (const h of [...new Set([...this.hosts(), ...own])]) {
        if (ports.http) origins.push(`http://${h}:${ports.http}`);
        if (ports.https) origins.push(`https://${h}:${ports.https}`);
      }
      for (const peer of this.peerView()) {
        for (const h of [peer.host, peer.addr]) if (h && /^[A-Za-z0-9.-]+$/.test(h)) origins.push(`http://${h}:${peer.port}`);
      }
      headers['content-security-policy'] = csp([...new Set(origins)]);
      headers['referrer-policy'] = 'no-referrer';
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // The web app manifest, made for the phone asking. An icon added to the
  // iOS Home Screen opens as an app with storage of its own, separate from
  // Safari's, so nothing the phone stored when it paired is there on the
  // first open. The token rides in start_url instead: the page puts it in
  // the manifest link, and the cookie covers a fetch that did not carry it.
  _manifest(req, res, device) {
    const body = Buffer.from(
      JSON.stringify({
        id: '/',
        name: 'Shelf',
        short_name: 'Shelf',
        description: 'The file shelf shared by your computers.',
        start_url: device ? `/?t=${encodeURIComponent(device._token)}` : '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f2f2f7',
        theme_color: '#3a63e8',
        // Inline, not linked: when a page has a manifest, iOS builds the Home
        // Screen icon from these and draws a letter on theme_color when it
        // cannot use them. With linked files it drew the letter on Baron's
        // iPhone (2026-11-07) even though the share sheet showed the same
        // PNG fine; an inline icon was what worked for Laneway's site.
        icons: [
          { src: this._dataUri('apple-touch-icon.png') || '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
          { src: this._dataUri('icon-512.png') || '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      }),
      'utf8',
    );
    res.writeHead(200, {
      'content-type': 'application/manifest+json',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---- request handling ----

  // Returns true when the request was one of ours (handled), false to let
  // the peer protocol have it.
  async handle(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const get = method === 'GET' || method === 'HEAD';

    if (p === '/manifest.webmanifest') {
      if (!get) return send(res, 405, { error: 'method' }), true;
      this._manifest(req, res, this.deviceFor(req, url));
      return true;
    }

    if (STATIC[p]) {
      if (!get) return send(res, 405, { error: 'method' }), true;
      this._serveStatic(req, res, STATIC[p], STATIC[p][1].startsWith('text/html') ? this.deviceFor(req, url) : null);
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
      // A phone that is already on the shelf (its cookie or token came along)
      // scanned a QR code again: it stays the phone it is, and the code it
      // brought is used up so it cannot let anyone else in.
      const existing = this.deviceFor(req, url);
      if (existing) {
        const pi = this.pairInfo() && this.pair;
        const code = normCode(body.code);
        const pin = String(body.pin || '').replace(/\D/g, '');
        const used = !!pi && ((code.length === 20 && safeEqual(code, pi.code)) || (!pi.pinLocked && pin.length === 6 && safeEqual(pin, pi.pin)));
        if (used) {
          this.pair = null;
          this.onPaired(this.shelf.items.get(existing.id));
        }
        return send(res, 200, {
          token: existing._token,
          already: true,
          device: { id: existing.id, name: existing.name },
          computer: { id: this.self.id, name: this.self.name },
          version: this.version,
          secure: !!req.socket.encrypted,
          ports: this.ports(),
          hosts: this.hosts(),
          peers: this.peerView(),
        }, existing._via === 'cookie' ? {} : { 'set-cookie': setCookie(existing._token) }), true;
      }
      const r = this._pairAttempt(clientIp(req), body);
      if (r.status !== 200) return send(res, r.status, { error: r.error }), true;
      const token = crypto.randomBytes(32).toString('base64url');
      const ua = String(req.headers['user-agent'] || '');
      const name = String(body.name || '').trim().slice(0, 60) || nameFromUa(ua);
      const d = this.shelf.addDevice({ name, tokenHash: sha256(token), ua });
      this.onPaired(d);
      return send(res, 200, {
        token,
        device: { id: d.id, name: d.name },
        computer: { id: this.self.id, name: this.self.name },
        version: this.version,
        secure: !!req.socket.encrypted,
        ports: this.ports(),
        hosts: this.hosts(),
        peers: this.peerView(),
      }, { 'set-cookie': setCookie(token) }), true;
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
      const extra = {};
      // A phone that arrived with its token in the address (the switch to the
      // secure or the stable address) gets the cookie for this address too.
      if (device && device._via !== 'cookie') extra['set-cookie'] = setCookie(device._token);
      return send(res, 200, {
        paired: !!device,
        device: device ? { id: device.id, name: device.name } : null,
        token: device ? device._token : undefined,
        computer: { id: this.self.id, name: this.self.name },
        version: this.version,
        secure: !!req.socket.encrypted,
        ports: this.ports(),
        hosts: this.hosts(),
        peers: this.peerView(),
      }, extra), true;
    }

    if (p === '/api/forget' && method === 'POST') {
      if (device) this.shelf.removeDevice(device.id);
      return send(res, 200, { ok: true }, { 'set-cookie': clearCookie() }), true;
    }

    if (p === '/api/handoff' && method === 'POST') {
      if (!device) return send(res, 401, { error: 'not paired' }), true;
      return send(res, 200, this._newHandoff(device)), true;
    }

    if (!device) return send(res, 401, { error: 'not paired' }), true;

    if (p.startsWith('/api/push')) return this._pushRoute(req, res, p, method, device), true;

    if (p === '/api/state' && get) return send(res, 200, this.snapshot()), true;
    if (p === '/api/events' && get) return this._sse(req, res, device), true;

    if (p === '/api/upload' && (method === 'PUT' || method === 'POST')) {
      const name = url.searchParams.get('name');
      if (!name) return send(res, 400, { error: 'name is required' }), true;
      const size = Number(url.searchParams.get('size')) || Number(req.headers['content-length']) || 0;
      const mtime = Number(url.searchParams.get('mtime')) || null;
      // Nothing arriving for a minute means the phone is gone; the upload is
      // cut so its item disappears everywhere instead of arriving forever.
      // The listener is taken off again: the socket is kept alive across
      // uploads, and one left behind per upload would pile up.
      const stalled = () => req.destroy(new Error('upload stalled'));
      req.socket.setTimeout(UPLOAD_IDLE_MS);
      req.socket.on('timeout', stalled);
      try {
        const it = await this.shelf.addUpload({ name, size, stream: req, by: { id: device.id, name: device.name }, mtime });
        return send(res, 201, { item: this.itemView(it) }), true;
      } catch (err) {
        if (!res.headersSent) send(res, 500, { error: err.message || 'upload failed' });
        else res.destroy();
        return true;
      } finally {
        try {
          req.socket.setTimeout(0);
          req.socket.off('timeout', stalled);
        } catch {}
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

  // GET /api/push: the key to subscribe with and whether this phone is on.
  // POST /api/push: a subscription. POST /api/push/off: stop.
  // POST /api/push/test: send this phone a notification now.
  async _pushRoute(req, res, p, method, device) {
    if (!this.push) return send(res, 404, { error: 'This computer does not send notifications.' });
    if (p === '/api/push' && (method === 'GET' || method === 'HEAD')) {
      return send(res, 200, { key: this.push.publicKey(), computer: this.self.name, ...this.push.status(device.id) });
    }
    if (method !== 'POST') return send(res, 405, { error: 'method' });
    const body = (await readJson(req, 4096)) || {};
    if (p === '/api/push') {
      if (!this.push.subscribe(device.id, body.subscription)) return send(res, 400, { error: 'That is not a subscription this computer can send to.' });
      return send(res, 200, { ok: true, ...this.push.status(device.id) });
    }
    if (p === '/api/push/off') {
      this.push.unsubscribe(device.id, typeof body.endpoint === 'string' ? body.endpoint : null);
      return send(res, 200, { ok: true, ...this.push.status(device.id) });
    }
    if (p === '/api/push/test') {
      const results = await this.push.send(device.id, { title: 'Notifications are on', body: `Test from ${this.self.name}. New things on the shelf show up like this.`, tag: 'shelf-test', url: '/' });
      const ok = results.some((r) => r.ok);
      return send(res, ok ? 200 : 502, { ok, results: results.map((r) => ({ status: r.status, error: r.error })), ...this.push.status(device.id) });
    }
    return send(res, 404, { error: 'not found' });
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
