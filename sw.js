/* BG Changer Pro — Service Worker v1.0
   Strategy: App Shell → Cache First | CDN/Model → Cache First | Rest → Network First */

const VERSION   = 'bg-changer-v1.0';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

/* INSTALL */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ACTIVATE — delete old caches */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* FETCH */
self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* App shell → cache first */
  if (url.endsWith('/') || url.includes('index.html') ||
      url.includes('manifest.json') || url.includes('icon.svg')) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  /* CDN (AI model, JSZip, fonts) → cache first + bg update */
  if (url.includes('cdn.jsdelivr.net')     ||
      url.includes('cdnjs.cloudflare.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com')) {
    e.respondWith(cacheFirstBgUpdate(e.request));
    return;
  }

  /* Everything else → network first */
  e.respondWith(networkFirst(e.request));
});

/* ── Strategies ────────────────────────────────────────────────────────── */
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
    if (resp?.ok) {
      const c = await caches.open(VERSION);
      c.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch {
    return caches.match(req) || new Response('Offline', { status: 503 });
  }
}

async function fetchAndStore(req) {
  const resp = await fetch(req);
  if (resp?.ok && resp.type !== 'opaque') {
    const c = await caches.open(VERSION);
    c.put(req, resp.clone()).catch(() => {});
  }
  return resp;
}