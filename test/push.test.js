'use strict';

// Notifications: the computer encrypts and signs a push the way a real push
// service and browser expect (checked here by decrypting it as the phone
// would and verifying the VAPID signature), batches what lands on the shelf
// together, leaves out what the phone put there itself, and forgets a
// subscription the push service says is gone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Shelf } = require('../src/core/shelf');
const { Web } = require('../src/core/web');
const { Push, encrypt, vapidAuth, validSubscription, newKeys } = require('../src/core/push');
const tlsmod = require('../src/core/tls');

const WEB_DIR = path.join(__dirname, '..', 'src', 'web');

// A phone's side of a subscription: its keys and the decryption of a push.
function phoneKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

function decrypt(body, phone) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  assert.ok(sealed.length <= rs, 'one record');
  const uaPub = phone.ecdh.getPublicKey();
  const shared = phone.ecdh.computeSecret(asPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, phone.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

function verifyVapid(header, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, 'vapid header');
  const [h, b, s] = m[1].split('.');
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'signature');
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  assert.strictEqual(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, 'exp within a day');
  assert.match(claims.sub, /^(mailto:|https:)/);
  return m[2];
}

// A stand-in push service on https, answering with `status()`.
async function pushService(dir) {
  const certs = tlsmod.ensure(dir, { hosts: ['localhost'], ips: ['127.0.0.1'] });
  const got = [];
  let status = () => 201;
  const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status(req));
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const agent = new https.Agent({ ca: certs.ca });
  return { got, origin, agent, setStatus: (fn) => (status = fn), close: () => new Promise((r) => server.close(r)) };
}

async function makeWeb(svc) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-push-'));
  const self = { id: crypto.randomBytes(8).toString('hex'), name: 'PC' };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const push = new Push({ file: path.join(dataDir, 'push.json'), hosts: [/^127\.0\.0\.1$/], agent: svc.agent });
  const web = new Web({ shelf, self, webDir: WEB_DIR, version: 'test', lingerMs: () => 600000, push, notifyDelay: 150 });
  const server = http.createServer((req, res) => {
    web.handle(req, res, new URL(req.url, 'http://x')).then((mine) => {
      if (!mine) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    web.stop();
    await new Promise((r) => server.close(r));
    await shelf.saveNow();
  };
  return { dataDir, self, shelf, web, push, base, stop };
}

async function call(base, p, { method = 'GET', token, body } = {}) {
  const h = {};
  if (token) h.authorization = 'Bearer ' + token;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
}

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('encryption and the VAPID header are what a browser and push service expect', () => {
  const phone = phoneKeys();
  const sub = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: phone.keys };
  const msg = { title: 'Shelf', body: 'x'.repeat(2000) };
  const a = encrypt(Buffer.from(JSON.stringify(msg)), sub);
  const b = encrypt(Buffer.from(JSON.stringify(msg)), sub);
  assert.notDeepStrictEqual(a.subarray(0, 16), b.subarray(0, 16), 'fresh salt every time');
  assert.deepStrictEqual(decrypt(a, phone), msg);
  const keys = newKeys();
  assert.strictEqual(verifyVapid(vapidAuth(keys, sub.endpoint), sub.endpoint), keys.pub);
  assert.throws(() => encrypt(Buffer.alloc(5000), sub), /too long/);
});

test('only real push services over https are accepted as subscriptions', () => {
  const { keys } = phoneKeys();
  assert.ok(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys }));
  assert.ok(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }));
  assert.strictEqual(validSubscription({ endpoint: 'http://web.push.apple.com/abc', keys }), null, 'plain http');
  assert.strictEqual(validSubscription({ endpoint: 'https://192.168.1.10/abc', keys }), null, 'a local address');
  assert.strictEqual(validSubscription({ endpoint: 'https://evilpush.apple.com.example.net/abc', keys }), null, 'a look-alike');
  assert.strictEqual(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'AAAA', auth: keys.auth } }), null, 'bad key');
  assert.strictEqual(validSubscription(null), null);
});

