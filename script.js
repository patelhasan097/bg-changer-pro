/**
 * script.js
 * -----------------------------------------------------------------------
 * Entry point. Loaded as `<script type="module" src="script.js">` from
 * index.html. Keeps only two jobs: boot the UI, and register the
 * service worker for offline/installable behaviour. Everything else
 * lives in assets/js/*.js.
 */

import { initUI } from './assets/js/ui.js';

document.addEventListener('DOMContentLoaded', () => {
  initUI();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Scope note: sw.js must be served from the same directory as this
    // file (the site root) so its default scope covers the whole app —
    // if you deploy under a GitHub Pages project subpath, no change is
    // needed as long as sw.js stays at the repo root.
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed (app still works online):', err);
    });
  });
}
