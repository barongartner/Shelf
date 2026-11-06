'use strict';

// Runs two shelves in one process, talking over loopback, and checks that
// items, downloads, linger expiry and removal all reach the other computer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Shelf } = require('../src/core/shelf');
const { Net, newCode } = require('../src/core/net');

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

test('two computers share one shelf', async (t) => {
  const code = newCode();
  const a = await makeNode('Mac', code);
  const b = await makeNode('PC', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });

  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => a.net.peerList().some((p) => p.online) && b.net.peerList().some((p) => p.online), 'peers online');

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));

  await t.test('a file dropped on one shows up and downloads on the other', async () => {
    const file = path.join(srcDir, 'photo.bin');
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
    fs.writeFileSync(file, bytes);
    const it = await a.shelf.addPath(file);
    await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'download');
    const got = fs.readFileSync(b.shelf.local.get(it.id).path);
    assert.ok(got.equals(bytes));
    assert.strictEqual(b.shelf.items.get(it.id).addedByName, 'Mac');
  });

  await t.test('folders keep their structure, empty folders included', async () => {
    const dir = path.join(srcDir, 'Project');
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'empty'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi');
    fs.writeFileSync(path.join(dir, 'src', 'deep', 'x.txt'), 'deep file');
    const it = await a.shelf.addPath(dir);
    await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'folder download');
    const out = b.shelf.local.get(it.id).path;
    assert.strictEqual(path.basename(out), 'Project');
    assert.strictEqual(fs.readFileSync(path.join(out, 'src', 'deep', 'x.txt'), 'utf8'), 'deep file');
    assert.ok(fs.statSync(path.join(out, 'empty')).isDirectory());
  });

  await t.test('text travels inline', async () => {
    const it = a.shelf.addText('hello from the mac\nsecond line');
    await until(() => b.shelf.items.get(it.id), 'text item');
    assert.strictEqual(b.shelf.items.get(it.id).text, 'hello from the mac\nsecond line');
    assert.strictEqual(b.shelf.items.get(it.id).name, 'hello from the mac');
  });

  await t.test('taking an item starts the linger timer everywhere, then it leaves', async () => {
    const file = path.join(srcDir, 'notes.txt');
    fs.writeFileSync(file, 'keep me');
    const it = await a.shelf.addPath(file);
    await until(() => b.shelf.local.get(it.id)?.state === 'ready', 'download');
    const bCopy = b.shelf.local.get(it.id).path;

    b.shelf.take(it.id, 400);
    await until(() => a.shelf.items.get(it.id).expiresAt, 'linger reaches the other computer');
    await until(() => a.shelf.items.get(it.id).removed && b.shelf.items.get(it.id).removed, 'expiry');
    await until(() => !fs.existsSync(bCopy), "downloaded copy deleted");
    assert.ok(fs.existsSync(file), 'the original dropped file is never deleted');
  });

  await t.test('keep cancels the linger timer', async () => {
    const it = a.shelf.addText('stay');
    await until(() => b.shelf.items.get(it.id), 'arrive');
    a.shelf.take(it.id, 1500);
    await until(() => b.shelf.items.get(it.id).expiresAt, 'linger reaches the other computer');
    b.shelf.keep(it.id);
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(!a.shelf.items.get(it.id).removed);
    assert.strictEqual(a.shelf.items.get(it.id).expiresAt, null);
  });

  await t.test('removing on either computer removes it everywhere, for good', async () => {
    const it = a.shelf.addText('bye');
    await until(() => b.shelf.items.get(it.id), 'arrive');
    b.shelf.remove(it.id);
    await until(() => a.shelf.items.get(it.id).removed, 'removal reaches the other computer');
    a.shelf.keep(it.id);
    assert.ok(a.shelf.items.get(it.id).removed);
  });
});

test('a computer with a different code is not let in', async (t) => {
  const a = await makeNode('Mac', newCode());
  const c = await makeNode('Stranger', newCode());
  t.after(async () => {
    await a.net.stop();
    await c.net.stop();
  });
  a.shelf.addText('private');
  assert.strictEqual(await c.net.addAddress('127.0.0.1', a.net.port), 'nearby');
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(c.shelf.visible().length, 0);
  assert.strictEqual(c.net.peerList().length, 0);
  assert.strictEqual(c.net.nearbyList().length, 1);
});

test('joining asks the other computer, then shares its shelf', async (t) => {
  let asked = null;
  const a = await makeNode('Mac', newCode());
  a.net.onPairRequest = async (who) => {
    asked = who.name;
    return true;
  };
  const b = await makeNode('PC', newCode());
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  const it = a.shelf.addText('welcome');
  await b.net.addAddress('127.0.0.1', a.net.port);
  const [n] = b.net.nearbyList();
  await b.net.requestJoin(n.id);
  assert.strictEqual(asked, 'PC');
  assert.strictEqual(b.net.code, a.net.code);
  await until(() => b.shelf.items.get(it.id), 'shelf contents after joining');
  await until(() => a.net.peerList().some((p) => p.name === 'PC' && p.online), 'joiner shows up as a peer');
});

