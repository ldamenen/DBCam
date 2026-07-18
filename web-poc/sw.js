// sw.js — offline support (ARCHITECTURE §0: self-contained after first load).
//
// Strategy:
//   - App shell + Core JS/CSS/HTML: NETWORK-FIRST, falling back to cache — so a
//     reload always picks up the latest deploy (the version tag stays honest),
//     but the app still opens with no connectivity.
//   - vendor/ assets (MediaPipe wasm + models, ~26MB total): CACHE-FIRST — big,
//     versioned-with-the-repo, no reason to refetch on every load.
//   - The PWA manifest + icons are same-origin (relative to /web-poc/), so the
//     network-first branch below caches them too — installable offline.
// Only GET requests on http(s) are handled; media blobs and everything else pass
// straight through.

const CACHE = 'dbcam-v0.13.0';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const isVendor = url.pathname.includes('/vendor/');
  const isRemoteModel = url.hostname === 'storage.googleapis.com';

  if (isVendor || isRemoteModel) {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
  // Cross-origin non-model requests: default browser behavior.
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (_e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw _e;
  }
}
