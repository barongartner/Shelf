'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Shelf } = require('../core/shelf');
const { Net, newCode, normalizeCode } = require('../core/net');
const files = require('../core/files');

const isMac = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', '..', 'assets');

// SHELF_PROFILE runs a separate copy with its own data, so two shelves can
// talk to each other on one computer while developing.
const profile = process.env.SHELF_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Shelf-${profile}`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

let win = null;
let tray = null;
let shelf = null;
let net = null;
let settings = null;
const icons = new Map(); // item id -> data URL
const DATA = () => app.getPath('userData');

// ---- settings ----

function defaultName() {
  if (isMac) {
    try {
      return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  return os.hostname().replace(/\.local$/, '');
}

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(path.join(DATA(), 'settings.json'), 'utf8'));
  } catch {}
  return {
    id: s.id || crypto.randomBytes(8).toString('hex'),
    name: s.name || defaultName() + (profile ? ` (${profile})` : ''),
    code: s.code || newCode(),
    lingerMin: s.lingerMin ?? 10,
    onTop: s.onTop ?? true,
    popUp: s.popUp ?? true,
    bounds: s.bounds || null,
  };
}

let saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    fs.writeFileSync(path.join(DATA(), 'settings.json'), JSON.stringify(settings, null, 2));
  }, 200);
}

// ---- startup ----

async function start() {
  if (isMac) app.dock?.hide();
  fs.mkdirSync(DATA(), { recursive: true });
  settings = loadSettings();
  saveSettings();

  const self = { id: settings.id, name: settings.name };
  shelf = new Shelf({ dataDir: DATA(), self });
  await shelf.load();
  net = new Net({ shelf, self, code: settings.code, onPairRequest: askToPair });
  await net.start();

  shelf.on('change', pushState);
  shelf.on('dropped', (id) => icons.delete(id));
  shelf.on('arrived', () => {
    if (settings.popUp && win && !win.isVisible()) win.showInactive();
  });
  net.on('peers', pushState);

  createWindow();
  createTray();
  ipc();

  for (const p of (process.env.SHELF_SEED || '').split(',').filter(Boolean)) await shelf.addPath(p);
}

app.on('window-all-closed', () => {});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !net) return;
  e.preventDefault();
  quitting = true;
  await Promise.race([Promise.all([shelf.saveNow(), net.stop()]), new Promise((r) => setTimeout(r, 1500))]);
  app.quit();
});

// ---- window ----

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 340;
  const height = Math.min(500, workArea.height - 80);
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + Math.round((workArea.height - height) / 2),
  };
}

function boundsOnScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x + 60 > w.x && b.x < w.x + w.width - 60 && b.y >= w.y - 10 && b.y < w.y + w.height - 40);
}

function createWindow() {
  const bounds = boundsOnScreen(settings.bounds) ? settings.bounds : defaultBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 260,
    minHeight: 220,
    show: false,
    frame: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.onTop,
    title: 'Shelf',
    backgroundColor: isMac ? '#00000000' : undefined,
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    icon: isMac ? undefined : path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  applyOnTop();
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    snapshotIfAsked();
  });
  const remember = () => {
    settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('show', updateTray);
  win.on('hide', updateTray);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function applyOnTop() {
  win.setAlwaysOnTop(settings.onTop, 'floating');
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible() && (win.isFocused() || settings.onTop)) win.hide();
  else showWindow();
}

// Dev aid: SHELF_SNAPSHOT=/path/to.png writes a screenshot of the window.
function snapshotIfAsked() {
  const out = process.env.SHELF_SNAPSHOT;
  if (!out) return;
  setTimeout(async () => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    if (process.env.SHELF_SNAPSHOT_SETTINGS) {
      win.webContents.send('open-settings');
      await new Promise((r) => setTimeout(r, 600));
      fs.writeFileSync(out.replace(/\.png$/, '-settings.png'), (await win.webContents.capturePage()).toPNG());
    }
    if (process.env.SHELF_SNAPSHOT_QUIT) app.quit();
  }, Number(process.env.SHELF_SNAPSHOT_DELAY || 2500));
}

// ---- tray ----

function createTray() {
  const img = isMac
    ? nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(ASSETS, 'tray-win.png'));
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Shelf');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  updateTray();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide Shelf' : 'Show Shelf', click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Keep Shelf on Top',
      type: 'checkbox',
      checked: settings.onTop,
      click: (m) => setSetting('onTop', m.checked),
    },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => setSetting('openAtLogin', m.checked),
    },
    {
      label: 'Settings…',
      click: () => {
        showWindow();
        win.webContents.send('open-settings');
      },
    },
    { type: 'separator' },
    { label: `Shelf ${app.getVersion()}`, enabled: false },
    { label: 'Quit Shelf', role: 'quit' },
  ]);
}

function updateTray() {
  if (!tray) return;
  const n = shelf.visible().length;
  if (isMac) tray.setTitle(n ? String(n) : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(n ? `Shelf — ${n} item${n === 1 ? '' : 's'}` : 'Shelf');
}

// ---- state for the window ----

let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
    updateTray();
  }, 60);
}

function snapshot() {
  return {
    self: { id: settings.id, name: settings.name },
    code: net.code,
    port: net.port,
    addresses: localAddresses(),
    version: app.getVersion(),
    settings: {
      lingerMin: settings.lingerMin,
      onTop: settings.onTop,
      popUp: settings.popUp,
      openAtLogin: app.getLoginItemSettings().openAtLogin,
    },
    items: shelf.visible().map((it) => {
      const l = shelf.local.get(it.id);
      const state = it.kind === 'text' ? 'ready' : l ? l.state : 'missing';
      if (state === 'ready' && !icons.has(it.id) && l) loadIcon(it, l.path);
      return {
        id: it.id,
        kind: it.kind,
        name: it.name,
        size: it.size,
        count: it.kind === 'folder' ? (it.files || []).length : undefined,
        text: it.kind === 'text' ? it.text : undefined,
        from: it.addedBy === settings.id ? null : it.addedByName,
        addedAt: it.addedAt,
        expiresAt: it.expiresAt,
        state,
        got: l ? l.got : 0,
        icon: icons.get(it.id) || null,
      };
    }),
    peers: net.peerList(),
    nearby: net.nearbyList(),
  };
}

// Quick Look / shell thumbnails: a preview for images and documents, the
// file or folder icon otherwise. app.getFileIcon is avoided on macOS because
// it crashes Electron 44 there.
async function loadIcon(it, p) {
  icons.set(it.id, null);
  try {
    let img = await nativeImage.createThumbnailFromPath(p, { width: 96, height: 96 }).catch(() => null);
    if ((!img || img.isEmpty()) && !isMac) img = await app.getFileIcon(p, { size: 'large' });
    if (img && !img.isEmpty()) {
      icons.set(it.id, img.toDataURL());
      pushState();
    }
  } catch {}
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---- actions ----

function readyPath(id) {
  const l = shelf.local.get(id);
  return l && l.state === 'ready' ? l.path : null;
}

function lingerMs() {
  return settings.lingerMin > 0 ? settings.lingerMin * 60 * 1000 : null;
}

function take(id) {
  const ms = lingerMs();
  if (ms) shelf.take(id, ms);
}

// A drop onto the shelf of something that came off the shelf is a drag that
// changed its mind: cancel the linger timer instead of adding a duplicate.
function itemForPath(p) {
  const abs = path.resolve(p);
  for (const dir of [shelf.storeDir, shelf.outboxDir]) {
    if (files.isInside(abs, dir) && abs !== path.resolve(dir)) {
      const first = path.relative(dir, abs).split(path.sep)[0];
      return first.split('-')[0];
    }
  }
  for (const [id, l] of shelf.local) if (l.path && path.resolve(l.path) === abs) return id;
  return null;
}

async function addPaths(paths) {
  const errors = [];
  for (const p of paths) {
    const own = itemForPath(p);
    if (own && shelf.items.get(own) && !shelf.items.get(own).removed) {
      shelf.keep(own);
      continue;
    }
    try {
      await shelf.addPath(p);
    } catch (err) {
      errors.push(`${path.basename(p)}: ${err.message}`);
    }
  }
  if (errors.length) flash(errors.join('\n'));
}

function flash(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('flash', msg);
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; await files.exists(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

async function saveToDownloads(id) {
  const it = shelf.items.get(id);
  if (!it) return;
  if (it.kind === 'text') {
    const dst = await uniquePath(app.getPath('downloads'), files.safeName(it.name.slice(0, 40)) + '.txt');
    await fs.promises.writeFile(dst, it.text);
    shell.showItemInFolder(dst);
  } else {
    const src = readyPath(id);
    if (!src) return flash(`${it.name} hasn't finished arriving yet`);
    const dst = await uniquePath(app.getPath('downloads'), files.safeName(it.name));
    await files.cloneCopy(src, dst);
    shell.showItemInFolder(dst);
  }
  take(id);
}

