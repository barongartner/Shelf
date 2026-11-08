'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell, clipboard, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');
const { Shelf } = require('../core/shelf');
const { Net, newCode, normalizeCode } = require('../core/net');
const files = require('../core/files');
const { extOf, kindOfName } = require('../core/httpu');

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

// The shelf is a popup drawn inside a slightly larger transparent window:
// PANEL is the part you see, MARGIN the clear band around it that holds the
// shadow, and the caret pointing at the tray icon lives in that band too.
const PANEL_W = 340;
const PANEL_H = 520;
const MARGIN = 12;
let placement = null; // { edge, caret } while docked to the tray icon, null once dragged away

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
    notifyPhone: s.notifyPhone ?? true,
    // A position saved by the old plain window is dropped once, so the popup
    // starts out docked to its icon.
    bounds: s.layout === 'popup' ? s.bounds || null : null,
    layout: 'popup',
    address: s.address || null,
    // Computers this one has been on a shelf with, so they can be dialed
    // again after a restart when discovery is blocked.
    knownPeers: Array.isArray(s.knownPeers) ? s.knownPeers : [],
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

// ---- notifications for things a phone sends ----

// A phone (through this computer or another one on the shelf) put something
// on the shelf. Things sent together, like a batch of photos from the share
// sheet, become one notification once nothing new has come for 2 seconds.
let phoneNew = [];
let phoneTimer = null;
let phoneNote = null;

function fromPhone(it) {
  const d = it.addedBy && shelf.items.get(it.addedBy);
  return !!d && d.kind === 'device';
}

function phoneArrived(it) {
  if (!settings.notifyPhone || !Notification.isSupported()) return;
  phoneNew.push(it);
  clearTimeout(phoneTimer);
  phoneTimer = setTimeout(notifyPhone, phoneNew.length >= 60 ? 0 : 2000);
}

function phoneNoteText(its) {
  const from = [...new Set(its.map((it) => it.addedByName).filter(Boolean))];
  const sender = from.length === 1 ? from[0] : 'your phone';
  const n = its.length;
  if (n === 1 && its[0].kind === 'text') return { title: `Text from ${sender}`, body: String(its[0].text || its[0].name).trim().slice(0, 200) };
  if (n === 1) return { title: its[0].name.slice(0, 80), body: `From ${sender}. Click to open the shelf.` };
  const kinds = its.map((it) => (it.kind === 'file' ? kindOfName(it.name) : it.kind));
  const noun = kinds.every((k) => k === 'image') ? 'photos' : kinds.every((k) => k === 'video') ? 'videos' : kinds.every((k) => k === 'image' || k === 'video') ? 'photos and videos' : its.every((it) => it.kind === 'file') ? 'files' : 'things';
  const names = its.slice(0, 3).map((it) => it.name.slice(0, 40)).join(', ');
  return { title: `${n} ${noun} from ${sender}`, body: `${names}${n > 3 ? `, and ${n - 3} more` : ''}. Click to open the shelf.` };
}

function notifyPhone() {
  const its = phoneNew.filter((it) => {
    const cur = shelf.items.get(it.id);
    return cur && !cur.removed;
  });
  phoneNew = [];
  if (!its.length) return;
  const { title, body } = phoneNoteText(its);
  phoneNote = new Notification({ title, body, icon: path.join(ASSETS, 'icon-256.png') });
  phoneNote.on('click', () => {
    placeIfUnmoved();
    reveal(false);
  });
  phoneNote.show();
}

// ---- startup ----

