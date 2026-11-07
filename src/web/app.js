'use strict';

// The phone side of Shelf. Talks to the computer that served this page over
// its API, listens for changes over server-sent events, and keeps the same
// item semantics as the desktop app: taking something starts its linger
// countdown everywhere, removing it removes it everywhere.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'shelf.token';
const LAST_KEY = 'shelf.last';
const HOME_KEY = 'shelf.homeHintDone';
const PREPARED_LIMIT = 400 * 1024 * 1024;
const PREFETCH_LIMIT = 80 * 1024 * 1024;
const SHARE_LIMIT = 200 * 1024 * 1024;

const canShareFiles = !!(window.isSecureContext && navigator.share && navigator.canShare);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
// Opened from the Home Screen icon: no browser around the page, and on iOS
// storage of its own, separate from Safari's.
const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
document.body.classList.toggle('standalone', standalone);
const PAIR_MSG = standalone
  ? 'On your computer, click the phone button at the top of the shelf and type the six-digit code shown under the QR code.'
  : 'Scan the QR code on your computer, or type the six-digit code shown under it.';

let token = null;
let state = null;
let me = null;
let es = null;
let online = false;
let lastSyncAt = 0;
let fromCache = false;
let cookieOk = false; // the computer's cookie signs requests on its own
let selecting = false;
let viewing = null;
let suppressClick = false;
let lastPairCheck = 0;
let pendingSave = null; // ids handed over from the plain address to save here
let pendingOpen = null; // ids a tapped notification asked to show
const selected = new Set();
const tiles = new Map(); // id -> { el, parts, key }
const rows = new Map();
const prepared = new Map(); // id -> File, for the share sheet
const queue = [];
let uploading = false;
let uploadTotal = 0;
let uploadDone = 0;

// ---- helpers ----

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svg(path, box = '0 0 16 16') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', box);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  s.appendChild(p);
  return s;
}

const ICON_PLAY = 'M4 2.5v11l9-5.5z';

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  do {
    n /= 1024;
    u++;
  } while (n >= 1024 && u < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

function fmtLeft(ms) {
  if (ms <= 0) return 'Leaving';
  const s = Math.ceil(ms / 1000);
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

function fmtWhen(t) {
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function ext(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  return m ? m[1] : '';
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function auth() {
  return token ? { authorization: 'Bearer ' + token } : {};
}

// Links the browser follows on its own (images, downloads, the event stream)
// carry the token only until the cookie is known to work, so it does not end
// up in download histories and file metadata.
function withToken(path) {
  if (cookieOk) return path;
  return `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token || '')}`;
}

async function probeCookie() {
  try {
    const r = await fetch('/api/me', { cache: 'no-store' }).then((x) => x.json());
    cookieOk = !!(r && r.paired);
  } catch {}
}

async function api(path, { method = 'GET', body } = {}) {
  const at = token;
  const r = await fetch(path, {
    method,
    headers: { ...auth(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  if (r.status === 401) {
    // Only a refusal of the token in use now means anything; a late answer
    // to a request made with an old one is just late.
    if (token === at) onUnpaired();
    throw new Error('Not connected');
  }
  if (!r.ok) throw new Error((json && json.error) || `Something went wrong (${r.status})`);
  return json;
}

function current(id) {
  return state && state.items.find((i) => i.id === id);
}

function isMedia(it) {
  return it.kind === 'file' && (it.type === 'image' || it.type === 'video');
}

function mediaIds() {
  return state ? state.items.filter(isMedia).map((i) => i.id) : [];
}

// ---- pairing ----

function showPair(msg, err) {
  $('app').hidden = true;
  $('pair').hidden = false;
  $('pair-busy').hidden = true;
  $('pair-form').hidden = false;
  $('pair-msg').textContent = msg || PAIR_MSG;
  $('pair-err').hidden = !err;
  $('pair-err').textContent = err || '';
}

// The pairing card with a spinner: the page is doing something that takes
// a moment, and a blank screen would look like it froze.
function showBusy(msg) {
  $('app').hidden = true;
  $('pair').hidden = false;
  $('pair-busy').hidden = false;
  $('pair-form').hidden = true;
  $('pair-err').hidden = true;
  $('pair-msg').textContent = msg;
}

function storeToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
  setManifestToken();
}

// The manifest link carries the token, so the Home Screen app iOS makes from
// this page opens signed in even though its storage is not Safari's.
function setManifestToken() {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = token ? `/manifest.webmanifest?t=${encodeURIComponent(token)}` : '/manifest.webmanifest';
}

// While the page is signed in, in a browser, its address carries a handoff
// code the computer honours for ten minutes. Whatever loads that address to
// make the Home Screen app, even with no cookies and no script of its own,
// gets a page and a manifest with the token in them. The code is renewed
// while the page is open; an old one in the history is just dead.
let handoffTimer = null;
let handoffUntil = 0;

async function refreshHandoff() {
  if (standalone || !token) return;
  clearTimeout(handoffTimer);
  if (handoffUntil - Date.now() > 90000) {
    handoffTimer = setTimeout(refreshHandoff, handoffUntil - Date.now() - 60000);
    return;
  }
  try {
    const r = await api('/api/handoff', { method: 'POST' });
    if (!token) return;
    handoffUntil = r.expiresAt;
    // The viewer keeps its own entry in the history; only the address changes.
    history.replaceState(history.state, '', `${location.pathname}?h=${encodeURIComponent(r.code)}`);
    handoffTimer = setTimeout(refreshHandoff, Math.max(30000, r.expiresAt - Date.now() - 60000));
  } catch {
    handoffTimer = setTimeout(refreshHandoff, 60000);
  }
}

async function pair(body) {
  showBusy('Connecting to your computer');
  try {
    // The token goes along when there is one: a phone already on the shelf
    // stays the same phone instead of becoming a second one.
    const r = await fetch('/api/pair', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.error || 'That did not work');
    storeToken(json.token);
    me = { ...json, paired: true, token: undefined };
    if (await moveToBetter(json)) return;
    toast(json.already ? `Already connected to ${json.computer.name}` : `Connected to ${json.computer.name}`);
    refreshHandoff();
    enterApp();
  } catch (err) {
    showPair(null, err.message);
  }
}

function onUnpaired() {
  if (es) {
    es.close();
    es = null;
  }
  storeToken(null);
  clearTimeout(handoffTimer);
  handoffUntil = 0;
  history.replaceState(history.state, '', location.pathname);
  state = null;
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {}
  closeViewer(false);
  closeSheets();
  showPair(
    standalone
      ? 'This phone is no longer on the shelf. On your computer, click the phone button and type the six-digit code here to connect again.'
      : 'This phone is no longer on the shelf. Scan the QR code on your computer to connect again.',
  );
}

// The shelf as it was the last time the computer answered, so opening the
// bookmark shows something at once and survives the computer being asleep.
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LAST_KEY));
    return c && c.state && c.me ? c : null;
  } catch {
    return null;
  }
}

let cacheTimer = null;
function saveCache() {
  if (!state || !me || fromCache) return;
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ at: lastSyncAt, state, me }));
    } catch {}
  }, 1500);
}