test('file names Windows would reject are cleaned up on the way in', () => {
  const { safeRel, safeName } = require('../src/core/files');
  assert.strictEqual(safeRel('a:b/c?.txt'), 'a_b/c_.txt');
  assert.strictEqual(safeName('trailing dot.'), 'trailing dot');
  assert.strictEqual(safeName('..'), 'item');
});

test('starting a new shelf and joining the old one again brings the shelf back, wiping nothing', async (t) => {
  const code = newCode();
  const a = await makeNode('PC', code);
  const b = await makeNode('Mac', code);
  t.after(async () => {
    await a.net.stop();
    await b.net.stop();
  });
  assert.strictEqual(await b.net.addAddress('127.0.0.1', a.net.port), 'peer');
  await until(() => a.net.peerList().some((p) => p.online) && b.net.peerList().some((p) => p.online), 'peers online');
  const text = b.shelf.addText('shared');
  const phone = b.shelf.addDevice({ name: 'iPhone', tokenHash: 'e'.repeat(64) });
  await until(() => a.shelf.items.get(text.id) && a.shelf.items.get(phone.id), 'arrive');

  a.shelf.forgetAll();
  assert.strictEqual(a.shelf.visible().length, 0);
  assert.strictEqual(a.shelf.devices().length, 0);
  assert.ok(![...a.shelf.items.values()].some((it) => it.removed), 'nothing is turned into a removal');
  a.net.setCode(newCode());
  await new Promise((r) => setTimeout(r, 300));
  a.net.setCode(code);
  await until(() => a.shelf.items.get(text.id) && a.shelf.items.get(phone.id), 'the shelf comes back after joining again');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!b.shelf.items.get(text.id).removed, 'the item survives on the other computer');
  assert.ok(b.shelf.devices().some((d) => d.id === phone.id), 'the phone survives on the other computer');
  assert.ok(!a.shelf.items.get(text.id).removed);
});

test('a Keep made while the taker was away beats the expiry; a removal stays final', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-keep-'));
  const a = new Shelf({ dataDir: dir(), self: { id: 'aaaa', name: 'A' } });
  const b = new Shelf({ dataDir: dir(), self: { id: 'bbbb', name: 'B' } });
  const it = a.addText('stay please');
  b.merge(a.payload());
  a.take(it.id, 1);
  b.merge(a.payload());
  // A is asleep: B keeps it, A never hears. Then A wakes and expires it.
  b.keep(it.id);
  const until = Date.now() + 5;
  while (Date.now() < until);
  a.sweep();
  assert.ok(a.items.get(it.id).removed);
  assert.strictEqual(a.items.get(it.id).expired, true);
  b.merge(a.payload());
  assert.ok(!b.items.get(it.id).removed, 'the Keep is newer than the expiry');
  a.merge(b.payload());
  assert.ok(!a.items.get(it.id).removed, 'and brings the item back on the taker');
  assert.strictEqual(a.items.get(it.id).expiresAt, null);

  // An expiry nobody answered still removes it everywhere.
  a.take(it.id, 1);
  b.merge(a.payload());
  const until2 = Date.now() + 5;
  while (Date.now() < until2);
  a.sweep();
  b.merge(a.payload());
  assert.ok(b.items.get(it.id).removed);

  // An explicit removal beats any later version.
  const t2 = a.addText('gone');
  b.merge(a.payload());
  a.remove(t2.id);
  b.keep(t2.id);
  b._update(b.items.get(t2.id), { name: 'renamed later' });
  a.merge(b.payload());
  assert.ok(a.items.get(t2.id).removed);
  b.merge(a.payload());
  assert.ok(b.items.get(t2.id).removed);
});

test('a computer that did not start the countdown waits minutes, not an hour', () => {
  const { LINGER_GRACE } = require('../src/core/shelf');
  assert.ok(LINGER_GRACE <= 5 * 60 * 1000);
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-grace-'));
  const a = new Shelf({ dataDir: dir(), self: { id: 'aaaa', name: 'A' } });
  const b = new Shelf({ dataDir: dir(), self: { id: 'bbbb', name: 'B' } });
  const it = a.addText('taken');
  a.take(it.id, 1000);
  b.merge(a.payload());
  const cur = b.items.get(it.id);
  b.items.set(it.id, { ...cur, expiresAt: Date.now() - LINGER_GRACE - 1 });
  b.sweep();
  assert.ok(b.items.get(it.id).removed, 'gone once the clock slack has passed');
});
