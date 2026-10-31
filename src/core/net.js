'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const files = require('./files');
const { Web } = require('./web');
const tlsmod = require('./tls');
const { send, readBody, parseJson, safeEqual, sha256 } = require('./httpu');

const DEFAULT_PORT = 47474;
const DEFAULT_HTTPS_PORT = 47475;
const ONLINE_WINDOW = 35 * 1000;
const TICK_MS = 2000;
const SYNC_EVERY_TICKS = 5;
const ADDRESS_CHECK_TICKS = 15;
const MAX_DOWNLOADS = 3;
const MAX_BODY = 64 * 1024 * 1024;
const SMALL_BODY = 64 * 1024;
const AUTH_WINDOW = 5 * 60 * 1000;
const REPLAY_KEEP = 10000;
const PEER_FAIL_MS = 60 * 1000;
const BACKOFF_MAX = 5 * 60 * 1000;
const PAIR_DECLINE_MS = 60 * 1000;
const PAIR_DECLINE_LONG_MS = 15 * 60 * 1000;
const PAIR_HANGUP_MS = 10 * 1000;
const PAIR_DIALOG_GAP_MS = 5 * 1000;
const UNAUTH_BEFORE_DEMOTE = 3;
const BODY_IDLE_MS = 60 * 1000;

// Shelf code -> the secret the computers on a shelf share, and a short
// public id advertised over mDNS so computers on different shelves ignore
// each other. The secret is stretched so the public id cannot be turned back
// into the code, and it never travels: requests carry a signature made with
// it instead (see _signedHeaders).
function codeKeys(code) {
  const norm = normalizeCode(code);
  const token = crypto.scryptSync(norm, 'shelf-token-v2', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return {
    token,
    sid: crypto.createHash('sha256').update('shelf-id-v2:' + token).digest('hex').slice(0, 12),
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

function ownAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4') out.push(a.address);
  }
  return out;
}

// Addresses another device could reach: no loopback, no link-local.
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}

// The address of the interface the default route uses. A UDP "connect" picks
// the interface without sending anything.
function outboundAddress() {
  return new Promise((resolve) => {
    let done = false;
    const sock = dgram.createSocket('udp4');
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {}
      resolve(v);
    };
    sock.on('error', () => finish(null));
    try {
      sock.connect(53, '8.8.8.8', () => {
        try {
          finish(sock.address().address);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), 1000).unref();
  });
}

function hostNames() {
  const h = os.hostname().toLowerCase().replace(/\.local$/, '');
  if (!h || !/^[a-z0-9-]+$/.test(h)) return [];
  return [h, `${h}.local`];
}

function sign(token, parts) {
  return crypto.createHmac('sha256', token).update(parts.join('|')).digest('hex');
}

function endpoint(addr, port) {
  return `${addr}:${port}`;
}

function sanitizePeer({ id, name, sid, addr, port }) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) return null;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  if (typeof addr !== 'string' || !addr || addr.length > 64) return null;
  return {
    id,
    name: (typeof name === 'string' ? name.trim().slice(0, 60) : '') || 'Computer',
    sid: typeof sid === 'string' ? sid.slice(0, 32) : '?',
    addr,
    port: p,
  };
}