function timeoutSignal(ms) {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

async function boot() {
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {}
  // A pairing code or a token can arrive in the fragment (the QR code, or a
  // move between this computer's addresses) or in the query string (the
  // Home Screen app opens at the start_url its manifest was made with).
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const code = h.get('p') || q.get('p');
  const handed = h.get('t') || q.get('t');
  // A handoff code in the address (see refreshHandoff) signs this page in
  // when its storage is empty: a private tab, or the view the system opens
  // to make the Home Screen app.
  const hand = token ? null : q.get('h');
  // Photos the plain address was asked to save: they come up selected here
  // on the secure one, one tap from the share sheet.
  const toSave = (h.get('s') || '').split(',').filter((x) => /^[\w-]{1,64}$/.test(x));
  if (toSave.length) pendingSave = toSave;
  // Opened from a notification: the new things it was about.
  const fresh = (q.get('n') || '').split(',').filter((x) => /^[\w-]{1,64}$/.test(x));
  if (fresh.length) pendingOpen = fresh;
  if (location.search || location.hash) history.replaceState(history.state, '', location.pathname);
  if (code) {
    // A QR code scanned on a phone that is already connected: ask first. The
    // code still goes to the computer so it is used up, but the phone stays
    // the phone it is.
    let r = null;
    if (token) {
      try {
        r = await fetch('/api/me', { headers: auth(), cache: 'no-store', signal: timeoutSignal(8000) }).then((x) => x.json());
      } catch {}
    }
    if (!(r && r.paired)) return pair({ code });
    fetch('/api/pair', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => {});
    toast(`Already connected to ${r.computer.name}`);
  }
  if (handed) storeToken(handed);
  const cached = loadCache();
  const known = !!(token || cached);
  // Something on screen at once: the last shelf for a phone that has been
  // here, a spinner for one that has not (or for a token that just arrived
  // and is still to be checked). A computer that is off answers nothing for
  // a long while, and a blank page that long looks broken.
  if (cached || (token && !handed)) {
    me = (cached && cached.me) || { computer: { name: 'your computer' }, device: null };
    enterApp({ cached });
  } else showBusy('Connecting to your computer');
  // Ask the computer who this phone is. The cookie it set when the phone
  // paired answers even when the browser has emptied this page's storage.
  let r = null;
  try {
    r = await fetch(hand ? `/api/me?h=${encodeURIComponent(hand)}` : '/api/me', { headers: auth(), cache: 'no-store', signal: timeoutSignal(8000) }).then((x) => x.json());
  } catch {}
  if (r && r.paired) {
    if (r.token && r.token !== token) storeToken(r.token);
    me = { ...r, token: undefined };
    if (await moveToBetter(r)) return;
    setManifestToken();
    refreshHandoff();
    if (handed && !toSave.length) toast(`Connected to ${r.computer.name}`);
    if ($('app').hidden) return enterApp({ cached });
    if (selecting) updateSelbar();
    else $('computer').textContent = me.computer.name;
    renderSettings();
    return;
  }
  if (r && r.paired === false) {
    if (known) return onUnpaired();
    return showPair();
  }
  // The computer is not answering. A phone that was on the shelf keeps the
  // page and waits; the stream reconnects by itself when the computer is back.
  if (!known) return showPair('Your computer is not answering. Make sure Shelf is open on it and that this phone is on the same Wi-Fi.');
  if ($('app').hidden) {
    me = (cached && cached.me) || { computer: { name: 'your computer' }, device: null };
    enterApp({ cached });
  }
  setOnline(false);
}

// ---- live state ----

// On the secure address the page can keep itself, so the bookmark opens
// even while the computer is asleep; everything else always comes live.
function keepShell() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const v = (document.querySelector('script[src*="app.js"]') || {}).src || '';
  const m = /[?&]v=([^&]+)/.exec(v);
  navigator.serviceWorker.register(`/sw.js?v=${m ? m[1] : '0'}`).catch(() => {});
}

function enterApp({ cached = null } = {}) {
  $('pair').hidden = true;
  $('app').hidden = false;
  $('computer').textContent = me.computer.name;
  keepShell();
  if (cached && cached.state && !state) {
    fromCache = true;
    lastSyncAt = cached.at || 0;
    apply(cached.state);
  }
  renderSettings();
  connect();
  probeCookie();
  maybeShowHomeCard();
  syncPush();
}

let offlineSince = 0;

function setOnline(on) {
  const was = online;
  online = on;
  if (on) {
    offlineSince = 0;
    fallbackTo = null;
    fallbackTried.clear();
  } else if (!offlineSince) offlineSince = Date.now();
  $('dot').classList.toggle('on', on);
  const b = $('banner');
  b.hidden = on;
  if (!on) {
    const name = me ? me.computer.name : 'your computer';
    b.replaceChildren(lastSyncAt
      ? `Looking for ${name}. Showing the shelf as it was at ${fmtWhen(lastSyncAt)}.`
      : `Looking for ${name}`);
    if (fallbackTo) b.append(' ', peerLink(fallbackTo));
  }
  if (on && !was) {
    retryImages();
    refreshHandoff();
  }
}

// ---- the other computers ----

// A phone on the shelf is let in by every computer on it, so when this one
// stops answering the page can carry on through another. The token rides in
// the fragment, the same way the page moves between this computer's own
// addresses, so the phone stays the phone it is.
function knownPeers() {
  return (state && state.peers) || (me && me.peers) || [];
}

function peerBases(p) {
  const out = [];
  for (const h of [p.host, p.addr]) {
    if (!h || !p.port) continue;
    out.push(`http://${h.includes(':') ? `[${h}]` : h}:${p.port}/`);
  }
  return out;
}

function peerHref(base) {
  return `${base}#t=${encodeURIComponent(token || '')}`;
}

function peerLink(p) {
  const a = el('a', 'peer-link', `Open through ${p.name}`);
  a.href = peerHref(peerBases(p)[0]);
  a.addEventListener('click', async (e) => {
    // The name on the network can fail where the plain address works.
    e.preventDefault();
    const bases = peerBases(p);
    const ok = await Promise.all(bases.map(reachable));
    const i = ok.indexOf(true);
    if (i < 0) return toast(`${p.name} is not answering either.`);
    location.href = peerHref(bases[i]);
  });
  return a;
}

let fallbackTo = null;
let fallbackBusy = false;
const fallbackTried = new Set();

setInterval(async () => {
  if (online || !offlineSince || !token || fallbackBusy || fallbackTo) return;
  if (Date.now() - offlineSince < 15000) return;
  fallbackBusy = true;
  try {
    for (const p of knownPeers()) {
      for (const base of peerBases(p)) {
        if (fallbackTried.has(base)) continue;
        fallbackTried.add(base);
        if (!(await reachable(base)) || online) continue;
        // A browser tab just moves. The Home Screen app would open the other
        // address outside itself, so it offers the move instead.
        if (!standalone) return location.replace(peerHref(base));
        fallbackTo = p;
        setOnline(false);
        return;
      }
    }
  } finally {
    fallbackBusy = false;
  }
}, 5000);

// Thumbnails that failed while the computer was away load again now.
function retryImages() {
  for (const row of tiles.values()) {
    if (!row.key.src || row.el.classList.contains('loaded')) continue;
    row.parts.img.src = `${row.key.src}${row.key.src.includes('?') ? '&' : '?'}r=${Date.now()}`;
  }
}

let lastBeat = 0;

function connect() {
  if (es) es.close();
  es = new EventSource(withToken('/api/events'));
  lastBeat = Date.now();
  es.addEventListener('state', (e) => {
    lastBeat = Date.now();
    lastSyncAt = Date.now();
    fromCache = false;
    setOnline(true);
    try {
      apply(JSON.parse(e.data));
    } catch {}
    resumeSave();
    openNew();
  });
  es.addEventListener('ping', () => {
    lastBeat = Date.now();
    setOnline(true);
  });
  es.onerror = () => {
    setOnline(false);
    checkStillPaired();
  };
}

