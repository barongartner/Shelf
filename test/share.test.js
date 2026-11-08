'use strict';

// The share sheet endpoint: an iPhone Shortcut posts whatever was shared
// (a link, text, a photo, a file) as the raw body, with the phone's key in
// the address. Links and text become text items, everything else a file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Shelf } = require('../src/core/shelf');
const { Net, newCode } = require('../src/core/net');
const { shareText, shareName } = require('../src/core/web');

const WEB_DIR = path.join(__dirname, '..', 'src', 'web');

async function makeNode(name, code) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `shelf-${name}-`));
  const self = { id: crypto.randomBytes(8).toString('hex'), name };
  const shelf = new Shelf({ dataDir, self });
  await shelf.load();
  const net = new Net({ shelf, self, code, port: 0, httpsPort: 0, mdns: false, tickMs: 100, web: { webDir: WEB_DIR, version: 'test', lingerMs: () => 500 } });
  await net.start();
  return { shelf, net, base: `http://127.0.0.1:${net.port}` };
}

test('shareText tells links and text from files', () => {
  assert.strictEqual(shareText(Buffer.from('https://example.com/a?b=1'), 'text/plain'), 'https://example.com/a?b=1');
  assert.strictEqual(shareText(Buffer.from('https://example.com/x'), ''), 'https://example.com/x');
  assert.strictEqual(shareText(Buffer.from('https://example.com/x'), 'application/octet-stream'), 'https://example.com/x');
  assert.strictEqual(shareText(Buffer.from('{"url":"https://a.b/c"}'), 'application/json'), 'https://a.b/c');
  assert.strictEqual(shareText(Buffer.from('[InternetShortcut]\r\nURL=https://a.b/ini\r\n'), ''), 'https://a.b/ini');
  const plist = '<?xml version="1.0"?><plist><dict><key>URL</key><string>https://a.b/?x=1&amp;y=2</string></dict></plist>';
  assert.strictEqual(shareText(Buffer.from(plist), 'application/x-plist'), 'https://a.b/?x=1&y=2');
  assert.strictEqual(shareText(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), ''), null, 'a JPEG is not text');
  assert.strictEqual(shareText(Buffer.from('plain words'), 'image/jpeg'), null, 'the type says file');
  assert.strictEqual(shareText(Buffer.from('<html></html>'), 'text/html'), null);
  assert.strictEqual(shareText(Buffer.from('   '), 'text/plain'), null);
});

test('shareName keeps a given name and names the rest by type', () => {
  assert.strictEqual(shareName('IMG_1234.HEIC', 'image/heic'), 'IMG_1234.HEIC');
  assert.strictEqual(shareName('IMG_1234', 'image/jpeg'), 'IMG_1234.jpg');
  assert.strictEqual(shareName('', 'image/jpeg'), 'Photo.jpg');
  assert.strictEqual(shareName('', 'video/quicktime'), 'Video.mov');
  assert.strictEqual(shareName('', 'application/pdf'), 'Document.pdf');
  assert.strictEqual(shareName('', ''), 'File');
  assert.strictEqual(shareName('../../etc/passwd', ''), 'passwd');
});