// Talks to the other computers: an HTTP server they sync with and download
// from, mDNS to find them, and a download queue that pulls every item this
// computer doesn't have a copy of yet. Also serves the browser client for
// phones, over http and (when `web` is given) https with its own certificate.
//
// Every request between computers carries a signature made with the shelf
// secret over the method, path, time, body and the address it was sent to,
// and every answer carries one back over the same address, so a device
// that merely claims to be on the shelf learns nothing and cannot stand in
// the middle.
class Net extends EventEmitter {
  constructor({ shelf, self, code, port = DEFAULT_PORT, mdns = true, onPairRequest, tickMs = TICK_MS, web = null, httpsPort = DEFAULT_HTTPS_PORT }) {
    super();
    this.tickMs = tickMs;
    this.shelf = shelf;
    this.self = self;
    this.preferredPort = port;
    this.preferredHttpsPort = httpsPort;
    this.useMdns = mdns;
    this.onPairRequest = onPairRequest || (async () => false);
    this.peers = new Map(); // same shelf, proven
    this.nearby = new Map(); // Shelf apps on a different shelf
    this.verifying = new Set(); // ids being checked right now
    this.active = new Map(); // id -> AbortController
    this.backoff = new Map(); // id -> retry-after ms
    this.failures = new Map(); // id -> consecutive failures
    this.peerFail = new Map(); // `${id}:${peerId}` -> skip until
    this.replay = new Map(); // request nonce -> expiry
    this.declines = new Map(); // addr -> { n, until } for /pair
    this.pairingFrom = new Set(); // addrs with a /pair dialog open
    this.lastPairDialog = 0;
    this.webOpts = web; // { webDir?, version?, thumb?, lingerMs?, certDir }
    this.web = null;
    this.tls = null;
    this.httpsPort = null;
    this.httpsError = null;
    this.addresses = { ips: [], hosts: [], best: null };
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
    const handler = (req, res) => {
      this._handle(req, res).catch((err) => {
        if (!res.headersSent) send(res, err.code === 'TOO_LARGE' ? 413 : 500, { error: String(err.message || err) });
        else res.destroy();
      });
    };
    if (this.webOpts) {
      this.web = new Web({
        shelf: this.shelf,
        self: this.self,
        webDir: this.webOpts.webDir,
        version: this.webOpts.version,
        thumb: this.webOpts.thumb,
        lingerMs: this.webOpts.lingerMs,
        caDer: () => (this.tls ? this.tls.caDer : null),
        ports: () => ({ http: this.port, https: this.httpsPort }),
        hosts: () => this.addresses.hosts.filter((h) => h.endsWith('.local')),
      });
      this.web.onPaired = (d) => this.emit('paired', d);
      this.on('peers', () => this.web.broadcast());
    }
    this.server = http.createServer(handler);
    this.server.requestTimeout = 0; // uploads and syncs of big folders take as long as they take
    this.server.headersTimeout = 60 * 1000;
    this.port = await listen(this.server, this.preferredPort);
    await this.refreshAddresses();
    if (this.webOpts && this.webOpts.certDir) {
      try {
        this.tls = tlsmod.ensure(this.webOpts.certDir, this._certNames());
        this.https = https.createServer({ key: this.tls.key, cert: this.tls.cert }, handler);
        this.https.requestTimeout = 0;
        this.https.headersTimeout = 60 * 1000;
        this.https.on('tlsClientError', () => {});
        this.httpsPort = await listen(this.https, this.preferredHttpsPort);
      } catch (err) {
        this.httpsError = err;
        this.https = null;
        this.httpsPort = null;
      }
    }
    if (this.useMdns) this._startMdns();
    this._ticks = 0;
    this._timer = setInterval(() => this._tick(), this.tickMs);
  }

