/* Service worker: lets the app open with no signal. API calls are never cached. */
const CACHE = 'fleettrack-v1';
const SHELL = [
  '/', '/driver', '/control',
  '/static/css/app.css', '/static/css/login.css', '/static/css/driver.css', '/static/css/control.css',
  '/static/js/common.js', '/static/js/login.js', '/static/js/driver.js', '/static/js/control.js',
  '/static/icons/icon-192.png', '/static/icons/favicon-32.png', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first (always the latest version when online), cached copy when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
