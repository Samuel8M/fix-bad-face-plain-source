// Offline support for the home-screen app. Pages load fresh when online (so updates arrive);
// built files and the face models are cached after first use, so it also works without signal.
const CACHE = 'fix-bad-face-plain-v1';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('fix-bad-face-plain-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const model = url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/');
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !model && !fonts) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        (await caches.open(CACHE)).put('./', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./')) ?? Response.error();
      }
    })());
    return;
  }

  // Built files have content hashes and model URLs are versioned, so a cached copy stays valid.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  })());
});