  async stop() {
    clearInterval(this._timer);
    clearTimeout(this._syncTimer);
    for (const ac of this.active.values()) ac.abort();
    if (this.web) this.web.stop();
    if (this.bonjour) {
      await new Promise((r) => this.bonjour.unpublishAll(r));
      this.bonjour.destroy();
    }
    for (const s of [this.https, this.server]) {
      if (!s) continue;
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
  }

  // ---- addresses and the phone certificate ----

  // Loopback is included so the page can be opened on this computer too.
  _certNames() {
    return {
      hosts: [...this.addresses.hosts, 'localhost'],
      ips: [...this.addresses.ips, '127.0.0.1'],
      computerName: this.self.name,
    };
  }

  async refreshAddresses() {
    const ips = lanAddresses();
    const best = (await outboundAddress()) || ips[0] || null;
    const next = { ips, hosts: hostNames(), best: ips.includes(best) ? best : ips[0] || null };
    const changed = JSON.stringify(next) !== JSON.stringify(this.addresses);
    this.addresses = next;
    if (changed && this.https && this.tls) {
      try {
        const t = tlsmod.ensure(this.webOpts.certDir, this._certNames());
        if (t.leafIsNew || t.caIsNew) this.https.setSecureContext({ key: t.key, cert: t.cert });
        this.tls = t;
      } catch (err) {
        this.httpsError = err;
      }
    }
    if (changed) this.emit('addresses', next);
    return next;
  }

  // ---- request signing ----

  // `to` is the address:port the request is sent to. It is part of every
  // signature, and the receiver only accepts requests addressed to itself,
  // so a signed request cannot be carried to a different computer.
  _signedHeaders(method, pathAndQuery, bodyBuf, to) {
    const ts = String(Date.now());
    const rnd = crypto.randomBytes(8).toString('hex');
    return {
      'x-shelf-id': this.self.id,
      'x-shelf-ts': ts,
      'x-shelf-rnd': rnd,
      'x-shelf-to': to,
      'x-shelf-pre': sign(this.token, ['pre', method, pathAndQuery, ts, rnd, this.self.id, to]),
      'x-shelf-auth': sign(this.token, ['req', method, pathAndQuery, ts, rnd, to, sha256(bodyBuf || '')]),
      rnd,
    };
  }

  // Is this address:port one of mine, as a sender would have dialed it?
  _isMine(to) {
    const m = /^(.+):(\d+)$/.exec(String(to || ''));
    if (!m || Number(m[2]) !== this.port) return false;
    const addr = m[1].replace(/^\[|\]$/g, '');
    return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || ownAddresses().includes(addr);
  }

  // Checks the headers alone, before any body is read: a stranger costs no
  // memory. Returns { ok, id, ts, rnd, to } or { ok: false, clock: true }
  // when the signature is right but the sender's clock is off.
  _verifyPre(req) {
    const h = req.headers;
    const id = h['x-shelf-id'];
    const ts = Number(h['x-shelf-ts']);
    const rnd = h['x-shelf-rnd'];
    const to = h['x-shelf-to'];
    const pre = h['x-shelf-pre'];
    if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) return { ok: false };
    if (!Number.isFinite(ts) || typeof rnd !== 'string' || !/^[a-f0-9]{16}$/.test(rnd) || typeof pre !== 'string') return { ok: false };
    if (typeof to !== 'string' || !this._isMine(to)) return { ok: false };
    if (!safeEqual(pre, sign(this.token, ['pre', req.method, req.url, String(ts), rnd, id, to]))) return { ok: false };
    if (Math.abs(Date.now() - ts) > AUTH_WINDOW) return { ok: false, clock: true };
    return { ok: true, id, ts, rnd, to };
  }

  // Checks the full signature over the body; returns the sender's id or null.
  _verifyRequest(req, bodyBuf) {
    const pre = this._verifyPre(req);
    if (!pre.ok) return null;
    const auth = req.headers['x-shelf-auth'];
    if (typeof auth !== 'string') return null;
    const expected = sign(this.token, ['req', req.method, req.url, String(pre.ts), pre.rnd, pre.to, sha256(bodyBuf || '')]);
    if (!safeEqual(auth, expected)) return null;
    if (this.replay.has(pre.rnd)) return null;
    // Kept for as long as the signed time could still be accepted.
    this.replay.set(pre.rnd, Math.max(Date.now(), pre.ts) + AUTH_WINDOW);
    if (this.replay.size > REPLAY_KEEP) this._sweepReplay();
    return pre.id;
  }

  _sweepReplay() {
    const now = Date.now();
    for (const [k, until] of this.replay) if (until <= now) this.replay.delete(k);
  }

  _proof(req, extra) {
    return sign(this.token, ['resp', req.headers['x-shelf-rnd'], this.self.id, req.headers['x-shelf-to'], extra]);
  }

  _expectedProof(rnd, p, extra) {
    return sign(this.token, ['resp', rnd, p.id, endpoint(p.addr, p.port), extra]);
  }

  // ---- shelf membership ----

  setCode(code) {
    this._setCode(code);
    // Nothing from the old shelf may keep arriving.
    for (const ac of this.active.values()) ac.abort();
    this.active.clear();
    this.backoff.clear();
    this.failures.clear();
    this.peerFail.clear();
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
    if (this.web) this.web.broadcast();
  }