async function paste() {
  const formats = clipboard.availableFormats();
  if (isMac) {
    const url = clipboard.read('public.file-url');
    if (url && url.startsWith('file://')) return addPaths([decodeURIComponent(new URL(url).pathname)]);
  } else {
    const raw = clipboard.readBuffer('FileNameW');
    if (raw && raw.length) {
      const p = raw.toString('ucs2').replace(/\u0000+$/, '');
      if (p) return addPaths([p]);
    }
  }
  if (formats.some((f) => f.startsWith('image/'))) {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' at ').replace(/:/g, '.');
      return shelf.addBuffer(`Pasted image ${stamp}.png`, img.toPNG());
    }
  }
  const text = clipboard.readText();
  if (text && text.trim()) shelf.addText(text);
}

// Starts a native drag of an item's file. On macOS the drag is of an APFS
// clone in the outbox, so Finder moving it can't take the shelf's own copy (or
// the original you dropped). Windows drags the file itself.
function startDrag(sender, id) {
  const p = readyPath(id);
  const it = shelf.items.get(id);
  if (!p || !it) return;
  let dragPath = p;
  if (isMac) {
    dragPath = path.join(shelf.outboxDir, `${id}-${crypto.randomBytes(3).toString('hex')}`, path.basename(p));
    try {
      fs.mkdirSync(path.dirname(dragPath), { recursive: true });
      fs.cpSync(p, dragPath, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    } catch (err) {
      return flash(`Couldn't start the drag: ${err.message}`);
    }
  }
  const icon = icons.get(id) ? nativeImage.createFromDataURL(icons.get(id)).resize({ width: 48 }) : nativeImage.createFromPath(path.join(ASSETS, 'drag.png'));
  sender.startDrag({ file: dragPath, icon });
  take(id);
  setTimeout(() => {
    if (!fs.existsSync(p)) shelf.setLocal(id, { state: 'missing' });
  }, 1000);
}

async function askToPair({ name }) {
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Let It Join', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: `“${name}” wants to join your shelf`,
    detail: 'It will see everything on this shelf, and anything it adds will show up here.',
  });
  return response === 0;
}

