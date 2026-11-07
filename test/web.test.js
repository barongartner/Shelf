'use strict';

// The browser client's API, exercised the way a phone uses it: pair with the
// code from the QR, read the shelf, download with Range, upload, add text,
// take, and get removed. Two computers share the shelf so the phone's device
// record and its uploads are checked on the other computer too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Shelf } = require('../src/core/shelf');
const { Net, newCode } = require('../src/core/net');

const WEB_DIR = path.join(__dirname, '..', 'src', 'web');

async function makeNode(name, code, { web = true, certs = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `shelf-${name}-`));
  const self = { id: crypto.randomBytes(8).toString('hex'), name };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const net = new Net({
    shelf,
    self,
    code,
    port: 0,
    httpsPort: 0,
    mdns: false,
    tickMs: 100,
    web: web
      ? {
          webDir: WEB_DIR,
          version: 'test',
          lingerMs: () => 500,
          thumb: async (it) => (it.name.endsWith('.jpg') ? { buf: Buffer.from('THUMB-' + it.name), type: 'image/jpeg' } : null),
          certDir: certs ? path.join(dataDir, 'certs') : null,
        }
      : null,
  });
  await net.start();
  return { name, dataDir, self, shelf, net, base: `http://127.0.0.1:${net.port}` };
}

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function call(base, p, { method = 'GET', token, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined && !Buffer.isBuffer(body)) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  } else payload = body;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (!raw) {
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {}
  }
  return { status: r.status, headers: r.headers, json, buf };
}

// Collects n `state` events from the SSE stream.
function sseStates(url, headers, n, ms = 4000) {
  return new Promise((resolve, reject) => {
    const out = [];
    let buf = '';
    const req = http.get(url, { headers }, (res) => {
      res.on('data', (c) => {
        buf += c;
        let m;
        while ((m = /event: state\ndata: ([^\n]*)\n\n/.exec(buf))) {
          out.push(JSON.parse(m[1]));
          buf = buf.slice(m.index + m[0].length);
          if (out.length >= n) {
            req.destroy();
            resolve(out);
          }
        }
      });
    });
    req.on('error', (e) => (out.length >= n ? null : reject(e)));
    setTimeout(() => {
      req.destroy();
      out.length >= n ? resolve(out) : reject(new Error(`only ${out.length} of ${n} SSE events`));
    }, ms);
  });
}

