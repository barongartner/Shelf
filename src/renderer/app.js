'use strict';

const api = window.shelf;
const $ = (id) => document.getElementById(id);
const isMac = api.platform === 'darwin';
const thisComputer = isMac ? 'This Mac' : 'This PC';

let state = null;
let selected = null;
let view = 'shelf'; // shelf | settings | phone
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
  if (ms <= 0) return 'Leaving';
  const s = Math.ceil(ms / 1000);
  if (s < 600) return `Leaves in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 3600) return `Leaves in ${Math.round(s / 60)} min`;
  return `Leaves in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function fmtWhen(t) {
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
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
    return `Arriving, ${pct}% of ${fmtSize(it.size)}`;
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
  // Toggle classes instead of rewriting className, so the arrival animation
  // class survives the first update.
  for (const k of ['file', 'folder', 'text']) li.classList.toggle('kind-' + k, it.kind === k);
  li.classList.toggle('waiting', it.state !== 'ready');
  li.classList.toggle('leaving', !!it.expiresAt);
  li.classList.toggle('selected', selected === it.id);

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
  const phones = state.devices.length;
  $('empty-sub').textContent = others || phones
    ? 'They show up on your other computers and your phone right away.'
    : state.nearby.length
      ? `${state.nearby[0].name} is nearby. Open Settings to join it.`
      : 'Connect a phone with the phone button above, or open Shelf on another computer and join from Settings.';
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
  if (view === 'phone') renderPairExpiry();
}, 1000);

// ---- footer and views ----

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
  if (state.devices.length) {
    const n = state.devices.length;
    box.appendChild(el('span', 'phones-chip', `${n} phone${n === 1 ? '' : 's'}`));
  }
  if (state.nearby.length && view === 'shelf') box.appendChild(el('span', 'nearby-chip', `${state.nearby.length} nearby`));
}

