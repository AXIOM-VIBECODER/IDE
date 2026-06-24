// AXIOM IDE — Service Worker
// Caches the app shell so the IDE loads instantly and works offline for the UI
const CACHE = 'axiom-v6-shell-v1';
const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon.svg',
  'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      cache.addAll(SHELL).catch(() => {})  // non-fatal if CDN is offline
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls, WebSocket upgrades, or cross-origin except CDN
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/ws') ||
      e.request.headers.get('upgrade') === 'websocket') {
    return;
  }

  // Network-first for navigation (always get fresh index.html when online)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Cache-first for static assets and CDN resources
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});

// Background sync — notify clients when connectivity restores
self.addEventListener('sync', e => {
  if (e.tag === 'axiom-reconnect') {
    self.clients.matchAll().then(clients =>
      clients.forEach(c => c.postMessage({ type: 'online' }))
    );
  }
});
