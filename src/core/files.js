'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = { describe, safeJoin, cloneCopy, isInside, exists, safeName };
