// TukuruMukuru service worker.
//
// Strategy:
//  - Navigations (HTML page loads): network-first, so the server's auth
//    redirect (/ -> /login) is always respected. Only falls back to a
//    generic offline page when there's truly no network - never to a
//    cached copy of the chat or login shell, so a logged-out visitor is
//    never shown a stale "logged in" page or vice versa.
//  - Static assets (css/js/images/manifest): stale-while-revalidate. Serve
//    instantly from cache, then refresh the cache in the background so the
//    next visit picks up whatever shipped in the latest deploy.
//  - /api/*, /socket.io/* (the realtime handshake/polling transport): never
//    cached, always network - these carry live/session state.
//
// CACHE_VERSION: bump this string whenever the precache list below changes,
// so the old cache is dropped on activate instead of lingering forever.
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `tukurumukuru-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  '/style.css',
  '/client.js',
  '/login-client.js',
  '/manifest.webmanifest',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/stickers/neutral.webp',
  '/stickers/greeting.webp',
  '/stickers/curious.webp',
  '/stickers/playful.webp',
  '/stickers/excited.webp',
  '/stickers/affectionate.webp',
  '/stickers/sleepy.webp',
  '/stickers/napping.webp',
  '/stickers/hungry.webp',
  '/stickers/startled.webp',
  '/stickers/annoyed.webp',
  '/stickers/laughing.webp',
  '/stickers/sad.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Cache each URL individually so one failure (e.g. a slow/missing
      // asset) doesn't abort the whole install like cache.addAll() would.
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[sw] precache skipped', url, err.message))
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== STATIC_CACHE).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

function isNeverCached(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/')
  );
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await networkPromise) || Response.error();
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(STATIC_CACHE);
    return (await cache.match(OFFLINE_URL)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept POST /api/login, /api/logout, etc.

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // only handle same-origin requests

  if (isNeverCached(url)) return; // let these hit the network untouched

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

// --- Web Push ---

self.addEventListener('push', (event) => {
  let payload = { title: 'TukuruMukuru', body: 'You have a new message.' };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch (err) {
      payload.body = event.data.text() || payload.body;
    }
  }

  const options = {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url || '/' },
    tag: 'tukurumukuru-nudge', // collapse repeated nudges into one notification instead of stacking
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = allClients.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) await existing.navigate(targetUrl);
        return;
      }
      await self.clients.openWindow(targetUrl);
    })()
  );
});
