'use strict';

const fs = require('fs');
const os = require('os');
const dns = require('dns');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const path = require('path');
const crypto = require('crypto');
const { isIP } = require('net');
const { EventEmitter } = require('events');
const files = require('./files');
const { Web } = require('./web');
const tlsmod = require('./tls');
const { send, readBody, parseJson, safeEqual, sha256 } = require('./httpu');

const DEFAULT_PORT = 47474;
const DEFAULT_HTTPS_PORT = 47475;
const PROTOCOL = 3; // 3: file bytes carry a signed sha256 trailer
const ONLINE_WINDOW = 35 * 1000;
const STALE_MS = 2 * 60 * 1000;
const TICK_MS = 2000;
const SYNC_EVERY_TICKS = 5;
const ADDRESS_CHECK_TICKS = 15;
const NEARBY_CHECK_TICKS = 60;
const MAX_DOWNLOADS = 3;
const MAX_BODY = 64 * 1024 * 1024;
const SMALL_BODY = 64 * 1024;
const AUTH_WINDOW = 5 * 60 * 1000;
const REPLAY_KEEP = 10000;
const PEER_FAIL_MS = 60 * 1000;
const BACKOFF_MAX = 5 * 60 * 1000;
const FAIL_LIMIT = 3;
const PAIR_DECLINE_MS = 60 * 1000;
const PAIR_DECLINE_LONG_MS = 15 * 60 * 1000;
const PAIR_HANGUP_MS = 10 * 1000;
const PAIR_GAVE_UP_MS = 30 * 1000;
const PAIR_DIALOG_GAP_MS = 5 * 1000;
const PAIR_BEAT_MS = 10 * 1000;
const PAIR_IDLE_MS = 75 * 1000;
const PAIR_WAIT_MS = 10 * 60 * 1000;
const UNAUTH_BEFORE_DEMOTE = 3;
const BODY_IDLE_MS = 60 * 1000;
const SKEW_STEP_MS = 5000;

// Adapters no other device on the Wi-Fi can reach: WSL, Hyper-V, VM and
// container bridges.
const VIRTUAL_IFACE = /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|vmnet|docker|^br-|^veth|^virbr/i;

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

function subnet(a) {
  return String(a || '').split('.').slice(0, 3).join('.');
}

function ownAddresses({ v6 = false } = {}) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' || (v6 && a.family === 'IPv6')) out.push(a.address);
  }
  return out;
}

// Addresses another device could reach, the best one first: no loopback, no
// link-local, and no virtual adapters unless there is nothing else.
function lanAddresses(best = null) {
  const real = [];
  const virtual = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      (VIRTUAL_IFACE.test(name) ? virtual : real).push(a.address);
    }
  }
  const out = [...new Set(real.length ? real : virtual)];
  if (best) {
    const rank = (a) => (a === best ? 0 : subnet(a) === subnet(best) ? 1 : 2);
    out.sort((a, b) => rank(a) - rank(b));
  }
  return out;
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

function urlBase(addr, port) {
  return `http://${String(addr).includes(':') ? `[${addr}]` : addr}:${port}`;
}

function cleanHost(h) {
  return typeof h === 'string' && /^[a-z0-9-]{1,63}\.local$/i.test(h) ? h.toLowerCase() : null;
}

function sanitizePeer({ id, name, sid, addr, port, host }) {
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
    host: cleanHost(host),
  };
}

const NOT_REACHED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTDOWN', 'EADDRNOTAVAIL']);

function noAnswer(where) {
  return `No Shelf app answered at ${where}. Check the address and that Shelf is open there (and allowed through its firewall).`;
}