// iOS drops a background tab's stream without saying so and the browser
// never reconnects on its own, so the page watches the heartbeat itself.
setInterval(() => {
  if (!token || !es || document.visibilityState !== 'visible') return;
  if (Date.now() - lastBeat > 50000) {
    connect();
    refresh();
  }
}, 10000);

window.addEventListener('online', () => {
  if (!token) return;
  connect();
  refresh();
});

async function checkStillPaired() {
  const now = Date.now();
  if (now - lastPairCheck < 5000) return;
  lastPairCheck = now;
  try {
    const r = await fetch('/api/me', { headers: auth() }).then((x) => x.json());
    if (r && r.paired === false) onUnpaired();
  } catch {}
}

async function refresh() {
  try {
    const s = await api('/api/state');
    lastSyncAt = Date.now();
    fromCache = false;
    apply(s);
    setOnline(true);
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !token) return;
  connect();
  refresh();
});

function apply(s) {
  state = s;
  if (!selecting) $('computer').textContent = s.computer.name;
  if (me) me.computer = s.computer;
  render();
  if (viewing) renderViewer();
  if (!$('sheet-settings').hidden) renderSettings();
  saveCache();
}

// ---- home screen ----

function homeHintDone() {
  try {
    return localStorage.getItem(HOME_KEY) === '1';
  } catch {
    return true;
  }
}

function dismissHomeCard() {
  try {
    localStorage.setItem(HOME_KEY, '1');
  } catch {}
  $('home-card').hidden = true;
}

function maybeShowHomeCard() {
  $('home-card').hidden = standalone || homeHintDone();
}

function stableHost() {
  const h = me && me.hosts && me.hosts[0];
  if (!h || h === location.hostname.toLowerCase()) return null;
  return h;
}

function addSteps() {
  if (isIOS) return ['Tap the Share button at the bottom of Safari (the square with the arrow).', 'Scroll the sheet and tap Add to Home Screen, then Add.'];
  if (isAndroid) return ['Open the browser menu (the three dots).', 'Tap Add to Home screen, then Add.'];
  return ['Bookmark this page, or pin it in your browser.'];
}

// Whether another of this computer's addresses answers from this phone. A
// no-cors fetch says nothing about the answer, only that one came; a
// certificate the phone does not trust fails it, which is the point.
async function reachable(url) {
  try {
    await fetch(url + 'api/me', { mode: 'no-cors', cache: 'no-store', signal: timeoutSignal(3000) });
    return true;
  } catch {
    return false;
  }
}

// The address a Home Screen icon should hold: the computer's name on the
// network, which stays the same when its address changes, and secure when
// this phone trusts the computer's certificate. Only a step up from the
// current address is ever taken, never a step down.
async function betterAddress(info) {
  const host = info && info.hosts && info.hosts[0];
  const ports = (info && info.ports) || {};
  if (!host) return null;
  const onHost = location.hostname.toLowerCase() === host;
  const secure = location.protocol === 'https:';
  const tries = [];
  if (ports.https && !(onHost && secure)) tries.push(`https://${host}:${ports.https}/`);
  if (ports.http && !onHost && !secure) tries.push(`http://${host}:${ports.http}/`);
  if (!tries.length) return null;
  const ok = await Promise.all(tries.map(reachable));
  const i = ok.indexOf(true);
  return i < 0 ? null : tries[i];
}

// Moves the page to the better address, signed in: the token rides in the
// fragment, which never leaves the phone. The Home Screen app stays where
// it is; its address was fixed when it was added.
async function moveToBetter(info) {
  if (standalone || !token) return false;
  const url = await betterAddress(info);
  if (!url) return false;
  location.replace(`${url}#t=${encodeURIComponent(token)}`);
  return true;
}

async function goStable() {
  if (!token) return;
  const btn = $('btn-stable');
  btn.disabled = true;
  btn.textContent = 'Checking';
  const moved = await moveToBetter(me);
  btn.disabled = false;
  btn.textContent = 'Use the stable address';
  if (!moved) toast(`This phone cannot find ${stableHost() || 'the computer'} on this Wi-Fi right now. Add the icon at this address instead.`);
}

$('home-later').addEventListener('click', dismissHomeCard);
$('home-show').addEventListener('click', () => {
  dismissHomeCard();
  renderSettings();
  $('sheet-settings').hidden = false;
  setTimeout(() => $('home-section').scrollIntoView({ block: 'start', behavior: 'smooth' }), 100);
});
$('btn-stable').addEventListener('click', goStable);

// ---- rendering ----

function render() {
  const media = state.items.filter(isMedia);
  const others = state.items.filter((it) => !isMedia(it));
  syncKeyed($('grid'), tiles, media, buildTile, updateTile);
  syncKeyed($('list'), rows, others, buildRow, updateRow);
  $('empty').hidden = state.items.length > 0;
  for (const id of [...selected]) if (!current(id)) selected.delete(id);
  for (const id of [...prepared.keys()]) if (!current(id)) prepared.delete(id);
  updateSelbar();
}

function syncKeyed(container, map, items, build, update) {
  const ids = new Set(items.map((i) => i.id));
  for (const [id, row] of map) {
    if (!ids.has(id)) {
      row.el.remove();
      map.delete(id);
    }
  }
  items.forEach((it, index) => {
    let row = map.get(it.id);
    if (!row) {
      row = build(it);
      map.set(it.id, row);
    }
    update(row, it);
    if (container.children[index] !== row.el) container.insertBefore(row.el, container.children[index] || null);
  });
}

function buildTile(it) {
  const t = el('div', 'tile');
  t.dataset.id = it.id;
  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.draggable = false;
  img.addEventListener('load', () => t.classList.add('loaded'));
  img.addEventListener('error', () => t.classList.remove('loaded'));
  const glyph = el('div', 'tile-glyph');
  const badge = el('div', 'tile-badge');
  badge.appendChild(svg(ICON_PLAY));
  const leave = el('div', 'tile-leave');
  const prog = el('div', 'tile-progress');
  const bar = el('div', 'tile-bar');
  prog.appendChild(bar);
  const check = el('div', 'tile-check');
  t.append(img, glyph, badge, leave, prog, check);
  wireItem(t, it.id);
  return { el: t, parts: { img, glyph, badge, leave, prog, bar }, key: {} };
}

function updateTile(row, it) {
  const { parts, key } = row;
  const src = it.thumb ? withToken(`/t/${it.id}`) : '';
  if (key.src !== src) {
    key.src = src;
    row.el.classList.remove('loaded');
    if (src) parts.img.src = src;
    else parts.img.removeAttribute('src');
  }
  parts.glyph.textContent = (ext(it.name) || (it.type === 'video' ? 'video' : 'photo')).toUpperCase();
  parts.badge.hidden = it.type !== 'video';
  row.el.classList.toggle('selected', selected.has(it.id));
  row.el.classList.toggle('waiting', !it.ready);
  parts.prog.hidden = it.ready;
  parts.bar.style.width = it.progress != null ? `${Math.round(it.progress * 100)}%` : '0';
  parts.leave.hidden = !it.expiresAt;
  if (it.expiresAt) parts.leave.textContent = fmtLeft(it.expiresAt - Date.now());
  row.el.title = it.name;
}

function buildRow(it) {
  const li = el('li', 'row');
  li.dataset.id = it.id;
  const glyph = el('div', 'glyph');
  const info = el('div', 'row-info');
  const name = el('div', 'row-name');
  const meta = el('div', 'row-meta');
  const leave = el('span', 'leave');
  const metaText = el('span');
  meta.append(leave, metaText);
  const prog = el('div', 'row-prog');
  const bar = el('div');
  prog.appendChild(bar);
  info.append(name, meta, prog);
  const check = el('div', 'row-check');
  const chev = el('div', 'chev');
  li.append(glyph, info, check, chev);
  wireItem(li, it.id);
  return { el: li, parts: { glyph, name, metaText, leave, prog, bar }, key: {} };
}

