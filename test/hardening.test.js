'use strict';

// The sharp edges found in review: a stranger that knows the public shelf id
// must learn nothing, a known peer must not be movable by an announcement,
// signatures must not carry to another computer, hostile item fields must
// be dropped, state writes must never collide, and a folder that changed on
// the source must repair itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Shelf, sanitizeRemote } = require('../src/core/shelf');
const { Net, newCode, codeKeys } = require('../src/core/net');

async function makeNode(name, code) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `shelf-${name}-`));
  const self = { id: crypto.randomBytes(8).toString('hex'), name };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const net = new Net({ shelf, self, code, port: 0, mdns: false, tickMs: 100 });
  await net.start();
  return { name, dataDir, self, shelf, net };
}

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function hmac(token, parts) {
  return crypto.createHmac('sha256', token).update(parts.join('|')).digest('hex');
}

// Signs a request the way Net does: bound to a time, a nonce and the
// address it is sent to.
function signed(token, id, method, pathAndQuery, body, to, opts = {}) {
  const ts = String(opts.ts || Date.now());
  const rnd = opts.rnd || crypto.randomBytes(8).toString('hex');
  return {
    'x-shelf-id': id,
    'x-shelf-ts': ts,
    'x-shelf-rnd': rnd,
    'x-shelf-to': to,
    'x-shelf-pre': hmac(token, ['pre', method, pathAndQuery, ts, rnd, id, to]),
    'x-shelf-auth': hmac(token, ['req', method, pathAndQuery, ts, rnd, to, crypto.createHash('sha256').update(body || '').digest('hex')]),
  };
}

function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, body: s, headers: res.headers }));
    }).on('error', reject);
  });
}

test('a device that advertises the right shelf id but not the secret is kept out', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  a.shelf.addText('private');
  t.after(() => a.net.stop());

  // A fake "peer" server: answers /hello with a's real sid, keeps whatever it receives.
  const received = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/hello')) {
        res.end(JSON.stringify({ app: 'shelf', v: 2, id: 'feedfacefeedface', name: 'Evil Mac', sid: a.net.sid, port: fake.address().port, proof: 'nope' }));
      } else {
        res.end(JSON.stringify({ from: { id: 'feedfacefeedface', name: 'Evil Mac', port: fake.address().port }, items: [{ id: 'deadbeefdeadbeefdeadbeef', kind: 'text', text: 'injected', addedAt: Date.now(), v: Date.now(), vBy: 'x' }], have: [] }));
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());

  // The way mDNS would introduce it.
  a.net._seen({ id: 'feedfacefeedface', name: 'Evil Mac', sid: a.net.sid, addr: '127.0.0.1', port: fake.address().port });
  await until(() => received.length > 0, 'the stranger is challenged');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(received.every((r) => r.url.startsWith('/hello')), 'only a challenge was sent, never a sync');
  assert.ok(received.every((r) => !JSON.stringify(r.headers).includes(a.net.token)), 'the secret never travels');
  assert.strictEqual(a.net.peerList().length, 0);
  assert.ok(a.net.nearbyList().some((n) => n.name === 'Evil Mac'), 'listed as nearby, not as a peer');
  assert.strictEqual(a.shelf.items.has('deadbeefdeadbeefdeadbeef'), false, 'nothing injected');

  // A direct unsigned or badly signed sync is refused.
  const r1 = await post(a.net.port, '/sync', { from: { id: 'feedfacefeedface', name: 'x', port: 1 }, items: [], have: [] });
  assert.strictEqual(r1.status, 401);
  const r2 = await post(a.net.port, '/sync', {}, { 'x-shelf-id': 'feedfacefeedface', 'x-shelf-ts': String(Date.now()), 'x-shelf-rnd': 'aaaaaaaaaaaaaaaa', 'x-shelf-to': `127.0.0.1:${a.net.port}`, 'x-shelf-pre': 'f'.repeat(64), 'x-shelf-auth': 'f'.repeat(64) });
  assert.strictEqual(r2.status, 401);
  // The real secret with a stale clock is told so, and nothing else.
  const { token } = codeKeys(code);
  const body = JSON.stringify({ from: { id: 'feedfacefeedface', name: 'x', port: 1 }, items: [], have: [] });
  const r3 = await post(a.net.port, '/sync', JSON.parse(body), signed(token, 'feedfacefeedface', 'POST', '/sync', body, `127.0.0.1:${a.net.port}`, { ts: Date.now() - 10 * 60 * 1000 }));
  assert.strictEqual(r3.status, 401, 'stale signature');
  assert.strictEqual(JSON.parse(r3.body).error, 'clock');
  assert.strictEqual(a.net.peerList().length, 0, 'a clock complaint does not make a peer');
});

