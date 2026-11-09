// Pharma service worker. Caches the app shell so the app still opens (showing
// the last screen it had data for) on a bad connection. It NEVER caches
// Supabase API calls: stock and prices must come from the network when it is
// available, since a stale "in stock" answer at the counter is worse than a slow
// one. Bump CACHE_NAME on every deploy so returning users get the new shell.

const CACHE_NAME = 'hodhi-shell-v4m';
// The vendored libraries must be listed here, or a first-ever offline open
// fails: index.html comes from the cache but vendor-supabase.js does not.
const SHELL_FILES = [
  './', './index.html', './style.css', './nativeShell.js', './install.js', './config.js', './manifest.json',
  './vendor-supabase.js',
  './js/core.js',
  './js/barcode.js',
  './js/staff-access.js',
  './js/shell.js',
  './js/profile.js',
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
  './js/supplier-order.js',
  './js/expenses.js',
  './js/customers.js',
  './js/controlled-stocktake.js',
  './js/cash-drawer.js',
  './js/main.js'
  // vendor-xlsx.js (880 KB) is deliberately not pre-cached. Only Excel
  // import/export needs it; the app loads it after the first screen and the fetch
  // handler below then keeps it cached for offline use.
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

  // Ignore anything that is not a plain GET, and never cache Supabase or other
  // cross-origin API traffic. That data must be live.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first for the app's own code and markup; cache-first for everything
  // else (icons, fonts, vendored libraries, which only change with their
  // filename). Cache-first for all of it left returning users on old code until
  // CACHE_NAME was bumped by hand. Network-first still serves the cached copy
  // when the network fails.
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