function updateRow(row, it) {
  const { parts } = row;
  row.el.className = 'row kind-' + it.kind;
  if (selected.has(it.id)) row.el.classList.add('selected');
  parts.glyph.className = 'glyph' + (it.kind === 'folder' ? ' folder' : it.kind === 'text' ? ' text' : '');
  parts.glyph.textContent = it.kind === 'text' ? '“' : it.kind === 'folder' ? '' : ext(it.name).slice(0, 5);
  parts.name.textContent = it.kind === 'text' ? (it.text || '').trim().replace(/\s+/g, ' ').slice(0, 160) : it.name;
  parts.metaText.textContent = metaFor(it);
  parts.leave.textContent = it.expiresAt ? `Leaves in ${fmtLeft(it.expiresAt - Date.now())} · ` : '';
  parts.prog.hidden = it.ready;
  parts.bar.style.width = it.progress != null ? `${Math.round(it.progress * 100)}%` : '0';
}

function metaFor(it) {
  if (!it.ready) return it.progress != null ? `Arriving, ${Math.round(it.progress * 100)}%` : 'Arriving';
  const bits = [];
  if (it.kind === 'text') bits.push('Text');
  else if (it.kind === 'folder') bits.push(`${it.count} item${it.count === 1 ? '' : 's'}, ${fmtSize(it.size)}`);
  else bits.push(fmtSize(it.size));
  if (it.from) bits.push(`from ${it.from}`);
  return bits.join(' · ');
}

setInterval(() => {
  if (!state) return;
  for (const it of state.items) {
    if (!it.expiresAt) continue;
    const t = tiles.get(it.id);
    if (t) updateTile(t, it);
    const r = rows.get(it.id);
    if (r) updateRow(r, it);
  }
  if (viewing && current(viewing)?.expiresAt) renderViewerMeta(current(viewing));
}, 1000);

// ---- tap, long-press, selection ----

function wireItem(node, id) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX;
    sy = e.clientY;
    suppressClick = false;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      if (!selecting) enterSelect();
      toggleSelect(id);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 420);
  });
  node.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel();
  });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', () => {
    cancel();
    suppressClick = false;
  });
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
  node.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (selecting) toggleSelect(id);
    else openViewer(id);
  });
}

function enterSelect() {
  selecting = true;
  document.body.classList.add('selecting');
  $('dock').hidden = true;
  $('selbar').hidden = false;
  $('btn-select').textContent = 'Done';
  updateSelbar();
}

function exitSelect() {
  selecting = false;
  selected.clear();
  if (me) $('computer').textContent = me.computer.name;
  document.body.classList.remove('selecting');
  $('dock').hidden = false;
  $('selbar').hidden = true;
  $('btn-select').textContent = 'Select';
  for (const row of tiles.values()) row.el.classList.remove('selected');
  for (const row of rows.values()) row.el.classList.remove('selected');
  trimPrepared();
}

function toggleSelect(id) {
  const it = current(id);
  if (!it) return;
  if (selected.has(id)) selected.delete(id);
  else {
    selected.add(id);
    const selectedBytes = [...selected].map(current).filter(Boolean).reduce((n, x) => n + (x.size || 0), 0);
    if (canShareFiles && isMedia(it) && it.ready && it.size <= PREFETCH_LIMIT && selectedBytes <= SHARE_LIMIT) prepare(it).catch(() => {});
  }
  const t = tiles.get(id);
  if (t) t.el.classList.toggle('selected', selected.has(id));
  const r = rows.get(id);
  if (r) r.el.classList.toggle('selected', selected.has(id));
  updateSelbar();
}

function updateSelbar() {
  if (!selecting) return;
  const its = [...selected].map(current).filter(Boolean);
  const n = its.length;
  // The count lives in the header while selecting; the bar is for actions.
  $('computer').textContent = n ? `${n} selected` : 'Tap items to select them';
  const shareable = n > 0 && its.every((it) => it.kind === 'file' && it.ready) && (canShareFiles || its.every(isMedia));
  const save = $('sel-save');
  save.hidden = false;
  save.disabled = !shareable;
  if (!save.dataset.busy) save.textContent = shareLabel(its);
  $('sel-download').disabled = !its.some((it) => it.kind !== 'text' && it.ready) && !its.some((it) => it.kind === 'text');
  $('sel-remove').disabled = n === 0;
}

function shareLabel(its) {
  const n = its.length;
  if (!n) return 'Save';
  if (its.every((it) => it.type === 'image')) return n === 1 ? 'Save Photo' : `Save ${n} Photos`;
  if (its.every((it) => it.type === 'video')) return n === 1 ? 'Save Video' : `Save ${n} Videos`;
  return n === 1 ? 'Save' : `Save ${n}`;
}

$('btn-select').addEventListener('click', () => (selecting ? exitSelect() : enterSelect()));
$('sel-cancel').addEventListener('click', exitSelect);
$('sel-save').addEventListener('click', (e) => shareItems([...selected], e.currentTarget));
$('sel-download').addEventListener('click', () => downloadItems([...selected]));
$('sel-remove').addEventListener('click', () => removeItems([...selected]));

// ---- getting files out ----

async function prepare(it) {
  if (prepared.has(it.id)) return prepared.get(it.id);
  const r = await fetch(withToken(`/v/${it.id}`), { headers: auth() });
  if (!r.ok) throw new Error(`Couldn't load ${it.name}`);
  const blob = await r.blob();
  const file = new File([blob], it.name, { type: it.mime || blob.type || 'application/octet-stream', lastModified: it.addedAt });
  prepared.set(it.id, file);
  trimPrepared(it.id);
  return file;
}

function trimPrepared(keepId) {
  let total = 0;
  for (const f of prepared.values()) total += f.size;
  for (const [id, f] of prepared) {
    if (total <= PREPARED_LIMIT) break;
    if (id === keepId || selected.has(id) || id === viewing) continue;
    prepared.delete(id);
    total -= f.size;
  }
}

// Share-sheet save. iOS only lets the sheet open from a tap, so the files
// are fetched first; if that took too long, the button turns into "Save"
// and a second tap opens the sheet right away.
async function shareItems(ids, btn) {
  const its = ids.map(current).filter((it) => it && it.kind === 'file' && it.ready);
  if (!its.length) return toast('Nothing to save');
  if (!canShareFiles) return saveFromPlain(its, btn);
  // The share sheet holds every file in memory three times over; big
  // batches go to the Files app instead of crashing the tab.
  const total = its.reduce((n, it) => n + (it.size || 0), 0);
  if (total > SHARE_LIMIT) {
    toast('Too big for the share sheet, so it downloads to Files instead');
    return downloadItems(its.map((it) => it.id));
  }
  const label = shareLabel(its);
  const missing = its.filter((it) => !prepared.has(it.id));
  if (missing.length) {
    btn.disabled = true;
    btn.dataset.busy = '1';
    let n = 0;
    try {
      for (const it of missing) {
        btn.textContent = missing.length > 1 ? `Preparing ${++n} of ${missing.length}` : 'Preparing';
        await prepare(it);
      }
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      delete btn.dataset.busy;
      btn.textContent = label;
      return;
    }
    btn.disabled = false;
    delete btn.dataset.busy;
    btn.textContent = label;
  }
  const fileList = its.map((it) => prepared.get(it.id)).filter(Boolean);
  if (!navigator.canShare({ files: fileList })) return toast('This browser cannot save these files');
  try {
    await navigator.share({ files: fileList });
    for (const it of its) api(`/api/items/${it.id}/take`, { method: 'POST' }).catch(() => {});
    if (selecting) exitSelect();
  } catch (err) {
    if (!err || err.name === 'AbortError') return;
    if (err.name === 'NotAllowedError') toast(`Ready. Tap ${label} again.`);
    else toast(`Couldn't share: ${err.message}`);
  }
}

