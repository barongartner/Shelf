'use strict';

// The network layer's failure paths: hostile answers to a download, why a
// download failed and giving up on it, clocks apart, computers remembered
// across a restart, address ranking, and plain-language connection errors.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Shelf } = require('../src/core/shelf');
const { Net, newCode, codeKeys, fetchToFile } = require('../src/core/net');
const { safeEqual } = require('../src/core/httpu');

async function makeNode(name, code, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `shelf-${name}-`));
  const self = opts.self || { id: crypto.randomBytes(8).toString('hex'), name };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const n = new Net({ shelf, self, code, port: 0, mdns: false, tickMs: 100, known: opts.known || [] });
  await n.start();
  return { name, dataDir, self, shelf, net: n };
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

function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('safeEqual compares bytes, so a latin1 header of the right length is just unequal', () => {
  const good = 'a'.repeat(64);
  const evil = Buffer.alloc(64, 0xe9).toString('latin1');
  assert.strictEqual(evil.length, 64);
  assert.strictEqual(safeEqual(evil, good), false);
  assert.strictEqual(safeEqual(good, good), true);
  assert.strictEqual(safeEqual(undefined, good), false);
});

test('a bad proof header on a download is a failed download, not a crash', async (t) => {
  // A raw answer with 64 bytes of 0xE9 where the proof goes.
  const srv = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nx-shelf-proof: '), Buffer.alloc(64, 0xe9), Buffer.from('\r\ncontent-length: 4\r\n\r\nabcd')]));
      sock.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const crashed = [];
  const onCrash = (err) => crashed.push(err);
  process.on('uncaughtException', onCrash);
  t.after(() => process.off('uncaughtException', onCrash));
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-proof-')), 'x');
  await assert.rejects(fetchToFile(`http://127.0.0.1:${srv.address().port}/blob/x`, {}, dest, () => {}, undefined, 'b'.repeat(64)), /bad proof/);
  assert.strictEqual(crashed.length, 0);
});

test('bytes that do not match the signed sum are refused', async (t) => {
  const body = Buffer.from('the real bytes');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'x-shelf-proof': 'p'.repeat(64), 'x-shelf-size': String(body.length), trailer: 'x-shelf-sum' });
    res.addTrailers({ 'x-shelf-sum': 's'.repeat(64) });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sum-'));
  const url = `http://127.0.0.1:${srv.address().port}/blob/x`;
  let seen = null;
  await assert.rejects(
    fetchToFile(url, {}, path.join(dir, 'a'), () => {}, undefined, 'p'.repeat(64), (hex) => ((seen = hex), 'other'.padEnd(64, '0'))),
    (err) => err.code === 'BAD_SUM',
  );
  assert.strictEqual(seen, crypto.createHash('sha256').update(body).digest('hex'), 'the sum is over the bytes received');
  await fetchToFile(url, {}, path.join(dir, 'b'), () => {}, undefined, 'p'.repeat(64), () => 's'.repeat(64));
  assert.ok(fs.readFileSync(path.join(dir, 'b')).equals(body));
});

test('files between computers carry a signed sum and arrive intact', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const file = path.join(src, 'photo.jpg');
  fs.writeFileSync(file, crypto.randomBytes(200000));
  const it = await a.shelf.addPath(file);
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => b.net.peers.get(a.self.id)?.blobSum, 'the peer says it signs bytes');
  await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'downloaded');
  assert.ok(fs.readFileSync(b.shelf.local.get(it.id).path).equals(fs.readFileSync(file)));
});

test('a download that keeps failing says why, gives up, and Retry starts it again', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  const realProof = a.net._proof.bind(a.net);
  a.net._proof = (req, extra) => (extra === 'blob' ? 'f'.repeat(64) : realProof(req, extra));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const file = path.join(src, 'doc.pdf');
  fs.writeFileSync(file, crypto.randomBytes(5000));
  const it = await a.shelf.addPath(file);
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  for (let i = 1; i <= 3; i++) {
    await until(() => (b.net.failures.get(it.id) || 0) >= i && !b.net.active.has(it.id), `failure ${i}`);
    const l = b.shelf.local.get(it.id);
    assert.strictEqual(l.state, 'missing');
    assert.match(l.error, /didn't match/);
    assert.strictEqual(l.failed, i >= 3, `failed only after three tries (try ${i})`);
    b.net.backoff.clear();
    b.net.peerFail.clear();
    b.net.pump();
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(b.net.failures.get(it.id), 3, 'no more tries once it gave up');
  a.net._proof = realProof;
  b.net.retry(it.id);
  await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'downloaded after Retry');
  const l = b.shelf.local.get(it.id);
  assert.strictEqual(l.error, null);
  assert.strictEqual(l.failed, false);
});

