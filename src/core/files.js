'use strict';

const fs = require('fs');
const path = require('path');

// A folder with more entries than this cannot go on the shelf: its manifest
// travels inside every sync.
const MAX_ENTRIES = 50000;

// Describes a dropped path as a shelf item: a single file, or a folder with a
// manifest of every regular file and directory inside it. Symlinks and special
// files are skipped so a folder can't pull in things outside itself.
async function describe(p) {
  const st = await fs.promises.lstat(p);
  const name = path.basename(p);
  if (st.isFile()) return { kind: 'file', name, size: st.size };
  if (!st.isDirectory()) throw new Error(`${name} is not a file or folder`);

  const files = [];
  const dirs = [];
  let size = 0;
  async function walk(abs, rel) {
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      if (files.length + dirs.length >= MAX_ENTRIES) throw new Error(`${name} has too many files for the shelf (over ${MAX_ENTRIES.toLocaleString()})`);
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        dirs.push(childRel);
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        const s = (await fs.promises.stat(childAbs)).size;
        files.push({ p: childRel, s });
        size += s;
      }
    }
  }
  await walk(p, '');
  return { kind: 'folder', name, size, files, dirs };
}

// Resolves a manifest-relative path inside base, refusing anything that would
// escape it (".." segments, absolute paths, drive letters).
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel === '') return base;
  const target = path.resolve(base, ...rel.split('/'));
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path escapes item');
  }
  return target;
}

// The file a folder item's manifest entry points at on this computer: the
// path as listed, or its cleaned-up form on a computer that downloaded the
// folder. Only entries in the manifest are served, and never through a link.
async function manifestFile(it, root, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (!(it.files || []).some((f) => f.p === rel)) return null;
  for (const candidate of [rel, safeRel(rel)]) {
    let file;
    try {
      file = safeJoin(root, candidate);
    } catch {
      return null;
    }
    try {
      const st = await fs.promises.lstat(file);
      if (st.isFile()) return file;
      if (st.isSymbolicLink()) return null;
    } catch {}
  }
  return null;
}

// Copy that clones on APFS (instant, no extra disk) and falls back to a real
// copy elsewhere. The copy is independent of the source either way.
async function cloneCopy(src, dst) {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.cp(src, dst, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    errorOnExist: false,
    force: true,
  });
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function safeName(name) {
  // Keeps names valid on both macOS and Windows.
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 200);
  return cleaned || 'item';
}

// Makes each segment of a manifest path valid here; a Mac file name can hold
// characters Windows won't accept.
function safeRel(rel) {
  return String(rel).split('/').map(safeName).join('/');
}

module.exports = { describe, safeJoin, manifestFile, safeRel, cloneCopy, isInside, exists, safeName, MAX_ENTRIES };