// The share sheet, and with it Save to Photos for many at once, only exists
// on the secure address. From the plain one: move there when this phone
// trusts the computer's certificate, otherwise say how to trust it, and
// meanwhile offer the photos one under the other to press and hold.
function secureAddresses() {
  const port = me && me.ports && me.ports.https;
  if (!port) return [];
  const hosts = [...((me && me.hosts) || []), location.hostname];
  return [...new Set(hosts.filter(Boolean).map((h) => `https://${h}:${port}/`))];
}

async function saveFromPlain(its, btn) {
  saveAsk = its.map((it) => it.id);
  const urls = secureAddresses();
  if (urls.length && token) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.dataset.busy = '1';
    btn.textContent = 'Checking';
    const ok = await Promise.all(urls.map(reachable));
    btn.disabled = false;
    delete btn.dataset.busy;
    btn.textContent = label;
    const i = ok.indexOf(true);
    if (i >= 0) return goSecure(urls[i], saveAsk);
  }
  openSaveSheet();
}

function goSecure(url, ids) {
  // The token and the ids ride in the fragment, which never leaves the phone.
  location.href = `${url}#t=${encodeURIComponent(token)}${ids && ids.length ? `&s=${ids.join(',')}` : ''}`;
}

let saveAsk = [];

function openSaveSheet() {
  const its = saveAsk.map(current).filter(Boolean);
  const photos = its.length && its.every((it) => it.type === 'image');
  const what = its.length === 1 ? (photos ? 'this photo' : 'this') : photos ? `these ${its.length} photos` : `these ${its.length}`;
  const hasSecure = secureAddresses().length > 0;
  $('save-title').textContent = its.length === 1 ? (photos ? 'Save to Photos' : 'Save') : `Save ${its.length} to Photos`;
  let text;
  if (!hasSecure) text = 'This computer has no secure address, so saving many at once is not available. Press and hold each photo instead.';
  else
    text = `iPhone only lets a page save a batch straight to Photos on a secure address, and this phone does not trust this computer yet. Set it up once (about a minute), and from then on Save puts ${what} in Photos with one tap:`;
  $('save-text').textContent = text;
  $('save-steps').hidden = !hasSecure;
  // Profiles only download from Safari, not from a Home Screen app.
  $('save-step1').textContent = standalone ? `Open ${location.host} in Safari, open Settings in Shelf, and download the certificate there. Tap ` : '';
  $('save-switch').hidden = !hasSecure;
  // Press and hold is fine for one photo, useless for a batch.
  $('save-hold').hidden = hasSecure && its.length > 1;
  $('save-hold').textContent = hasSecure ? 'Press and hold instead' : 'Show them to press and hold';
  $('sheet-save').hidden = false;
}

$('save-switch').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking';
  const urls = secureAddresses();
  const ok = await Promise.all(urls.map(reachable));
  btn.disabled = false;
  btn.textContent = 'I trusted it, save now';
  const i = ok.indexOf(true);
  if (i >= 0) return goSecure(urls[i], saveAsk);
  toast('Your phone does not trust the certificate yet. Check step 3.');
});
$('save-hold').addEventListener('click', () => {
  $('sheet-save').hidden = true;
  openHoldSave(saveAsk);
});
$('save-cancel').addEventListener('click', () => ($('sheet-save').hidden = true));
$('sheet-save').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('sheet-save').hidden = true;
});

// Every photo full size, one under the other: iPhone's press-and-hold menu
// has Save to Photos on an image even on the plain address. Videos have no
// such menu, so they download to Files, where Share has Save Video.
function openHoldSave(ids) {
  const its = ids.map(current).filter((it) => it && isMedia(it) && it.ready);
  if (!its.length) return;
  const list = $('hold-list');
  list.replaceChildren();
  for (const it of its) {
    const fig = el('figure', 'hold-item');
    if (it.type === 'image') {
      const img = el('img');
      img.src = withToken(`/v/${it.id}`);
      img.alt = it.name;
      img.addEventListener('contextmenu', () => take(it.id));
      fig.appendChild(img);
    } else {
      const v = el('video');
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.src = withToken(`/v/${it.id}`);
      if (it.thumb) v.poster = withToken(`/t/${it.id}`);
      const a = el('a', 'pill light', 'Download video');
      a.href = withToken(`/d/${it.id}`);
      a.download = it.name;
      a.addEventListener('click', () => take(it.id));
      fig.append(v, a);
    }
    fig.appendChild(el('figcaption', null, it.name));
    list.appendChild(fig);
  }
  const vids = its.some((it) => it.type === 'video');
  $('hold-hint').textContent = vids
    ? 'Press and hold a photo, then tap Save to Photos. Videos download to Files: open one there, tap Share, then Save Video.'
    : its.length === 1
      ? 'Press and hold the photo, then tap Save to Photos.'
      : 'Press and hold each photo, then tap Save to Photos.';
  $('holdsave').hidden = false;
  $('holdsave').scrollTop = 0;
  document.body.classList.add('noscroll');
  if (selecting) exitSelect();
}

$('hold-done').addEventListener('click', () => {
  $('holdsave').hidden = true;
  $('hold-list').replaceChildren();
  if (!viewing) document.body.classList.remove('noscroll');
});

// Arrived from the plain address with photos to save: select them and get
// them ready, so one tap on Save opens the share sheet.
function resumeSave() {
  if (!pendingSave || !state) return;
  const ids = pendingSave.filter((id) => current(id));
  pendingSave = null;
  if (!ids.length || !canShareFiles) return;
  closeViewer();
  if (!selecting) enterSelect();
  for (const id of ids) if (!selected.has(id)) toggleSelect(id);
  toast(`Secure address. Tap ${shareLabel(ids.map(current))} to put them in Photos.`);
}

// Opened from a notification: show what it was about. One thing opens in
// the viewer; several come up selected, so photos are one tap from Photos.
function openNew() {
  if (!pendingOpen || !state) return;
  const ids = pendingOpen.filter((id) => current(id));
  pendingOpen = null;
  if (!ids.length) return toast('That is not on the shelf any more.');
  closeSheets();
  closeViewer();
  if (ids.length === 1) return openViewer(ids[0]);
  if (selecting) exitSelect();
  enterSelect();
  for (const id of ids) toggleSelect(id);
  const its = ids.map(current);
  toast(canShareFiles && its.every(isMedia) ? `Tap ${shareLabel(its)} to put them in Photos.` : `${ids.length} new things, picked out.`);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type !== 'shelf-open' || !Array.isArray(m.ids)) return;
    pendingOpen = m.ids.filter((x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x));
    if (online) openNew();
  });
}

function take(id) {
  api(`/api/items/${id}/take`, { method: 'POST' }).catch(() => {});
}