  peerList() {
    const now = Date.now();
    return [...this.peers.values()]
      .map((p) => ({ id: p.id, name: p.name, online: now - p.lastOk < ONLINE_WINDOW, addr: p.addr, port: p.port, clockSkew: p.clockSkew || 0 }))
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
    const r = await request('POST', `http://${n.addr}:${n.port}/pair`, { body, timeout: 70 * 1000, limit: SMALL_BODY });
    if (r.status === 403) throw new Error(`${n.name} said no`);
    if (r.status === 429) throw new Error(`${n.name} is busy with another request. Try again in a minute.`);
    if (r.status !== 200 || !r.json || !r.json.code) throw new Error(`${n.name} didn't answer`);
    this.setCode(r.json.code);
    await this._verifyPeer({ ...n, sid: this.sid });
    return r.json.code;
  }

  // Adds a computer by IP address, for networks where mDNS doesn't get through.
  async addAddress(host, port = DEFAULT_PORT) {
    const rnd = crypto.randomBytes(8).toString('hex');
    const to = endpoint(host, port);
    const r = await request('GET', `http://${host}:${port}/hello`, { timeout: 4000, limit: SMALL_BODY, headers: { 'x-shelf-challenge': rnd, 'x-shelf-to': to } });
    if (r.status !== 200 || !r.json || r.json.app !== 'shelf') throw new Error(`No Shelf app at ${host}:${port}`);
    const h = r.json;
    if (h.id === this.self.id) throw new Error("That's this computer");
    const c = sanitizePeer({ id: h.id, name: h.name, sid: h.sid, addr: host, port });
    if (!c) throw new Error(`No Shelf app at ${host}:${port}`);
    const proven = typeof h.proof === 'string' && safeEqual(h.proof, sign(this.token, ['hello', rnd, c.id, to]));
    if (proven) {
      this._seen({ ...c, sid: this.sid }, { verified: true });
      return 'peer';
    }
    this._seen({ ...c, sid: c.sid === this.sid ? '?' : c.sid });
    return 'nearby';
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
      const body = Buffer.from(JSON.stringify(this._payload()));
      const to = endpoint(p.addr, p.port);
      const { rnd, ...headers } = this._signedHeaders('POST', '/sync', body, to);
      const r = await request('POST', `http://${p.addr}:${p.port}/sync`, { raw: body, headers, timeout: 8000 });
      if (r.status === 401) {
        if (r.json && r.json.error === 'clock') {
          // Same shelf, clocks apart: keep the peer and say so.
          const skew = Number(r.json.serverTime) - Date.now();
          if (p.clockSkew !== skew) {
            p.clockSkew = skew;
            this.emit('peers');
          }
          return;
        }
        // Several refusals in a row: they moved to a different shelf (a single
        // one could be anything, including someone answering in their place).
        p.unauth = (p.unauth || 0) + 1;
        if (p.unauth >= UNAUTH_BEFORE_DEMOTE) {
          this.peers.delete(p.id);
          this.nearby.set(p.id, { ...p, sid: '?' });
          this.emit('peers');
        }
        return;
      }
      if (r.status !== 200 || !r.json) throw new Error('sync failed');
      if (!safeEqual(r.headers['x-shelf-proof'], this._expectedProof(rnd, p, sha256(r.raw)))) throw new Error('bad proof');
      p.lastOk = Date.now();
      p.unauth = 0;
      if (p.clockSkew) {
        p.clockSkew = 0;
        this.emit('peers');
      }
      const name = typeof r.json.from?.name === 'string' ? r.json.from.name.trim().slice(0, 60) : '';
      if (name && name !== p.name) {
        p.name = name;
        this.emit('peers');
      }
      p.have = new Set((Array.isArray(r.json.have) ? r.json.have : []).filter((x) => typeof x === 'string'));
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
    if (this._ticks % ADDRESS_CHECK_TICKS === 0) this.refreshAddresses().catch(() => {});
    if (this._ticks % 30 === 0) this._sweepReplay();
    this.pump();
  }

