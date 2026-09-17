/* Hodhi service worker — caches the app shell so the app still opens (and
   shows the last screen it had data for) on a bad connection, which matters
   a lot for a pharmacy in a rural sub-county. It deliberately NEVER caches
   Supabase API calls — stock, prices and stock levels must always come from
   the network when it's available; a stale cached "in stock" answer at a
   pharmacy counter is worse than a slow one. Bump CACHE_NAME on every
   deploy so returning users pick up the new app shell instead of an old
   cached copy. */

const CACHE_NAME = 'hodhi-shell-v2c';
const SHELL_FILES = [
  './', './index.html', './style.css', './app.js', './config.js', './manifest.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(SHELL_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Never touch anything that isn't a plain GET, and never cache Supabase
  // (or any cross-origin) API traffic — that data must always be live.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
      // Cache-first for instant loads, but still refresh the cache in the
      // background so the next offline load has the latest shell.
      return cached || network;
    })
  );
});