test('a correctly signed sync is accepted once, a replay is refused, and a copy for another address is refused', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  t.after(() => a.net.stop());
  const { token } = codeKeys(code);
  const body = JSON.stringify({ from: { id: 'c0ffeec0ffeec0ff', name: 'Mac', port: 1 }, items: [], have: [] });
  const to = `127.0.0.1:${a.net.port}`;
  const headers = signed(token, 'c0ffeec0ffeec0ff', 'POST', '/sync', body, to);
  const r1 = await post(a.net.port, '/sync', JSON.parse(body), headers);
  assert.strictEqual(r1.status, 200);
  assert.ok(a.net.peerList().some((p) => p.name === 'Mac'), 'a signed request proves membership');
  const r2 = await post(a.net.port, '/sync', JSON.parse(body), headers);
  assert.strictEqual(r2.status, 401, 'replay');
  // Signed for some other computer's address: carried here, it is worthless.
  const elsewhere = signed(token, 'c0ffeec0ffeec0ff', 'POST', '/sync', body, '10.9.9.9:47474');
  assert.strictEqual((await post(a.net.port, '/sync', JSON.parse(body), elsewhere)).status, 401, 'bound to the address it was sent to');
});

test('the headers are checked before any body is read', async (t) => {
  const a = await makeNode('PC', newCode());
  t.after(() => a.net.stop());
  // Promise a huge body, send none: the answer must come anyway, at once.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: a.net.port, path: '/sync', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 50 * 1024 * 1024, 'x-shelf-id': 'feedfacefeedface' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.on('error', (e) => (req.destroyed ? null : reject(e)));
    req.flushHeaders();
    setTimeout(() => reject(new Error('no answer without the body')), 3000);
  });
  assert.strictEqual(status, 401);
});

test('an announcement for a known peer cannot move it, and a relay cannot borrow its proof', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => b.net.peerList().some((p) => p.online), 'peer online');
  const realPort = b.net.peers.get(a.self.id).port;

  // A relay that forwards everything to the real computer, headers intact.
  const seen = [];
  const relay = http.createServer((req, res) => {
    seen.push(req.url);
    const fwd = http.request({ host: '127.0.0.1', port: a.net.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    fwd.on('error', () => res.destroy());
    req.pipe(fwd);
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());

  // The announcement names the real computer's id and shelf, at the relay's address.
  b.net._seen({ id: a.self.id, name: 'PC', sid: b.net.sid, addr: '127.0.0.1', port: relay.address().port });
  await until(() => seen.length > 0, 'the new address is challenged');
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(b.net.peers.get(a.self.id).port, realPort, 'the peer still points at the real computer');
  assert.ok(seen.every((u) => u.startsWith('/hello')), 'nothing but the challenge went to the relay');
  assert.ok(b.net.peerList().some((p) => p.id === a.self.id), 'and the peer was not dropped');

  // Added by hand through the relay: same answer.
  assert.strictEqual(await b.net.addAddress('127.0.0.1', relay.address().port), 'nearby');
  assert.strictEqual(b.net.peers.get(a.self.id).port, realPort);
});

test('a cancelled download is retried instead of sitting at a frozen bar', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const file = path.join(src, 'big.bin');
  fs.writeFileSync(file, crypto.randomBytes(6 * 1024 * 1024));
  const it = await a.shelf.addPath(file);
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => b.net.active.has(it.id), 'download starts');
  b.net.active.get(it.id).abort();
  // Over loopback the file may already be through; either way nothing may be
  // left showing a download that is not running.
  await new Promise((r) => setTimeout(r, 300));
  const l = b.shelf.local.get(it.id);
  assert.ok(l.state !== 'downloading' || b.net.active.has(it.id), 'no frozen progress bar');
  await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'downloaded in the end', 15000);
  assert.ok(fs.readFileSync(b.shelf.local.get(it.id).path).equals(fs.readFileSync(file)));
});