// What went wrong with a download, in words, and whether trying again can help.
function downloadFailure(err, from) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  if (err && err.status === 404) {
    if (err.reason === 'not here') return { text: `${from} doesn't have it ready right now.`, permanent: false };
    return { text: `The original was moved or deleted on ${from}.`, permanent: true };
  }
  if (err && err.status === 401) return { text: `${from} turned this computer away. Check that both clocks are right.`, permanent: false };
  if (err && err.status) return { text: `${from} had a problem sending it (error ${err.status}). Trying again.`, permanent: false };
  if (msg === 'bad proof' || code === 'BAD_SUM') return { text: `The copy from ${from} didn't match what was sent, so it was thrown away.`, permanent: true };
  if (code === 'ENOSPC') return { text: "There isn't enough free space on this computer.", permanent: true };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { text: "Shelf isn't allowed to save files in its folder on this computer.", permanent: true };
  if (msg === 'path escapes item' || code === 'ENAMETOOLONG' || code === 'EINVAL') return { text: "It has a file name this computer can't save.", permanent: true };
  if (NOT_REACHED.has(code)) return { text: `Couldn't reach ${from}. Trying again.`, permanent: false };
  if (msg === 'timeout' || msg === 'transfer cut short' || msg === 'aborted' || code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') {
    return { text: `Lost the connection to ${from}. Trying again.`, permanent: false };
  }
  return { text: `Couldn't copy it from ${from}. Trying again.`, permanent: false };
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
//
// `known` is the list of computers seen before ({ id, name, addr, port }),
// checked again on start; 'known' is emitted with the current list whenever
// it changes so the caller can keep it.
class Net extends EventEmitter {
  constructor({ shelf, self, code, port = DEFAULT_PORT, mdns = true, onPairRequest, tickMs = TICK_MS, web = null, httpsPort = DEFAULT_HTTPS_PORT, known = [] }) {
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
    this.known = new Map(); // id -> { id, name, addr, port }, kept across restarts
    this.mdnsAddrs = new Map(); // id -> { addrs, port } as last announced
    this.verifying = new Set(); // ids being checked right now
    this.active = new Map(); // id -> AbortController
    this.backoff = new Map(); // id -> retry-after ms
    this.failures = new Map(); // id -> consecutive failures
    this.failedAt = new Map(); // id -> item version that gave up
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
    for (const k of Array.isArray(known) ? known : []) {
      const c = k && typeof k === 'object' ? sanitizePeer(k) : null;
      if (c && c.id !== self.id) this.known.set(c.id, { id: c.id, name: c.name, addr: c.addr, port: c.port });
    }
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
        peers: () => this.peerList().filter((p) => p.online).map((p) => ({ name: p.name, addr: p.addr, port: p.port, host: p.host })),
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
    this._recheckKnown(true);
  }

