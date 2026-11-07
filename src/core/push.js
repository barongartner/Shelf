'use strict';

// Web Push from the computer to the phone's Home Screen app. The phone hands
// over a subscription (an endpoint at Apple's or another browser's push
// service, plus its keys); the computer encrypts a short message for it
// (RFC 8291, aes128gcm) and posts it there, signed with this computer's
// VAPID key (RFC 8292). Nothing here needs a library: Node's crypto has the
// P-256 keys, HKDF and AES-GCM it takes.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Where a subscription may point. A paired phone is trusted, but the
// computer still only ever posts to a real push service.
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const SUBJECT = 'https://github.com/barongartner/Shelf';
const MAX_SUBS_PER_DEVICE = 4;
const RECORD_SIZE = 4096;
const SEND_TIMEOUT = 20000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

function newKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { pub: b64u(ecdh.getPublicKey()), priv: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject({ pub, priv }) {
  const p = fromB64u(pub);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) },
    format: 'jwk',
  });
}

// The VAPID header for one push service (the JWT's audience is its origin).
function vapidAuth(keys, endpoint, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.pub}`;
}

// RFC 8291: one aes128gcm record for the subscription's keys. salt and
// local (an ECDH with keys) can be passed in to check against the RFC's
// worked example.
function encrypt(plaintext, sub, { salt = crypto.randomBytes(16), local = null } = {}) {
  const uaPub = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error('bad p256dh key');
  if (authSecret.length < 16) throw new Error('bad auth secret');
  const ecdh = local || crypto.createECDH('prime256v1');
  if (!local) ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (data.length + 16 > RECORD_SIZE) throw new Error('message too long for one push');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head[20] = asPub.length;
  return Buffer.concat([head, asPub, sealed]);
}

function validSubscription(s, hosts = PUSH_HOSTS) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 1024) return null;
  let u;
  try {
    u = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !hosts.some((h) => h.test(u.hostname))) return null;
  const keys = s.keys || {};
  if (fromB64u(keys.p256dh).length !== 65 || fromB64u(keys.auth).length < 16) return null;
  return { endpoint: s.endpoint, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) } };
}

function post(endpoint, headers, body, agent) {
  return new Promise((resolve) => {
    const req = https.request(endpoint, { method: 'POST', headers: { ...headers, 'content-length': body.length }, agent, timeout: SEND_TIMEOUT }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (text.length < 2000) text += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ status: 0, text: String(err.message || err) }));
    req.end(body);
  });
}

class Push {
  // file: where keys and subscriptions are kept (null keeps them in memory)
  // hosts / agent: for tests, a local push service to post to
  constructor({ file = null, hosts = PUSH_HOSTS, agent = undefined } = {}) {
    this.file = file;
    this.hosts = hosts;
    this.agent = agent;
    this.data = null;
  }

  _load() {
    if (this.data) return this.data;
    let d = null;
    if (this.file) {
      try {
        d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {}
    }
    if (!d || !d.vapid || !d.vapid.pub || !d.vapid.priv) d = { vapid: newKeys(), subs: {} };
    if (!d.subs || typeof d.subs !== 'object') d.subs = {};
    this.data = d;
    if (this.file && !fs.existsSync(this.file)) this._save();
    return d;
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  publicKey() {
    return this._load().vapid.pub;
  }

  subsFor(deviceId) {
    return this._load().subs[deviceId] || [];
  }

  status(deviceId) {
    const list = this.subsFor(deviceId);
    const last = list.reduce((a, s) => (s.lastAt && (!a || s.lastAt > a.lastAt) ? s : a), null);
    return { on: list.length > 0, lastAt: last ? last.lastAt : null, lastStatus: last ? last.lastStatus : null, lastError: last ? last.lastError || null : null };
  }

  subscribe(deviceId, raw) {
    const s = validSubscription(raw, this.hosts);
    if (!s) return false;
    const d = this._load();
    const old = (d.subs[deviceId] || []).find((x) => x.endpoint === s.endpoint);
    // The page hands its subscription over on every open; the same one keeps
    // what is known about the last send.
    if (old && old.keys.p256dh === s.keys.p256dh && old.keys.auth === s.keys.auth) return true;
    const list = (d.subs[deviceId] || []).filter((x) => x.endpoint !== s.endpoint);
    list.push({ ...s, addedAt: Date.now() });
    d.subs[deviceId] = list.slice(-MAX_SUBS_PER_DEVICE);
    this._save();
    return true;
  }

  unsubscribe(deviceId, endpoint = null) {
    const d = this._load();
    if (!d.subs[deviceId]) return;
    const list = endpoint ? d.subs[deviceId].filter((x) => x.endpoint !== endpoint) : [];
    if (list.length) d.subs[deviceId] = list;
    else delete d.subs[deviceId];
    this._save();
  }

  // Drops the subscriptions of phones that are no longer on the shelf.
  keepOnly(deviceIds) {
    const d = this._load();
    const keep = new Set(deviceIds);
    let changed = false;
    for (const id of Object.keys(d.subs)) {
      if (!keep.has(id)) {
        delete d.subs[id];
        changed = true;
      }
    }
    if (changed) this._save();
  }

  devices() {
    return Object.keys(this._load().subs);
  }

  // Sends one message to every subscription of a phone. A subscription the
  // push service says is gone (404, 410) is forgotten.
  async send(deviceId, message) {
    const d = this._load();
    const list = [...this.subsFor(deviceId)];
    const plain = Buffer.from(JSON.stringify(message));
    const results = [];
    for (const s of list) {
      let r;
      try {
        const body = encrypt(plain, s);
        r = await post(
          s.endpoint,
          {
            'content-type': 'application/octet-stream',
            'content-encoding': 'aes128gcm',
            ttl: '86400',
            urgency: 'high',
            authorization: vapidAuth(d.vapid, s.endpoint),
          },
          body,
          this.agent,
        );
      } catch (err) {
        r = { status: 0, text: String(err.message || err) };
      }
      const ok = r.status >= 200 && r.status < 300;
      results.push({ endpoint: s.endpoint, status: r.status, ok, error: ok ? null : r.text.slice(0, 300) || `status ${r.status}` });
      if (r.status === 404 || r.status === 410) {
        this.unsubscribe(deviceId, s.endpoint);
        continue;
      }
      const cur = this.subsFor(deviceId).find((x) => x.endpoint === s.endpoint);
      if (cur) {
        cur.lastAt = Date.now();
        cur.lastStatus = r.status;
        cur.lastError = ok ? null : r.text.slice(0, 300) || `status ${r.status}`;
      }
    }
    if (list.length) this._save();
    return results;
  }
}

module.exports = { Push, encrypt, vapidAuth, validSubscription, newKeys, PUSH_HOSTS };