async function start() {
  if (isMac) app.dock?.hide();
  // Windows only shows notifications for the app id its Start menu
  // shortcut was installed with.
  if (process.platform === 'win32') app.setAppUserModelId('com.barongartner.shelf');
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
    known: settings.knownPeers || [],
    onPairRequest: askToPair,
    web: {
      webDir: WEB,
      version: app.getVersion(),
      thumb: thumbForWeb,
      lingerMs,
      certDir: path.join(DATA(), 'certs'),
      pushFile: path.join(DATA(), 'push.json'),
      shortcutFile: path.join(DATA(), 'Shelf.shortcut'),
    },
  });
  await net.start();

  shelf.on('change', pushState);
  shelf.on('dropped', (id) => icons.delete(id));
  shelf.on('arrived', (it) => {
    if (settings.popUp && win && !win.isVisible()) {
      placeIfUnmoved();
      reveal(true);
    }
    if (it && fromPhone(it)) phoneArrived(it);
  });
  net.on('peers', pushState);
  if (net.web) net.web.onOnline = pushState;
  net.on('known', (list) => {
    settings.knownPeers = Array.isArray(list) ? list : [];
    saveSettings();
  });
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

function windowSize(display) {
  const wa = display.workArea;
  const panelH = Math.max(300, Math.min(PANEL_H, wa.height - 2 * MARGIN - 16));
  return { width: PANEL_W + 2 * MARGIN, height: panelH + 2 * MARGIN };
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
  // Only the position is kept from last time; the size follows the screen.
  const saved = boundsOnScreen(settings.bounds) ? settings.bounds : null;
  win = new BrowserWindow({
    ...windowSize(saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()),
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.onTop,
    // A tool window on Windows: no taskbar button and no Alt+Tab entry,
    // like the system's own flyouts.
    type: isMac ? undefined : 'toolbar',
    title: 'Shelf',
    backgroundColor: '#00000000',
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
      reveal(false);
    }
    snapshotIfAsked();
  });
  const remember = () => {
    if (placing) return;
    settings.bounds = win.getBounds();
    saveSettings();
    setPlacement(null); // dragged away from the icon: no caret until it is moved back
  };
  win.on('moved', remember);
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

// Docks the window to the tray icon: flush against the taskbar (under the
// menu bar on a Mac), centred on the icon, with the caret pointing at it.
// The icon's bounds come from the click when there was one; Windows reports
// zeros for a hidden or just-created icon, and then the cursor is the best
// guess.
function placeNearTray(clickBounds) {
  if (!tray || !win) return false;
  let b = clickBounds && clickBounds.width ? clickBounds : null;
  if (!b) {
    try {
      b = tray.getBounds();
    } catch {}
  }
  if (process.env.SHELF_DEV && process.env.SHELF_DEV_TRAY) {
    // Dev aid: pretend the icon is at x,y[,w,h] to try every taskbar edge.
    const [x, y, w = 24, h = 24] = process.env.SHELF_DEV_TRAY.split(',').map(Number);
    b = { x, y, width: w, height: h };
  }
  if (!b || (!b.width && !b.height)) {
    const c = screen.getCursorScreenPoint();
    b = { x: c.x, y: c.y, width: 1, height: 1 };
  }
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const { bounds: db, workArea: wa } = display;
  const { width, height } = windowSize(display);
  // The taskbar is on whichever screen edge the icon is nearest to.
  let edge = 'top';
  if (!isMac) {
    const d = { top: cy - db.y, bottom: db.y + db.height - cy, left: cx - db.x, right: db.x + db.width - cx };
    edge = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a));
  }
  const horizontal = edge === 'top' || edge === 'bottom';
  let x;
  let y;
  if (horizontal) {
    x = Math.min(Math.max(cx - width / 2, wa.x + 8 - MARGIN), wa.x + wa.width - width + MARGIN - 8);
    y = edge === 'bottom' ? wa.y + wa.height - height : wa.y;
  } else {
    y = Math.min(Math.max(cy - height / 2, wa.y + 8 - MARGIN), wa.y + wa.height - height + MARGIN - 8);
    x = edge === 'left' ? wa.x : wa.x + wa.width - width;
  }
  x = Math.round(x);
  y = Math.round(y);
  // Where along that edge the caret sits, kept off the rounded corners.
  const along = horizontal ? cx - x : cy - y;
  const span = horizontal ? width : height;
  const caret = Math.round(Math.min(Math.max(along, MARGIN + 24), span - MARGIN - 24));
  placing = true;
  win.setBounds({ x, y, width, height });
  setTimeout(() => (placing = false), 300);
  setPlacement({ edge, caret });
  if (process.env.SHELF_DEV) console.log(`SHELF_PLACED ${JSON.stringify({ icon: b, edge, caret, x, y, width, height })}`);
  return true;
}