  async stop() {
    this._stopping = true;
    clearInterval(this._timer);
    clearTimeout(this._syncTimer);
    for (const ac of this.active.values()) ac.abort();
    if (this.web) this.web.stop();
    if (this.bonjour) {
      const b = this.bonjour;
      this.bonjour = null;
      await new Promise((r) => {
        b.unpublishAll(r);
        setTimeout(r, 2000).unref();
      });
      b.destroy();
    }
    for (const s of [this.https, this.server]) {
      if (!s) continue;
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
  }

  // ---- addresses and the phone certificate ----

  ownHost() {
    return this.addresses.hosts.find((h) => h.endsWith('.local')) || null;
  }

  // Loopback is included so the page can be opened on this computer too.
  _certNames() {
    return {
      hosts: [...this.addresses.hosts, 'localhost'],
      ips: [...this.addresses.ips, '127.0.0.1'],
      computerName: this.self.name,
    };
  }

  async refreshAddresses() {
    // A slow answer keeps the last best address rather than reshuffling.
    const out = (await outboundAddress()) || this.addresses.best;
    const ips = lanAddresses(out);
    const next = { ips, hosts: hostNames(), best: ips.includes(out) ? out : ips[0] || null };
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
    if (changed) {
      this.emit('addresses', next);
      // The announcement carries the addresses it was built with, and the
      // multicast socket only joined the interfaces that existed then.
      this._restartMdns();
    }
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
    return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || ownAddresses({ v6: true }).includes(addr);
  }

  // Checks the headers alone, before any body is read: a stranger costs no
  // memory. Returns { ok, id, ts, rnd, to } or { ok: false, clock: true, id,
  // ts } when the signature is right but the sender's clock is off.
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
    if (Math.abs(Date.now() - ts) > AUTH_WINDOW) return { ok: false, clock: true, id, ts };
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
    this.failedAt.clear();
    this.peerFail.clear();
    for (const p of this.peers.values()) this.nearby.set(p.id, { id: p.id, name: p.name, sid: p.sid, addr: p.addr, port: p.port, host: p.host });
    this.peers.clear();
    for (const n of [...this.nearby.values()]) if (n.sid === this.sid) this._seen(n, { addrs: n.addrs });
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

  // clockSkew is how far the other computer's clock is ahead of this one's
  // (ms, negative when behind); clockOff says signed requests are being
  // refused because of it.
  peerList() {
    const now = Date.now();
    return [...this.peers.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        online: now - p.lastOk < ONLINE_WINDOW,
        addr: p.addr,
        port: p.port,
        host: p.host || null,
        clockSkew: p.clockOff ? p.clockSkew || 0 : 0,
        clockOff: !!p.clockOff,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  nearbyList() {
    return [...this.nearby.values()]
      .filter((n) => !this.peers.has(n.id))
      .map((n) => ({ id: n.id, name: n.name, addr: n.addr }));
  }

  knownList() {
    return [...this.known.values()].map((k) => ({ ...k }));
  }

  _remember(c) {
    const k = { id: c.id, name: c.name, addr: c.addr, port: c.port };
    const cur = this.known.get(c.id);
    if (cur && cur.name === k.name && cur.addr === k.addr && cur.port === k.port) return;
    this.known.set(c.id, k);
    this.emit('known', this.knownList());
  }

  // Drops a computer from every list. One still on this shelf comes back as
  // soon as it syncs again; only a new shelf code keeps it out.
  forget(id) {
    const had = this.known.delete(id);
    const shown = this.peers.delete(id) | this.nearby.delete(id);
    this.mdnsAddrs.delete(id);
    if (had) this.emit('known', this.knownList());
    if (shown) this.emit('peers');
    return had || !!shown;
  }

  // Asks a nearby computer to let this one join its shelf. The other computer
  // shows a prompt; if accepted it answers with its shelf code. The other
  // side keeps the line alive while its question is open.
  async requestJoin(nearbyId) {
    const n = this.nearby.get(nearbyId);
    if (!n) throw new Error('That computer is no longer nearby');
    const body = { id: this.self.id, name: this.self.name, port: this.port };
    let r;
    try {
      r = await request('POST', `${urlBase(n.addr, n.port)}/pair`, { body, timeout: PAIR_IDLE_MS, deadline: PAIR_WAIT_MS, limit: SMALL_BODY });
    } catch (err) {
      if (!err.connected && (NOT_REACHED.has(err.code) || err.code === 'ENOTFOUND')) {
        throw new Error(`Couldn't reach ${n.name} at ${n.addr}. Check that Shelf is open there and allowed through its firewall.`);
      }
      throw new Error(`Nobody answered on ${n.name} in time. Try again and click Let It Join there.`);
    }
    if (r.status === 403) throw new Error(`${n.name} said no`);
    if (r.status === 429) {
      if (r.json && r.json.error === 'declined recently') throw new Error(`${n.name} said no a moment ago. Try again later.`);
      throw new Error(`${n.name} is busy with another request. Try again in a minute.`);
    }
    if (r.status !== 200 || !r.json || !r.json.code) throw new Error(`${n.name} didn't answer. Try again.`);
    this.setCode(r.json.code);
    await this._verifyPeer({ ...n, sid: this.sid }, this._targets(n));
    return r.json.code;
  }

  // Adds a computer by IP address (or name), for networks where mDNS doesn't
  // get through.
  async addAddress(host, port = DEFAULT_PORT) {
    const name = String(host == null ? '' : host).trim().replace(/^\[|\]$/g, '');
    const p = Number(port);
    if (!name || /[\s/\\]/.test(name) || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error("That doesn't look like an address. Type it like 192.168.1.20 or 192.168.1.20:47474.");
    }
    const where = endpoint(name.includes(':') ? `[${name}]` : name, p);
    let addr = name;
    if (!isIP(name)) {
      try {
        addr = (await dns.promises.lookup(name, { family: 4 })).address;
      } catch {
        throw new Error(`${name} could not be found on this network. Try its IP address instead.`);
      }
    }
    let r;
    try {
      r = await this._hello(addr, p);
    } catch {
      throw new Error(noAnswer(where));
    }
    if (!r.json) throw new Error(noAnswer(where));
    const h = r.json;
    if (h.id === this.self.id) throw new Error("That's this computer");
    const c = sanitizePeer({ id: h.id, name: h.name, sid: h.sid, addr, port: p, host: h.host });
    if (!c) throw new Error(noAnswer(where));
    this._remember(c);
    if (r.proven) {
      this._seen({ ...c, sid: this.sid }, { verified: true });
      return 'peer';
    }
    this._seen({ ...c, sid: c.sid === this.sid ? '?' : c.sid });
    return 'nearby';
  }

  // Asks a Shelf at addr:port who it is, with a challenge only the shelf
  // secret answers. Rejects when nothing answers.
  async _hello(addr, port) {
    const rnd = crypto.randomBytes(8).toString('hex');
    const to = endpoint(addr, port);
    const r = await request('GET', `${urlBase(addr, port)}/hello`, { timeout: 4000, limit: SMALL_BODY, headers: { 'x-shelf-challenge': rnd, 'x-shelf-to': to } });
    const json = r.status === 200 && r.json && r.json.app === 'shelf' && typeof r.json.id === 'string' ? r.json : null;
    const proven = !!json && typeof json.proof === 'string' && safeEqual(json.proof, sign(this.token, ['hello', rnd, json.id, to]));
    return { json, proven };
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
      from: { id: this.self.id, name: this.self.name, port: this.port, v: PROTOCOL, host: this.ownHost() },
      items: this.shelf.payload(),
      have: this.shelf.have(),
    };
  }

  _clockOff(p, skew) {
    if (p.clockOff && Math.abs((p.clockSkew || 0) - skew) < SKEW_STEP_MS) return;
    p.clockOff = true;
    p.clockSkew = skew;
    this.emit('peers');
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
      const r = await request('POST', `${urlBase(p.addr, p.port)}/sync`, { raw: body, headers, timeout: 8000 });
      if (r.status === 401) {
        if (r.json && r.json.error === 'clock') {
          // Same shelf, clocks apart: keep the peer and say so.
          const skew = Number(r.json.serverTime) - Date.now();
          if (Number.isFinite(skew)) this._clockOff(p, skew);
          return;
        }
        // Several refusals in a row: they moved to a different shelf (a single
        // one could be anything, including someone answering in their place).
        p.unauth = (p.unauth || 0) + 1;
        if (p.unauth >= UNAUTH_BEFORE_DEMOTE) {
          this.peers.delete(p.id);
          this.nearby.set(p.id, { id: p.id, name: p.name, sid: '?', addr: p.addr, port: p.port, host: p.host });
          this.emit('peers');
        }
        return;
      }
      if (r.status !== 200 || !r.json) throw new Error('sync failed');
      if (!safeEqual(r.headers['x-shelf-proof'], this._expectedProof(rnd, p, sha256(r.raw)))) throw new Error('bad proof');
      p.lastOk = Date.now();
      p.unauth = 0;
      p.blobSum = Number(r.json.from?.v) >= 3;
      if (p.clockOff) {
        p.clockOff = false;
        p.clockSkew = 0;
        this.emit('peers');
      }
      const name = typeof r.json.from?.name === 'string' ? r.json.from.name.trim().slice(0, 60) : '';
      if (name && name !== p.name) {
        p.name = name;
        this.emit('peers');
      }
      const host = cleanHost(r.json.from?.host);
      if (host && host !== p.host) {
        p.host = host;
        this.emit('peers');
      }
      this._remember(p);
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
      if (this.browser && this._ticks % (SYNC_EVERY_TICKS * 3) === 0) {
        this.browser.expire();
        this.browser.update();
      }
    }
    if (this._ticks % ADDRESS_CHECK_TICKS === 0) {
      this.refreshAddresses().catch(() => {});
      this._recheckKnown();
    }
    if (this._ticks % NEARBY_CHECK_TICKS === 0) this._recheckNearby();
    if (this._ticks % 30 === 0) this._sweepReplay();
    this.pump();
  }

  // Where a computer might be now: what mDNS last announced for it, then the
  // address it was last proven at.
  _targets(c) {
    const out = [];
    const add = (addr, port) => {
      if (addr && port && !out.some((t) => t.addr === addr && t.port === port)) out.push({ addr, port });
    };
    const m = this.mdnsAddrs.get(c.id);
    if (m) for (const a of m.addrs) add(a, m.port);
    for (const a of c.addrs || []) add(a, c.port);
    add(c.addr, c.port);
    const k = this.known.get(c.id);
    if (k) add(k.addr, k.port);
    return out;
  }

  // Computers seen before that are not online now (or have been quiet a
  // while) are asked again wherever they might be.
  _recheckKnown(all = false) {
    const now = Date.now();
    for (const k of this.known.values()) {
      const p = this.peers.get(k.id);
      if (p && now - p.lastOk < (all ? ONLINE_WINDOW : STALE_MS)) continue;
      if (!p && this.nearby.has(k.id) && this.nearby.get(k.id).sid !== '?' && this.nearby.get(k.id).sid !== this.sid) continue;
      const c = p || k;
      this._verifyPeer({ ...c, sid: this.sid }, this._targets(c));
    }
  }

  // Nearby computers that could not prove themselves may simply have been
  // unreachable at the address tried, or have joined since.
  _recheckNearby() {
    for (const n of [...this.nearby.values()]) {
      if (this.peers.has(n.id) || (n.sid !== '?' && n.sid !== this.sid)) continue;
      this._verifyPeer({ ...n, sid: this.sid }, this._targets(n));
    }
  }

  // Records a computer we heard from (mDNS, an incoming sync, or a manual
  // add). A computer that claims our shelf becomes a peer only once it has
  // proven it knows the secret, at the address in question: a signed request
  // from there, or a correct answer to our challenge sent there. A known
  // peer's address changes only the same way. `addrs` lists every address
  // it was announced at, best first.
  _seen(raw, { verified = false, addrs = null } = {}) {
    const c = sanitizePeer(raw);
    if (!c || c.id === this.self.id) return null;
    const { id, name, sid, addr, port, host } = c;
    const all = addrs && addrs.length ? addrs : [addr];
    if (sid === this.sid) {
      const p = this.peers.get(id);
      if (p && !verified) {
        if (p.port !== port || !all.includes(p.addr)) this._verifyPeer(c, this._targets({ ...c, addrs: all }));
        return p;
      }
      if (!p && !verified) {
        this._verifyPeer(c, this._targets({ ...c, addrs: all }));
        return null;
      }
      const isNew = !p;
      const peer = p || { id, lastOk: 0, have: new Set() };
      Object.assign(peer, { name: name || peer.name || 'Computer', addr, port, sid });
      if (host) peer.host = host;
      this.peers.set(id, peer);
      this.nearby.delete(id);
      this._remember(peer);
      if (isNew) {
        this.emit('peers');
        this._syncPeer(peer);
      }
      return peer;
    }
    const prev = this.nearby.get(id);
    this.nearby.set(id, { id, name, sid, addr, port, host: host || (prev && prev.host) || null, addrs: all });
    if (!prev || prev.addr !== addr || prev.name !== name || prev.sid !== sid) this.emit('peers');
    return null;
  }

  // Challenges a computer at each place it might be, in order, until one
  // proves it.
  async _verifyPeer(c, targets = null) {
    if (this.verifying.has(c.id)) return;
    this.verifying.add(c.id);
    try {
      const list = targets && targets.length ? targets : [{ addr: c.addr, port: c.port }];
      let stranger = null;
      for (const t of list) {
        let r;
        try {
          r = await this._hello(t.addr, t.port);
        } catch {
          continue; // unreachable there
        }
        if (!r.json || r.json.id !== c.id) continue;
        if (r.proven) {
          this._seen({ ...c, ...t, name: r.json.name, host: r.json.host, sid: this.sid }, { verified: true });
          return;
        }
        stranger = stranger || { ...c, ...t, sid: r.json.sid === this.sid || typeof r.json.sid !== 'string' ? '?' : r.json.sid };
      }
      if (stranger && !this.peers.has(c.id)) {
        // Says it is on our shelf, cannot prove it: a stranger.
        const prev = this.nearby.get(c.id);
        this.nearby.set(c.id, { id: c.id, name: c.name, sid: stranger.sid, addr: stranger.addr, port: stranger.port, host: c.host || null, addrs: list.map((t) => t.addr) });
        if (!prev || prev.sid !== stranger.sid || prev.addr !== stranger.addr) this.emit('peers');
      }
      // Unreachable everywhere for now; mDNS, a sync or the next check brings it back.
    } finally {
      this.verifying.delete(c.id);
    }
  }

  // ---- downloads ----

  pump() {
    if (this.active.size >= MAX_DOWNLOADS) return;
    const now = Date.now();
    const unfail = [];
    for (const it of this.shelf.needsDownload()) {
      if (this.active.size >= MAX_DOWNLOADS) break;
      const l = this.shelf.local.get(it.id);
      if (l && l.failed) {
        // Gave up on this version; a changed item (a repaired folder) is a
        // fresh start.
        if (this.failedAt.has(it.id) && this.failedAt.get(it.id) !== it.v) unfail.push(it.id);
        continue;
      }
      if (this.active.has(it.id) || (this.backoff.get(it.id) || 0) > now) continue;
      const source = this._sourceFor(it.id);
      if (!source) continue;
      this._download(it, source);
    }
    for (const id of unfail) this.retry(id);
  }

  // Clears a download that gave up and tries again now.
  retry(id) {
    this.failures.delete(id);
    this.backoff.delete(id);
    this.failedAt.delete(id);
    for (const k of [...this.peerFail.keys()]) if (k.startsWith(id + ':')) this.peerFail.delete(k);
    const l = this.shelf.local.get(id);
    if (l && (l.failed || l.error)) this.shelf.setLocal(id, { error: null, failed: false });
    this.pump();
    return true;
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
      // A peer that signs the bytes must: a missing signature is a swap.
      const sumProof = peer.blobSum ? (hex) => this._expectedProof(rnd, peer, 'blob-sum:' + hex) : null;
      return fetchToFile(`${urlBase(peer.addr, peer.port)}${pathAndQuery}`, headers, out, progress, ac.signal, proof, sumProof);
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
          try {
            await fetchPart(`?p=${encodeURIComponent(f.p)}`, out);
          } catch (err) {
            // A file that failed its check has the right size and would be
            // kept by the next attempt.
            if (!ac.signal.aborted) await fs.promises.rm(out, { force: true }).catch(() => {});
            throw err;
          }
        }
        // A retry follows a repaired manifest: whatever the source no longer
        // has must not come along.
        await prunePartial(tmp, it);
      } else {
        await fetchPart('', tmp);
      }
      await fs.promises.rename(tmp, dest);
      this.backoff.delete(it.id);
      this.failures.delete(it.id);
      this.failedAt.delete(it.id);
      for (const k of [...this.peerFail.keys()]) if (k.startsWith(it.id + ':')) this.peerFail.delete(k);
      this.active.delete(it.id);
      if (!this.shelf.items.get(it.id) || this.shelf.items.get(it.id).removed) {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return;
      }
      this.shelf.setLocal(it.id, { state: 'ready', got, path: dest, error: null, failed: false });
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
      const why = downloadFailure(err, peer.name || 'the other computer');
      const failed = why.permanent && n >= FAIL_LIMIT;
      if (failed) this.failedAt.set(it.id, (cur || it).v);
      if (this.shelf.local.has(it.id)) this.shelf.setLocal(it.id, { state: 'missing', got: 0, error: why.text, failed });
    }
  }

  // ---- server ----

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const from = cleanAddr(req.socket.remoteAddress);

    if (this.web && (await this.web.handle(req, res, url))) return;

    if (req.method === 'GET' && url.pathname === '/hello') {
      const out = { app: 'shelf', v: PROTOCOL, id: this.self.id, name: this.self.name, sid: this.sid, port: this.port, host: this.ownHost() };
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
        if (pre.clock) {
          const p = this.peers.get(pre.id);
          if (p) this._clockOff(p, pre.ts - Date.now());
        }
        return send(res, 401, pre.clock ? { error: 'clock', serverTime: Date.now() } : { error: 'not on this shelf' });
      }
      // The listener comes off again afterwards: peers keep the socket alive
      // across syncs, and one left behind per sync would pile up.
      const stalled = () => req.destroy(new Error('sync stalled'));
      req.socket.setTimeout(BODY_IDLE_MS);
      req.socket.on('timeout', stalled);
      let raw;
      try {
        raw = await readBody(req, MAX_BODY);
      } catch (err) {
        if (err.code === 'TOO_LARGE') return send(res, 413, { error: 'too large' });
        throw err;
      } finally {
        req.socket.setTimeout(0);
        req.socket.off('timeout', stalled);
      }
      const senderId = this._verifyRequest(req, raw);
      if (!senderId) return send(res, 401, { error: 'not on this shelf' });
      const body = parseJson(raw);
      if (!body || !body.from || body.from.id !== senderId) return send(res, 400, { error: 'bad request' });
      const p = this._seen({ ...body.from, sid: this.sid, addr: from }, { verified: true });
      if (p) {
        p.lastOk = Date.now();
        p.blobSum = Number(body.from.v) >= 3;
        if (p.clockOff) {
          p.clockOff = false;
          p.clockSkew = 0;
          this.emit('peers');
        }
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
      // The bytes are hashed on the way out and the signed hash follows them
      // as a trailer, so nothing in between can swap them unnoticed.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-shelf-size': String(st.size),
        'x-shelf-proof': this._proof(req, 'blob'),
        trailer: 'x-shelf-sum',
      });
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('data', (c) => hash.update(c));
      stream.on('end', () => res.addTrailers({ 'x-shelf-sum': this._proof(req, 'blob-sum:' + hash.digest('hex')) }));
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    send(res, 404, { error: 'not found' });
  }

  // Another computer asking to join. One open question per address, a
  // cooldown after a refusal or a quick hang-up, a gap between questions,
  // and the question goes away if the asker hangs up before it is answered.
  // While it is open the line is kept alive so the asker does not give up.
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
    const beat = setInterval(() => {
      try {
        if (!res.headersSent && !res.destroyed) res.writeProcessing();
      } catch {}
    }, PAIR_BEAT_MS);
    try {
      const ok = await this.onPairRequest({ id: body.id.slice(0, 64), name: body.name.trim().slice(0, 60), addr: from, signal: ac.signal });
      done = true;
      if (ac.signal.aborted) {
        // A hang-up after a long wait is the asker giving up, not someone
        // poking at the dialog.
        if (Date.now() - now < PAIR_GAVE_UP_MS) {
          const n = (d ? d.n : 0) + 1;
          this.declines.set(from, { n, until: Date.now() + Math.min(PAIR_HANGUP_MS * 2 ** (n - 1), PAIR_DECLINE_LONG_MS) });
        }
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
      clearInterval(beat);
      this.pairingFrom.delete(from);
    }
  }

  // ---- mDNS ----

  _startMdns() {
    const { Bonjour } = require('bonjour-service');
    this.bonjour = new Bonjour({}, () => {});
    this._publish();
    const browser = this.bonjour.find({ type: 'shelf' }, (svc) => this._fromService(svc));
    this.browser = browser;
    browser.on('down', (svc) => {
      const id = svc.txt && svc.txt.id;
      if (!id) return;
      this.mdnsAddrs.delete(id);
      if (this.nearby.delete(id)) this.emit('peers');
    });
    browser.on('srv-update', (svc) => this._fromService(svc));
    browser.on('txt-update', (svc) => this._fromService(svc));
    // The Browser only reports a known service again when its name, port or
    // text change, never its addresses, and never marks it as seen again.
    // Every answer is read here as well, after the Browser has had it.
    browser.mdns.on('response', (packet, rinfo) => {
      if (this.browser !== browser) return;
      let built;
      try {
        built = browser.buildServicesFor(browser.name, packet, browser.txt, rinfo, Date.now());
      } catch {
        return;
      }
      for (const svc of built) {
        const cur = svc.fqdn && browser.services.find((s) => String(s.fqdn).toLowerCase() === String(svc.fqdn).toLowerCase());
        if (!cur) continue;
        cur.lastSeen = svc.lastSeen;
        const addrs = (svc.addresses || []).filter(isIPv4);
        if (!addrs.length || addrs.join(',') === (cur.addresses || []).filter(isIPv4).join(',')) continue;
        cur.addresses = svc.addresses;
        cur.referer = svc.referer;
        this._fromService(cur);
      }
    });
  }

  // Rebuilds the mDNS side after a network change: a fresh announcement and
  // a multicast socket on the interfaces as they are now.
  _restartMdns() {
    const old = this.bonjour;
    if (!old || this._stopping) return;
    this.bonjour = null;
    this.browser = null;
    this.service = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        old.destroy();
      } catch {}
      if (!this._stopping && !this.bonjour && this.useMdns) this._startMdns();
    };
    try {
      old.unpublishAll(finish);
    } catch {
      finish();
    }
    setTimeout(finish, 2000).unref();
  }

  _publish() {
    const svc = this.bonjour.publish({
      name: `Shelf ${this.self.id.slice(0, 10)}`,
      type: 'shelf',
      port: this.port,
      txt: { id: this.self.id, name: this.self.name, sid: this.sid, ...(this.ownHost() ? { host: this.ownHost() } : {}) },
      disableIPv6: true,
    });
    // Announce reachable addresses only, best first: the library lists
    // every adapter, WSL and VM bridges included, in whatever order the
    // system gives them.
    const base = svc.records.bind(svc);
    let cached = null;
    svc.records = () => {
      if (!cached) {
        const all = base();
        const ips = this.addresses.ips;
        const a = all.filter((r) => r.type === 'A' && ips.includes(r.data)).sort((x, y) => ips.indexOf(x.data) - ips.indexOf(y.data));
        cached = a.length ? [...all.filter((r) => r.type !== 'A'), ...a] : all;
      }
      return cached.map((r) => ({ ...r }));
    };
    svc.on('error', () => {});
    this.service = svc;
  }

  _republish() {
    if (!this.bonjour) return;
    const old = this.service;
    const done = () => {
      if (!this.bonjour) return;
      this._publish();
      if (this.browser) this.browser.update();
    };
    if (old) old.stop(done);
    else done();
  }

  // Every announced address, the likeliest first: same subnet as this
  // computer's own best address, then the one the announcement came from.
  _rankAddrs(addrs, referer) {
    const best = this.addresses.best;
    const list = [...new Set(addrs.filter((a) => isIPv4(a) && !a.startsWith('169.254.')))];
    const ref = isIPv4(referer || '') && !referer.startsWith('169.254.') ? referer : null;
    if (ref && !list.includes(ref)) list.push(ref);
    const rank = (a) => (best && subnet(a) === subnet(best) ? 0 : a === ref ? 1 : 2);
    list.sort((a, b) => rank(a) - rank(b));
    if (!list.length) list.push(...addrs.filter(isIPv4));
    return list;
  }

  _fromService(svc) {
    const txt = svc.txt || {};
    if (typeof txt.id !== 'string' || txt.id === this.self.id) return;
    let addrs = this._rankAddrs(svc.addresses || [], svc.referer && svc.referer.address);
    if (!addrs.length) return;
    // Another copy on this same computer: loopback skips the network entirely.
    if (ownAddresses().includes(addrs[0])) addrs = ['127.0.0.1'];
    this.mdnsAddrs.set(txt.id, { addrs, port: svc.port });
    this._seen({ id: txt.id, name: txt.name, sid: txt.sid, addr: addrs[0], port: svc.port, host: txt.host }, { addrs });
  }
}

