'use strict';

// Service worker for the secure address only (browsers allow one nowhere
// else). It keeps the page itself and its assets, so the Home Screen app
// opens even while the computer is asleep: the page then shows the shelf as
// it was and reconnects when the computer answers. Nothing from the API is
// ever cached here, and neither is the manifest, which is made per phone.

const VERSION = new URL(self.location.href).searchParams.get('v') || '0';
const CACHE = `shelf-shell-${VERSION}`;
const SHELL = ['/', `/app.js?v=${VERSION}`, `/style.css?v=${VERSION}`, '/icon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isShell = url.pathname === '/' || url.pathname === '/index.html';
  const isAsset = SHELL.includes(url.pathname + url.search) || SHELL.includes(url.pathname);
  if (!isShell && !isAsset) return; // the API and files always go to the computer
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isAsset && !isShell) {
        const hit = await cache.match(req, { ignoreSearch: false });
        if (hit) return hit;
      }
      const network = fetch(req).then((fresh) => {
        if (fresh && fresh.ok) return cache.put(isShell ? '/' : req, fresh.clone()).then(() => fresh, () => fresh);
        return fresh;
      });
      // A sleeping computer leaves the connection hanging for a long while.
      // The page itself waits 2.5 s at most: after that the kept copy opens
      // and the answer, when it comes, only refreshes the copy for next time.
      if (isShell) {
        event.waitUntil(network.catch(() => {}));
        const late = new Promise((resolve) => setTimeout(() => resolve(null), 2500));
        const first = await Promise.race([network.catch(() => null), late]);
        if (first) return first;
        const hit = await cache.match('/');
        if (hit) return hit;
        return network;
      }
      try {
        return await network;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});

// ---- notifications ----

// The computer sends one when something new lands on the shelf. iOS takes
// away the subscription of a page that gets a push and shows nothing, so
// every push shows a notification, even one that cannot be read.
self.addEventListener('push', (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {}
  const title = typeof m.title === 'string' && m.title ? m.title : 'Shelf';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof m.body === 'string' ? m.body : 'Something new is on the shelf.',
      tag: typeof m.tag === 'string' ? m.tag : 'shelf',
      icon: '/apple-touch-icon.png',
      badge: '/icon-192.png',
      data: { url: typeof m.url === 'string' && m.url.startsWith('/') ? m.url : '/' },
    }),
  );
});

// A tap opens the shelf with the new things picked out. An open window is
// told to show them; otherwise the app opens at an address that says which.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  const ids = (url.searchParams.get('n') || '').split(',').filter((x) => /^[\w-]{1,64}$/.test(x));
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        win.postMessage({ type: 'shelf-open', ids });
        try {
          await win.focus();
          return;
        } catch {}
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
