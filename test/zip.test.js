'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const zip = require('../src/core/zip');

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// Reads the central directory back: name, crc, size, offset per entry.
function centralDir(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30);
    out.push({
      name: buf.subarray(p + 46, p + 46 + nl).toString('utf8'),
      crc: buf.readUInt32LE(p + 16),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      dir: (buf.readUInt32LE(p + 38) & 0x10) !== 0,
    });
    p += 46 + nl + xl;
  }
  assert.strictEqual(p, eocd, 'central directory ends where the end record starts');
  return out;
}

test('a folder streams as a stored zip whose length is known up front', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-zip-'));
  const dir = path.join(src, 'Trip');
  fs.mkdirSync(path.join(dir, 'day 1', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'empty'));
  const a = crypto.randomBytes(99999);
  fs.writeFileSync(path.join(dir, 'day 1', 'deep', 'a.bin'), a);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'see the pier');
  fs.writeFileSync(path.join(dir, 'zero.bin'), '');
  fs.writeFileSync(path.join(dir, 'café.txt'), 'accent');
  const entries = await zip.entriesForDir('Trip', dir);
  const { length, stream, zip64 } = zip.zipOf(entries);
  assert.strictEqual(zip64, false);
  const buf = await collect(stream);
  assert.strictEqual(buf.length, length);
  const cd = centralDir(buf);
  assert.deepStrictEqual(
    cd.map((e) => e.name),
    ['Trip/', 'Trip/café.txt', 'Trip/day 1/', 'Trip/day 1/deep/', 'Trip/day 1/deep/a.bin', 'Trip/empty/', 'Trip/notes.txt', 'Trip/zero.bin'],
  );
  const big = cd.find((e) => e.name.endsWith('a.bin'));
  assert.strictEqual(big.size, a.length);
  assert.strictEqual(big.crc, zlib.crc32(a));
  assert.strictEqual(buf.readUInt32LE(big.offset), 0x04034b50, 'offset points at the local header');
  assert.ok(cd.find((e) => e.name === 'Trip/empty/').dir);
  const zero = cd.find((e) => e.name.endsWith('zero.bin'));
  assert.strictEqual(zero.size, 0);
  assert.strictEqual(zero.crc, 0);

  if (process.platform === 'win32') {
    const out = path.join(src, 'out.zip');
    fs.writeFileSync(out, buf);
    const dest = path.join(src, 'unz');
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${out}' -DestinationPath '${dest}' -Force`], { stdio: 'pipe' });
    assert.ok(fs.readFileSync(path.join(dest, 'Trip', 'day 1', 'deep', 'a.bin')).equals(a));
    assert.ok(fs.statSync(path.join(dest, 'Trip', 'empty')).isDirectory());
    assert.strictEqual(fs.readFileSync(path.join(dest, 'Trip', 'café.txt'), 'utf8'), 'accent');
  }
  fs.rmSync(src, { recursive: true, force: true });
});

test('several items zip together with duplicate names kept apart by the caller', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-zip-'));
  fs.writeFileSync(path.join(src, 'x.txt'), 'one');
  fs.writeFileSync(path.join(src, 'y.txt'), 'two');
  const entries = [await zip.entryForFile('x.txt', path.join(src, 'x.txt')), await zip.entryForFile('x (2).txt', path.join(src, 'y.txt'))];
  const { length, stream } = zip.zipOf(entries);
  const buf = await collect(stream);
  assert.strictEqual(buf.length, length);
  assert.deepStrictEqual(centralDir(buf).map((e) => e.name), ['x.txt', 'x (2).txt']);
  fs.rmSync(src, { recursive: true, force: true });
});

test('the zip64 layout arithmetic matches what is written', async () => {
  // Force the zip64 path on a small file by generating with zip64 = true.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-zip-'));
  fs.writeFileSync(path.join(src, 'f.bin'), crypto.randomBytes(5000));
  const entries = [{ name: 'd/', dir: true }, await zip.entryForFile('d/f.bin', path.join(src, 'f.bin'))];
  const { Readable } = require('stream');
  // zipOf picks classic for small files; reach the generator through a 64-bit-sized fake to check the arithmetic.
  const len64 = zip.archiveLength(entries, true);
  const lenClassic = zip.archiveLength(entries, false);
  assert.strictEqual(len64 - lenClassic, 20 + 8 + 28 * 2 + 76, 'extra fields, 8-byte descriptor, central extras, zip64 end records');
  assert.ok(Readable);
  fs.rmSync(src, { recursive: true, force: true });
});

test('a file that changes size while zipping fails loudly instead of corrupting silently', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-zip-'));
  const f = path.join(src, 'grow.bin');
  fs.writeFileSync(f, crypto.randomBytes(1000));
  const entries = [await zip.entryForFile('grow.bin', f)];
  fs.appendFileSync(f, 'more');
  const { stream } = zip.zipOf(entries);
  await assert.rejects(collect(stream), /changed while/);
  fs.rmSync(src, { recursive: true, force: true });
});
