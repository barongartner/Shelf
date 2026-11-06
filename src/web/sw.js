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