test('download failures are put in words, and only lasting ones give up', () => {
  const { downloadFailure } = require('../src/core/net');
  const gone = downloadFailure(Object.assign(new Error('HTTP 404'), { status: 404, reason: 'gone' }), 'Mac');
  assert.deepStrictEqual(gone, { text: 'The original was moved or deleted on Mac.', permanent: true });
  assert.strictEqual(downloadFailure(Object.assign(new Error('x'), { code: 'ENOSPC' }), 'Mac').permanent, true);
  assert.strictEqual(downloadFailure(Object.assign(new Error('x'), { code: 'EACCES' }), 'Mac').permanent, true);
  assert.strictEqual(downloadFailure(new Error('timeout'), 'Mac').permanent, false);
  assert.match(downloadFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'Mac').text, /Couldn't reach Mac/);
});

test('a retried folder download drops files the source no longer has', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const dir = path.join(src, 'Album');
  fs.mkdirSync(path.join(dir, 'kept'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), crypto.randomBytes(1000));
  fs.writeFileSync(path.join(dir, 'kept', 'b.bin'), crypto.randomBytes(1000));
  const it = await a.shelf.addPath(dir);
  // What an earlier attempt left behind, from before the manifest changed.
  const tmp = path.join(path.dirname(b.shelf.storePath(it)), '.partial-' + path.basename(b.shelf.storePath(it)));
  fs.mkdirSync(path.join(tmp, 'old dir'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kept'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'stale.bin'), 'no longer on the source');
  fs.writeFileSync(path.join(tmp, 'old dir', 'c.bin'), 'nor this');
  fs.writeFileSync(path.join(tmp, 'kept', 'd.bin'), 'nor this');
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'folder arrives');
  const out = b.shelf.local.get(it.id).path;
  assert.ok(fs.existsSync(path.join(out, 'a.bin')));
  assert.ok(fs.existsSync(path.join(out, 'kept', 'b.bin')));
  assert.ok(!fs.existsSync(path.join(out, 'stale.bin')));
  assert.ok(!fs.existsSync(path.join(out, 'old dir')));
  assert.ok(!fs.existsSync(path.join(out, 'kept', 'd.bin')));
});

test('a computer whose clock is off is reported as such, with the skew', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => a.net.peerList().some((p) => p.id === b.self.id), 'a knows b');
  const { token } = codeKeys(code);
  const ts = String(Date.now() - 10 * 60 * 1000);
  const rnd = crypto.randomBytes(8).toString('hex');
  const to = `127.0.0.1:${a.net.port}`;
  const headers = {
    'x-shelf-id': b.self.id,
    'x-shelf-ts': ts,
    'x-shelf-rnd': rnd,
    'x-shelf-to': to,
    'x-shelf-pre': hmac(token, ['pre', 'POST', '/sync', ts, rnd, b.self.id, to]),
    'content-type': 'application/json',
    'content-length': 2,
  };
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: a.net.port, path: '/sync', method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.strictEqual(status, 401);
  const p = a.net.peerList().find((x) => x.id === b.self.id);
  assert.strictEqual(p.clockOff, true);
  assert.ok(p.clockSkew < -9 * 60 * 1000 && p.clockSkew > -11 * 60 * 1000, `skew ${p.clockSkew}`);
  assert.ok('host' in p, 'peer entries carry host');
  await until(() => !a.net.peerList().find((x) => x.id === b.self.id).clockOff, 'a good sync clears it');
});

