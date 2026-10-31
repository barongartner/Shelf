'use strict';

// Streams a stored (uncompressed) .zip of files already on disk. Photos and
// videos do not compress anyway, and storing lets the archive's exact length
// be known before the first byte goes out, so the phone shows real download
// progress. ZIP64 is used only when something passes the classic limits.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const LIMIT32 = 0xffffffff;

const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) : makeCrc32();

function makeCrc32() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf, prev = 0) => {
    let c = ~prev >>> 0;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
}

function dosDateTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime()) || d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xffff, time: time & 0xffff };
}

// entries: [{ name, path, size, mtime }] for files, [{ name: 'dir/', dir: true }] for folders.
function needsZip64(entries) {
  if (entries.length >= 0xffff) return true;
  if (entries.some((e) => !e.dir && e.size >= LIMIT32)) return true;
  return archiveLength(entries, false) >= LIMIT32;
}

function archiveLength(entries, zip64) {
  let n = 0;
  for (const e of entries) {
    const nl = Buffer.byteLength(e.name, 'utf8');
    const isDir = !!e.dir;
    n += 30 + nl + (zip64 && !isDir ? 20 : 0) + (isDir ? 0 : e.size + (zip64 ? 24 : 16));
    n += 46 + nl + (zip64 ? 28 : 0);
  }
  return n + 22 + (zip64 ? 76 : 0);
}

async function* generate(entries, zip64) {
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { date, time } = dosDateTime(e.mtime);
    const isDir = !!e.dir;
    const flags = isDir ? 0x0800 : 0x0808; // UTF-8 names; files use a data descriptor
    const extra = zip64 && !isDir ? 20 : 0;
    const local = Buffer.alloc(30 + name.length + extra);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(extra ? LIMIT32 : 0, 18);
    local.writeUInt32LE(extra ? LIMIT32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra, 28);
    name.copy(local, 30);
    if (extra) {
      const x = 30 + name.length;
      local.writeUInt16LE(0x0001, x);
      local.writeUInt16LE(16, x + 2);
      local.writeBigUInt64LE(0n, x + 4);
      local.writeBigUInt64LE(0n, x + 12);
    }
    yield local;
    let crc = 0;
    let size = 0;
    let descLen = 0;
    if (!isDir) {
      for await (const chunk of fs.createReadStream(e.path)) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        yield chunk;
      }
      if (size !== e.size) throw new Error(`${e.name} changed while it was being zipped`);
      descLen = zip64 ? 24 : 16;
      const desc = Buffer.alloc(descLen);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      if (zip64) {
        desc.writeBigUInt64LE(BigInt(size), 8);
        desc.writeBigUInt64LE(BigInt(size), 16);
      } else {
        desc.writeUInt32LE(size, 8);
        desc.writeUInt32LE(size, 12);
      }
      yield desc;
    }
    central.push({ name, flags, time, date, crc, size, offset, isDir });
    offset += local.length + size + descLen;
  }
  const cdStart = offset;
  for (const c of central) {
    const extraLen = zip64 ? 28 : 0;
    const b = Buffer.alloc(46 + c.name.length + extraLen);
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE(zip64 ? 45 : 20, 4);
    b.writeUInt16LE(zip64 ? 45 : 20, 6);
    b.writeUInt16LE(c.flags, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt16LE(c.time, 12);
    b.writeUInt16LE(c.date, 14);
    b.writeUInt32LE(c.crc >>> 0, 16);
    b.writeUInt32LE(zip64 ? LIMIT32 : c.size, 20);
    b.writeUInt32LE(zip64 ? LIMIT32 : c.size, 24);
    b.writeUInt16LE(c.name.length, 28);
    b.writeUInt16LE(extraLen, 30);
    b.writeUInt16LE(0, 32);
    b.writeUInt16LE(0, 34);
    b.writeUInt16LE(0, 36);
    b.writeUInt32LE(c.isDir ? 0x10 : 0, 38);
    b.writeUInt32LE(zip64 ? LIMIT32 : c.offset, 42);
    c.name.copy(b, 46);
    if (zip64) {
      const x = 46 + c.name.length;
      b.writeUInt16LE(0x0001, x);
      b.writeUInt16LE(24, x + 2);
      b.writeBigUInt64LE(BigInt(c.size), x + 4);
      b.writeBigUInt64LE(BigInt(c.size), x + 12);
      b.writeBigUInt64LE(BigInt(c.offset), x + 20);
    }
    yield b;
    offset += b.length;
  }
  const cdSize = offset - cdStart;
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(central.length), 24);
    z.writeBigUInt64LE(BigInt(central.length), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdStart), 48);
    yield z;
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeUInt32LE(0, 4);
    l.writeBigUInt64LE(BigInt(offset), 8);
    l.writeUInt32LE(1, 16);
    yield l;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(zip64 ? 0xffff : central.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : central.length, 10);
  end.writeUInt32LE(zip64 ? LIMIT32 : cdSize, 12);
  end.writeUInt32LE(zip64 ? LIMIT32 : cdStart, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

// Returns the archive's exact byte length and a stream that produces it.
function zipOf(entries) {
  const zip64 = needsZip64(entries);
  return { length: archiveLength(entries, zip64), zip64, stream: Readable.from(generate(entries, zip64)) };
}

// Walks a folder on disk into entries rooted at `root` ("Project/").
async function entriesForDir(root, dir) {
  const rootName = root.endsWith('/') ? root : root + '/';
  const out = [{ name: rootName, dir: true }];
  async function walk(abs, rel) {
    const list = await fs.promises.readdir(abs, { withFileTypes: true });
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}${e.name}`;
      if (e.isDirectory()) {
        out.push({ name: childRel + '/', dir: true });
        await walk(childAbs, childRel + '/');
      } else if (e.isFile()) {
        const st = await fs.promises.stat(childAbs);
        out.push({ name: childRel, path: childAbs, size: st.size, mtime: st.mtime });
      }
    }
  }
  await walk(dir, rootName);
  return out;
}

async function entryForFile(name, file) {
  const st = await fs.promises.stat(file);
  return { name, path: file, size: st.size, mtime: st.mtime };
}

module.exports = { zipOf, entriesForDir, entryForFile, archiveLength, needsZip64, crc32 };