test('hostile item fields from a peer are dropped or bounded', () => {
  const now = Date.now();
  assert.strictEqual(sanitizeRemote({ id: 'not hex' }), null);
  assert.strictEqual(sanitizeRemote({ id: 'a'.repeat(24), kind: 'text', addedAt: now, v: now, vBy: 'x' }), null, 'text without text');
  assert.strictEqual(sanitizeRemote({ id: 'a'.repeat(24), kind: 'text', text: 'x'.repeat(300 * 1024), addedAt: now, v: now, vBy: 'x' }), null, 'oversized text');
  assert.strictEqual(sanitizeRemote({ id: 'a'.repeat(24), kind: 'weird', addedAt: now, v: now, vBy: 'x' }), null, 'unknown kind');
  assert.strictEqual(sanitizeRemote({ id: 'a'.repeat(24), kind: 'file', name: 'x', addedAt: 'soon', v: now, vBy: 'x' }), null, 'bad time');
  const far = sanitizeRemote({ id: 'a'.repeat(24), kind: 'file', name: 'x', size: 10, addedAt: now, v: 1e308, vBy: 'x' });
  assert.ok(far.v <= now + 5 * 60 * 1000 + 1000, 'version stamps from the future are clamped');
  const ok = sanitizeRemote({ id: 'b'.repeat(24), kind: 'file', name: 'n'.repeat(999), size: 5, addedAt: now, v: now, vBy: 'x', addedByName: 'y'.repeat(999), extra: 'dropped' });
  assert.strictEqual(ok.name.length, 255);
  assert.strictEqual(ok.addedByName.length, 80);
  assert.strictEqual('extra' in ok, false);
  const folder = sanitizeRemote({ id: 'c'.repeat(24), kind: 'folder', name: 'f', size: 1, addedAt: now, v: now, vBy: 'x', files: [{ p: 'a.txt', s: 1 }, { p: 5, s: 1 }, { p: 'b', s: -1 }], dirs: ['d', 7] });
  assert.deepStrictEqual(folder.files, [{ p: 'a.txt', s: 1 }]);
  assert.deepStrictEqual(folder.dirs, ['d']);
  const dev = sanitizeRemote({ id: 'd'.repeat(24), kind: 'device', name: 'phone', addedAt: now, v: now, vBy: 'x', tokenHash: 'zz' });
  assert.strictEqual(dev, null, 'device without a proper token hash');
  const tomb = sanitizeRemote({ id: 'e'.repeat(24), removed: true, addedAt: now, v: now, vBy: 'x', text: 'ignored' });
  assert.deepStrictEqual(Object.keys(tomb).sort(), ['addedAt', 'id', 'kind', 'removed', 'v', 'vBy']);
});

test('old items are still accepted; tombstones, kept for years, are what stops a comeback', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-old-'));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  shelf.merge([{ id: 'f'.repeat(24), kind: 'text', text: 'last year', name: 'last year', addedAt: old, v: old, vBy: 'x' }]);
  shelf.merge([{ id: 'a'.repeat(24), kind: 'device', name: 'Old phone', tokenHash: 'b'.repeat(64), addedAt: old, v: old, vBy: 'x' }]);
  assert.strictEqual(shelf.visible().length, 1, 'a year-old item from a computer that was away still counts');
  assert.strictEqual(shelf.devices().length, 1, 'and so does a phone paired a year ago');
  shelf.remove('f'.repeat(24));
  shelf.merge([{ id: 'f'.repeat(24), kind: 'text', text: 'last year', name: 'last year', addedAt: old, v: old, vBy: 'x' }]);
  assert.strictEqual(shelf.visible().length, 0, 'the tombstone wins');
});

test('overlapping saves never corrupt the state file, and a broken one does not wipe the store', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-save-'));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  const big = 'x'.repeat(200 * 1024);
  const saves = [];
  for (let i = 0; i < 12; i++) {
    shelf.addText(big + i);
    saves.push(shelf.saveNow());
  }
  await Promise.all(saves);
  const parsed = JSON.parse(fs.readFileSync(shelf.statePath, 'utf8'));
  assert.strictEqual(parsed.items.length, 12);
  assert.deepStrictEqual(fs.readdirSync(dataDir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left');
  // A broken state file is set aside, and what the store holds comes back as items.
  fs.writeFileSync(shelf.statePath, '{"items": [truncated');
  const id = 'c'.repeat(24);
  fs.mkdirSync(path.join(shelf.storeDir, id), { recursive: true });
  fs.writeFileSync(path.join(shelf.storeDir, id, 'IMG_0007.JPG'), 'bytes');
  const again = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await again.load();
  assert.ok(fs.existsSync(path.join(shelf.storeDir, id, 'IMG_0007.JPG')), 'store survives an unreadable list');
  assert.ok(fs.readdirSync(dataDir).some((n) => n.startsWith('shelf.json.bad-')), 'bad file kept for inspection');
  const back = again.visible().find((it) => it.id === id);
  assert.ok(back && back.name === 'IMG_0007.JPG', 'the stored file is an item again');
  await again.saveNow();
  const third = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await third.load();
  assert.ok(fs.existsSync(path.join(shelf.storeDir, id, 'IMG_0007.JPG')), 'and the next launch keeps it too');
});

test('an upload the app died in the middle of is removed on the next start, not left arriving forever', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ghost-'));
  const id = 'd'.repeat(24);
  const now = Date.now();
  fs.mkdirSync(path.join(dataDir, 'store', id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'store', id, '.partial-clip.mov'), 'half');
  fs.writeFileSync(path.join(dataDir, 'shelf.json'), JSON.stringify({
    items: [{ id, kind: 'file', name: 'clip.mov', size: 1000, addedBy: 'phone', addedByName: 'iPhone', addedAt: now, v: now, vBy: 'me', removed: false, expiresAt: null }],
    local: { [id]: { path: path.join(dataDir, 'store', id, 'clip.mov'), state: 'downloading', uploading: true } },
  }));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  assert.strictEqual(shelf.visible().length, 0);
  assert.ok(shelf.items.get(id).removed, 'tombstoned so every computer drops it');
  assert.ok(!fs.existsSync(path.join(dataDir, 'store', id)), 'partial file gone');
});