  // Records a computer we heard from (mDNS, an incoming sync, or a manual
  // add). A computer that claims our shelf becomes a peer only once it has
  // proven it knows the secret, at the address in question: a signed request
  // from there, or a correct answer to our challenge sent there. A known
  // peer's address changes only the same way.
  _seen(raw, { verified = false } = {}) {
    const c = sanitizePeer(raw);
    if (!c || c.id === this.self.id) return null;
    const { id, name, sid, addr, port } = c;
    if (sid === this.sid) {
      const p = this.peers.get(id);
      if (p && !verified) {
        if (p.addr !== addr || p.port !== port) this._verifyPeer(c);
        return p;
      }
      if (!p && !verified) {
        this._verifyPeer(c);
        return null;
      }
      const isNew = !p;
      const peer = p || { id, lastOk: 0, have: new Set() };
      Object.assign(peer, { name: name || peer.name || 'Computer', addr, port, sid });
      this.peers.set(id, peer);
      this.nearby.delete(id);
      if (isNew) {
        this.emit('peers');
        this._syncPeer(peer);
      }
      return peer;
    }
    const known = this.nearby.get(id);
    this.nearby.set(id, { id, name, sid, addr, port });
    if (!known) this.emit('peers');
    return null;
  }

  async _verifyPeer(c) {
    if (this.verifying.has(c.id)) return;
    this.verifying.add(c.id);
    try {
      const rnd = crypto.randomBytes(8).toString('hex');
      const to = endpoint(c.addr, c.port);
      const r = await request('GET', `http://${c.addr}:${c.port}/hello`, { timeout: 4000, limit: SMALL_BODY, headers: { 'x-shelf-challenge': rnd, 'x-shelf-to': to } });
      const ok = r.status === 200 && r.json && r.json.id === c.id && typeof r.json.proof === 'string' && safeEqual(r.json.proof, sign(this.token, ['hello', rnd, c.id, to]));
      if (ok) this._seen({ ...c, name: r.json.name, sid: this.sid }, { verified: true });
      else if (!this.peers.has(c.id)) {
        // Says it is on our shelf, cannot prove it: a stranger.
        this.nearby.set(c.id, { ...c, sid: '?' });
        this.emit('peers');
      }
    } catch {
      // Unreachable for now; mDNS or a sync will bring it back.
    } finally {
      this.verifying.delete(c.id);
    }
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

  // An online peer that has the item, preferring one that has not just
  // failed to serve it. With a single source the item's own backoff paces
  // the retries.
  _sourceFor(id) {
    const now = Date.now();
    let fallback = null;
    for (const p of this.peers.values()) {
      if (now - p.lastOk >= ONLINE_WINDOW || !p.have.has(id)) continue;
      if ((this.peerFail.get(`${id}:${p.id}`) || 0) > now) {
        fallback = fallback || p;
        continue;
      }
      return p;
    }
    return fallback;
  }

  // Pulls an item's bytes from a peer. A folder is fetched file by file into
  // a partial directory that survives failures, so a retry only fetches what
  // is still missing.
  async _download(it, peer) {
    const ac = new AbortController();
    this.active.set(it.id, ac);
    const dest = this.shelf.storePath(it);
    const dir = path.dirname(dest);
    const tmp = path.join(dir, '.partial-' + path.basename(dest));
    const to = endpoint(peer.addr, peer.port);
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
    const fetchPart = (query, out) => {
      const pathAndQuery = `/blob/${it.id}${query}`;
      const { rnd, ...headers } = this._signedHeaders('GET', pathAndQuery, null, to);
      const proof = this._expectedProof(rnd, peer, 'blob');
      return fetchToFile(`http://${peer.addr}:${peer.port}${pathAndQuery}`, headers, out, progress, ac.signal, proof);
    };
    this.shelf.setLocal(it.id, { state: 'downloading', got: 0, path: dest });
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (it.kind === 'folder') {
        await fs.promises.mkdir(tmp, { recursive: true });
        for (const d of it.dirs || []) await fs.promises.mkdir(files.safeJoin(tmp, files.safeRel(d)), { recursive: true });
        for (const f of it.files || []) {
          const out = files.safeJoin(tmp, files.safeRel(f.p));
          const have = await fs.promises.stat(out).catch(() => null);
          if (have && have.isFile() && have.size === f.s) {
            progress(f.s);
            continue;
          }
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await fetchPart(`?p=${encodeURIComponent(f.p)}`, out);
        }
      } else {
        await fetchPart('', tmp);
      }
      await fs.promises.rename(tmp, dest);
      this.backoff.delete(it.id);
      this.failures.delete(it.id);
      for (const k of [...this.peerFail.keys()]) if (k.startsWith(it.id + ':')) this.peerFail.delete(k);
      this.active.delete(it.id);
      if (!this.shelf.items.get(it.id) || this.shelf.items.get(it.id).removed) {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return;
      }
      this.shelf.setLocal(it.id, { state: 'ready', got, path: dest });
    } catch (err) {
      this.active.delete(it.id);
      const cur = this.shelf.items.get(it.id);
      if (ac.signal.aborted) {
        if (!cur || cur.removed) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
        else if (this.shelf.local.has(it.id)) this.shelf.setLocal(it.id, { state: 'missing', got: 0 });
        return;
      }
      if (it.kind !== 'folder') await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      const n = (this.failures.get(it.id) || 0) + 1;
      this.failures.set(it.id, n);
      this.backoff.set(it.id, Date.now() + Math.min(4000 * 2 ** (n - 1), BACKOFF_MAX));
      this.peerFail.set(`${it.id}:${peer.id}`, Date.now() + PEER_FAIL_MS);
      if (this.shelf.local.has(it.id)) this.shelf.setLocal(it.id, { state: 'missing', got: 0 });
    }
  }

