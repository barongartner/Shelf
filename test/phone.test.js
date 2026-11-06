'use strict';

// What the computers keep about a phone, and the phone moving between them:
// the token never reaches disk or the wire, a phone that scans again stays
// one phone, stale phones clear themselves, and the page is told about the
// other computers so it can carry on through them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Shelf } = require('../src/core/shelf');
const { Web } = require('../src/core/web');

const WEB_DIR = path.join(__dirname, '..', 'src', 'web');

async function makeWeb({ peers = () => [], dataDir } = {}) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-phone-'));
  const self = { id: crypto.randomBytes(8).toString('hex'), name: 'PC' };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const web = new Web({ shelf, self, webDir: WEB_DIR, version: 'test', lingerMs: () => 600000, peers, ports: () => ({ http: 47474 }), hosts: () => ['pc.local'] });
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
  return { dataDir, self, shelf, web, base, stop };
}

async function call(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, json, text };
}

test('the phone token never reaches shelf.json or the sync payload', async (t) => {
  const n = await makeWeb();
  t.after(n.stop);
  const pair = n.web.newPair();
  const r = await call(n.base, '/api/pair', { method: 'POST', body: { code: pair.code } });
  assert.strictEqual(r.status, 200);
  const token = r.json.token;
  // Every way a phone is recognised, plus a rename and a lastSeen touch.
  await call(n.base, '/api/me', { token });
  await call(n.base, `/api/state?t=${token}`);
  await call(n.base, '/api/state', { headers: { cookie: `shelf=${token}` } });
  await call(n.base, '/manifest.webmanifest', { token });
  await call(n.base, '/', { headers: { cookie: `shelf=${token}` } });
  await call(n.base, '/api/me', { method: 'POST', token, body: { name: 'Pocket' } });
  const d = n.shelf.items.get(r.json.device.id);
  n.shelf._update(d, { lastSeen: 1 });
  n.shelf.touchDevice(d.id);
  await call(n.base, '/api/me', { token });
  await n.shelf.saveNow();
  const live = n.shelf.items.get(r.json.device.id);
  assert.strictEqual(live.name, 'Pocket');
  assert.ok(!Object.keys(live).some((k) => k.startsWith('_')), 'the stored record carries no extras');
  assert.ok(!JSON.stringify(n.shelf.payload()).includes(token), 'not in what is synced');
  assert.ok(!fs.readFileSync(n.shelf.statePath, 'utf8').includes(token), 'not on disk');
  assert.ok(fs.readFileSync(n.shelf.statePath, 'utf8').includes(live.tokenHash), 'the hash is what is kept');
});

test('a shelf.json written by an older version is scrubbed of tokens on load', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-scrub-'));
  const now = Date.now();
  const leaked = 'LEAKED-' + crypto.randomBytes(16).toString('hex');
  const dev = { id: 'a'.repeat(24), kind: 'device', name: 'iPhone', tokenHash: 'b'.repeat(64), ua: '', lastSeen: now, addedAt: now, expiresAt: null, removed: false, v: now, vBy: 'x', _token: leaked, _via: 'cookie' };
  fs.writeFileSync(path.join(dataDir, 'shelf.json'), JSON.stringify({ items: [dev], local: {} }));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  assert.strictEqual(shelf.devices().length, 1, 'the phone is kept');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'shelf.json'), 'utf8').includes(leaked), 'the token is gone from disk');
});

