'use strict';

const api = window.shelf;
const $ = (id) => document.getElementById(id);
const isMac = api.platform === 'darwin';
const thisComputer = isMac ? 'This Mac' : 'This PC';

let state = null;
let selected = null;
let internalDrag = null; // id of a text item being dragged from the shelf
const rows = new Map(); // id -> { el, parts }
const seenIds = new Set();
let firstRender = true;

document.body.classList.toggle('mac', isMac);

// ---- helpers ----

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svg(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  s.appendChild(p);
  return s;
}

const ICON_SAVE = 'M7.25 2h1.5v6.6l2.2-2.2 1.06 1.06L8 11.47 3.99 7.46l1.06-1.06 2.2 2.2zM3 12.5h10V14H3z';
const ICON_COPY = 'M5 2h7a1 1 0 0 1 1 1v8h-1.5V3.5H5zM3 5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm.5 1.5v6h6v-6z';
const ICON_X = 'M4.6 3.5 8 6.9l3.4-3.4 1.1 1.1L9.1 8l3.4 3.4-1.1 1.1L8 9.1l-3.4 3.4-1.1-1.1L6.9 8 3.5 4.6z';

function fmtSize(n) {
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
  if (ms <= 0) return 'Leaving…';
  const s = Math.ceil(ms / 1000);
  if (s < 600) return `Leaves in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 3600) return `Leaves in ${Math.round(s / 60)} min`;
  return `Leaves in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function ext(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1] : '';
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

async function run(promise) {
  const r = await promise;
  if (r && r.ok === false) toast(r.error);
  return r;
}

// ---- items ----

function metaFor(it) {
  if (it.state === 'downloading') {
    const pct = it.size ? Math.min(99, Math.floor((it.got / it.size) * 100)) : 0;
    return `Arriving… ${pct}% of ${fmtSize(it.size)}`;
  }
  if (it.state === 'missing') return `Waiting for ${it.from || 'another computer'}`;
  const bits = [];
  if (it.kind === 'text') bits.push('Text');
  else if (it.kind === 'folder') bits.push(`${it.count} item${it.count === 1 ? '' : 's'}, ${fmtSize(it.size)}`);
  else bits.push(fmtSize(it.size));
  bits.push(it.from ? `from ${it.from}` : 'added here');
  return bits.join(' · ');
}

function buildRow(it) {
  const li = el('li', 'item');
  li.dataset.id = it.id;
  li.draggable = true;
  const thumb = el('div', 'thumb');
  const info = el('div', 'info');
  const name = el('div', 'name');
  const meta = el('div', 'meta');
  const metaText = el('span');
  const leave = el('span', 'leave');
  meta.append(leave, metaText);
  info.append(name, meta);
  const actions = el('div', 'actions');
  const keep = el('button', 'act keep', 'Keep');
  keep.title = 'Keep it on the shelf';
  const primary = el('button', 'act');
  const remove = el('button', 'act');
  remove.title = 'Remove from the shelf';
  remove.appendChild(svg(ICON_X));
  actions.append(keep, primary, remove);
  const progress = el('div', 'progress');
  li.append(thumb, info, actions, progress);

  keep.addEventListener('click', (e) => {
    e.stopPropagation();
    run(api.keep(li.dataset.id));
  });
  primary.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = current(li.dataset.id);
    if (!cur) return;
    if (cur.kind === 'text') {
      run(api.copyText(cur.id));
      toast('Copied');
    } else run(api.save(cur.id));
  });
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    run(api.remove(li.dataset.id));
  });
  li.addEventListener('click', () => select(li.dataset.id));
  li.addEventListener('dblclick', () => {
    const cur = current(li.dataset.id);
    if (!cur) return;
    if (cur.kind === 'text') {
      run(api.copyText(cur.id));
      toast('Copied');
    } else run(api.open(cur.id));
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    select(li.dataset.id);
    api.contextMenu(li.dataset.id);
  });
  li.addEventListener('dragstart', (e) => {
    const cur = current(li.dataset.id);
    if (!cur) return e.preventDefault();
    if (cur.kind === 'text') {
      internalDrag = cur.id;
      e.dataTransfer.setData('text/plain', cur.text);
      e.dataTransfer.effectAllowed = 'copy';
      return;
    }
    e.preventDefault();
    if (cur.state === 'ready') api.drag(cur.id);
    else toast(`${cur.name} is still on its way`);
  });
  li.addEventListener('dragend', (e) => {
    const id = internalDrag;
    internalDrag = null;
    if (id && e.dataTransfer.dropEffect !== 'none') api.take(id);
  });

  return { el: li, parts: { thumb, name, metaText, leave, keep, primary, progress }, key: {} };
}

