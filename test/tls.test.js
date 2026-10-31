'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { X509Certificate } = require('crypto');
const tls = require('../src/core/tls');

function get(port, opts) {
  return new Promise((resolve) => {
    https
      .get({ host: '127.0.0.1', port, path: '/', agent: false, ...opts }, (res) => {
        const cert = res.socket.getPeerCertificate();
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, san: cert.subjectaltname }));
      })
      .on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

test('an authority and a server certificate are made once and reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-tls-'));
  const first = tls.ensure(dir, { hosts: ['pc', 'pc.local'], ips: ['192.168.1.20'], computerName: 'PC' });
  assert.ok(first.caIsNew && first.leafIsNew);
  const again = tls.ensure(dir, { hosts: ['pc', 'pc.local'], ips: ['192.168.1.20'], computerName: 'PC' });
  assert.ok(!again.caIsNew && !again.leafIsNew);
  assert.strictEqual(again.cert, first.cert);
  const moved = tls.ensure(dir, { hosts: ['pc', 'pc.local'], ips: ['10.0.0.5'], computerName: 'PC' });
  assert.ok(!moved.caIsNew && moved.leafIsNew, 'new address, new server certificate, same authority');
  assert.strictEqual(moved.ca, first.ca);

  const leaf = new X509Certificate(moved.cert);
  const ca = new X509Certificate(moved.ca);
  assert.ok(ca.ca);
  assert.ok(leaf.checkIssued(ca));
  assert.ok(leaf.verify(ca.publicKey));
  assert.strictEqual(leaf.subjectAltName, 'DNS:pc, DNS:pc.local, IP Address:10.0.0.5');
  assert.deepStrictEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'serverAuth, which iOS insists on');
  const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400000;
  assert.ok(days <= 825, `iOS refuses server certificates longer than 825 days, this one is ${days}`);
  assert.ok(moved.caDer[0] === 0x30);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a server can swap to a new certificate while running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-tls-'));
  const a = tls.ensure(dir, { hosts: ['localhost'], ips: ['127.0.0.1'], computerName: 'PC' });
  const srv = https.createServer({ key: a.key, cert: a.cert }, (req, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.deepStrictEqual(await get(port, { ca: a.ca }), { status: 200, san: 'DNS:localhost, IP Address:127.0.0.1' });
  assert.ok((await get(port, {})).error, 'not trusted without the authority');
  const b = tls.ensure(dir, { hosts: ['localhost'], ips: ['127.0.0.1', '10.1.1.1'], computerName: 'PC' });
  srv.setSecureContext({ key: b.key, cert: b.cert });
  assert.deepStrictEqual(await get(port, { ca: a.ca }), { status: 200, san: 'DNS:localhost, IP Address:127.0.0.1, IP Address:10.1.1.1' });
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