function downloadItems(ids) {
  const its = ids.map(current).filter(Boolean);
  if (!its.length) return;
  let url;
  let name;
  const files = its.filter((it) => it.kind !== 'text' && it.ready);
  if (its.length === 1 && its[0].kind !== 'folder') {
    if (its[0].kind === 'file' && !its[0].ready) return toast(`${its[0].name} is still arriving`);
    url = withToken(`/d/${its[0].id}`);
    name = its[0].kind === 'text' ? 'Text.txt' : its[0].name;
  } else if (files.length) {
    url = withToken(`/api/zip?ids=${files.map((f) => f.id).join(',')}`);
    name = files.length === 1 ? `${files[0].name}.zip` : 'Shelf.zip';
  } else return toast('Nothing to download yet');
  const sent = its.length === 1 && its[0].kind !== 'folder' ? [its[0]] : files;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  for (const it of sent) take(it.id);
  if (selecting) exitSelect();
}

async function removeItems(ids) {
  const its = ids.map(current).filter(Boolean);
  if (!its.length) return;
  const what = its.length === 1 ? `"${its[0].name}"` : `${its.length} items`;
  if (!confirm(`Remove ${what} from the shelf on every computer?`)) return;
  for (const it of its) await api(`/api/items/${it.id}/remove`, { method: 'POST' }).catch((e) => toast(e.message));
  if (selecting) exitSelect();
  if (viewing && its.some((it) => it.id === viewing)) closeViewer();
}

// ---- viewer ----

function openViewer(id) {
  const it = current(id);
  if (!it) return;
  viewing = id;
  $('viewer').hidden = false;
  document.body.classList.add('noscroll');
  history.pushState({ viewer: id }, '');
  renderViewer();
  if (canShareFiles && isMedia(it) && it.ready && it.size <= PREFETCH_LIMIT) prepare(it).catch(() => {});
}

function closeViewer(pop = true) {
  if (!viewing) return;
  viewing = null;
  $('viewer').hidden = true;
  $('v-stage').replaceChildren();
  delete $('v-stage').dataset.key;
  document.body.classList.remove('noscroll');
  if (pop && history.state && history.state.viewer) history.back();
}

window.addEventListener('popstate', () => {
  if (viewing) closeViewer(false);
});

function renderViewerMeta(it) {
  const bits = [];
  if (it.kind === 'folder') bits.push(`${it.count} items, ${fmtSize(it.size)}`);
  else if (it.kind !== 'text') bits.push(fmtSize(it.size));
  if (it.from) bits.push(`from ${it.from}`);
  bits.push(fmtWhen(it.addedAt));
  if (it.expiresAt) bits.push(`leaves in ${fmtLeft(it.expiresAt - Date.now())}`);
  if (!it.ready) bits.push(it.progress != null ? `arriving ${Math.round(it.progress * 100)}%` : 'arriving');
  $('v-meta').textContent = bits.join(' · ');
  $('v-keep').hidden = !it.expiresAt;
}

function renderViewer() {
  const it = current(viewing);
  if (!it) return closeViewer();
  $('v-name').textContent = it.kind === 'text' ? 'Text' : it.name;
  renderViewerMeta(it);
  const stage = $('v-stage');
  const key = `${it.id}:${it.ready}:${it.kind}`;
  if (stage.dataset.key !== key) {
    stage.dataset.key = key;
    stage.replaceChildren();
    if (it.kind === 'text') {
      stage.appendChild(el('pre', 'text-view', it.text || ''));
    } else if (it.kind === 'file' && it.ready && it.type === 'image') {
      const img = el('img');
      img.alt = it.name;
      img.src = withToken(`/v/${it.id}`);
      img.addEventListener('error', () => {
        if (it.thumb && !img.dataset.fallback) {
          img.dataset.fallback = '1';
          img.src = withToken(`/t/${it.id}`);
        }
      });
      stage.appendChild(img);
    } else if (it.kind === 'file' && it.ready && it.type === 'video') {
      const v = el('video');
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.src = withToken(`/v/${it.id}`);
      if (it.thumb) v.poster = withToken(`/t/${it.id}`);
      stage.appendChild(v);
    } else if (it.kind === 'file' && it.ready && it.type === 'audio') {
      const card = el('div', 'file-card');
      card.append(el('div', 'glyph', ext(it.name)), el('div', 'name', it.name));
      const a = el('audio');
      a.controls = true;
      a.src = withToken(`/v/${it.id}`);
      a.style.marginTop = '16px';
      a.style.width = '100%';
      card.appendChild(a);
      stage.appendChild(card);
    } else {
      const card = el('div', 'file-card');
      const g = el('div', 'glyph' + (it.kind === 'folder' ? ' folder' : ''), it.kind === 'folder' ? '' : ext(it.name));
      card.append(g, el('div', 'name', it.name), el('div', 'meta', it.ready ? metaFor(it) : 'Still arriving on your computer'));
      if (it.kind === 'folder' && it.files && it.files.length) {
        const ul = el('ul', 'folder-list');
        for (const f of it.files.slice(0, 300)) {
          const li = el('li');
          const a = el('a', null, f.p);
          a.href = withToken(`/d/${it.id}?p=${encodeURIComponent(f.p)}`);
          a.download = f.p.split('/').pop();
          li.append(a, el('span', null, fmtSize(f.s)));
          ul.appendChild(li);
        }
        if (it.files.length > 300) ul.appendChild(el('li', null, `and ${it.files.length - 300} more`));
        card.appendChild(ul);
      }
      stage.appendChild(card);
    }
  }
  const save = $('v-save');
  save.hidden = !(it.kind === 'file' && it.ready && (canShareFiles || isMedia(it)));
  if (!save.dataset.busy) save.textContent = it.type === 'image' ? 'Save to Photos' : it.type === 'video' ? 'Save Video' : 'Save';
  $('v-hint').hidden = !(!canShareFiles && it.kind === 'file' && it.ready && it.type === 'image');
  $('v-download').hidden = it.kind === 'text';
  $('v-download').textContent = it.kind === 'folder' ? 'Download .zip' : 'Download';
  $('v-download').disabled = !it.ready;
  $('v-copy').hidden = it.kind !== 'text';
}

$('v-close').addEventListener('click', () => closeViewer());
$('v-save').addEventListener('click', (e) => viewing && shareItems([viewing], e.currentTarget));
$('v-download').addEventListener('click', () => viewing && downloadItems([viewing]));
$('v-copy').addEventListener('click', async () => {
  const it = current(viewing);
  if (!it) return;
  if (await copyText(it.text || '')) {
    toast('Copied');
    take(it.id);
  } else toast('Select the text and copy it');
});

// The clipboard API only exists on the secure address. On the plain one the
// old copy command still works, as long as it runs inside the tap itself,
// which is why it comes first there.
async function copyText(text) {
  if (!(navigator.clipboard && window.isSecureContext)) return copyBySelecting(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyBySelecting(text);
  }
}

function copyBySelecting(text) {
  const ta = el('textarea', 'copy-buffer');
  ta.value = text;
  ta.readOnly = true;
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  return ok;
}
$('v-keep').addEventListener('click', () => viewing && api(`/api/items/${viewing}/keep`, { method: 'POST' }).catch((e) => toast(e.message)));
$('v-remove').addEventListener('click', () => viewing && removeItems([viewing]));

// Swipe between photos and videos.
(() => {
  const stage = $('v-stage');
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!viewing || e.changedTouches.length !== 1 || Date.now() - t0 > 600) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 50) return;
    const ids = mediaIds();
    const i = ids.indexOf(viewing);
    if (i < 0) return;
    const next = ids[i + (dx < 0 ? 1 : -1)];
    if (next) {
      viewing = next;
      history.replaceState({ viewer: next }, '');
      renderViewer();
      const it = current(next);
      if (canShareFiles && it && isMedia(it) && it.ready && it.size <= PREFETCH_LIMIT) prepare(it).catch(() => {});
    }
  }, { passive: true });
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (viewing) closeViewer();
    else if (!$('sheet-text').hidden || !$('sheet-settings').hidden) closeSheets();
    else if (selecting) exitSelect();
  }
});

