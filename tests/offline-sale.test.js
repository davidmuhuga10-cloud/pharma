// Offline selling (the device side): a sale rung up with no internet must be queued
// on the phone - surviving it being switched off and on - and sent the moment a
// connection comes back, never lost and never recorded twice. The database side
// (record_offline_sale, tested against a real database) is covered in
// tests/run_tests.js's "Offline selling" section; this file checks the client-side
// queue, sync logic and checkout wiring at the source level, the same way
// tests/dash-tile-links.test.js checks dashboard.js, without needing a browser.
// Run from the project folder:   node tests/offline-sale.test.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const offline = read('js/offline-sale.js');
const sell = read('js/sell.js');
const shell = read('js/shell.js');
const reports = read('js/reports.js');
const stocktake = read('js/controlled-stocktake.js');
const core = read('js/core.js');
const indexHtml = read('index.html');
const sw = read('sw.js');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

// --- the queue itself lives in IndexedDB (survives the phone restarting), not
// localStorage (synchronous - would freeze a busy till) or an in-memory array
// (lost the moment the tab closes) ---
check(/indexedDB\.open\(OFFLINE_DB_NAME/.test(offline), 'the queue is opened as an IndexedDB database');
check(!/localStorage\.(get|set)Item/.test(offline), 'the queue is never actually read from or written to localStorage (synchronous - would freeze a busy till) - only IndexedDB holds a queued sale');
check(/keyPath:\s*'client_ref'/.test(offline), 'each queued sale is keyed by its own client_ref, so adding the same one twice replaces, never duplicates');
for (const fn of ['offlineQueueAdd', 'offlineQueueList', 'offlineQueueRemove', 'offlineQueueMarkError']) {
  check(new RegExp('function ' + fn + '\\s*\\(').test(offline), fn + '() is defined');
}

// --- a fresh id is generated once, when the sale is queued - not regenerated on
// every sync attempt, or a retried sync would be recorded as a second sale ---
check(/function genClientRef\s*\(/.test(offline), 'genClientRef() is defined');
check(/crypto\.randomUUID/.test(offline), 'it uses a real UUID where the browser supports one');
check(/\breturn\s+'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'/.test(offline), 'and falls back to a manually-built one on an old WebView that lacks crypto.randomUUID, rather than failing the sale');

// --- "are we offline" is judged exactly the same way everywhere in the app, by
// reusing friendlyError()'s own network-failure wording (js/core.js) ---
const coreNetworkRegex = (core.match(/if \(\/([^/]+)\/i\.test\(msg\)\) return 'No internet connection/) || [])[1];
const offlineNetworkRegex = (offline.match(/function looksOffline[\s\S]*?return \/([^/]+)\/i\.test\(msg\)/) || [])[1];
check(!!coreNetworkRegex && !!offlineNetworkRegex, 'both friendlyError() and looksOffline() define a network-failure pattern to compare');
check(coreNetworkRegex === offlineNetworkRegex, 'looksOffline() uses the exact same network-failure wording as friendlyError() - one rule for "this is a connectivity problem", not two that could quietly disagree');
check(/navigator\.onLine === false/.test(offline), 'it also trusts the browser\'s own online/offline flag, not only a failed request');

// --- syncing: oldest first, idempotent-safe, stops in order rather than
// hammering the rest of the queue once the connection is gone again ---
check(/function syncOfflineQueue\s*\(/.test(offline), 'syncOfflineQueue() is defined');
check(/record_offline_sale/.test(offline), 'it calls record_offline_sale() - the same idempotent RPC tested in tests/run_tests.js - never record_sale, for a queued offline sale');
check(/rows\.sort\(function \(a, b\) \{ return \(a\.queued_at \|\| 0\) - \(b\.queued_at \|\| 0\); \}\)/.test(offline), 'sales are sent oldest first, so two sales for the same drug sync in the order they actually happened');
check(/offlineQueueRemove\(row\.client_ref\)/.test(offline), 'a sale is removed from the device queue only after the server confirms it');
check(/if \(looksOffline\(e\)\) break/.test(offline), 'if the connection drops again mid-sync, it stops there and tries the rest later, instead of giving up on the whole queue or retrying out of order');
check(/catch \(e\) \{[\s\S]{0,400}offlineQueueMarkError/.test(offline), 'a genuine (non-connectivity) rejection is flagged on the queued row rather than silently dropped or retried forever');
check(/if \(offlineSyncing\) return/.test(offline), 'two sync attempts cannot run at once (a timer and the online event firing together)');

// --- startup: pick up anything still queued from before the app was last closed,
// then keep trying on reconnect and periodically, in case the network is patchy ---
check(/function startOfflineSync\s*\(/.test(offline), 'startOfflineSync() is defined');
check(/addEventListener\('online',\s*syncOfflineQueue\)/.test(offline), 'it retries the moment the browser reports a connection');
check(/setInterval\(syncOfflineQueue,\s*30000\)/.test(offline), 'and also retries periodically (every 30s), since a weak signal does not always fire the online event');
check(/startOfflineSync\(\);/.test(shell) && new RegExp('function finishInit[\\s\\S]{0,80}startOfflineSync\\(\\)').test(shell), 'startOfflineSync() is called from finishInit() - once the app actually has a signed-in session, on every app start');

// --- the badge: visible only when there is something to sync, with a manual
// "Sync now" escape hatch, and it never requires a full screen rebuild to update ---
check(/function renderOfflineBadge\s*\(/.test(offline), 'renderOfflineBadge() is defined');
check(/getElementById\('offlineBanner'\)/.test(offline), 'it targets the #offlineBanner element directly, so refreshing it never disturbs whatever screen is open');
check(/if \(!STATE\.profile \|\| !offlineQueueCountCache\) \{ el\.innerHTML = ''; return; \}/.test(offline), 'the badge is empty (shows nothing) when there is nothing queued or nobody is signed in yet');
check(/onclick="syncOfflineQueue\(\)"/.test(offline), 'the badge offers a manual "Sync now" button');
check(/<div id="offlineBanner"><\/div>/.test(shell), 'the shell reserves a spot for the badge, right under the top bar, next to the support-mode banner');
check(/renderOfflineBadge\(\);(?!\s*\})[\s\S]{0,40}return renderTab\(\);/.test(shell) || /wireNavDrawer\(\);\s*renderOfflineBadge\(\);/.test(shell), 'render() refills the badge every time it rebuilds the page (the div above is otherwise wiped blank)');

// --- the offline quote fallback: an estimate from the cached shelf price, used
// only when the real, priced quote cannot be reached at all ---
check(/function offlineIndicativeQuote\s*\(/.test(offline), 'offlineIndicativeQuote() is defined');
check(/offlineEstimate:\s*true/.test(offline), 'its result is clearly marked as an estimate, not a real server quote');

// --- wiring into the Sell screen: checkout can still open with no connection,
// and completeSale() tries the normal online path first and only falls back to
// the queue on an actual connectivity failure, never on an ordinary rejection
// (over the credit limit, a bad quantity, etc. must still refuse the sale) ---
check(/quote = offlineIndicativeQuote\(STATE\.cart\)/.test(sell), 'openCheckout() falls back to the cached-price estimate when quote_sale cannot be reached, instead of leaving the cashier stuck with no way to even open checkout');
check(/if \(!looksOffline\(e\)\) \{[\s\S]{0,200}return;\s*\}\s*\/\/ No connection/.test(sell) || (/if \(!looksOffline\(e\)\) \{/.test(sell) && /quote = offlineIndicativeQuote/.test(sell)), 'a quote_sale failure that is NOT a connectivity problem still shows the normal error (does not pretend the cause was always "offline")');
check(/body\.dataset\.offlineQuote = quote\.offlineEstimate \? '1' : ''/.test(sell), 'the checkout sheet remembers whether this is an offline-estimated quote');
check(/knownOffline = !!\(body && body\.dataset\.offlineQuote === '1'\)/.test(sell), "completeSale() knows, before even trying, that this checkout opened with no connection (skips straight to the queue instead of waiting for record_sale to time out)");
check(/if \(!knownOffline\) \{[\s\S]{0,50}try \{[\s\S]{0,400}record_sale/.test(sell), 'when not already known to be offline, completeSale() still tries record_sale first - the normal online path is unchanged');
check(/if \(!looksOffline\(e\)\) \{ toast\(friendlyError\(e\), 'bad'\); return; \}\s*\n\s*wasOffline = true;/.test(sell), 'an ordinary record_sale rejection (over credit limit, bad quantity, permission) still shows the real error and refuses the sale - only a genuine connectivity failure falls through to the offline queue');
check(/offlineQueueAdd\(\{[\s\S]{0,80}client_ref:\s*genClientRef\(\)/.test(sell), 'a sale that falls back to offline is queued with a fresh client_ref, generated once, right here');
check(/syncOfflineQueue\(\);\s*\/\/ in case a connection actually exists after all/.test(sell), 'it still tries an immediate sync, in case the "offline" guess was wrong (a false negative on navigator.onLine, say)');
check(/showReceipt\(soldItems, payments, customer, invoiceNo, quotedTotal, wasOffline\)/.test(sell), 'the receipt is shown immediately either way (online or queued) - a cashier never has to wait for a connection before printing');

// --- receipts and the Sell screen clearly say when a sale was recorded offline,
// rather than silently showing a normal one ---
check(/Recorded offline — pending sync/.test(sell) || /Recorded offline.*pending sync/.test(sell), 'the printed receipt says "pending sync" in place of an invoice number when one was not issued yet');
check(/function showReceipt\(items, payments, customer, invoiceNo, chargedTotal, offline\)/.test(sell), 'showReceipt() takes an explicit offline flag rather than guessing from a missing invoice number');

// --- the owner's side: a sale that needs a look is actually visible somewhere,
// not only sitting in the database (sales_report_page already carries the
// columns - see migrations/2026-11-07_offline_selling.sql and tests/run_tests.js) ---
check(/s\.needs_review \? ' <span class="badge bad"/.test(reports), 'a flagged sale in the Sales Report transaction list shows a "Needs a look" badge, with the reason as its tooltip');
check(/s\.recorded_offline \? ' <span class="badge warn">Offline<\/span>/.test(reports), 'and a normal (unflagged) offline sale is still marked as recorded offline, so the owner can tell which sales came from a device that was briefly disconnected');
check(/s\.needs_review \?[\s\S]{0,40}class="inline-notice"/.test(reports), 'opening a flagged sale\'s detail shows the full review note, not just the list badge');
check(/'Recorded offline':.*s\.recorded_offline/.test(reports) || /Recorded offline.*s\.recorded_offline/.test(reports), 'the Sales Report\'s Excel export also carries recorded_offline and needs_review, so the owner can filter for them outside the app too');

// --- the owner also sees it the moment the app opens, not only on a trip to the
// Sales Report - the same "needs your attention" dashboard strip that already
// covers credit owed, refills due and a controlled-drug mismatch (dashboard_extras(),
// see migrations/2026-11-07_offline_selling.sql and tests/run_tests.js) ---
check(/x\.sales_needing_review\) > 0 && can\('void'\)/.test(stocktake), "the dashboard alert only shows to owner/co-owner/pharmacist (can('void')) - the same roles who can actually do something about a flagged sale, not every seller");
check(/rows\.push\(\["goReport\('sales'\)',? ?'', ?'warn'/.test(stocktake) || /goReport\('sales'\)[\s\S]{0,20}'warn'/.test(stocktake), 'tapping the alert goes straight to the Sales Report, the same navigation the dashboard tiles already use');

// --- the new file is wired in exactly like every other js/ file (loaded, split
// into its own global-scope file, pre-cached for offline use) ---
check(/<script src="js\/offline-sale\.js"><\/script>/.test(indexHtml), 'js/offline-sale.js is loaded by index.html');
check(/'\.\/js\/offline-sale\.js'/.test(sw), 'js/offline-sale.js is pre-cached by the service worker, so it is there on a first-ever offline open too');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS offline selling (client side): IndexedDB queue, sync-on-reconnect, checkout fallback and the owner-visible review flag all wired up');
