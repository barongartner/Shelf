'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');
const { Shelf } = require('../core/shelf');
const { Net, newCode, normalizeCode } = require('../core/net');
const files = require('../core/files');
const { extOf } = require('../core/httpu');

const isMac = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const WEB = path.join(__dirname, '..', 'web');

// SHELF_PROFILE runs a separate copy with its own data, so two shelves can
// talk to each other on one computer while developing.
const profile = process.env.SHELF_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Shelf-${profile}`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch((err) => {
    // Never leave a window-less process holding the single-instance lock.
    dialog.showErrorBox('Shelf could not start', String((err && err.stack) || err));
    app.exit(1);
  });
}

// The portable exe runs from a temp folder that is deleted on exit, so the
// login item must point at the exe the user actually keeps.
const loginItem = () => ({
  path: process.env.PORTABLE_EXECUTABLE_FILE || undefined,
  args: ['--hidden'],
});

let win = null;
let tray = null;
let shelf = null;
let net = null;
let settings = null;
let firstRun = false;
let placing = false;
let hiddenAt = 0;
let shownAt = 0;
let dialogOpen = false;
let thumbQueue = Promise.resolve();
let qrCache = null; // { text, data }
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
  const file = path.join(DATA(), 'settings.json');
  let s = null;
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
    s = JSON.parse(raw);
  } catch {}
  if (!s && raw) {
    // A half-written file must not cost this computer its identity.
    try {
      fs.copyFileSync(file, file + '.bad');
    } catch {}
    try {
      s = JSON.parse(fs.readFileSync(file + '.tmp', 'utf8'));
    } catch {}
  }
  firstRun = !s && !raw;
  s = s || {};
  return {
    id: s.id || crypto.randomBytes(8).toString('hex'),
    name: s.name || defaultName() + (profile ? ` (${profile})` : ''),
    code: s.code || newCode(),
    lingerMin: s.lingerMin ?? 10,
    onTop: s.onTop ?? true,
    popUp: s.popUp ?? true,
    bounds: s.bounds || null,
    address: s.address || null,
  };
}

let saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    const file = path.join(DATA(), 'settings.json');
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch {}
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
  net = new Net({
    shelf,
    self,
    code: settings.code,
    onPairRequest: askToPair,
    web: {
      webDir: WEB,
      version: app.getVersion(),
      thumb: thumbForWeb,
      lingerMs,
      certDir: path.join(DATA(), 'certs'),
    },
  });
  await net.start();

  shelf.on('change', pushState);
  shelf.on('dropped', (id) => icons.delete(id));
  shelf.on('arrived', () => {
    if (settings.popUp && win && !win.isVisible()) {
      placeIfUnmoved();
      win.showInactive();
    }
  });
  net.on('peers', pushState);
  net.on('addresses', () => {
    qrCache = null;
    pushState();
  });
  net.on('paired', (d) => {
    flash(`${d.name} is now on the shelf`);
    pushState();
  });

  createWindow();
  createTray();
  ipc();

  for (const p of (process.env.SHELF_SEED || '').split(',').filter(Boolean)) await shelf.addPath(p);

  // Dev aid: SHELF_DEV=1 prints a pairing link so the phone page can be
  // opened in a browser on this computer.
  if (process.env.SHELF_DEV) {
    net.web.newPair();
    console.log(`SHELF_PHONE_URL ${phoneUrl(true)}`);
    console.log(`SHELF_LOCAL_URL http://127.0.0.1:${net.port}/#p=${net.web.pairInfo().code}`);
    console.log(`SHELF_SECURE_URL https://127.0.0.1:${net.httpsPort}/`);
  }
}

app.on('window-all-closed', () => {});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !net) return;
  e.preventDefault();
  quitting = true;
  const deadline = setTimeout(() => app.exit(0), 1500);
  try {
    await Promise.all([shelf.saveNow(), net.stop()]);
  } catch {
    // A failed save must not keep the app alive.
  } finally {
    clearTimeout(deadline);
    app.quit();
  }
});

// ---- window ----

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 340;
  const height = Math.min(520, workArea.height - 80);
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

function openedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  if (isMac) {
    try {
      return !!app.getLoginItemSettings(loginItem()).wasOpenedAtLogin;
    } catch {}
  }
  return false;
}

function opensAtLogin() {
  try {
    return !!app.getLoginItemSettings(loginItem()).openAtLogin;
  } catch {
    return false;
  }
}