  // ---- server ----

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const from = cleanAddr(req.socket.remoteAddress);

    if (this.web && (await this.web.handle(req, res, url))) return;

    if (req.method === 'GET' && url.pathname === '/hello') {
      const out = { app: 'shelf', v: 2, id: this.self.id, name: this.self.name, sid: this.sid, port: this.port };
      const ch = req.headers['x-shelf-challenge'];
      const to = req.headers['x-shelf-to'];
      // The proof names the address the challenger dialed and is only given
      // when that address is this computer's own.
      if (typeof ch === 'string' && /^[a-f0-9]{16}$/.test(ch) && typeof to === 'string' && this._isMine(to)) {
        out.proof = sign(this.token, ['hello', ch, this.self.id, to]);
      }
      return send(res, 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/pair') return this._pairRoute(req, res, from);

    if (url.pathname === '/sync' && req.method === 'POST') {
      // Headers first: nobody without the secret gets to fill memory.
      const pre = this._verifyPre(req);
      if (!pre.ok) {
        req.resume();
        return send(res, 401, pre.clock ? { error: 'clock', serverTime: Date.now() } : { error: 'not on this shelf' });
      }
      req.socket.setTimeout(BODY_IDLE_MS, () => req.destroy(new Error('sync stalled')));
      let raw;
      try {
        raw = await readBody(req, MAX_BODY);
      } catch (err) {
        if (err.code === 'TOO_LARGE') return send(res, 413, { error: 'too large' });
        throw err;
      } finally {
        req.socket.setTimeout(0);
      }
      const senderId = this._verifyRequest(req, raw);
      if (!senderId) return send(res, 401, { error: 'not on this shelf' });
      const body = parseJson(raw);
      if (!body || !body.from || body.from.id !== senderId) return send(res, 400, { error: 'bad request' });
      const p = this._seen({ ...body.from, sid: this.sid, addr: from }, { verified: true });
      if (p) {
        p.lastOk = Date.now();
        p.have = new Set((Array.isArray(body.have) ? body.have : []).filter((x) => typeof x === 'string'));
        this._refreshOnline();
      }
      this.shelf.merge(body.items);
      this.pump();
      const out = Buffer.from(JSON.stringify(this._payload()));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': out.length,
        'x-shelf-proof': this._proof(req, sha256(out)),
      });
      return res.end(out);
    }

    const m = url.pathname.match(/^\/blob\/([a-f0-9]{16,64})$/);
    if (req.method === 'GET' && m) {
      if (!this._verifyRequest(req, null)) return send(res, 401, { error: 'not on this shelf' });
      const it = this.shelf.items.get(m[1]);
      const l = this.shelf.local.get(m[1]);
      if (!it || it.removed || !l || l.state !== 'ready') return send(res, 404, { error: 'not here' });
      let file;
      if (it.kind === 'folder') {
        file = await files.manifestFile(it, l.path, url.searchParams.get('p'));
        if (!file) {
          // The folder on disk no longer matches what was promised; tell the
          // others about the folder as it is now.
          this.shelf.redescribe(it.id).catch(() => {});
          return send(res, 404, { error: 'gone' });
        }
      } else file = l.path;
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch {
        if (it.kind !== 'folder') this.shelf.setLocal(it.id, { state: 'missing' });
        return send(res, 404, { error: 'gone' });
      }
      if (!st.isFile()) return send(res, 404, { error: 'not a file' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
        'x-shelf-proof': this._proof(req, 'blob'),
      });
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    send(res, 404, { error: 'not found' });
  }