// Removes from a partial folder everything its manifest does not list.
async function prunePartial(tmp, it) {
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const root = path.resolve(tmp);
  const keepFiles = new Set();
  const keepDirs = new Set();
  const keepParents = (abs) => {
    for (let d = path.dirname(abs); d.length > root.length; d = path.dirname(d)) keepDirs.add(fold(d));
  };
  for (const f of it.files || []) {
    const abs = files.safeJoin(root, files.safeRel(f.p));
    keepFiles.add(fold(abs));
    keepParents(abs);
  }
  for (const d of it.dirs || []) {
    const abs = files.safeJoin(root, files.safeRel(d));
    keepDirs.add(fold(abs));
    keepParents(abs);
  }
  const walk = async (dir) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && keepDirs.has(fold(abs))) await walk(abs);
      else if (!(e.isFile() && keepFiles.has(fold(abs)))) await fs.promises.rm(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
  await walk(root);
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

// A request with a bounded answer, an idle timeout and a hard deadline. A
// rejection carries err.connected: whether the other side was reached at all.
function request(method, url, { body, raw, headers = {}, timeout = 5000, deadline, limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let req;
    try {
      const data = raw || (body === undefined ? null : Buffer.from(JSON.stringify(body)));
      req = http.request(url, {
        method,
        headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
        timeout,
      });
      if (data) req.write(data);
    } catch (err) {
      err.connected = false;
      return reject(err);
    }
    const timer = setTimeout(() => req.destroy(new Error('deadline')), deadline || Math.max(timeout * 3, 15000));
    const done = (fn) => (v) => {
      clearTimeout(timer);
      if (v instanceof Error) v.connected = connected;
      fn(v);
    };
    req.on('socket', (s) => {
      if (!s.connecting) connected = true;
      else s.once('connect', () => (connected = true));
    });
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
    req.end();
  });
}