function createWindow() {
  const bounds = boundsOnScreen(settings.bounds) ? settings.bounds : defaultBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 280,
    minHeight: 240,
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
    if (firstRun || !openedAtLogin() || process.env.SHELF_SNAPSHOT) {
      placeIfUnmoved();
      win.show();
    }
    snapshotIfAsked();
  });
  const remember = () => {
    if (placing) return;
    settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('show', updateTray);
  win.on('hide', updateTray);
  win.on('blur', () => {
    // Without "keep on top" the shelf behaves like a menu: it goes away when
    // you click elsewhere. Pinned, it stays so you can drag files onto it.
    // Windows can fire a blur right after a tray click shows the window,
    // before it ever had focus; that one is ignored.
    if (!isMac && Date.now() - shownAt < 400) return;
    if (!settings.onTop && !dialogOpen && win.isVisible()) {
      win.hide();
      hiddenAt = Date.now();
    }
  });
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

// Puts the window next to the tray icon (above a bottom taskbar, under the
// menu bar) until the user drags it somewhere else. The icon's bounds come
// from the click when there was one; Windows reports zeros for a hidden or
// just-created icon, and then the cursor is the best guess.
function placeNearTray(clickBounds) {
  if (!tray || !win) return false;
  let b = clickBounds && clickBounds.width ? clickBounds : null;
  if (!b) {
    try {
      b = tray.getBounds();
    } catch {}
  }
  if (!b || (!b.width && !b.height)) {
    const c = screen.getCursorScreenPoint();
    b = { x: c.x, y: c.y, width: 1, height: 1 };
  }
  const display = screen.getDisplayNearestPoint({ x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) });
  const wa = display.workArea;
  const { width, height } = win.getBounds();
  let x = Math.round(b.x + b.width / 2 - width / 2);
  let y;
  if (isMac) y = wa.y + 6;
  else if (b.y >= wa.y + wa.height - 1) y = wa.y + wa.height - height - 10; // taskbar at the bottom
  else if (b.y + b.height <= wa.y + 1) y = wa.y + 10; // taskbar at the top
  else {
    y = Math.round(b.y + b.height / 2 - height / 2);
    x = b.x >= wa.x + wa.width - 1 ? wa.x + wa.width - width - 10 : wa.x + 10; // taskbar on a side
  }
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - width - 8);
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - height - 8);
  placing = true;
  win.setPosition(Math.round(x), Math.round(y));
  setTimeout(() => (placing = false), 300);
  return true;
}

function placeIfUnmoved(clickBounds) {
  if (!settings.bounds) placeNearTray(clickBounds);
}

function showWindow(clickBounds) {
  if (!win) return;
  placeIfUnmoved(clickBounds);
  shownAt = Date.now();
  win.show();
  win.focus();
}

function toggleWindow(_e, clickBounds) {
  // A click on the tray icon blurs the window first; don't reopen what that
  // click just closed.
  if (Date.now() - hiddenAt < 350) return;
  if (win.isVisible() && (win.isFocused() || settings.onTop)) win.hide();
  else showWindow(clickBounds);
}