test('a phone that scans a QR code again stays one phone', async (t) => {
  const n = await makeWeb();
  t.after(n.stop);
  let paired = 0;
  n.web.onPaired = () => paired++;
  const first = await call(n.base, '/api/pair', { method: 'POST', body: { code: n.web.newPair().code } });
  assert.strictEqual(first.status, 200);
  const token = first.json.token;
  assert.strictEqual(paired, 1);

  // Again with the cookie only, the way Safari sends it.
  const code2 = n.web.newPair().code;
  const again = await call(n.base, '/api/pair', { method: 'POST', body: { code: code2 }, headers: { cookie: `shelf=${token}` } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.already, true);
  assert.strictEqual(again.json.device.id, first.json.device.id);
  assert.strictEqual(again.json.token, token);
  assert.strictEqual(n.shelf.devices().length, 1, 'no second phone');
  assert.strictEqual(n.web.pairInfo(), null, 'the code is used up');
  assert.strictEqual(paired, 2, 'the computer hears the code was used');
  assert.strictEqual((await call(n.base, '/api/pair', { method: 'POST', body: { code: code2 } })).status, 403, 'nobody else can use it');

  // With the token in the header and a stale code: still the same phone, nothing counted as a guess.
  const stale = await call(n.base, '/api/pair', { method: 'POST', token, body: { pin: '123456' } });
  assert.strictEqual(stale.status, 200);
  assert.strictEqual(stale.json.device.id, first.json.device.id);
  assert.strictEqual(n.shelf.devices().length, 1);

  // A dead token does not count as already connected.
  n.shelf.removeDevice(first.json.device.id);
  const fresh = await call(n.base, '/api/pair', { method: 'POST', body: { code: n.web.newPair().code }, headers: { cookie: `shelf=${token}` } });
  assert.strictEqual(fresh.status, 200);
  assert.ok(!fresh.json.already);
  assert.notStrictEqual(fresh.json.token, token);
});

test('a phone nobody has seen for 90 days is dropped', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-stale-'));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  const old = shelf.addDevice({ name: 'Old phone', tokenHash: 'c'.repeat(64) });
  const live = shelf.addDevice({ name: 'New phone', tokenHash: 'd'.repeat(64) });
  shelf.items.set(old.id, { ...shelf.items.get(old.id), lastSeen: Date.now() - 91 * 24 * 60 * 60 * 1000 });
  shelf.sweep();
  assert.deepStrictEqual(shelf.devices().map((d) => d.id), [live.id]);
  assert.ok(shelf.items.get(old.id).removed, 'removed for good, everywhere');
  await shelf.saveNow();
});

test('the page is told about the other computers and may check they answer', async (t) => {
  const peers = [
    { id: 'm', name: 'MacBook', addr: '192.168.1.20', port: 47474, host: 'macbook.local', online: true },
    { id: 'o', name: 'Old PC', addr: '192.168.1.30', port: 47474, online: false },
  ];
  const n = await makeWeb({ peers: () => peers });
  t.after(n.stop);
  const r = await call(n.base, '/api/pair', { method: 'POST', body: { code: n.web.newPair().code } });
  assert.deepStrictEqual(r.json.peers, [{ name: 'MacBook', addr: '192.168.1.20', port: 47474, host: 'macbook.local' }], 'only computers that are online');
  const me = await call(n.base, '/api/me', { token: r.json.token });
  assert.deepStrictEqual(me.json.peers, r.json.peers);
  const s = await call(n.base, '/api/state', { token: r.json.token });
  assert.deepStrictEqual(s.json.peers, r.json.peers);
  assert.ok(s.json.devices.every((d) => d.online === false), 'no stream open, not connected now');
  const page = await call(n.base, '/');
  const policy = page.headers.get('content-security-policy');
  const connect = policy.split('; ').find((x) => x.startsWith('connect-src'));
  assert.ok(connect.includes('http://macbook.local:47474'), connect);
  assert.ok(connect.includes('http://192.168.1.20:47474'), connect);
  assert.ok(connect.includes('http://pc.local:47474'), 'its own stable name is still there');
  assert.ok(!connect.includes('192.168.1.30'), 'not a computer that is offline');
});

test('peers default to none, so a Web made without them still works', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-nopeers-'));
  const self = { id: 'me', name: 'PC' };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const web = new Web({ shelf, self, webDir: WEB_DIR });
  t.after(() => web.stop());
  assert.deepStrictEqual(web.snapshot().peers, []);
  assert.deepStrictEqual(web.onlineDeviceIds(), []);
});