test('new things on the shelf ring the phone once per batch, with the ids to open', async (t) => {
  const svc = await pushService(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-pushsvc-')));
  const n = await makeWeb(svc);
  t.after(async () => {
    await n.stop();
    await svc.close();
  });
  // Already on the shelf before the computer started watching: not news.
  const pair = await call(n.base, '/api/pair', { method: 'POST', body: { code: n.web.newPair().code } });
  const token = pair.json.token;
  const deviceId = pair.json.device.id;
  const phone = phoneKeys();
  const endpoint = `${svc.origin}/push/one`;

  await t.test('before subscribing the phone gets the key and is off', async () => {
    assert.strictEqual((await call(n.base, '/api/push')).status, 401, 'needs the phone token');
    const r = await call(n.base, '/api/push', { token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.on, false);
    assert.strictEqual(Buffer.from(r.json.key, 'base64url').length, 65);
    const bad = await call(n.base, '/api/push', { method: 'POST', token, body: { subscription: { endpoint: 'https://example.com/x', keys: phone.keys } } });
    assert.strictEqual(bad.status, 400);
  });

  await t.test('subscribing turns it on and survives a restart of the computer', async () => {
    const r = await call(n.base, '/api/push', { method: 'POST', token, body: { subscription: { endpoint, keys: phone.keys } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.on, true);
    const again = new Push({ file: path.join(n.dataDir, 'push.json'), hosts: [/^127\.0\.0\.1$/] });
    assert.strictEqual(again.subsFor(deviceId).length, 1);
    assert.strictEqual(again.publicKey(), n.push.publicKey());
  });

  await t.test('three things added together make one notification', async () => {
    const a = await n.shelf.addBuffer('IMG_1.jpg', Buffer.from('a'));
    const b = await n.shelf.addBuffer('IMG_2.jpg', Buffer.from('b'));
    const c = await n.shelf.addBuffer('IMG_3.HEIC', Buffer.from('c'));
    await until(() => svc.got.length >= 1, 'a push');
    await sleep(400);
    assert.strictEqual(svc.got.length, 1, 'one push for the batch');
    const p = svc.got[0];
    assert.strictEqual(p.url, '/push/one');
    assert.strictEqual(p.headers['content-encoding'], 'aes128gcm');
    assert.ok(Number(p.headers.ttl) > 0);
    assert.strictEqual(verifyVapid(p.headers.authorization, endpoint), n.push.publicKey());
    const m = decrypt(p.body, phone);
    assert.strictEqual(m.title, '3 photos', 'the title says what arrived, never Shelf');
    assert.match(m.body, /IMG_1.jpg, IMG_2.jpg, IMG_3.HEIC. Tap to save them.$/);
    const ids = new URL(m.url, 'http://x').searchParams.get('n').split(',');
    assert.deepStrictEqual(ids.sort(), [a.id, b.id, c.id].sort());
  });

  await t.test('what the phone uploads itself does not ring it', async () => {
    svc.got.length = 0;
    const r = await fetch(`${n.base}/api/upload?name=mine.jpg&size=3`, { method: 'PUT', headers: { authorization: 'Bearer ' + token }, body: 'abc' });
    assert.strictEqual(r.status, 201);
    await call(n.base, '/api/text', { method: 'POST', token, body: { text: 'from the phone' } });
    await sleep(500);
    assert.strictEqual(svc.got.length, 0);
    n.shelf.addText('hello from the computer');
    await until(() => svc.got.length === 1, 'a push for the text');
    const m = decrypt(svc.got[0].body, phone);
    assert.match(m.title, /^(Text from PC|New text)$/);
    assert.strictEqual(m.body, 'hello from the computer');
  });

  await t.test('a test push comes back with how it went', async () => {
    svc.got.length = 0;
    const r = await call(n.base, '/api/push/test', { method: 'POST', token, body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(decrypt(svc.got[0].body, phone).tag, 'shelf-test');
    svc.setStatus(() => 403);
    const bad = await call(n.base, '/api/push/test', { method: 'POST', token, body: {} });
    assert.strictEqual(bad.status, 502);
    assert.ok(bad.json.lastError, 'the failure is kept for the settings page');
    svc.setStatus(() => 201);
  });

  await t.test('a subscription the push service says is gone is forgotten', async () => {
    svc.setStatus(() => 410);
    svc.got.length = 0;
    await n.shelf.addBuffer('later.pdf', Buffer.from('p'));
    await until(() => svc.got.length === 1, 'a push');
    await until(() => !n.push.status(deviceId).on, 'subscription dropped');
    svc.setStatus(() => 201);
  });

  await t.test('turning off and removing the phone both stop it', async () => {
    await call(n.base, '/api/push', { method: 'POST', token, body: { subscription: { endpoint, keys: phone.keys } } });
    const off = await call(n.base, '/api/push/off', { method: 'POST', token, body: { endpoint } });
    assert.strictEqual(off.json.on, false);
    await call(n.base, '/api/push', { method: 'POST', token, body: { subscription: { endpoint, keys: phone.keys } } });
    n.shelf.removeDevice(deviceId);
    svc.got.length = 0;
    await n.shelf.addBuffer('after.jpg', Buffer.from('z'));
    await sleep(500);
    assert.strictEqual(svc.got.length, 0);
    assert.deepStrictEqual(n.push.devices(), []);
  });
});

test('a restart does not ring the phone for what was already there', async (t) => {
  const svc = await pushService(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-pushsvc-')));
  const n = await makeWeb(svc);
  const pair = await call(n.base, '/api/pair', { method: 'POST', body: { code: n.web.newPair().code } });
  const phone = phoneKeys();
  await call(n.base, '/api/push', { method: 'POST', token: pair.json.token, body: { subscription: { endpoint: `${svc.origin}/p`, keys: phone.keys } } });
  await n.shelf.addBuffer('old.jpg', Buffer.from('o'));
  await until(() => svc.got.length === 1, 'the first push');
  await n.stop();
  svc.got.length = 0;
  const shelf = new Shelf({ dataDir: n.dataDir, self: n.self });
  await shelf.load();
  const push = new Push({ file: path.join(n.dataDir, 'push.json'), hosts: [/^127\.0\.0\.1$/], agent: svc.agent });
  const web = new Web({ shelf, self: n.self, webDir: WEB_DIR, version: 'test', push, notifyDelay: 50 });
  t.after(async () => {
    web.stop();
    await svc.close();
  });
  shelf.addText('a change, so the computer looks again');
  await until(() => svc.got.length === 1, 'the push for the new text');
  await sleep(200);
  const m = decrypt(svc.got[0].body, phone);
  assert.strictEqual(m.body, 'a change, so the computer looks again', 'only the new text, not old.jpg');
});
