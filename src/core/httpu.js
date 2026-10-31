'use strict';

// Small HTTP helpers shared by the peer protocol (net.js) and the browser
// client (web.js): JSON bodies, file responses with Range support, and the
// file-type guesses the phone page needs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf', zip: 'application/zip',
  txt: 'text/plain', md: 'text/plain', csv: 'text/plain', json: 'text/plain', log: 'text/plain',
  // Active content is never served as itself: a stored page must not run on
  // the shelf's origin, where the phone's token lives.
  html: 'text/plain', htm: 'text/plain', svg: 'text/plain', xml: 'text/plain', xhtml: 'text/plain',
};

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function mimeFor(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

// image | video | audio | pdf | text | other
function kindOfName(name) {
  const m = mimeFor(name);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/plain') return 'text';
  return 'other';
}

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

// Reads a request body up to `limit` bytes. Past the limit it rejects with
// err.code === 'TOO_LARGE' without destroying the socket, so the caller can
// still answer 413.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        const err = new Error('too large');
        err.code = 'TOO_LARGE';
        reject(err);
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8') || 'null');
  } catch {
    return null;
  }
}

async function readJson(req, limit) {
  return parseJson(await readBody(req, limit));
}

// RFC 6266: an ASCII fallback plus the real UTF-8 name.
function contentDisposition(type, name) {
  const clean = String(name).replace(/[\r\n"\\]/g, '_');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// Streams a file with single-range support (video scrubbing, resumed
// downloads). `inline` previews in the browser; otherwise it downloads.
async function sendFile(req, res, file, { name, inline = false, mime, cache = 'private, no-cache' } = {}) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return send(res, 404, { error: 'gone' });
  }
  if (!st.isFile()) return send(res, 404, { error: 'not a file' });
  const total = st.size;
  let start = 0;
  let end = total - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    if (m[1] === '') start = Math.max(0, total - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
    }
    if (total === 0 || start > end || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    status = 206;
  }
  const headers = {
    'content-type': mime || (inline ? mimeFor(name || file) : 'application/octet-stream'),
    'content-length': total === 0 ? 0 : end - start + 1,
    'accept-ranges': 'bytes',
    'last-modified': st.mtime.toUTCString(),
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', name || path.basename(file)),
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || total === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

module.exports = { MIME, extOf, mimeFor, kindOfName, send, readBody, readJson, parseJson, contentDisposition, sendFile, safeEqual, sha256 };