test('the share endpoint puts links, text and files on the shelf', async (t) => {
  const a = await makeNode('PC', newCode());
  t.after(() => a.net.stop());
  const pair = a.net.web.newPair();
  const paired = await (await fetch(a.base + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code, name: 'Baron iPhone' }) })).json();
  const token = paired.token;
  const share = (body, { name = '', type } = {}) =>
    fetch(`${a.base}/api/share?t=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body });

  await t.test('without the key it is refused', async () => {
    const r = await fetch(a.base + '/api/share', { method: 'POST', body: 'https://x.y' });
    assert.strictEqual(r.status, 401);
  });

  await t.test('a link becomes a text item from the phone', async () => {
    const r = await share('https://www.instagram.com/reel/abc/', { name: 'Instagram', type: 'text/plain' });
    assert.strictEqual(r.status, 201);
    const { item } = await r.json();
    assert.strictEqual(item.kind, 'text');
    const it = a.shelf.items.get(item.id);
    assert.strictEqual(it.text, 'https://www.instagram.com/reel/abc/');
    assert.strictEqual(it.addedBy, paired.device.id);
  });

  await t.test('a link named after its host is still a link', async () => {
    const r = await share('https://www.instagram.com/p/xyz/', { name: 'www.instagram.com' });
    const { item } = await r.json();
    assert.strictEqual(item.kind, 'text');
  });

  await t.test('a photo becomes a file with its name', async () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]);
    const r = await share(jpg, { name: 'IMG_0042', type: 'image/jpeg' });
    assert.strictEqual(r.status, 201);
    const { item } = await r.json();
    assert.strictEqual(item.kind, 'file');
    assert.strictEqual(item.name, 'IMG_0042.jpg');
    const l = a.shelf.local.get(item.id);
    assert.strictEqual(l.state, 'ready');
    assert.deepStrictEqual(fs.readFileSync(l.path), jpg);
  });

  await t.test('a named text file stays a file', async () => {
    const r = await share('a,b\n1,2\n', { name: 'Sheet.csv', type: 'text/csv' });
    const { item } = await r.json();
    assert.strictEqual(item.kind, 'file');
    assert.strictEqual(item.name, 'Sheet.csv');
  });

  await t.test('a big file streams past the text limit intact', async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024);
    const r = await share(big, { type: 'video/quicktime' });
    assert.strictEqual(r.status, 201);
    const { item } = await r.json();
    assert.strictEqual(item.name, 'Video.mov');
    assert.strictEqual(item.size, big.length);
    assert.ok(fs.readFileSync(a.shelf.local.get(item.id).path).equals(big));
  });

  await t.test('big text with no type is a file, not a text item', async () => {
    const r = await share('x'.repeat(300 * 1024));
    const { item } = await r.json();
    assert.strictEqual(item.kind, 'file');
  });

  await t.test('an empty share is refused', async () => {
    assert.strictEqual((await share('', { type: 'text/plain' })).status, 400);
  });
});

test('the unsigned Shortcut is served for a Mac to sign, and the signed one comes from the data folder', async (t) => {
  const a = await makeNode('PC', newCode());
  t.after(() => a.net.stop());
  const un = await fetch(a.base + '/shortcut/unsigned');
  assert.strictEqual(un.status, 200);
  const xml = Buffer.from(await un.arrayBuffer()).toString('utf8');
  assert.match(xml, /<key>WFWorkflowImportQuestions<\/key>/);
  assert.match(xml, /is\.workflow\.actions\.downloadurl/);
  assert.ok(!/api\/share\?t=/.test(xml), 'no key baked in');
  assert.strictEqual((await fetch(a.base + '/Shelf.shortcut')).status, 404, 'none until one is dropped in the data folder');
  assert.strictEqual((await (await fetch(a.base + '/api/me')).json()).shortcut, false);
  // The signed copy lives in the computer's data folder (it carries the
  // signer's Apple ID details, so it never ships in the app).
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sc-')), 'Shelf.shortcut');
  fs.writeFileSync(f, Buffer.concat([Buffer.from('AEA1'), crypto.randomBytes(200)]));
  a.net.web.shortcutFile = f;
  const signed = await fetch(a.base + '/Shelf.shortcut');
  assert.strictEqual(signed.status, 200);
  assert.strictEqual(Buffer.from(await signed.arrayBuffer()).subarray(0, 4).toString('latin1'), 'AEA1');
  const me = await (await fetch(a.base + '/api/me')).json();
  assert.strictEqual(me.shortcut, true);
});

test('a web page shared as a file goes on the shelf as its link', async (t) => {
  const { pageLink } = require('../src/core/web');
  assert.strictEqual(pageLink(Buffer.from('<head><link rel="canonical" href="https://www.youtube.com/watch?v=abc&amp;t=3"></head>')), 'https://www.youtube.com/watch?v=abc&t=3');
  assert.strictEqual(pageLink(Buffer.from('<meta property="og:url" content="https://a.b/og"><link rel="canonical" href="https://a.b/c">')), 'https://a.b/og');
  assert.strictEqual(pageLink(Buffer.from('<html>no link</html>')), null);

  const a = await makeNode('PC', newCode());
  t.after(() => a.net.stop());
  const pair = a.net.web.newPair();
  const { token } = await (await fetch(a.base + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code }) })).json();
  const big = '<html><head>' + '<script>' + 'x'.repeat(400 * 1024) + '</script>' + '<link rel="canonical" href="https://www.youtube.com/watch?v=xyz"></head></html>';
  const r = await fetch(`${a.base}/api/share?t=${token}&name=YouTube`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: big });
  assert.strictEqual(r.status, 201);
  const { item } = await r.json();
  assert.strictEqual(item.kind, 'text');
  assert.strictEqual(a.shelf.items.get(item.id).text, 'https://www.youtube.com/watch?v=xyz');
  const plain = await fetch(`${a.base}/api/share?t=${token}&name=Page.html`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<html>hi</html>' });
  assert.strictEqual((await plain.json()).item.kind, 'file', 'a page with no address stays a file');
});
