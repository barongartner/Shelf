'use strict';

// Certificates for the browser client. A phone needs https to save photos
// through the share sheet, so each computer makes its own little certificate
// authority once and signs a server certificate with it for the addresses it
// currently has. Install the authority on the phone and the warning goes
// away for good; otherwise Safari asks once per certificate.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const CA_DAYS = 3650;
const LEAF_DAYS = 820; // iOS refuses server certificates valid for more than 825 days
const RENEW_BEFORE_DAYS = 30;
const day = 24 * 60 * 60 * 1000;

function newKeyPem() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
}

function serial() {
  const b = crypto.randomBytes(16);
  b[0] = (b[0] & 0x7f) | 0x01; // positive, never zero
  return b.toString('hex');
}

function makeCa(computerName) {
  const keyPem = newKeyPem();
  const key = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - day);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * day);
  const attrs = [
    { name: 'commonName', value: `Shelf on ${computerName}`.slice(0, 64) },
    { name: 'organizationName', value: 'Shelf' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(key, forge.md.sha256.create());
  return { keyPem, certPem: forge.pki.certificateToPem(cert) };
}

function makeLeaf(ca, { hosts, ips }) {
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const keyPem = newKeyPem();
  const key = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - day);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * day);
  cert.setSubject([
    { name: 'commonName', value: String(hosts[0] || ips[0] || 'shelf').slice(0, 64) },
    { name: 'organizationName', value: 'Shelf' },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames = [...hosts.map((h) => ({ type: 2, value: h })), ...ips.map((ip) => ({ type: 7, ip }))];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { keyPem, certPem: forge.pki.certificateToPem(cert), notAfter: cert.validity.notAfter.getTime() };
}

function derOf(certPem) {
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes(), 'binary');
}

function fingerprint(certPem) {
  return crypto.createHash('sha256').update(derOf(certPem)).digest('hex');
}

function readOr(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Loads or creates the authority and a server certificate for exactly these
// names and addresses. Reuses the server certificate while the names match
// and it has more than a month left.
function ensure(dir, { hosts = [], ips = [], computerName = 'this computer' }) {
  fs.mkdirSync(dir, { recursive: true });
  const paths = {
    caKey: path.join(dir, 'ca.key'),
    caCert: path.join(dir, 'ca.pem'),
    key: path.join(dir, 'server.key'),
    cert: path.join(dir, 'server.pem'),
    meta: path.join(dir, 'server.json'),
  };
  let ca = { keyPem: readOr(paths.caKey), certPem: readOr(paths.caCert) };
  let caOk = false;
  try {
    if (ca.keyPem && ca.certPem) {
      const c = forge.pki.certificateFromPem(ca.certPem);
      forge.pki.privateKeyFromPem(ca.keyPem);
      caOk = c.validity.notAfter.getTime() - Date.now() > RENEW_BEFORE_DAYS * day;
    }
  } catch {}
  let caIsNew = false;
  if (!caOk) {
    ca = makeCa(computerName);
    fs.writeFileSync(paths.caKey, ca.keyPem, { mode: 0o600 });
    fs.writeFileSync(paths.caCert, ca.certPem);
    caIsNew = true;
  }
  const caFp = fingerprint(ca.certPem);
  const sans = [...new Set([...hosts, ...ips])].sort();
  let leaf = null;
  if (!caIsNew) {
    try {
      const meta = JSON.parse(readOr(paths.meta));
      const keyPem = readOr(paths.key);
      const certPem = readOr(paths.cert);
      if (
        keyPem && certPem && meta && meta.caFp === caFp &&
        JSON.stringify(meta.sans) === JSON.stringify(sans) &&
        meta.notAfter - Date.now() > RENEW_BEFORE_DAYS * day
      ) {
        forge.pki.certificateFromPem(certPem);
        leaf = { keyPem, certPem, notAfter: meta.notAfter };
      }
    } catch {}
  }
  let leafIsNew = false;
  if (!leaf) {
    leaf = makeLeaf(ca, { hosts, ips });
    fs.writeFileSync(paths.key, leaf.keyPem, { mode: 0o600 });
    fs.writeFileSync(paths.cert, leaf.certPem);
    fs.writeFileSync(paths.meta, JSON.stringify({ sans, notAfter: leaf.notAfter, caFp }));
    leafIsNew = true;
  }
  return {
    key: leaf.keyPem,
    cert: leaf.certPem,
    ca: ca.certPem,
    caDer: derOf(ca.certPem),
    caFingerprint: caFp,
    sans,
    notAfter: leaf.notAfter,
    caIsNew,
    leafIsNew,
  };
}

module.exports = { ensure, makeCa, makeLeaf, fingerprint, derOf, LEAF_DAYS };