test('computers seen before are remembered and found again after a restart', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  let known = null;
  b.net.on('known', (list) => (known = list));
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  assert.ok(known && known.some((k) => k.id === a.self.id && k.port === a.net.port && k.addr === '127.0.0.1'), "'known' lists the added computer");
  assert.deepStrictEqual(Object.keys(known[0]).sort(), ['addr', 'id', 'name', 'port']);
  await b.net.stop();
  // Restarted with the saved list and nothing else to go on.
  const b2 = await makeNode('Mac', code, { self: b.self, known });
  t.after(async () => {
    await a.net.stop();
    await b2.net.stop();
  });
  await until(() => b2.net.peerList().some((p) => p.id === a.self.id && p.online), 'found again from the saved list');
  let after = null;
  b2.net.on('known', (list) => (after = list));
  assert.ok(b2.net.forget(a.self.id));
  assert.deepStrictEqual(after, []);
});

test('a peer that went quiet is looked for again where it was last proven', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  const p = b.net.peers.get(a.self.id);
  p.port = await closedPort();
  p.lastOk = 0;
  b.net._recheckKnown();
  await until(() => b.net.peers.get(a.self.id).port === a.net.port && b.net.peerList()[0].online, 'back at the right address');
});

test('announced addresses are tried best first, and a later one still works', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  b.net.addresses.best = '10.0.0.249';
  assert.deepStrictEqual(b.net._rankAddrs(['172.18.80.1', '10.0.0.5', '192.168.1.4'], '192.168.1.4'), ['10.0.0.5', '192.168.1.4', '172.18.80.1']);
  // The first address answers nothing; the second is the real one.
  const dead = await closedPort();
  await b.net._verifyPeer({ id: a.self.id, name: 'PC', sid: b.net.sid, addr: '127.0.0.1', port: dead }, [{ addr: '127.0.0.1', port: dead }, { addr: '127.0.0.1', port: a.net.port }]);
  assert.strictEqual(b.net.peers.get(a.self.id)?.port, a.net.port);
});

test('connection problems come back as plain sentences', async (t) => {
  const b = await makeNode('Mac', newCode());
  t.after(() => b.net.stop());
  const dead = await closedPort();
  await assert.rejects(b.net.addAddress('127.0.0.1', dead), (err) => err.message === `No Shelf app answered at 127.0.0.1:${dead}. Check the address and that Shelf is open there (and allowed through its firewall).`);
  await assert.rejects(b.net.addAddress('http', NaN), /doesn't look like an address/);
  await assert.rejects(b.net.addAddress('no-such-shelf-host.invalid', 47474), /could not be found on this network/);
  b.net.nearby.set('ab'.repeat(8), { id: 'ab'.repeat(8), name: 'PC', sid: 'x', addr: '127.0.0.1', port: dead });
  await assert.rejects(b.net.requestJoin('ab'.repeat(8)), /Couldn't reach PC at 127\.0\.0\.1/);
});

test('the join question keeps the line alive and a long wait costs no cooldown', async (t) => {
  const a = await makeNode('PC', newCode());
  const b = await makeNode('Mac', newCode());
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  a.net.onPairRequest = () => new Promise((r) => setTimeout(() => r(true), 600));
  await b.net.addAddress('127.0.0.1', a.net.port);
  const [n] = b.net.nearbyList();
  assert.strictEqual(await b.net.requestJoin(n.id), a.net.code);
  // A hang-up after the asker waited a long time is not punished.
  a.net.lastPairDialog = 0;
  let aborted = false;
  a.net.onPairRequest = ({ signal }) => new Promise((r) => signal.addEventListener('abort', () => ((aborted = true), r(false))));
  const realNow = Date.now;
  const req = http.request({ host: '127.0.0.1', port: a.net.port, path: '/pair', method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ id: 'abcdef0123456789', name: 'Laptop' }));
  await new Promise((r) => setTimeout(r, 150));
  Date.now = () => realNow() + 60 * 1000;
  try {
    req.destroy();
    await until(() => aborted, 'dialog cancelled');
  } finally {
    Date.now = realNow;
  }
  assert.ok(![...a.net.declines.values()].some((d) => d.until > Date.now()), 'no cooldown');
});