function setPlacement(p) {
  placement = p;
  if (win && !win.isDestroyed()) win.webContents.send('placement', p);
}

function placeIfUnmoved(clickBounds) {
  if (!settings.bounds) placeNearTray(clickBounds);
  else if (placement) setPlacement(null);
}

// Every show goes through here so the page can play its slide-in first.
function reveal(inactive) {
  if (!win.isVisible()) win.webContents.send('slide');
  if (inactive) win.showInactive();
  else win.show();
}

function showWindow(clickBounds) {
  if (!win) return;
  placeIfUnmoved(clickBounds);
  shownAt = Date.now();
  reveal(false);
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
  const online = new Set(net.web && typeof net.web.onlineDeviceIds === 'function' ? net.web.onlineDeviceIds() : []);
  return {
    self: { id: settings.id, name: settings.name },
    code: net.code,
    port: net.port,
    addresses: net.addresses.ips,
    version: app.getVersion(),
    placement,
    settings: {
      lingerMin: settings.lingerMin,
      onTop: settings.onTop,
      popUp: settings.popUp,
      notifyPhone: settings.notifyPhone,
      openAtLogin: opensAtLogin(),
    },
    items: shelf.visible().map((it) => {
      const l = shelf.local.get(it.id);
      const state = it.kind === 'text' ? 'ready' : l ? l.state : 'missing';
      if (state === 'ready' && !icons.has(it.id) && l) loadIcon(it, l.path);
      const by = shelf.items.get(it.addedBy);
      return {
        id: it.id,
        kind: it.kind,
        name: it.name,
        size: it.size,
        count: it.kind === 'folder' ? (it.files || []).length : undefined,
        text: it.kind === 'text' ? it.text : undefined,
        from: it.addedBy === settings.id ? null : it.addedByName,
        fromPhone: !!by && by.kind === 'device',
        // The file lives where it was dropped on this computer, not in the store.
        local: !!(l && l.path) && !files.isInside(l.path, shelf.storeDir),
        error: (l && l.error) || null,
        failed: !!(l && l.failed),
        addedAt: it.addedAt,
        expiresAt: it.expiresAt,
        state,
        got: l ? l.got : 0,
        icon: icons.get(it.id) || null,
      };
    }),
    peers: net.peerList(),
    nearby: net.nearbyList(),
    devices: shelf.devices().map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen || d.addedAt, addedAt: d.addedAt, online: online.has(d.id) })),
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
  if (!ms) return false;
  const it = shelf.items.get(id);
  const was = it && it.expiresAt;
  shelf.take(id, ms);
  const now = shelf.items.get(id);
  return !was && !!(now && now.expiresAt);
}

