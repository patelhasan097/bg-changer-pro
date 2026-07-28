/* BG Changer Pro — Service Worker v1.0 */

const VERSION   = 'bg-changer-v1.0';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  if (url.endsWith('/') || url.includes('index.html') ||
      url.includes('manifest.json') || url.includes('icon.svg')) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  if (url.includes('cdn.jsdelivr.net') ||
      url.includes('cdnjs.cloudflare.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com')) {
    e.respondWith(cacheFirstBgUpdate(e.request));
    return;
  }

  e.respondWith(networkFirst(e.request));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  return hit || fetchAndStore(req);
}

async function cacheFirstBgUpdate(req) {
  const cache = await caches.open(VERSION);
  const hit   = await cache.match(req);
  if (hit) { fetchAndStore(req).catch(() => {}); return hit; }
  return fetchAndStore(req);
}

async function networkFirst(req) {
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      const c = await caches.open(VERSION);
      c.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function fetchAndStore(req) {
  const resp = await fetch(req);
  if (resp && resp.ok && resp.type !== 'opaque') {
    const c = await caches.open(VERSION);
    c.put(req, resp.clone()).catch(() => {});
  }
  return resp;
}