function setSetting(key, value) {
  if (key === 'name') {
    const name = String(value).trim().slice(0, 60);
    if (!name) return;
    settings.name = name;
    net.setName(name);
  } else if (key === 'lingerMin') {
    settings.lingerMin = Math.max(0, Number(value) || 0);
  } else if (key === 'onTop') {
    settings.onTop = !!value;
    applyOnTop();
  } else if (key === 'popUp') {
    settings.popUp = !!value;
  } else if (key === 'openAtLogin') {
    app.setLoginItemSettings({ openAtLogin: !!value });
  }
  saveSettings();
  pushState();
}

function setCode(code) {
  settings.code = code;
  saveSettings();
  pushState();
}

function ipc() {
  const handle = (name, fn) =>
    ipcMain.handle(name, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

  handle('state', () => snapshot());
  handle('add-paths', (paths) => addPaths((paths || []).filter((p) => typeof p === 'string' && p)));
  handle('add-text', (text) => shelf.addText(text));
  handle('paste', () => paste());
  ipcMain.on('drag', (e, id) => startDrag(e.sender, id));
  handle('take', (id) => take(id));
  handle('keep', (id) => shelf.keep(id));
  handle('remove', (id) => shelf.remove(id));
  handle('clear-all', () => shelf.clearAll());
  handle('open', async (id) => {
    const p = readyPath(id);
    if (p) await shell.openPath(p);
  });
  handle('reveal', (id) => {
    const p = readyPath(id);
    if (p) shell.showItemInFolder(p);
  });
  handle('quick-look', (id) => {
    const p = readyPath(id);
    if (p && isMac) win.previewFile(p);
  });
  handle('save', (id) => saveToDownloads(id));
  handle('copy-text', (id) => {
    const it = shelf.items.get(id);
    if (it && it.kind === 'text') {
      clipboard.writeText(it.text);
      take(id);
    }
  });
  handle('context-menu', (id) => itemMenu(id).popup({ window: win }));

  handle('set-setting', (key, value) => setSetting(key, value));
  handle('join', async (nearbyId) => {
    const code = await net.requestJoin(nearbyId);
    setCode(code);
  });
  handle('join-code', (code) => {
    const norm = normalizeCode(code);
    if (norm.length !== 12) throw new Error('A shelf code is 12 letters and numbers');
    const pretty = `${norm.slice(0, 4)}-${norm.slice(4, 8)}-${norm.slice(8)}`;
    net.setCode(pretty);
    setCode(pretty);
  });
  handle('add-ip', async (text) => {
    const [host, port] = String(text).trim().split(':');
    if (!host) throw new Error('Type an IP address');
    return net.addAddress(host, port ? Number(port) : undefined);
  });
  handle('new-shelf', () => {
    const code = newCode();
    net.setCode(code);
    setCode(code);
  });
  handle('copy-code', () => clipboard.writeText(net.code));
  handle('hide', () => win.hide());
}

function itemMenu(id) {
  const it = shelf.items.get(id);
  if (!it) return Menu.buildFromTemplate([]);
  const ready = it.kind === 'text' || !!readyPath(id);
  const revealLabel = isMac ? 'Show in Finder' : 'Show in File Explorer';
  const template = [];
  if (it.kind === 'text') {
    template.push({ label: 'Copy Text', click: () => { clipboard.writeText(it.text); take(id); } });
  } else {
    template.push({ label: 'Open', enabled: ready, click: () => shell.openPath(readyPath(id)) });
    if (isMac) template.push({ label: 'Quick Look', enabled: ready, click: () => win.previewFile(readyPath(id)) });
    template.push({ label: revealLabel, enabled: ready, click: () => shell.showItemInFolder(readyPath(id)) });
  }
  template.push({ label: 'Save to Downloads', enabled: ready, click: () => saveToDownloads(id) });
  template.push({ type: 'separator' });
  if (it.expiresAt) template.push({ label: 'Keep on Shelf', click: () => shelf.keep(id) });
  template.push({ label: 'Remove from Shelf', click: () => shelf.remove(id) });
  return Menu.buildFromTemplate(template);
}
