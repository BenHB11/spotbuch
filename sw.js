// Spotbuch Service Worker: App-Dateien und Autodex-Fotos offline verfügbar machen.
// Die App selbst kommt immer frisch aus dem Netz (Fallback: Cache), die Fotoblätter aus dem Cache.
const CACHE = 'spotbuch-v1';
const SHELL = ['./', 'index.html', 'config.js', 'shim.js', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const store = res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; };
  if (url.pathname.includes('/img/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(store)));
    return;
  }
  e.respondWith(fetch(e.request).then(store).catch(() => caches.match(e.request, {ignoreSearch: true})));
});