test('a dropped-in-place file that goes away and comes back is ready again', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-reprobe-'));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const file = path.join(src, 'on-the-ssd.bin');
  fs.writeFileSync(file, 'data');
  const it = await shelf.addPath(file);
  fs.rmSync(file);
  shelf.setLocal(it.id, { state: 'missing' });
  await shelf.saveNow();
  const again = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await again.load();
  assert.strictEqual(again.local.get(it.id).path, file, 'the original path is remembered while missing');
  assert.strictEqual(again.local.get(it.id).state, 'missing');
  fs.writeFileSync(file, 'data');
  for (let i = 0; i < 6; i++) again.sweep();
  await until(() => again.local.get(it.id).state === 'ready', 'probed again and found', 3000);
});

test('a folder that lost a file on the source repairs its manifest and the download resumes', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const dir = path.join(src, 'Album');
  fs.mkdirSync(dir);
  const files = {};
  for (let i = 0; i < 6; i++) {
    files[`p${i}.bin`] = crypto.randomBytes(300000);
    fs.writeFileSync(path.join(dir, `p${i}.bin`), files[`p${i}.bin`]);
  }
  const it = await a.shelf.addPath(dir);
  // Break the source before anyone downloads: the third file disappears.
  fs.rmSync(path.join(dir, 'p2.bin'));
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'folder arrives despite the missing file', 15000);
  const out = b.shelf.local.get(it.id).path;
  assert.ok(!fs.existsSync(path.join(out, 'p2.bin')));
  for (const n of ['p0.bin', 'p1.bin', 'p3.bin', 'p4.bin', 'p5.bin']) assert.ok(fs.readFileSync(path.join(out, n)).equals(files[n]), n);
  assert.strictEqual(a.shelf.items.get(it.id).files.length, 5, 'manifest repaired on the source');
  assert.ok(!fs.readdirSync(path.dirname(out)).some((n) => n.startsWith('.partial')), 'partial folder cleaned up');
  // symlinks and names outside the manifest are never served
  const { token } = codeKeys(code);
  const p = `/blob/${it.id}?p=${encodeURIComponent('../../secret.txt')}`;
  const r = await get(a.net.port, p, signed(token, b.self.id, 'GET', p, '', `127.0.0.1:${a.net.port}`));
  assert.strictEqual(r.status, 404);
});

test('starting a new shelf leaves the old items behind', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  const it = a.shelf.addText('old shelf');
  await until(() => b.shelf.items.get(it.id), 'arrive');
  b.shelf.forgetAll();
  b.net.setCode(newCode());
  assert.strictEqual(b.shelf.visible().length, 0);
  assert.strictEqual(b.net.peerList().length, 0);
  await until(() => a.shelf.items.get(it.id), 'a still has it');
  assert.ok(!a.shelf.items.get(it.id).removed, "leaving does not remove it from the others' shelf");
});

test('a pair request that hangs up is cancelled and cools down, declines cool down, and dialogs are spaced out', async (t) => {
  const a = await makeNode('PC', newCode());
  t.after(() => a.net.stop());
  let aborted = false;
  a.net.onPairRequest = ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve(false);
      });
    });
  const req = http.request({ host: '127.0.0.1', port: a.net.port, path: '/pair', method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ id: 'abcdef0123456789', name: 'Mac' }));
  await new Promise((r) => setTimeout(r, 150));
  req.destroy();
  await until(() => aborted, 'dialog cancelled when the asker hung up');
  assert.strictEqual((await post(a.net.port, '/pair', { id: 'abcdef0123456789', name: 'Mac' })).status, 429, 'a hang-up costs a cooldown');
  a.net.declines.clear();
  a.net.lastPairDialog = 0;
  a.net.onPairRequest = async () => false;
  assert.strictEqual((await post(a.net.port, '/pair', { id: 'abcdef0123456789', name: 'Mac' })).status, 403);
  assert.strictEqual((await post(a.net.port, '/pair', { id: 'abcdef0123456789', name: 'Mac' })).status, 429, 'cooldown after a refusal');
  a.net.declines.clear();
  assert.strictEqual((await post(a.net.port, '/pair', { id: 'abcdef0123456789', name: 'Mac' })).status, 429, 'no second dialog within seconds of the last');
});