// ---- putting things on the shelf ----

function enqueue(fileList) {
  const list = [...fileList].filter((f) => f && f.size >= 0);
  if (!list.length) return;
  queue.push(...list);
  uploadTotal += list.length;
  pumpUploads();
}

async function pumpUploads() {
  if (uploading) return;
  uploading = true;
  $('uploads').hidden = false;
  while (queue.length) {
    if (!token) {
      queue.length = 0;
      break;
    }
    const f = queue.shift();
    uploadDone++;
    $('upload-title').textContent = uploadTotal > 1 ? `Sending ${uploadDone} of ${uploadTotal}` : 'Sending';
    $('upload-name').textContent = f.name;
    $('upload-bar').style.width = '0';
    await uploadOne(f);
  }
  uploading = false;
  uploadTotal = 0;
  uploadDone = 0;
  $('uploads').hidden = true;
}

function uploadOne(file) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const at = token;
    const q = `name=${encodeURIComponent(file.name)}&size=${file.size}&mtime=${file.lastModified || ''}`;
    xhr.open('PUT', `/api/upload?${q}`);
    xhr.setRequestHeader('authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $('upload-bar').style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        queue.length = 0;
        if (token === at) onUnpaired();
      } else if (xhr.status !== 201) {
        let msg = '';
        try {
          msg = JSON.parse(xhr.responseText).error;
        } catch {}
        toast(`Couldn't send ${file.name}${msg ? ': ' + msg : ''}`);
      }
      resolve();
    };
    xhr.onerror = () => {
      toast(`Couldn't send ${file.name}`);
      resolve();
    };
    // A slice rather than the File itself: some iOS 26 builds send a File
    // picked from Photos as an empty body.
    xhr.send(file.slice(0, file.size, file.type));
  });
}

$('pick-photos').addEventListener('change', (e) => {
  enqueue(e.target.files);
  e.target.value = '';
});
$('pick-files').addEventListener('change', (e) => {
  enqueue(e.target.files);
  e.target.value = '';
});

document.addEventListener('paste', (e) => {
  if (!token || !state) return;
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (typing) return;
  const files = [...(e.clipboardData.files || [])];
  if (files.length) {
    e.preventDefault();
    return enqueue(files);
  }
  const text = e.clipboardData.getData('text/plain');
  if (text && text.trim()) {
    e.preventDefault();
    api('/api/text', { method: 'POST', body: { text } }).then(() => toast('Added to the shelf')).catch((err) => toast(err.message));
  }
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!token || !state) return;
  if (e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
});

$('btn-text').addEventListener('click', () => {
  $('sheet-text').hidden = false;
  $('text-input').value = '';
  setTimeout(() => $('text-input').focus(), 50);
});
$('text-cancel').addEventListener('click', closeSheets);
$('text-add').addEventListener('click', async () => {
  const text = $('text-input').value;
  if (!text.trim()) return closeSheets();
  try {
    await api('/api/text', { method: 'POST', body: { text } });
    closeSheets();
    toast('Added to the shelf');
  } catch (err) {
    toast(err.message);
  }
});

// ---- settings ----

function closeSheets() {
  $('sheet-text').hidden = true;
  $('sheet-settings').hidden = true;
}

for (const id of ['sheet-text', 'sheet-settings']) {
  $(id).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSheets();
  });
}

function renderSettings() {
  if (!me) return;
  if (document.activeElement !== $('set-name')) $('set-name').value = me.device ? me.device.name : '';
  $('set-computer').textContent = me.computer.name;
  $('version').textContent = state ? `Shelf ${state.version} on ${me.computer.name}` : '';

  const host = stableHost();
  const onStable = !!(me.hosts && me.hosts.includes(location.hostname.toLowerCase()));
  const homeSteps = $('home-steps');
  homeSteps.replaceChildren();
  if (standalone) {
    $('home-text').textContent = 'Shelf is on your Home Screen. It opens from the icon signed in, shows the shelf as it was, and reconnects on its own.';
    $('btn-stable').hidden = true;
  } else {
    $('home-text').textContent = onStable
      ? `This page is at ${location.hostname}, a name that stays the same even when the computer's network address changes, so an icon added here keeps working. Add it to your Home Screen:`
      : host
        ? `An icon added at this address stops working if the computer's network address ever changes. Its name on the network, ${host}, does not change, so the page moves there when the phone can reach it:`
        : 'Add this page to your Home Screen so the shelf is one tap away:';
    $('btn-stable').hidden = !host || onStable;
    if (host && !onStable) homeSteps.appendChild(el('li', null, 'Tap Use the stable address below. The shelf opens again at the new address, already signed in.'));
    for (const s of addSteps()) homeSteps.appendChild(el('li', null, s));
    homeSteps.appendChild(el('li', null, window.isSecureContext
      ? 'That is it. The icon opens Shelf like an app, signed in, even while the computer is asleep: it shows the shelf as it was and reconnects on its own.'
      : 'That is it. The icon opens Shelf like an app, signed in, and it reconnects on its own. On this plain address it can only open while Shelf is running on the computer; the secure address below also opens while the computer is asleep.'));
  }

  const httpsPort = me.ports && me.ports.https;
  const text = $('secure-text');
  const steps = $('cert-steps');
  const btn = $('btn-secure');
  if (window.isSecureContext) {
    text.textContent = canShareFiles
      ? 'You are on the secure address: Save to Photos works with one tap, for many photos at once. If Safari still warns about the certificate when you open this page, install it once:'
      : 'You are on the secure address. If Safari still warns about the certificate when you open this page, install it once:';
    steps.hidden = standalone;
    btn.hidden = true;
  } else if (httpsPort && standalone) {
    // Profiles install from Safari, not from an app, and the app cannot
    // change its own address: the secure version is added from Safari.
    text.textContent = `Right now, open a photo and press and hold it to save it to Photos, one at a time. For one-tap saving of many photos, open ${location.host} in Safari, follow the steps under Save to Photos there, and add Shelf to the Home Screen again from the secure address.`;
    steps.hidden = true;
    btn.hidden = true;
  } else if (httpsPort) {
    text.textContent = 'Right now, open a photo and press and hold it to save it to Photos, one at a time. For one-tap saving of many photos, switch to the secure address: install this computer’s certificate once, trust it, then tap the button.';
    steps.hidden = false;
    btn.hidden = false;
  } else {
    text.textContent = 'Open a photo and press and hold it to save it to Photos. This computer has no secure address, so saving many at once is not available.';
    steps.hidden = true;
    btn.hidden = true;
  }
  renderPush();

  const list = $('device-list');
  list.replaceChildren();
  for (const d of (state && state.devices) || []) {
    const li = el('li');
    const isMe = me.device && d.id === me.device.id;
    const seen = d.online || (isMe && online) ? 'connected now' : `last seen ${fmtWhen(d.lastSeen)}`;
    li.append(el('span', 'grow', d.name + (isMe ? ' (this phone)' : '')), el('span', 'sub', seen));
    list.appendChild(li);
  }
  if (!list.children.length) list.appendChild(el('li', null, 'No phones yet'));

  $('set-linger').textContent = lingerText();

  const peers = knownPeers();
  const links = $('peer-links');
  links.replaceChildren();
  for (const p of peers) links.appendChild(peerLink(p));
  $('peer-section').hidden = !peers.length || !token;
}

// ---- notifications ----