function updateRow(row, it) {
  const { el: li, parts, key } = row;
  li.className = 'item kind-' + it.kind;
  if (it.state !== 'ready') li.classList.add('waiting');
  if (it.expiresAt) li.classList.add('leaving');
  if (selected === it.id) li.classList.add('selected');

  const thumbKey = `${it.icon ? it.icon.length : 0}:${it.kind}:${it.name}`;
  if (key.thumb !== thumbKey) {
    key.thumb = thumbKey;
    parts.thumb.replaceChildren();
    if (it.icon) {
      const img = el('img');
      img.src = it.icon;
      img.alt = '';
      img.draggable = false;
      parts.thumb.appendChild(img);
    } else if (it.kind === 'text') {
      parts.thumb.appendChild(el('div', 'glyph text', '“'));
    } else if (it.kind === 'folder') {
      parts.thumb.appendChild(el('div', 'glyph folder'));
    } else {
      parts.thumb.appendChild(el('div', 'glyph', ext(it.name)));
    }
  }

  parts.name.textContent = it.kind === 'text' ? it.text.trim().replace(/\s+/g, ' ').slice(0, 200) : it.name;
  li.title = it.kind === 'text' ? it.text.slice(0, 600) : it.name;
  parts.metaText.textContent = metaFor(it);
  parts.keep.hidden = !it.expiresAt;

  const primaryKey = it.kind === 'text' ? 'copy' : 'save';
  if (key.primary !== primaryKey) {
    key.primary = primaryKey;
    parts.primary.replaceChildren(svg(primaryKey === 'copy' ? ICON_COPY : ICON_SAVE));
    parts.primary.title = primaryKey === 'copy' ? 'Copy' : 'Save to Downloads';
  }
  parts.primary.disabled = it.state !== 'ready';

  const pct = it.state === 'downloading' && it.size ? Math.min(100, (it.got / it.size) * 100) : 0;
  parts.progress.style.width = pct ? `${pct}%` : '0';
  parts.progress.hidden = it.state !== 'downloading';
  updateCountdown(row, it);
}

function updateCountdown(row, it) {
  row.parts.leave.textContent = it.expiresAt ? fmtLeft(it.expiresAt - Date.now()) + ' · ' : '';
}

function current(id) {
  return state && state.items.find((i) => i.id === id);
}

function renderItems() {
  const list = $('items');
  const ids = new Set(state.items.map((i) => i.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }
  state.items.forEach((it, index) => {
    let row = rows.get(it.id);
    if (!row) {
      row = buildRow(it);
      rows.set(it.id, row);
      if (!firstRender && !seenIds.has(it.id)) row.el.classList.add('fresh');
    }
    seenIds.add(it.id);
    updateRow(row, it);
    if (list.children[index] !== row.el) list.insertBefore(row.el, list.children[index] || null);
  });
  if (selected && !ids.has(selected)) selected = null;
  firstRender = false;

  const empty = state.items.length === 0;
  $('empty').hidden = !empty;
  const others = state.peers.filter((p) => p.online).length;
  $('empty-sub').textContent = others
    ? 'They show up on your other computers right away.'
    : state.nearby.length
      ? `${state.nearby[0].name} is nearby. Open Settings to join it.`
      : 'Open Shelf on another computer on this network, then join from Settings.';
}

function select(id) {
  selected = id;
  for (const [rid, row] of rows) row.el.classList.toggle('selected', rid === id);
}

setInterval(() => {
  if (!state) return;
  for (const it of state.items) {
    if (it.expiresAt) {
      const row = rows.get(it.id);
      if (row) updateCountdown(row, it);
    }
  }
}, 1000);

// ---- footer and settings ----

function renderFooter() {
  const box = $('peers-summary');
  box.replaceChildren();
  const me = el('span', 'peer-chip');
  me.append(el('span', 'dot on'), document.createTextNode(thisComputer));
  box.appendChild(me);
  const shown = state.peers.slice(0, 2);
  for (const p of shown) {
    const chip = el('span', 'peer-chip');
    chip.append(el('span', 'dot' + (p.online ? ' on' : '')), document.createTextNode(p.name));
    box.appendChild(chip);
  }
  if (state.peers.length > shown.length) box.appendChild(el('span', null, `+${state.peers.length - shown.length}`));
  if (state.nearby.length && !settingsOpen()) box.appendChild(el('span', 'nearby-chip', `${state.nearby.length} nearby`));
}

function settingsOpen() {
  return !$('settings-view').hidden;
}

function openSettings(open) {
  $('settings-view').hidden = !open;
  $('shelf-view').hidden = open;
  $('btn-done').hidden = !open;
  $('btn-settings').classList.toggle('on', open);
  if (open) renderSettings(true);
  renderFooter();
}

function renderSettings(full) {
  if (!state) return;
  const s = state.settings;
  if (full || document.activeElement !== $('set-name')) $('set-name').value = state.self.name;
  $('set-linger').value = String(s.lingerMin);
  $('set-popup').checked = s.popUp;
  $('set-ontop').checked = s.onTop;
  $('set-login').checked = s.openAtLogin;
  $('code').textContent = state.code;
  $('version').textContent = `Shelf ${state.version}`;
  $('my-address').textContent = state.addresses.length
    ? `This computer is ${state.addresses.map((a) => (state.port === 47474 ? a : `${a}:${state.port}`)).join(', ')}`
    : '';

  const peers = $('peer-list');
  peers.replaceChildren();
  const me = el('li');
  me.append(el('span', 'dot on'), el('span', 'grow', `${state.self.name}`), el('span', 'sub', 'this computer'));
  peers.appendChild(me);
  for (const p of state.peers) {
    const li = el('li');
    li.append(el('span', 'dot' + (p.online ? ' on' : '')), el('span', 'grow', p.name), el('span', 'sub', p.online ? 'connected' : 'offline'));
    peers.appendChild(li);
  }

  const nearby = $('nearby-list');
  nearby.replaceChildren();
  $('nearby-block').hidden = state.nearby.length === 0;
  for (const n of state.nearby) {
    const li = el('li');
    const btn = el('button', 'btn primary small', 'Join');
    btn.title = `Ask ${n.name} to let this computer join its shelf`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Asking…';
      const r = await run(api.join(n.id));
      btn.disabled = false;
      btn.textContent = 'Join';
      if (r.ok) toast(`Joined ${n.name}'s shelf`);
    });
    li.append(el('span', 'dot on'), el('span', 'grow', n.name), btn);
    nearby.appendChild(li);
  }
}