// Dev aid: SHELF_SNAPSHOT=/path/to.png writes a screenshot of the window.
function snapshotIfAsked() {
  const out = process.env.SHELF_SNAPSHOT;
  if (!out) return;
  setTimeout(async () => {
    const shot = async (name) => fs.writeFileSync(name, (await win.webContents.capturePage()).toPNG());
    await shot(out);
    if (process.env.SHELF_SNAPSHOT_SETTINGS) {
      win.webContents.send('open-settings');
      await new Promise((r) => setTimeout(r, 600));
      await shot(out.replace(/\.png$/, '-settings.png'));
    }
    if (process.env.SHELF_SNAPSHOT_PHONE) {
      win.webContents.send('open-phone');
      await new Promise((r) => setTimeout(r, 2500));
      await shot(out.replace(/\.png$/, '-phone.png'));
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
  if (isMac) tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  updateTray();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide Shelf' : 'Show Shelf', click: () => toggleWindow() },
    {
      label: 'Connect a Phone…',
      click: () => {
        showWindow();
        win.webContents.send('open-phone');
      },
    },
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
      checked: opensAtLogin(),
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
  tray.setToolTip(n ? `Shelf: ${n} item${n === 1 ? '' : 's'}` : 'Shelf');
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

function phoneAddress() {
  const { ips, best } = net.addresses;
  if (settings.address && ips.includes(settings.address)) return settings.address;
  return best || ips[0] || null;
}

// The QR points at the plain http address: it opens with no certificate
// fuss, and the page itself offers the secure address for one-tap saving
// to Photos once the phone trusts this computer's certificate.
function phoneUrl(withCode) {
  const addr = phoneAddress();
  if (!addr) return null;
  const base = `http://${addr}:${net.port}/`;
  const pair = net.web.pairInfo();
  return withCode && pair ? `${base}#p=${pair.code}` : base;
}

function phoneSecureUrl() {
  const addr = phoneAddress();
  return addr && net.httpsPort ? `https://${addr}:${net.httpsPort}/` : null;
}

function ensureQr(text) {
  if (!text) return null;
  if (qrCache && qrCache.text === text) return qrCache.data;
  if (qrCache && qrCache.text === text + ':pending') return null;
  qrCache = { text: text + ':pending', data: null };
  QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 280, color: { dark: '#111111', light: '#ffffff' } })
    .then((data) => {
      qrCache = { text, data };
      pushState();
    })
    .catch(() => {
      qrCache = null;
    });
  return null;
}

function snapshot() {
  const pair = net.web ? net.web.pairInfo() : null;
  // No live code, no QR: a code-less link would pair nobody.
  const url = pair ? phoneUrl(true) : null;
  return {
    self: { id: settings.id, name: settings.name },
    code: net.code,
    port: net.port,
    addresses: net.addresses.ips,
    version: app.getVersion(),
    settings: {
      lingerMin: settings.lingerMin,
      onTop: settings.onTop,
      popUp: settings.popUp,
      openAtLogin: opensAtLogin(),
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
    devices: shelf.devices().map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen || d.addedAt, addedAt: d.addedAt })),
    phone: {
      url,
      base: phoneUrl(false),
      stable: (() => {
        const h = net.addresses.hosts.find((x) => x.endsWith('.local'));
        return h ? `http://${h}:${net.port}/` : null;
      })(),
      secureBase: phoneSecureUrl(),
      qr: ensureQr(url),
      pin: pair ? pair.pin : null,
      expiresAt: pair ? pair.expiresAt : null,
      address: phoneAddress(),
      addresses: net.addresses.ips,
      secure: !!net.httpsPort,
      httpsError: net.httpsError ? String(net.httpsError.message || net.httpsError) : null,
    },
  };
}

// Quick Look / shell thumbnails: a preview for images and documents, the
// file or folder icon otherwise. app.getFileIcon is avoided on macOS because
// it crashes Electron 44 there.
// On Windows thumbnail extraction blocks the main thread while it runs, so
// requests go one at a time instead of all at once when a folder of photos
// lands.
function thumbnail(p, size) {
  const run = thumbQueue.then(() => nativeImage.createThumbnailFromPath(p, { width: size, height: size })).catch(() => null);
  thumbQueue = run.then(() => {}, () => {});
  return run;
}

async function loadIcon(it, p) {
  icons.set(it.id, null);
  try {
    let img = await thumbnail(p, 96);
    if ((!img || img.isEmpty()) && !isMac) img = await app.getFileIcon(p, { size: 'large' });
    if (img && !img.isEmpty()) {
      icons.set(it.id, img.toDataURL());
      pushState();
    }
  } catch {}
}