function lingerText() {
  const m = settings.lingerMin;
  return m === 60 ? '1 hour' : m > 60 && m % 60 === 0 ? `${m / 60} hours` : `${m} min`;
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

// action: { label, keep: id } puts a button on the toast.
function flash(msg, action) {
  if (win && !win.isDestroyed()) win.webContents.send('flash', msg, action || null);
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

// The clipboard module speaks MIME types (Electron 44 and later, modelled on
// the W3C clipboard): files copied in Explorer or the Finder arrive as a
// text/uri-list of file: URLs, an image as image/png, text as text/plain.
async function paste() {
  const items = await clipboard.read();
  const grab = async (type) => {
    const it = items.find((i) => i.types.includes(type));
    if (!it) return null;
    const v = await it.getType(type);
    return typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(await v.arrayBuffer());
  };
  const urls = (await grab('text/uri-list')) || (isMac ? await grab('electron application/osclipboard;format="public.file-url"') : null);
  if (urls) {
    const paths = [];
    for (const line of urls.toString('utf8').split(/\r?\n/)) {
      const u = line.trim();
      if (!u || u.startsWith('#') || !u.startsWith('file:')) continue;
      try {
        paths.push(fileURLToPath(u));
      } catch {}
    }
    if (paths.length) return addPaths(paths);
  }
  const png = await grab('image/png');
  if (png && png.length) {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' at ').replace(/:/g, '.');
    return shelf.addBuffer(`Pasted image ${stamp}.png`, png);
  }
  const text = await clipboard.readText();
  if (text && text.trim()) return shelf.addText(text);
  flash('Nothing to paste: copy a file, an image or some text first');
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
  // Electron does not say whether the drag was dropped or cancelled. On
  // Windows startDrag returns once it is over, so a release back over the
  // shelf is not a take. On the Mac it returns at once; a drop back onto the
  // shelf is caught by addPaths. Either way the toast makes a wrong countdown
  // one click to undo.
  let backOnShelf = false;
  if (!isMac && win && win.isVisible()) {
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    backOnShelf = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
  }
  if (!backOnShelf && take(id)) flash(`${it.name} leaves the shelf in ${lingerText()}.`, { label: 'Keep', keep: id });
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
  } else if (key === 'notifyPhone') {
    settings.notifyPhone = !!value;
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
  handle('retry', (id) => {
    if (typeof net.retry !== 'function') throw new Error('Retry is not available in this version');
    return net.retry(idOf(id));
  });
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
  handle('copy-text', async (id) => {
    const it = shelf.items.get(idOf(id));
    if (it && it.kind === 'text') {
      await clipboard.writeText(it.text);
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
    const { host, port } = parseAddress(text);
    return net.addAddress(host, port);
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
    return clipboard.writeText(url);
  });
  handle('phone-open', () => {
    const url = phoneUrl(true);
    if (!url) throw new Error('No network address yet');
    return shell.openExternal(url);
  });
  handle('device-remove', (id) => shelf.removeDevice(idOf(id)));
  handle('device-rename', (id, name) => shelf.renameDevice(idOf(id), String(name || '')));
}

// Takes "192.168.1.20", "mac.local:47474", "http://host:port/" or
// "[::1]:47474". An IPv6 host keeps its brackets, the way it is dialed.
function parseAddress(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('Type an IP address');
  let u = null;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s);
  } catch {}
  if (!u || !u.hostname) throw new Error(`"${s.slice(0, 60)}" is not an address. Type something like 192.168.1.20`);
  return { host: u.hostname, port: u.port ? Number(u.port) : undefined };
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
    template.push({ label: 'Copy Text', click: () => clipboard.writeText(it.text).then(() => take(id), () => flash('Could not copy the text')) });
  } else {
    template.push({ label: 'Open', enabled: ready, click: withPath((p) => shell.openPath(p)) });
    if (isMac) template.push({ label: 'Quick Look', enabled: ready, click: withPath((p) => win.previewFile(p)) });
    template.push({ label: revealLabel, enabled: ready, click: withPath((p) => shell.showItemInFolder(p)) });
  }
  template.push({ label: 'Save to Downloads', enabled: ready, click: () => saveToDownloads(id) });
  template.push({ type: 'separator' });
  const l = shelf.local.get(id);
  if (l && l.failed && typeof net.retry === 'function') template.push({ label: 'Retry', click: () => Promise.resolve(net.retry(id)).catch((err) => flash(err.message)) });
  if (it.expiresAt) template.push({ label: 'Keep on Shelf', click: () => shelf.keep(id) });
  template.push({ label: 'Remove from Shelf', click: () => shelf.remove(id) });
  return Menu.buildFromTemplate(template);
}