function showView(name) {
  view = name;
  $('shelf-view').hidden = name !== 'shelf';
  $('settings-view').hidden = name !== 'settings';
  $('phone-view').hidden = name !== 'phone';
  $('btn-done').hidden = name === 'shelf';
  $('btn-settings').classList.toggle('on', name === 'settings');
  $('btn-phone').classList.toggle('on', name === 'phone');
  if (name === 'settings') renderSettings(true);
  if (name === 'phone') {
    renderPhone();
    const p = state && state.phone;
    if (!p || !p.expiresAt || p.expiresAt - Date.now() < 60 * 1000) run(api.phoneRefresh());
  }
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

function renderPairExpiry() {
  const p = state && state.phone;
  const out = $('pair-expiry');
  if (!p || !p.expiresAt) {
    out.textContent = '';
    return;
  }
  const left = p.expiresAt - Date.now();
  if (left <= 0) {
    out.textContent = 'This code has expired.';
    if (view === 'phone' && !renderPairExpiry.refreshing) {
      renderPairExpiry.refreshing = true;
      run(api.phoneRefresh()).finally(() => (renderPairExpiry.refreshing = false));
    }
    return;
  }
  const s = Math.ceil(left / 1000);
  out.textContent = `This code works once, for the next ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.`;
}

function renderPhone() {
  if (!state) return;
  const p = state.phone;
  const img = $('qr');
  const ph = $('qr-placeholder');
  if (p.qr && p.url) {
    img.src = p.qr;
    img.hidden = false;
    ph.hidden = true;
  } else {
    img.hidden = true;
    ph.hidden = false;
    ph.textContent = p.address ? 'Making the code' : 'No network';
  }
  $('phone-base').textContent = p.base || '';
  $('phone-stable').hidden = !p.stable;
  $('phone-stable').textContent = p.stable ? `or ${p.stable.replace(/^https?:\/\//, '').replace(/\/$/, '')}, which stays the same when the address changes` : '';
  $('phone-pin').textContent = p.pin ? `${p.pin.slice(0, 3)} ${p.pin.slice(3)}` : '';
  renderPairExpiry();

  const problem = $('phone-problem');
  if (!p.address) {
    problem.hidden = false;
    problem.textContent = 'This computer has no network address. Connect it to Wi-Fi or Ethernet first.';
  } else if (!p.secure) {
    problem.hidden = false;
    problem.textContent = `The secure address could not be started${p.httpsError ? ` (${p.httpsError})` : ''}. The phone still works; only one-tap saving to its Photos app needs the secure address.`;
  } else problem.hidden = true;

  const field = $('addr-field');
  const sel = $('phone-addr');
  field.hidden = p.addresses.length < 2;
  if (p.addresses.length >= 2) {
    const want = p.addresses.join('|');
    if (sel.dataset.key !== want) {
      sel.dataset.key = want;
      sel.replaceChildren();
      for (const a of p.addresses) sel.appendChild(new Option(a, a));
    }
    sel.value = p.address;
  }

  const list = $('device-list');
  list.replaceChildren();
  if (!state.devices.length) {
    const li = el('li');
    li.append(el('span', 'sub', 'No phones yet. Scan the code above.'));
    list.appendChild(li);
  }
  for (const d of state.devices) {
    const li = el('li');
    const btn = el('button', 'btn small', 'Remove');
    btn.title = `${d.name} will no longer be able to open this shelf`;
    btn.addEventListener('click', () => {
      if (confirm(`Remove ${d.name} from the shelf? It will need to scan the code again.`)) run(api.deviceRemove(d.id));
    });
    li.append(el('span', 'dot on'), el('span', 'grow', d.name), el('span', 'sub', `seen ${fmtWhen(d.lastSeen)}`), btn);
    list.appendChild(li);
  }
}

$('set-name').addEventListener('change', (e) => run(api.setSetting('name', e.target.value)));
$('set-linger').addEventListener('change', (e) => run(api.setSetting('lingerMin', Number(e.target.value))));
$('set-popup').addEventListener('change', (e) => run(api.setSetting('popUp', e.target.checked)));
$('set-ontop').addEventListener('change', (e) => run(api.setSetting('onTop', e.target.checked)));
$('set-login').addEventListener('change', (e) => run(api.setSetting('openAtLogin', e.target.checked)));
$('btn-reset-pos').addEventListener('click', () => run(api.setSetting('resetPosition', true)));
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

$('btn-copy-url').addEventListener('click', async () => {
  const r = await run(api.phoneCopyUrl());
  if (r.ok) toast('Link copied. It works once, from a phone on this network.');
});
$('btn-new-code').addEventListener('click', () => run(api.phoneRefresh()));
$('phone-addr').addEventListener('change', (e) => run(api.setSetting('address', e.target.value)));

$('btn-settings').addEventListener('click', () => showView(view === 'settings' ? 'shelf' : 'settings'));
$('btn-phone').addEventListener('click', () => showView(view === 'phone' ? 'shelf' : 'phone'));
$('btn-done').addEventListener('click', () => showView('shelf'));
$('peers-summary').addEventListener('click', () => showView('settings'));
$('btn-hide').addEventListener('click', () => api.hide());
$('btn-pin').addEventListener('click', () => run(api.setSetting('onTop', !state.settings.onTop)));
api.onOpenSettings(() => showView('settings'));
api.onOpenPhone(() => showView('phone'));

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
  if (view !== 'shelf') showView('shelf');
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
    if (view !== 'shelf') showView('shelf');
    run(api.paste());
    return;
  }
  if (e.key === 'Escape') {
    if (view !== 'shelf') showView('shelf');
    else api.hide();
    return;
  }
  if (!state || view !== 'shelf') return;
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
  if (view === 'settings') renderSettings(false);
  if (view === 'phone') renderPhone();
}

api.onState(apply);
api.onFlash(toast);
api.getState().then((r) => r.ok && apply(r.value));
