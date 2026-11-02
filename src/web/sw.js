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
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(isShell ? '/' : req, fresh.clone());
        return fresh;
      } catch (err) {
        const hit = await cache.match(isShell ? '/' : req);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