test('a phone pairs, reads, downloads, uploads and is forgotten', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => a.net.peerList().some((p) => p.online) && b.net.peerList().some((p) => p.online), 'peers online');
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  let token = null;
  let deviceId = null;

  await t.test('the page is served with a content security policy', async () => {
    const r = await call(a.base, '/', { raw: true });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.ok(r.buf.toString().includes('<title>Shelf</title>'));
    for (const p of ['/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png']) {
      assert.strictEqual((await call(a.base, p, { raw: true })).status, 200, p);
    }
  });

  await t.test('the manifest makes a standalone app whose start page carries the token of the phone asking', async () => {
    const anon = await call(a.base, '/manifest.webmanifest');
    assert.strictEqual(anon.status, 200);
    assert.strictEqual(anon.headers.get('content-type'), 'application/manifest+json');
    assert.strictEqual(anon.headers.get('cache-control'), 'no-store', 'made per phone, never cached');
    assert.strictEqual(anon.json.display, 'standalone');
    assert.strictEqual(anon.json.start_url, '/', 'nobody signed in, nothing to hand over');
    assert.strictEqual(anon.json.scope, '/');
    // Inline PNGs: iOS drew a letter instead of linked manifest icons.
    const touch = fs.readFileSync(path.join(WEB_DIR, 'apple-touch-icon.png'));
    const i180 = anon.json.icons.find((i) => i.sizes === '180x180');
    assert.strictEqual(i180.src, `data:image/png;base64,${touch.toString('base64')}`);
    assert.ok(anon.json.icons.every((i) => i.src.startsWith('data:image/png;base64,') && i.purpose === 'any'));
    const pair = a.net.web.newPair();
    const r = await call(a.base, '/api/pair', { method: 'POST', body: { code: pair.code } });
    const tok = r.json.token;
    // The page puts the token in the manifest link; the cookie covers a fetch without it.
    assert.strictEqual((await call(a.base, `/manifest.webmanifest?t=${tok}`)).json.start_url, `/?t=${tok}`);
    assert.strictEqual((await call(a.base, '/manifest.webmanifest', { headers: { cookie: `shelf=${tok}` } })).json.start_url, `/?t=${tok}`);
    assert.strictEqual((await call(a.base, '/manifest.webmanifest?t=nope')).json.start_url, '/', 'an unknown token hands nothing over');
    assert.strictEqual((await call(a.base, '/manifest.webmanifest', { method: 'POST' })).status, 405);
    assert.strictEqual((await call(a.base, `/?t=${tok}`, { raw: true })).status, 200, 'the start page is the page');
    const plain = (await call(a.base, '/', { raw: true })).buf.toString();
    assert.match(plain, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/, 'no cookie, plain link');
    const known = (await call(a.base, '/', { raw: true, headers: { cookie: `shelf=${tok}` } })).buf.toString();
    assert.ok(known.includes(`<link rel="manifest" href="/manifest.webmanifest?t=${tok}" />`), 'the cookie puts the token in the markup');
    a.shelf.removeDevice(r.json.device.id);
    assert.strictEqual((await call(a.base, `/manifest.webmanifest?t=${tok}`)).json.start_url, '/', 'a forgotten phone gets a plain manifest');
  });

  await t.test('a handoff code in the address stands in for the cookie for ten minutes', async () => {
    assert.strictEqual((await call(a.base, '/api/handoff', { method: 'POST' })).status, 401);
    const pair = a.net.web.newPair();
    const r = await call(a.base, '/api/pair', { method: 'POST', body: { code: pair.code } });
    const tok = r.json.token;
    const h = await call(a.base, '/api/handoff', { method: 'POST', token: tok });
    assert.strictEqual(h.status, 200);
    assert.match(h.json.code, /^[A-Z2-9]{12}$/);
    assert.ok(h.json.expiresAt > Date.now() + 9 * 60 * 1000);
    // No cookie, no header: the code alone signs the page, the manifest and /api/me.
    const page = (await call(a.base, `/?h=${h.json.code}`, { raw: true })).buf.toString();
    assert.ok(page.includes(`<link rel="manifest" href="/manifest.webmanifest?t=${tok}" />`), 'the markup carries the token');
    assert.strictEqual((await call(a.base, `/manifest.webmanifest?h=${h.json.code}`)).json.start_url, `/?t=${tok}`);
    const me = await call(a.base, `/api/me?h=${h.json.code}`);
    assert.strictEqual(me.json.paired, true);
    assert.strictEqual(me.json.token, tok);
    assert.match(me.headers.get('set-cookie') || '', /^shelf=/, 'the view that used the code gets the cookie too');
    // One live code per phone; a new one retires the old one.
    const h2 = await call(a.base, '/api/handoff', { method: 'POST', token: tok });
    assert.strictEqual([...a.net.web.handoffs.values()].filter((x) => x.deviceId === r.json.device.id).length, 1);
    assert.strictEqual((await call(a.base, `/api/me?h=${h.json.code}`)).json.paired, false, 'the old code is dead');
    assert.strictEqual((await call(a.base, `/api/me?h=${h2.json.code}`)).json.paired, true);
    // Expired codes are refused and dropped.
    a.net.web.handoffs.get(h2.json.code).expiresAt = Date.now() - 1;
    assert.strictEqual((await call(a.base, `/api/me?h=${h2.json.code}`)).json.paired, false);
    assert.strictEqual(a.net.web.handoffs.size, 0);
    assert.strictEqual((await call(a.base, '/api/me?h=NOPE')).json.paired, false);
    a.shelf.removeDevice(r.json.device.id);
  });

  await t.test('nothing works before pairing', async () => {
    assert.strictEqual((await call(a.base, '/api/state')).status, 401);
    assert.strictEqual((await call(a.base, '/api/me')).json.paired, false);
    assert.strictEqual((await call(a.base, '/api/pair', { method: 'POST', body: { pin: '000000' } })).status, 403);
  });

  await t.test('pairing with the QR code gives a token every computer on the shelf accepts', async () => {
    const pair = a.net.web.newPair();
    assert.match(pair.code, /^[A-Z2-9]{20}$/);
    assert.match(pair.pin, /^\d{6}$/);
    const wrong = await call(a.base, '/api/pair', { method: 'POST', body: { code: 'NOPE' } });
    assert.strictEqual(wrong.status, 403);
    const r = await call(a.base, '/api/pair', { method: 'POST', body: { code: pair.code }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' } });
    assert.strictEqual(r.status, 200);
    token = r.json.token;
    deviceId = r.json.device.id;
    assert.strictEqual(r.json.device.name, 'iPhone');
    assert.strictEqual(r.json.computer.name, 'PC');
    // single use
    assert.strictEqual((await call(a.base, '/api/pair', { method: 'POST', body: { code: pair.code } })).status, 403);
    const me = await call(a.base, '/api/me', { token });
    assert.strictEqual(me.json.paired, true);
    assert.strictEqual(me.json.device.name, 'iPhone');
    // the token works in the query string too (img and video tags cannot set headers)
    assert.strictEqual((await call(a.base, `/api/state?t=${token}`)).status, 200);
    await until(() => b.shelf.devices().length === 1, 'device record reaches the other computer');
    assert.strictEqual((await call(b.base, '/api/state', { token })).status, 200, 'the other computer accepts the phone');
    assert.strictEqual(b.shelf.visible().length, 0, 'device records are not shelf items');
  });

  await t.test('the six-digit code works too; guessing locks the digits but never the QR code', async () => {
    const pair = a.net.web.newPair();
    const r = await call(a.base, '/api/pair', { method: 'POST', body: { pin: pair.pin } });
    assert.strictEqual(r.status, 200);
    a.shelf.removeDevice(r.json.device.id);
    const again = a.net.web.newPair();
    // Junk without any code does not count as a guess.
    for (let i = 0; i < 5; i++) assert.strictEqual((await call(a.base, '/api/pair', { method: 'POST', body: {} })).status, 403);
    assert.ok(!a.net.web.pair.pinLocked);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await call(a.base, '/api/pair', { method: 'POST', body: { pin: String(100000 + i) } })).status;
      a.net.web.fails.clear(); // keep the per-address lock out of this part
    }
    assert.strictEqual(last, 403);
    assert.ok(a.net.web.pair.pinLocked, 'the digits are locked');
    assert.ok(a.net.web.pairInfo(), 'the code on the QR is still live');
    assert.strictEqual((await call(a.base, '/api/pair', { method: 'POST', body: { pin: again.pin } })).status, 403, 'even the right digits are refused now');
    const viaQr = await call(a.base, '/api/pair', { method: 'POST', body: { code: again.code } });
    assert.strictEqual(viaQr.status, 200, 'the QR code still pairs');
    a.shelf.removeDevice(viaQr.json.device.id);
    a.net.web.newPair();
    for (let i = 0; i < 12; i++) last = (await call(a.base, '/api/pair', { method: 'POST', body: { pin: '123456' } })).status;
    assert.strictEqual(last, 429, 'an address that keeps guessing is locked out');
    a.net.web.fails.clear();
  });

  await t.test('a removed phone loses its live stream at once', async () => {
    const pair = a.net.web.newPair();
    const r = await call(a.base, '/api/pair', { method: 'POST', body: { code: pair.code } });
    assert.strictEqual(r.status, 200);
    const ended = new Promise((resolve) => {
      const req = http.get(`${a.base}/api/events?t=${r.json.token}`, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve('ended'));
        res.on('close', () => resolve('closed'));
      });
      req.on('error', () => resolve('error'));
    });
    await until(() => a.net.web.clients.size === 1, 'stream open');
    a.shelf.removeDevice(r.json.device.id);
    const how = await Promise.race([ended, new Promise((res) => setTimeout(() => res('still open'), 2000))]);
    assert.notStrictEqual(how, 'still open', 'the stream was cut');
    assert.strictEqual(a.net.web.clients.size, 0);
  });

  let photo;
  let photoBytes;
  await t.test('a file on the shelf is listed, thumbnailed, downloadable and seekable', async () => {
    photoBytes = crypto.randomBytes(200000);
    const file = path.join(srcDir, 'photo.jpg');
    fs.writeFileSync(file, photoBytes);
    photo = await a.shelf.addPath(file);
    const s = await call(a.base, '/api/state', { token });
    const it = s.json.items.find((i) => i.id === photo.id);
    assert.ok(it);
    assert.strictEqual(it.type, 'image');
    assert.strictEqual(it.ready, true);
    assert.strictEqual(it.thumb, true);
    assert.strictEqual(it.from, 'PC');
    const d = await call(a.base, `/d/${photo.id}`, { token, raw: true });
    assert.strictEqual(d.status, 200);
    assert.match(d.headers.get('content-disposition'), /^attachment; filename="photo.jpg"/);
    assert.ok(d.buf.equals(photoBytes));
    const v = await call(a.base, `/v/${photo.id}`, { token, raw: true, headers: { range: 'bytes=10-19' } });
    assert.strictEqual(v.status, 206);
    assert.strictEqual(v.headers.get('content-type'), 'image/jpeg');
    assert.strictEqual(v.headers.get('content-range'), `bytes 10-19/${photoBytes.length}`);
    assert.ok(v.buf.equals(photoBytes.subarray(10, 20)));
    const tail = await call(a.base, `/v/${photo.id}`, { token, raw: true, headers: { range: 'bytes=-5' } });
    assert.strictEqual(tail.status, 206);
    assert.ok(tail.buf.equals(photoBytes.subarray(-5)));
    const bad = await call(a.base, `/v/${photo.id}`, { token, raw: true, headers: { range: 'bytes=999999-' } });
    assert.strictEqual(bad.status, 416);
    const th = await call(a.base, `/t/${photo.id}`, { token, raw: true });
    assert.strictEqual(th.status, 200);
    assert.strictEqual(th.buf.toString(), 'THUMB-photo.jpg');
    assert.strictEqual((await call(a.base, `/d/${photo.id}`, { raw: true })).status, 401, 'no token, no file');
  });

  await t.test('an upload from the phone lands on both computers', async () => {
    const bytes = crypto.randomBytes(1500000);
    const r = await call(a.base, `/api/upload?name=${encodeURIComponent('IMG_0001.JPG')}&size=${bytes.length}&mtime=1700000000000`, { method: 'PUT', token, body: bytes, headers: { 'content-type': 'application/octet-stream' } });
    assert.strictEqual(r.status, 201);
    const it = r.json.item;
    assert.strictEqual(it.name, 'IMG_0001.JPG');
    assert.strictEqual(it.ready, true);
    assert.strictEqual(it.size, bytes.length);
    assert.strictEqual(it.from, 'iPhone');
    assert.ok(fs.readFileSync(a.shelf.local.get(it.id).path).equals(bytes));
    assert.ok(Math.abs(fs.statSync(a.shelf.local.get(it.id).path).mtimeMs - 1700000000000) < 2000, 'photo keeps its date');
    await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'upload reaches the other computer');
    assert.ok(fs.readFileSync(b.shelf.local.get(it.id).path).equals(bytes));
    assert.strictEqual(b.shelf.items.get(it.id).addedByName, 'iPhone');
  });

  await t.test('an upload that dies halfway leaves nothing behind anywhere', async () => {
    const before = a.shelf.visible().length;
    const half = crypto.randomBytes(400000);
    await new Promise((resolve) => {
      const req = http.request(`${a.base}/api/upload?name=broken.bin&size=800000`, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-length': 800000 } });
      req.on('error', () => resolve());
      req.on('close', resolve);
      req.write(half, () => setTimeout(() => req.destroy(), 150));
    });
    await until(() => a.shelf.visible().length === before, 'broken upload removed');
    await until(() => b.shelf.visible().length === before, 'removed on the other computer too');
    const stray = fs.readdirSync(a.shelf.storeDir).filter((d) => {
      const it = a.shelf.items.get(d);
      return !it || it.removed;
    });
    assert.deepStrictEqual(stray, [], 'no partial folders left in the store');
  });

  await t.test('text from the phone shows up with the phone as the sender', async () => {
    const r = await call(a.base, '/api/text', { method: 'POST', token, body: { text: 'hello from the phone' } });
    assert.strictEqual(r.status, 201);
    await until(() => b.shelf.items.get(r.json.item.id), 'text reaches the other computer');
    assert.strictEqual(b.shelf.items.get(r.json.item.id).addedByName, 'iPhone');
    assert.strictEqual((await call(a.base, `/d/${r.json.item.id}`, { token, raw: true })).buf.toString(), 'hello from the phone');
    assert.strictEqual((await call(a.base, '/api/text', { method: 'POST', token, body: { text: '   ' } })).status, 400);
  });

  await t.test('taking something from the phone starts the linger countdown everywhere', async () => {
    const it = a.shelf.addText('take me');
    await until(() => b.shelf.items.get(it.id), 'arrive');
    assert.strictEqual((await call(a.base, `/api/items/${it.id}/take`, { method: 'POST', token })).status, 200);
    await until(() => b.shelf.items.get(it.id).expiresAt, 'countdown reaches the other computer');
    await until(() => a.shelf.items.get(it.id).removed && b.shelf.items.get(it.id).removed, 'expiry', 4000);
    const gone = await call(a.base, `/api/items/${it.id}/keep`, { method: 'POST', token });
    assert.strictEqual(gone.status, 404);
  });

  await t.test('a folder downloads as a zip with the exact length, or file by file', async () => {
    const dir = path.join(srcDir, 'Trip');
    fs.mkdirSync(path.join(dir, 'day 1'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'empty'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'see the pier');
    fs.writeFileSync(path.join(dir, 'day 1', 'a.bin'), crypto.randomBytes(123456));
    const folder = await a.shelf.addPath(dir);
    const z = await call(a.base, `/d/${folder.id}`, { token, raw: true });
    assert.strictEqual(z.status, 200);
    assert.strictEqual(z.headers.get('content-type'), 'application/zip');
    assert.strictEqual(Number(z.headers.get('content-length')), z.buf.length, 'declared length is the real length');
    assert.strictEqual(z.buf.readUInt32LE(0), 0x04034b50);
    const eocd = z.buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.strictEqual(z.buf.readUInt16LE(eocd + 10), 5, 'Trip/, day 1/, empty/, notes.txt, a.bin');
    const one = await call(a.base, `/d/${folder.id}?p=${encodeURIComponent('day 1/a.bin')}`, { token, raw: true });
    assert.strictEqual(one.status, 200);
    assert.ok(one.buf.equals(fs.readFileSync(path.join(dir, 'day 1', 'a.bin'))));
    assert.strictEqual((await call(a.base, `/d/${folder.id}?p=..%2F..%2Fphoto.jpg`, { token, raw: true })).status, 404, 'no escaping the folder');
    assert.strictEqual((await call(a.base, `/d/${folder.id}?p=${encodeURIComponent('day 1/not-listed.bin')}`, { token, raw: true })).status, 404, 'only manifest entries are served');
    const many = await call(a.base, `/api/zip?ids=${folder.id},${photo.id}`, { token, raw: true });
    assert.strictEqual(many.status, 200);
    assert.strictEqual(Number(many.headers.get('content-length')), many.buf.length);
    // the copy on the other computer serves the same folder once it has it
    await until(() => b.shelf.local.get(folder.id)?.state === 'ready', 'folder on the other computer');
    const zb = await call(b.base, `/d/${folder.id}`, { token, raw: true });
    assert.strictEqual(zb.status, 200);
    assert.strictEqual(Number(zb.headers.get('content-length')), zb.buf.length);
  });

  await t.test('live updates arrive over server-sent events', async () => {
    // Three events: the shelf on opening, the phone now showing as connected, and the change.
    const p = sseStates(`${a.base}/api/events?t=${token}`, {}, 3);
    await until(() => a.net.web.clients.size === 1, 'stream open');
    assert.deepStrictEqual(a.net.web.onlineDeviceIds(), [deviceId]);
    await new Promise((r) => setTimeout(r, 250));
    a.shelf.addText('live');
    const [first, , third] = await p;
    assert.ok(first.items.length >= 1);
    assert.ok(third.items.some((i) => i.text === 'live'));
    assert.strictEqual(third.computer.name, 'PC');
    assert.ok(third.devices.some((d) => d.id === deviceId && d.online === true), 'the phone with a stream open shows as connected now');
  });

  await t.test('renaming the phone and removing it', async () => {
    const r = await call(a.base, '/api/me', { method: 'POST', token, body: { name: "Baron's iPhone" } });
    assert.strictEqual(r.json.device.name, "Baron's iPhone");
    await until(() => b.shelf.items.get(deviceId)?.name === "Baron's iPhone", 'rename reaches the other computer');
    b.shelf.removeDevice(deviceId);
    await until(() => (a.shelf.items.get(deviceId) || {}).removed, 'removal reaches the first computer');
    assert.strictEqual((await call(a.base, '/api/state', { token })).status, 401);
    assert.strictEqual((await call(b.base, '/api/state', { token })).status, 401);
    assert.strictEqual((await call(a.base, '/api/me', { token })).json.paired, false);
  });

  await t.test('the home-screen icon is a plain, public, opaque PNG at the root', async () => {
    for (const p of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/apple-touch-icon-180x180.png', '/apple-touch-icon-167x167.png', '/apple-touch-icon-152x152.png', '/apple-touch-icon-120x120.png', '/icon-192.png', '/icon-512.png']) {
      const r = await call(a.base, p, { raw: true });
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.headers.get('content-type'), 'image/png', p);
      assert.strictEqual(r.buf.readUInt32BE(0), 0x89504e47, `${p} is a PNG`);
    }
    const page = (await call(a.base, '/', { raw: true })).buf.toString();
    assert.match(page, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    assert.match(page, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/);
    assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    assert.match(page, /apple-mobile-web-app-capable/, 'opens as an app from the Home Screen; the token in start_url signs it in');
  });

  await t.test('the session lives in a cookie too, survives emptied storage, and ends with forget', async () => {
    const pair = a.net.web.newPair();
    const r = await call(a.base, '/api/pair', { method: 'POST', body: { pin: pair.pin } });
    assert.strictEqual(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^shelf=${r.json.token}; Max-Age=\\d+; Path=/; SameSite=Lax; HttpOnly`));
    // The browser lost localStorage: only the cookie comes back.
    const me = await call(a.base, '/api/me', { headers: { cookie: `shelf=${r.json.token}` } });
    assert.strictEqual(me.json.paired, true);
    assert.strictEqual(me.json.token, r.json.token, 'the page can refill its storage from the cookie');
    assert.ok(Array.isArray(me.json.hosts), 'stable names for the bookmark');
    assert.strictEqual(me.headers.get('set-cookie'), null, 'no cookie churn when the cookie was used');
    assert.strictEqual((await call(a.base, '/api/state', { headers: { cookie: `shelf=${r.json.token}` } })).status, 200);
    // Arriving on another of the computer's addresses with the token in the URL gets a cookie there.
    const handed = await call(a.base, `/api/me?t=${r.json.token}`);
    assert.match(handed.headers.get('set-cookie') || '', /^shelf=/);
    // Forget ends it everywhere.
    const bye = await call(a.base, '/api/forget', { method: 'POST', headers: { cookie: `shelf=${r.json.token}` } });
    assert.strictEqual(bye.status, 200);
    assert.match(bye.headers.get('set-cookie'), /^shelf=; Max-Age=0/);
    assert.strictEqual((await call(a.base, '/api/state', { headers: { cookie: `shelf=${r.json.token}` } })).status, 401);
    assert.strictEqual((await call(a.base, '/api/state', { token: r.json.token })).status, 401);
    await until(() => !b.shelf.devices().some((d) => d.id === r.json.device.id), 'revocation reaches the other computer');
  });

  await t.test('peer routes still work next to the browser routes', async () => {
    assert.strictEqual((await call(a.base, '/hello')).json.app, 'shelf');
    assert.strictEqual((await call(a.base, '/sync', { method: 'POST', body: {} })).status, 401);
    assert.strictEqual((await call(a.base, `/blob/${photo.id}`, { raw: true })).status, 401);
    assert.strictEqual((await call(a.base, '/nope')).status, 404);
  });
});

test('the phone page scripts and the desktop renderer script parse', () => {
  for (const f of ['src/web/app.js', 'src/web/sw.js', 'src/renderer/app.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotThrow(() => new Function(src), `${f} has a syntax error`);
  }
});

test('the service worker is served for the secure address with the right headers', async (t) => {
  const a = await makeNode('PC', newCode());
  t.after(() => a.net.stop());
  const r = await call(a.base, '/sw.js?v=1.1.0', { raw: true });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.strictEqual(r.headers.get('service-worker-allowed'), '/');
  assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
  assert.ok(r.buf.toString().includes("addEventListener('fetch'"));
  const page = (await call(a.base, '/', { raw: true })).buf.toString();
  assert.match(page, /app\.js\?v=test/, 'assets carry the version so updates reach the phone');
  assert.match(page, /style\.css\?v=test/);
});

test('https is served with the computer-made certificate', async (t) => {
  const a = await makeNode('PC', newCode(), { certs: true });
  t.after(() => a.net.stop());
  assert.ok(a.net.httpsPort, 'https port');
  assert.ok(a.net.tls && a.net.tls.ca);
  const get = (opts) =>
    new Promise((resolve) => {
      https.get({ host: '127.0.0.1', port: a.net.httpsPort, path: '/api/me', agent: false, ...opts }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ status: res.statusCode, body: s }));
      }).on('error', (e) => resolve({ error: e.code || e.message }));
    });
  const ok = await get({ ca: a.net.tls.ca });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.body).secure, true);
  const bad = await get({});
  assert.ok(bad.error, 'rejected without the authority');
  const cert = await fetch(`http://127.0.0.1:${a.net.port}/cert`);
  assert.strictEqual(cert.status, 200);
  assert.strictEqual(cert.headers.get('content-type'), 'application/x-x509-ca-cert');
  const der = Buffer.from(await cert.arrayBuffer());
  assert.strictEqual(der[0], 0x30, 'DER certificate');
  const { X509Certificate } = require('crypto');
  const x = new X509Certificate(der);
  assert.ok(x.ca);
  assert.match(x.subject, /Shelf on PC/);
});
