'use strict';

// The phone side of Shelf. Talks to the computer that served this page over
// its API, listens for changes over server-sent events, and keeps the same
// item semantics as the desktop app: taking something starts its linger
// countdown everywhere, removing it removes it everywhere.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'shelf.token';
const PREPARED_LIMIT = 400 * 1024 * 1024;
const PREFETCH_LIMIT = 80 * 1024 * 1024;
const SHARE_LIMIT = 200 * 1024 * 1024;

const canShareFiles = !!(window.isSecureContext && navigator.share && navigator.canShare);

let token = null;
let state = null;
let me = null;
let es = null;
let online = false;
let selecting = false;
let viewing = null;
let suppressClick = false;
let lastPairCheck = 0;
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
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
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
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function auth() {
  return token ? { authorization: 'Bearer ' + token } : {};
}

function withToken(path) {
  return `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token || '')}`;
}

async function api(path, { method = 'GET', body } = {}) {
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
    onUnpaired();
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
  if (msg) $('pair-msg').textContent = msg;
  $('pair-err').hidden = !err;
  $('pair-err').textContent = err || '';
}

async function pair(body) {
  $('app').hidden = true;
  $('pair').hidden = false;
  $('pair-busy').hidden = false;
  $('pair-form').hidden = true;
  $('pair-err').hidden = true;
  $('pair-msg').textContent = 'Connecting to your computer';
  try {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.error || 'That did not work');
    token = json.token;
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {}
    me = { paired: true, device: json.device, computer: json.computer };
    toast(`Connected to ${json.computer.name}`);
    enterApp();
  } catch (err) {
    showPair('Scan the QR code on your computer, or type the six-digit code shown under it.', err.message);
  }
}

function onUnpaired() {
  if (es) {
    es.close();
    es = null;
  }
  token = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  closeViewer(false);
  closeSheets();
  showPair('This phone is no longer on the shelf. Scan the QR code on your computer to connect again.');
}

async function boot() {
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {}
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const code = h.get('p');
  const handed = h.get('t');
  if (code || handed) history.replaceState(null, '', location.pathname);
  if (code) return pair({ code });
  if (handed) {
    // Came over from the plain address with this phone's existing token.
    token = handed;
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {}
  }
  if (!token) return showPair();
  let r = null;
  try {
    r = await fetch('/api/me', { headers: auth() }).then((x) => x.json());
  } catch {}
  if (!r) {
    showPair('Your computer is not answering. Make sure Shelf is open on it and that this phone is on the same Wi-Fi.');
    return;
  }
  if (!r.paired) return onUnpaired();
  me = r;
  enterApp();
}

// ---- live state ----

function enterApp() {
  $('pair').hidden = true;
  $('app').hidden = false;
  $('computer').textContent = me.computer.name;
  renderSettings();
  connect();
}

function setOnline(on) {
  online = on;
  $('dot').classList.toggle('on', on);
  const b = $('banner');
  b.hidden = on;
  if (!on) b.textContent = `Reconnecting to ${me ? me.computer.name : 'your computer'}`;
}

let lastBeat = 0;

function connect() {
  if (es) es.close();
  es = new EventSource(withToken('/api/events'));
  lastBeat = Date.now();
  es.addEventListener('state', (e) => {
    lastBeat = Date.now();
    setOnline(true);
    try {
      apply(JSON.parse(e.data));
    } catch {}
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
    apply(await api('/api/state'));
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
}

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
  node.addEventListener('pointercancel', cancel);
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
    if (canShareFiles && isMedia(it) && it.ready && it.size <= PREFETCH_LIMIT) prepare(it).catch(() => {});
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
  const shareable = canShareFiles && n > 0 && its.every((it) => it.kind === 'file' && it.ready);
  const save = $('sel-save');
  save.hidden = !canShareFiles;
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
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  for (const it of its) take(it.id);
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
  save.hidden = !(canShareFiles && it.kind === 'file' && it.ready);
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
  try {
    await navigator.clipboard.writeText(it.text || '');
    toast('Copied');
    take(it.id);
  } catch {
    toast('Select the text and copy it');
  }
});
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
    const q = `name=${encodeURIComponent(file.name)}&size=${file.size}&mtime=${file.lastModified || ''}`;
    xhr.open('PUT', `/api/upload?${q}`);
    xhr.setRequestHeader('authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $('upload-bar').style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 401) onUnpaired();
      else if (xhr.status !== 201) {
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
  const httpsPort = me.ports && me.ports.https;
  const text = $('secure-text');
  const steps = $('cert-steps');
  const btn = $('btn-secure');
  if (window.isSecureContext) {
    text.textContent = canShareFiles
      ? 'You are on the secure address: Save to Photos works with one tap, for many photos at once. If Safari still warns about the certificate when you open this page, install it once:'
      : 'You are on the secure address. If Safari still warns about the certificate when you open this page, install it once:';
    steps.hidden = false;
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
  const list = $('device-list');
  list.replaceChildren();
  for (const d of (state && state.devices) || []) {
    const li = el('li');
    const isMe = me.device && d.id === me.device.id;
    li.append(el('span', 'grow', d.name + (isMe ? ' (this phone)' : '')), el('span', 'sub', `last seen ${fmtWhen(d.lastSeen)}`));
    list.appendChild(li);
  }
  if (!list.children.length) list.appendChild(el('li', null, 'No phones yet'));
}

$('btn-settings').addEventListener('click', () => {
  renderSettings();
  $('sheet-settings').hidden = false;
});
$('btn-secure').addEventListener('click', () => {
  const httpsPort = me && me.ports && me.ports.https;
  if (!httpsPort || !token) return;
  // The token rides in the fragment: it never leaves the phone.
  location.href = `https://${location.hostname}:${httpsPort}/#t=${encodeURIComponent(token)}`;
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
$('btn-forget').addEventListener('click', () => {
  if (!confirm('Forget this phone? You will need to scan the QR code again to reconnect.')) return;
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
