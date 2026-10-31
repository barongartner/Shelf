'use strict';

// The sharp edges found in review: a stranger that knows the public shelf id
// must learn nothing, hostile item fields must be dropped, state writes must
// never collide, and a folder that changed on the source must repair itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Shelf, sanitizeRemote, TOMBSTONE_TTL } = require('../src/core/shelf');
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
      if (req.url.startsWith('/hello')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ app: 'shelf', v: 2, id: 'feedfacefeedface', name: 'Evil Mac', sid: a.net.sid, port: fake.address().port, proof: 'nope' }));
      } else {
        res.setHeader('content-type', 'application/json');
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
  const r2 = await post(a.net.port, '/sync', {}, { 'x-shelf-id': 'feedfacefeedface', 'x-shelf-ts': String(Date.now()), 'x-shelf-rnd': 'aaaaaaaaaaaaaaaa', 'x-shelf-auth': 'f'.repeat(64) });
  assert.strictEqual(r2.status, 401);
  // The real token with a stale timestamp is refused too.
  const { token } = codeKeys(code);
  const rnd = 'bbbbbbbbbbbbbbbb';
  const ts = String(Date.now() - 10 * 60 * 1000);
  const body = JSON.stringify({ from: { id: 'feedfacefeedface', name: 'x', port: 1 }, items: [], have: [] });
  const auth = crypto.createHmac('sha256', token).update(['req', 'POST', '/sync', ts, rnd, crypto.createHash('sha256').update(body).digest('hex')].join('|')).digest('hex');
  const r3 = await post(a.net.port, '/sync', JSON.parse(body), { 'x-shelf-id': 'feedfacefeedface', 'x-shelf-ts': ts, 'x-shelf-rnd': rnd, 'x-shelf-auth': auth });
  assert.strictEqual(r3.status, 401, 'stale signature');
});

test('a correctly signed sync is accepted once and a replay is refused', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  t.after(() => a.net.stop());
  const { token } = codeKeys(code);
  const rnd = crypto.randomBytes(8).toString('hex');
  const ts = String(Date.now());
  const body = JSON.stringify({ from: { id: 'c0ffeec0ffeec0ff', name: 'Mac', port: 1 }, items: [], have: [] });
  const auth = crypto.createHmac('sha256', token).update(['req', 'POST', '/sync', ts, rnd, crypto.createHash('sha256').update(body).digest('hex')].join('|')).digest('hex');
  const headers = { 'x-shelf-id': 'c0ffeec0ffeec0ff', 'x-shelf-ts': ts, 'x-shelf-rnd': rnd, 'x-shelf-auth': auth };
  const r1 = await post(a.net.port, '/sync', JSON.parse(body), headers);
  assert.strictEqual(r1.status, 200);
  assert.ok(a.net.peerList().some((p) => p.name === 'Mac'), 'a signed request proves membership');
  const r2 = await post(a.net.port, '/sync', JSON.parse(body), headers);
  assert.strictEqual(r2.status, 401, 'replay');
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

test('merge ignores items older than any tombstone this computer would still keep', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-old-'));
  const shelf = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await shelf.load();
  const old = Date.now() - TOMBSTONE_TTL - 1000;
  shelf.merge([{ id: 'f'.repeat(24), kind: 'text', text: 'ghost', name: 'ghost', addedAt: old, v: old, vBy: 'x' }]);
  assert.strictEqual(shelf.visible().length, 0);
  shelf.merge([{ id: '0'.repeat(24), kind: 'text', text: 'fresh', name: 'fresh', addedAt: Date.now(), v: Date.now(), vBy: 'x' }]);
  assert.strictEqual(shelf.visible().length, 1);
});

test('overlapping saves never corrupt the state file', async () => {
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
  // A broken state file is set aside, and the store is not wiped.
  fs.writeFileSync(shelf.statePath, '{"items": [truncated');
  fs.mkdirSync(path.join(shelf.storeDir, 'keepme'), { recursive: true });
  fs.writeFileSync(path.join(shelf.storeDir, 'keepme', 'file.bin'), 'bytes');
  const again = new Shelf({ dataDir, self: { id: 'me', name: 'me' } });
  await again.load();
  assert.ok(fs.existsSync(path.join(shelf.storeDir, 'keepme', 'file.bin')), 'store survives an unreadable list');
  assert.ok(fs.readdirSync(dataDir).some((n) => n.startsWith('shelf.json.bad-')), 'bad file kept for inspection');
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
  const fakeReq = await new Promise((resolve) => {
    const { token } = codeKeys(code);
    const rnd = crypto.randomBytes(8).toString('hex');
    const ts = String(Date.now());
    const p = `/blob/${it.id}?p=${encodeURIComponent('../../secret.txt')}`;
    const auth = crypto.createHmac('sha256', token).update(['req', 'GET', p, ts, rnd, crypto.createHash('sha256').update('').digest('hex')].join('|')).digest('hex');
    http.get({ host: '127.0.0.1', port: a.net.port, path: p, headers: { 'x-shelf-id': b.self.id, 'x-shelf-ts': ts, 'x-shelf-rnd': rnd, 'x-shelf-auth': auth } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.strictEqual(fakeReq, 404);
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

test('a pair request that hangs up is cancelled and declines cool down', async (t) => {
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
  a.net.onPairRequest = async () => false;
  assert.strictEqual((await post(a.net.port, '/pair', { id: 'abcdef0123456789', name: 'Mac' })).status, 403);
  assert.strictEqual((await post(a.net.port, '/pair', { id: 'abcdef0123456789', name: 'Mac' })).status, 429, 'cooldown after a refusal');
});