// Bigger previews for the phone page. PNG keeps transparency; everything
// else goes out as JPEG.
async function thumbForWeb(it, p) {
  const img = await thumbnail(p, 512);
  if (!img || img.isEmpty()) return null;
  const e = extOf(it.name);
  if (e === 'png' || e === 'gif' || e === 'webp') return { buf: img.toPNG(), type: 'image/png' };
  return { buf: img.toJPEG(82), type: 'image/jpeg' };
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

async function askToPair({ name, addr, signal }) {
  showWindow();
  dialogOpen = true;
  try {
    // "Not Now" is the default so a stray Enter cannot let a stranger in.
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Let It Join', 'Not Now'],
      defaultId: 1,
      cancelId: 1,
      signal,
      message: `“${name}” wants to join your shelf`,
      detail: `It is at ${addr}. It will see everything on this shelf, and anything it adds will show up here.`,
    });
    return response === 0 && !(signal && signal.aborted);
  } finally {
    dialogOpen = false;
  }
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
    app.setLoginItemSettings({ openAtLogin: !!value, ...loginItem() });
  } else if (key === 'address') {
    settings.address = value ? String(value) : null;
    qrCache = null;
  } else if (key === 'resetPosition') {
    settings.bounds = null;
    placeNearTray();
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

  const idOf = (id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{16,64}$/.test(id)) throw new Error('bad id');
    return id;
  };

  handle('state', () => snapshot());
  // The renderer's questions come through here so the blur-to-hide rule
  // knows a dialog is up and leaves the window alone.
  handle('confirm', async (message, detail) => {
    dialogOpen = true;
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['OK', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: String(message || '').slice(0, 200),
        detail: detail ? String(detail).slice(0, 400) : undefined,
      });
      return response === 0;
    } finally {
      dialogOpen = false;
    }
  });
  handle('add-paths', (paths) => addPaths((Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p)));
  handle('add-text', (text) => shelf.addText(String(text || '')));
  handle('paste', () => paste());
  ipcMain.on('drag', (e, id) => {
    if (typeof id === 'string' && /^[a-f0-9]{16,64}$/.test(id)) startDrag(e.sender, id);
  });
  handle('take', (id) => take(idOf(id)));
  handle('keep', (id) => shelf.keep(idOf(id)));
  handle('remove', (id) => shelf.remove(idOf(id)));
  handle('clear-all', () => shelf.clearAll());
  handle('open', async (id) => {
    const p = readyPath(idOf(id));
    if (p) await shell.openPath(p);
  });
  handle('reveal', (id) => {
    const p = readyPath(idOf(id));
    if (p) shell.showItemInFolder(p);
  });
  handle('quick-look', (id) => {
    const p = readyPath(idOf(id));
    if (p && isMac) win.previewFile(p);
  });
  handle('save', (id) => saveToDownloads(idOf(id)));
  handle('copy-text', (id) => {
    const it = shelf.items.get(idOf(id));
    if (it && it.kind === 'text') {
      clipboard.writeText(it.text);
      take(id);
    }
  });
  handle('context-menu', (id) => itemMenu(idOf(id)).popup({ window: win }));

  handle('set-setting', (key, value) => setSetting(String(key), value));
  handle('join', async (nearbyId) => {
    const code = await net.requestJoin(String(nearbyId));
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
    // A new shelf starts empty: the old items stay with the computers that
    // keep the old code.
    shelf.forgetAll();
    const code = newCode();
    net.setCode(code);
    setCode(code);
  });
  handle('copy-code', () => clipboard.writeText(net.code));
  handle('hide', () => win.hide());

  // phones
  handle('phone-refresh', () => {
    net.web.newPair();
    qrCache = null;
    pushState();
    return snapshot().phone;
  });
  handle('phone-copy-url', () => {
    const url = phoneUrl(true);
    if (!url) throw new Error('No network address yet');
    clipboard.writeText(url);
  });
  handle('phone-open', () => {
    const url = phoneUrl(true);
    if (!url) throw new Error('No network address yet');
    return shell.openExternal(url);
  });
  handle('device-remove', (id) => shelf.removeDevice(idOf(id)));
  handle('device-rename', (id, name) => shelf.renameDevice(idOf(id), String(name || '')));
}

function itemMenu(id) {
  const it = shelf.items.get(id);
  if (!it) return Menu.buildFromTemplate([]);
  const ready = it.kind === 'text' || !!readyPath(id);
  const revealLabel = isMac ? 'Show in Finder' : 'Show in File Explorer';
  // The item can leave the shelf while the menu is open; look again on click.
  const withPath = (fn) => () => {
    const p = readyPath(id);
    if (p) fn(p);
    else flash('That item is no longer on the shelf');
  };
  const template = [];
  if (it.kind === 'text') {
    template.push({ label: 'Copy Text', click: () => { clipboard.writeText(it.text); take(id); } });
  } else {
    template.push({ label: 'Open', enabled: ready, click: withPath((p) => shell.openPath(p)) });
    if (isMac) template.push({ label: 'Quick Look', enabled: ready, click: withPath((p) => win.previewFile(p)) });
    template.push({ label: revealLabel, enabled: ready, click: withPath((p) => shell.showItemInFolder(p)) });
  }
  template.push({ label: 'Save to Downloads', enabled: ready, click: () => saveToDownloads(id) });
  template.push({ type: 'separator' });
  if (it.expiresAt) template.push({ label: 'Keep on Shelf', click: () => shelf.keep(id) });
  template.push({ label: 'Remove from Shelf', click: () => shelf.remove(id) });
  return Menu.buildFromTemplate(template);
}
