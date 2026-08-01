/**
 * sw.js
 * -----------------------------------------------------------------------
 * Caching strategy:
 *  - APP SHELL (this repo's own files): cache-first, so the app opens
 *    instantly and works offline. Bump CACHE_VERSION to force everyone's
 *    browser to fetch fresh copies after you deploy a change.
 *  - NAVIGATION requests (loading index.html itself): network-first with
 *    a cache fallback, so people online always get your latest deploy,
 *    while people offline still get the last cached shell.
 *  - THIRD-PARTY CDN files (transformers.js, @huggingface/inference,
 *    JSZip, fonts): cache-first once fetched, so repeat sessions don't
 *    re-download multi-megabyte model/library files. These are NOT
 *    precached at install time (that would slow down first install and
 *    isn't needed for the app shell to work) — they're cached the first
 *    time they're actually used.
 *
 * Calls to huggingface.co / router.huggingface.co are intentionally left
 * alone (network only, never cached) — those are your live AI requests.
 */

const CACHE_VERSION = 'platelight-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './assets/js/constants.js',
  './assets/js/crypto.js',
  './assets/js/storage.js',
  './assets/js/tokenManager.js',
  './assets/js/segmentation.js',
  './assets/js/hfApi.js',
  './assets/js/imageUtils.js',
  './assets/js/queue.js',
  './assets/js/zipExport.js',
  './assets/js/ui.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
];

const RUNTIME_CACHE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NEVER_CACHE_HOSTS = ['huggingface.co', 'router.huggingface.co', 'api-inference.huggingface.co'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('platelight-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isNeverCache(url) {
  return NEVER_CACHE_HOSTS.some((host) => url.hostname.endsWith(host));
}
function isRuntimeCacheable(url) {
  return RUNTIME_CACHE_HOSTS.some((host) => url.hostname.endsWith(host));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (isNeverCache(url)) return; // let live AI calls hit the network untouched

  // Navigations: network-first, falling back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin shell files: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  // Known CDN hosts: cache-first, populate on first use.
  if (isRuntimeCacheable(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, res.clone()));
          }
          return res;
        });
      })
    );
    return;
  }

  // Anything else: just go to the network.
});