// The computer sends a push when something new lands on the shelf. Push
// needs the secure address and, on iPhone, the Home Screen app.
const canPush = !!(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
let pushInfo = null; // { key, on, lastError, computer } from the computer
let pushSub = null; // this app's subscription, if it has one

function keyBytes(b64u) {
  const s = String(b64u).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(buf, b64u) {
  if (!buf || !b64u) return false;
  const a = new Uint8Array(buf);
  const b = keyBytes(b64u);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function swReady() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Shelf is still setting itself up on this phone. Try again in a moment.')), 8000)),
  ]);
}

// Run on every open: the computer learns the subscription again if it lost
// it, and a subscription made with an old key is replaced.
async function syncPush() {
  if (!canPush || !token || (isIOS && !standalone)) return renderPush();
  try {
    pushInfo = await api('/api/push');
  } catch {
    pushInfo = null;
    return renderPush();
  }
  try {
    const reg = await swReady();
    pushSub = await reg.pushManager.getSubscription();
    if (pushSub && Notification.permission === 'granted') {
      if (!sameKey(pushSub.options && pushSub.options.applicationServerKey, pushInfo.key)) {
        await pushSub.unsubscribe().catch(() => {});
        pushSub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushInfo.key) }).catch(() => null);
      }
      if (pushSub) pushInfo = { ...pushInfo, ...(await api('/api/push', { method: 'POST', body: { subscription: pushSub.toJSON() } })) };
    }
  } catch {}
  renderPush();
}

function renderPush() {
  const text = $('push-text');
  $('btn-push').hidden = true;
  $('btn-push-test').hidden = true;
  $('btn-push-off').hidden = true;
  const name = me ? me.computer.name : 'your computer';
  const sends = `${name} sends them, so it has to be on with Shelf running.`;
  if (!window.isSecureContext) {
    text.textContent = `Shelf can ping this phone when something new lands on the shelf, but only on the secure address${isIOS ? ' and from the Home Screen app' : ''}. Set up the secure address under Save to Photos first.`;
    return;
  }
  if (isIOS && !standalone) {
    text.textContent = 'On iPhone, only the Home Screen app can get notifications. Add Shelf to your Home Screen from this page (see Home Screen above), open it from the icon, and turn them on there.';
    return;
  }
  if (!canPush) {
    text.textContent = 'This browser cannot show notifications from a page.';
    return;
  }
  if (Notification.permission === 'denied') {
    text.textContent = 'Notifications are blocked for Shelf. Turn them on in Settings, Notifications, Shelf, then come back here.';
    return;
  }
  if (!pushInfo) {
    text.textContent = `${name} is not answering, so notifications cannot be set up right now.`;
    return;
  }
  if (pushSub && pushInfo.on && Notification.permission === 'granted') {
    let t = `On. You get a notification when something new lands on the shelf from another device. Tap it and Shelf opens with the new things picked out. ${sends}`;
    if (pushInfo.lastError) t += ` The last one did not go through: ${pushInfo.lastError}`;
    text.textContent = t;
    $('btn-push-test').hidden = false;
    $('btn-push-off').hidden = false;
    return;
  }
  text.textContent = `Get a notification when something new lands on the shelf. Tap it and Shelf opens with the new things picked out. ${sends}`;
  $('btn-push').hidden = false;
}

$('btn-push').addEventListener('click', async () => {
  const btn = $('btn-push');
  btn.disabled = true;
  try {
    // First, while the tap still counts: iOS only asks from a tap.
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Turn them on in Settings, Notifications, Shelf.' : 'Notifications were not allowed.');
    if (!pushInfo) pushInfo = await api('/api/push');
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options && sub.options.applicationServerKey, pushInfo.key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushInfo.key) });
    pushSub = sub;
    pushInfo = { ...pushInfo, ...(await api('/api/push', { method: 'POST', body: { subscription: sub.toJSON() } })) };
    toast('Notifications are on');
  } catch (err) {
    toast(err.message || 'Could not turn on notifications', 6000);
  }
  btn.disabled = false;
  renderPush();
});

$('btn-push-test').addEventListener('click', async () => {
  const btn = $('btn-push-test');
  btn.disabled = true;
  try {
    pushInfo = { ...pushInfo, ...(await api('/api/push/test', { method: 'POST', body: {} })) };
    toast('Sent. It should show up in a few seconds.');
  } catch (err) {
    toast(`It did not go through: ${err.message}`, 8000);
    try {
      pushInfo = await api('/api/push');
    } catch {}
  }
  btn.disabled = false;
  renderPush();
});

$('btn-push-off').addEventListener('click', async () => {
  const btn = $('btn-push-off');
  btn.disabled = true;
  try {
    const endpoint = pushSub ? pushSub.endpoint : null;
    if (pushSub) await pushSub.unsubscribe().catch(() => {});
    pushSub = null;
    pushInfo = { ...pushInfo, ...(await api('/api/push/off', { method: 'POST', body: { endpoint } })) };
    toast('Notifications are off');
  } catch (err) {
    toast(err.message, 6000);
  }
  btn.disabled = false;
  renderPush();
});

// How long something taken through this computer stays. Each computer has
// its own setting, so this only speaks for the one serving the page.
function lingerText() {
  const name = me.computer.name;
  if (!state || state.linger === undefined) return '';
  if (!state.linger) return `${name} keeps things on the shelf after they are taken until someone removes them. That is a setting on ${name}; each computer has its own.`;
  const min = Math.round(state.linger / 60000);
  const span = min >= 60 && min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minute${min === 1 ? '' : 's'}`;
  return `Once something is saved, downloaded or copied through ${name}, it stays on the shelf for ${span}, then leaves. That is a setting on ${name}; each computer has its own.`;
}

$('btn-settings').addEventListener('click', () => {
  renderSettings();
  $('sheet-settings').hidden = false;
});
$('btn-secure').addEventListener('click', () => {
  const httpsPort = me && me.ports && me.ports.https;
  if (!httpsPort || !token) return;
  goSecure(`https://${location.hostname}:${httpsPort}/`);
});
$('settings-done').addEventListener('click', closeSheets);
$('set-name').addEventListener('change', async (e) => {
  try {
    const r = await api('/api/me', { method: 'POST', body: { name: e.target.value } });
    me.device = r.device;
    toast('Renamed');
  } catch (err) {
    toast(err.message);
  }
});
$('btn-forget').addEventListener('click', async () => {
  if (!confirm(standalone ? 'Forget this phone? You will need a new code from your computer to reconnect.' : 'Forget this phone? You will need to scan the QR code again to reconnect.')) return;
  // Only the computer can end the session: it holds the cookie that would
  // sign the phone straight back in. So nothing is cleared here unless it
  // said yes.
  const btn = $('btn-forget');
  btn.disabled = true;
  let ok = false;
  try {
    const r = await fetch('/api/forget', { method: 'POST', headers: auth(), signal: timeoutSignal(8000) });
    ok = r.ok;
  } catch {}
  btn.disabled = false;
  if (!ok) {
    const name = me ? me.computer.name : 'Your computer';
    return toast(`${name} is not answering, so it still remembers this phone. Try again when it is awake, or remove the phone in the phone panel on a computer.`, 8000);
  }
  onUnpaired();
  closeSheets();
});

// ---- pairing form ----

$('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = $('pin').value.replace(/\D/g, '');
  if (pin.length !== 6) return showPair(null, 'Type all six digits.');
  pair({ pin });
});

$('pin').addEventListener('input', (e) => {
  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
  e.target.value = v;
  if (v.length === 6) pair({ pin: v });
});

boot();