  // Another computer asking to join. One open question per address, a
  // cooldown after a refusal or a hang-up, a gap between questions, and the
  // question goes away if the asker hangs up before it is answered.
  async _pairRoute(req, res, from) {
    const body = parseJson(await readBody(req, 4096));
    if (!body || typeof body.id !== 'string' || typeof body.name !== 'string' || !body.id || !body.name.trim()) {
      return send(res, 400, { error: 'bad request' });
    }
    const now = Date.now();
    const d = this.declines.get(from);
    if (d && d.until > now) return send(res, 429, { error: 'declined recently' });
    if (this.pairingFrom.has(from) || now - this.lastPairDialog < PAIR_DIALOG_GAP_MS) return send(res, 429, { error: 'busy' });
    this.pairingFrom.add(from);
    this.lastPairDialog = now;
    const ac = new AbortController();
    let done = false;
    res.on('close', () => {
      if (!done) ac.abort();
    });
    try {
      const ok = await this.onPairRequest({ id: body.id.slice(0, 64), name: body.name.trim().slice(0, 60), addr: from, signal: ac.signal });
      done = true;
      if (ac.signal.aborted) {
        const n = (d ? d.n : 0) + 1;
        this.declines.set(from, { n, until: Date.now() + Math.min(PAIR_HANGUP_MS * 2 ** (n - 1), PAIR_DECLINE_LONG_MS) });
        return;
      }
      if (!ok) {
        const n = (d ? d.n : 0) + 1;
        this.declines.set(from, { n, until: Date.now() + (n >= 3 ? PAIR_DECLINE_LONG_MS : PAIR_DECLINE_MS) });
        return send(res, 403, { error: 'declined' });
      }
      this.declines.delete(from);
      // The joiner switches to our code and syncs to us right after this,
      // which is when it becomes a peer here.
      return send(res, 200, { code: this.code });
    } finally {
      done = true;
      this.pairingFrom.delete(from);
    }
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
    let addr = addrs.find((a) => !a.startsWith('169.254.')) || addrs[0] || svc.referer?.address;
    // Another copy on this same computer: loopback skips the network entirely.
    if (ownAddresses().includes(addr)) addr = '127.0.0.1';
    this._seen({ id: txt.id, name: txt.name, sid: txt.sid, addr, port: svc.port });
  }
}

// ---- small HTTP helpers ----

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (port !== 0 && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        server.removeListener('error', onError);
        listen(server, 0).then(resolve, reject);
      } else reject(err);
    };
    server.once('error', onError);
    // No host: both IPv6 and IPv4 where IPv6 exists, IPv4 alone otherwise. A
    // phone that resolves the computer's .local name to an IPv6 address can
    // still get in.
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

// A request with a bounded answer and a hard deadline.
function request(method, url, { body, raw, headers = {}, timeout = 5000, limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw || (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request(url, {
      method,
      headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      timeout,
    });
    const deadline = setTimeout(() => req.destroy(new Error('deadline')), Math.max(timeout * 3, 15000));
    const done = (fn) => (v) => {
      clearTimeout(deadline);
      fn(v);
    };
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', done(reject));
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        done(resolve)({ status: res.statusCode, headers: res.headers, raw: buf, json: parseJson(buf) });
      });
      res.on('error', done(reject));
    });
    if (data) req.write(data);
    req.end();
  });
}

function fetchToFile(url, headers, dest, onBytes, signal, proof) {
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
      if (proof && !safeEqual(res.headers['x-shelf-proof'], proof)) {
        req.destroy();
        return reject(new Error('bad proof'));
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

module.exports = { Net, newCode, normalizeCode, codeKeys, lanAddresses, outboundAddress, DEFAULT_PORT, DEFAULT_HTTPS_PORT };
