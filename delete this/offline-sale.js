// js/offline-sale.js - offline selling.
//
// A sale rung up with no internet (phone on airplane mode, patchy rural signal, a
// brief outage) must never be lost. This file is the device side of that: a small
// queue, held in IndexedDB so it survives the phone being switched off and on, plus
// the logic that sends each queued sale the moment a connection comes back. The
// database side is record_offline_sale() (see schema.sql / migrations) - every sale
// queued here is eventually sent there, never recorded any other way.
//
// IndexedDB, not localStorage: it survives a full phone restart, holds a queue
// (not just one value), and localStorage is synchronous - writing a sale to it on
// every tap at a busy till would freeze the screen.

var OFFLINE_DB_NAME = 'pharma-offline';
var OFFLINE_DB_VERSION = 1;
var OFFLINE_STORE = 'pending_sales';

function offlineDb() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error('This browser cannot store an offline sale.')); return; }
    var req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: 'client_ref' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function offlineQueueAdd(sale) {
  return offlineDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put(sale);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function offlineQueueList() {
  return offlineDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(OFFLINE_STORE, 'readonly');
      var req = tx.objectStore(OFFLINE_STORE).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function offlineQueueRemove(clientRef) {
  return offlineDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).delete(clientRef);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

// Best-effort note for the "Sync now" badge to show what is still stuck. Never
// required for correctness - a sale with no note is still safely queued.
function offlineQueueMarkError(clientRef, message) {
  return offlineDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(OFFLINE_STORE, 'readwrite');
      var store = tx.objectStore(OFFLINE_STORE);
      var req = store.get(clientRef);
      req.onsuccess = function () {
        var row = req.result;
        if (row) { row.lastError = message; store.put(row); }
      };
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }).catch(function () {});
}

// A fresh id for each offline sale, generated the moment it is queued (not when
// it syncs) - this is what record_offline_sale() uses to recognise a retried sync
// and never record the same sale twice. crypto.randomUUID needs a secure context,
// which a PWA with a service worker already requires, but a couple of very old
// in-app WebViews do not implement it - fall back rather than fail the sale.
function genClientRef() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Reuses friendlyError()'s own network-failure pattern (js/core.js) so "this
// connection has dropped" is judged exactly the same way everywhere in the app -
// one rule, not two that could quietly disagree.
function looksOffline(e) {
  if (navigator.onLine === false) return true;
  var msg = (e && e.message) || String(e || '');
  return /failed to fetch|network|load failed|networkerror|err_internet|offline/i.test(msg);
}

var offlineSyncing = false;
var offlineQueueCountCache = 0;

async function offlineQueueRefreshBadge() {
  try { offlineQueueCountCache = (await offlineQueueList()).length; }
  catch (e) { offlineQueueCountCache = 0; }
  renderOfflineBadge();
}

// Sends every queued sale, oldest first, stopping the moment one fails for a
// connectivity reason (so the rest stay queued in order rather than being retried
// out of turn). record_offline_sale() is idempotent on client_ref, so sending the
// same sale again after a half-finished sync (app closed mid-way, say) can never
// record it twice.
async function syncOfflineQueue() {
  if (offlineSyncing) return;
  if (navigator.onLine === false) return;
  offlineSyncing = true;
  try {
    var rows = await offlineQueueList();
    rows.sort(function (a, b) { return (a.queued_at || 0) - (b.queued_at || 0); });
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      try {
        await sb.rpc('record_offline_sale', {
          p_pharmacy_id: row.pharmacy_id,
          p_client_ref: row.client_ref,
          p_sold_at: row.sold_at,
          p_items: row.items,
          p_payments: row.payments,
          p_customer_name: row.customer_name || null,
          p_insurance_scheme: row.insurance_scheme || null,
          p_customer_id: row.customer_id || null
        }).then(function (r) { if (r.error) throw r.error; return r.data; });
        await offlineQueueRemove(row.client_ref);
      } catch (e) {
        if (looksOffline(e)) break; // connection dropped again - stop here, try the rest later
        // A genuine rejection (not connectivity) - leave it queued and flagged
        // rather than losing it or silently retrying forever.
        await offlineQueueMarkError(row.client_ref, friendlyError(e));
      }
    }
  } finally {
    offlineSyncing = false;
    offlineQueueRefreshBadge();
  }
}

// Called once from finishInit() (js/shell.js). Picks up any sale still queued
// from before the app was last closed, then keeps trying: the moment the browser
// reports a connection, and every 30 seconds while the app is open, in case the
// browser's own "online" event is wrong (patchy signal often is).
function startOfflineSync() {
  offlineQueueRefreshBadge();
  syncOfflineQueue();
  window.addEventListener('online', syncOfflineQueue);
  setInterval(syncOfflineQueue, 30000);
}

// The small amber banner under the top bar (see render() in js/shell.js, next to
// supportBannerHtml()). Updated directly, without a full render(), so it never
// interrupts whatever screen is open.
function renderOfflineBadge() {
  var el = document.getElementById('offlineBanner');
  if (!el) return;
  if (!STATE.profile || !offlineQueueCountCache) { el.innerHTML = ''; return; }
  var n = offlineQueueCountCache;
  el.innerHTML = '<div class="support-banner"><span>' + icon('warn', 15) + ' <b>' + n + '</b> sale' + (n === 1 ? '' : 's') +
    ' waiting to sync' + (navigator.onLine === false ? ' — no connection right now' : '') + '</span>' +
    '<button onclick="syncOfflineQueue()">Sync now</button></div>';
}

// Builds today's "indicative" line items/total from the cached stock list
// (STATE.drugsCache) instead of asking the server for a priced quote. Used only
// when quote_sale cannot be reached at all - see openCheckout() in js/sell.js.
// This is necessarily an estimate (today's shelf price, not FEFO batch pricing),
// which is exactly why an offline sale is flagged for review if what was actually
// collected turns out not to match once it syncs.
function offlineIndicativeQuote(cart) {
  var lines = cart.map(function (c) {
    return { drug_id: c.drug_id, quantity: c.qty, line_total: Math.round(c.qty * c.price * 100) / 100 };
  });
  var total = lines.reduce(function (a, l) { return a + l.line_total; }, 0);
  return { ok: true, total: Math.round(total * 100) / 100, lines: lines, offlineEstimate: true };
}
