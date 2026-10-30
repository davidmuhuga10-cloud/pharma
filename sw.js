/* Hodhi service worker — caches the app shell so the app still opens (and
   shows the last screen it had data for) on a bad connection, which matters
   a lot for a pharmacy in a rural sub-county. It deliberately NEVER caches
   Supabase API calls — stock, prices and stock levels must always come from
   the network when it's available; a stale cached "in stock" answer at a
   pharmacy counter is worse than a slow one. Bump CACHE_NAME on every
   deploy so returning users pick up the new app shell instead of an old
   cached copy. */

const CACHE_NAME = 'hodhi-shell-v2s';
// vendor-supabase.js and vendor-xlsx.js were missing from this list, so a
// first-ever offline open failed outright: index.html came from the cache,
// then <script src="vendor-supabase.js"> went to the network, got nothing,
// and app.js died on `supabase.createClient` — the exact single point of
// failure vendoring them was meant to remove. They only reached the cache
// once the fetch handler below had seen them on a successful online load.
const SHELL_FILES = [
  './', './index.html', './style.css', './nativeShell.js', './config.js', './manifest.json',
  './vendor-supabase.js',
  './js/core.js',
  './js/shell.js',
  './js/export.js',
  './js/auth.js',
  './js/dashboard.js',
  './js/inventory.js',
  './js/import.js',
  './js/stock-actions.js',
  './js/sell.js',
  './js/reports.js',
  './js/reports-stock.js',
  './js/claims-settings.js',
  './js/suppliers.js',
  './js/expenses.js',
  './js/customers.js',
  './js/controlled-stocktake.js',
  './js/main.js'
  // vendor-xlsx.js (880 KB) is deliberately NOT pre-cached: it is only needed
  // for Excel export/import, so the app loads it after the first screen, and the
  // fetch handler below then keeps it cached for offline use.
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

  // Network-first for the app's own code and markup; cache-first for
  // everything else (icons, fonts, the vendored libraries — none of which
  // change without their filename changing).
  //
  // This was cache-first for everything, which meant a returning user kept
  // running the OLD app.js and index.html out of the cache until someone
  // remembered to bump CACHE_NAME by hand on deploy. Forget once and a fix
  // shipped to Netlify simply never reaches the pharmacy that needs it —
  // they would have had to clear site data to get it. Network-first keeps
  // the offline guarantee (the cached copy is still served the moment the
  // network fails) without making correctness depend on remembering a
  // constant.
  var isAppShell = event.request.mode === 'navigate' ||
                   /\.(html|js|css)$/.test(url.pathname) ||
                   url.pathname === '/' ||
                   url.pathname.endsWith('/');
  var isVendor = /vendor-[^/]*\.js$/.test(url.pathname);

  if (isAppShell && !isVendor) {
    event.respondWith(
      fetch(event.request).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return resp;
      }).catch(function () {
        return caches.match(event.request).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