// Streams a download to `dest`. `proof` is the signature the answer's
// headers must carry; `sumProof(hex)`, when given, the one the trailer must
// carry over the sha256 of the bytes. A non-200 answer rejects with
// err.status and err.reason (the answer's error text).
function fetchToFile(url, headers, dest, onBytes, signal, proof, sumProof = null) {
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
      try {
        if (res.statusCode !== 200) {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            if ((size += c.length) <= 4096) chunks.push(c);
          });
          res.on('end', () => {
            const j = parseJson(Buffer.concat(chunks));
            const err = new Error(`HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.reason = j && typeof j.error === 'string' ? j.error : '';
            reject(err);
          });
          res.on('error', () => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, reason: '' })));
          return;
        }
        if (proof && !safeEqual(res.headers['x-shelf-proof'], proof)) {
          req.destroy();
          return reject(new Error('bad proof'));
        }
        const len = res.headers['content-length'] !== undefined ? res.headers['content-length'] : res.headers['x-shelf-size'];
        const expected = len === undefined ? NaN : Number(len);
        const hash = sumProof ? crypto.createHash('sha256') : null;
        let got = 0;
        out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (hash) hash.update(c);
          onBytes(c.length);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('transfer cut short')));
        out.on('error', reject);
        out.on('finish', () => {
          if (Number.isFinite(expected) && got !== expected) return reject(new Error('transfer cut short'));
          if (hash && !safeEqual(res.trailers['x-shelf-sum'], sumProof(hash.digest('hex')))) {
            return reject(Object.assign(new Error('bad sum'), { code: 'BAD_SUM' }));
          }
          resolve();
        });
        res.pipe(out);
      } catch (err) {
        req.destroy();
        reject(err);
      }
    });
  });
}

module.exports = { Net, newCode, normalizeCode, codeKeys, lanAddresses, outboundAddress, fetchToFile, downloadFailure, DEFAULT_PORT, DEFAULT_HTTPS_PORT };