$('set-name').addEventListener('change', (e) => run(api.setSetting('name', e.target.value)));
$('set-linger').addEventListener('change', (e) => run(api.setSetting('lingerMin', Number(e.target.value))));
$('set-popup').addEventListener('change', (e) => run(api.setSetting('popUp', e.target.checked)));
$('set-ontop').addEventListener('change', (e) => run(api.setSetting('onTop', e.target.checked)));
$('set-login').addEventListener('change', (e) => run(api.setSetting('openAtLogin', e.target.checked)));
$('btn-copy-code').addEventListener('click', () => {
  run(api.copyCode());
  toast('Shelf code copied');
});
$('btn-join-code').addEventListener('click', async () => {
  const r = await run(api.joinCode($('join-code').value));
  if (r.ok) {
    $('join-code').value = '';
    toast('Joined. Computers with this code will appear above.');
  }
});
$('btn-add-ip').addEventListener('click', async () => {
  const r = await run(api.addIp($('add-ip').value));
  if (r.ok) {
    $('add-ip').value = '';
    toast(r.value === 'peer' ? 'Connected' : 'Found it. It is on another shelf, so it is listed under Nearby.');
  }
});
$('btn-new-shelf').addEventListener('click', async () => {
  if (!confirm('Start a new, empty shelf? This computer stops sharing with the others until you join again.')) return;
  run(api.newShelf());
});
$('btn-clear').addEventListener('click', () => {
  if (!state.items.length) return;
  if (confirm(`Remove all ${state.items.length} items from the shelf on every computer?`)) run(api.clearAll());
});

$('btn-settings').addEventListener('click', () => openSettings(!settingsOpen()));
$('btn-done').addEventListener('click', () => openSettings(false));
$('peers-summary').addEventListener('click', () => openSettings(true));
$('btn-hide').addEventListener('click', () => api.hide());
$('btn-pin').addEventListener('click', () => run(api.setSetting('onTop', !state.settings.onTop)));
api.onOpenSettings(() => openSettings(true));

// ---- drop, paste, keys ----

let dragDepth = 0;
const overlay = $('drop-overlay');
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (internalDrag) return;
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!internalDrag) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  if (internalDrag) return;
  if (settingsOpen()) openSettings(false);
  const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  if (paths.length) return run(api.addPaths(paths));
  const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
  if (text && text.trim()) run(api.addText(text));
});

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (typing) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    if (settingsOpen()) openSettings(false);
    run(api.paste());
    return;
  }
  if (e.key === 'Escape') {
    if (settingsOpen()) openSettings(false);
    else api.hide();
    return;
  }
  if (!state || settingsOpen()) return;
  const ids = state.items.map((i) => i.id);
  const idx = ids.indexOf(selected);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(ids.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (ids[next]) {
      select(ids[next]);
      rows.get(ids[next]).el.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  const cur = selected && current(selected);
  if (!cur) return;
  if (e.key === ' ' && cur.kind !== 'text') {
    e.preventDefault();
    run(api.quickLook(cur.id));
  } else if (e.key === 'Enter') {
    if (cur.kind === 'text') {
      run(api.copyText(cur.id));
      toast('Copied');
    } else run(api.open(cur.id));
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    run(api.remove(cur.id));
  } else if (mod && e.key.toLowerCase() === 'c' && cur.kind === 'text') {
    run(api.copyText(cur.id));
    toast('Copied');
  }
});

// ---- state ----

function apply(s) {
  state = s;
  $('btn-pin').classList.toggle('on', s.settings.onTop);
  $('btn-pin').title = s.settings.onTop ? 'Kept on top (click to stop)' : 'Keep on top';
  renderItems();
  renderFooter();
  if (settingsOpen()) renderSettings(false);
}

api.onState(apply);
api.onFlash(toast);
api.getState().then((r) => r.ok && apply(r.value));
