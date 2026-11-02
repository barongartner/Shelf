'use strict';

// The main process and the preload cannot run under node:test, so this is
// the next best thing: every method they call on an Electron module or on a
// window, tray or web contents has to be declared in the typings of the
// Electron version installed. Electron drops and renames APIs between major
// versions (44 replaced the whole clipboard module), and a call to a method
// that no longer exists only shows up as a toast at runtime otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OBJECTS = ['app', 'shell', 'dialog', 'nativeImage', 'screen', 'Menu', 'Tray', 'BrowserWindow', 'clipboard', 'ipcMain', 'ipcRenderer', 'contextBridge', 'webUtils', 'win', 'tray', 'webContents', 'sender', 'powerMonitor'];

function declaredMethods() {
  const dts = fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'electron.d.ts'), 'utf8');
  const names = new Set();
  for (const m of dts.matchAll(/^\s+(?:static\s+)?(\w+)\s*(?:<[^>]*>)?\(/gm)) names.add(m[1]);
  return names;
}

function calls(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  for (const o of OBJECTS) {
    for (const m of src.matchAll(new RegExp(`\\b${o}\\.(\\w+)\\(`, 'g'))) out.push({ object: o, method: m[1] });
  }
  return out;
}

test('every Electron method the app calls exists in the installed Electron', () => {
  const declared = declaredMethods();
  assert.ok(declared.has('writeText') && declared.has('showItemInFolder'), 'the typings were read');
  const missing = [];
  for (const file of ['src/main/main.js', 'src/preload.js']) {
    for (const c of calls(file)) if (!declared.has(c.method)) missing.push(`${file}: ${c.object}.${c.method}()`);
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'calls to methods the installed Electron does not declare');
});
