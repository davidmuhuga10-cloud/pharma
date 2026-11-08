// Every report and list table looks the same: 10 rows a page with Prev/Next, plain coloured
// status text (no badge background), numbers right-aligned, a From-To range where dates matter,
// and a printed copy with the green letterhead that carries the WHOLE list. This checks the
// shared helpers in js/export.js and that each screen really uses them, without a browser.
// Run from the project folder:   node tests/report-tables.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
function grab(file, name) {
  const src = read(file), start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in ' + file);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}

const area = { className: '', innerHTML: '' };
const ctx = { console, $: sel => sel === '#printArea' ? area : null, setTimeout: () => {}, window: { print() {} },
  STATE: { pharmacy: { name: 'Test <Pharmacy>', phone: '0700 000 000', town: 'Nairobi' } }, icon: () => '' };
vm.createContext(ctx);
vm.runInContext(['esc', 'fmt', 'fmtDate', 'daysUntil'].map(n => grab('js/core.js', n)).join('\n') + '\n' + read('js/export.js'), ctx);
const run = c => vm.runInContext(c, ctx);

// ---- paging: 10 to a page ----
check(run('REPORT_PAGE_SIZE') === 10, 'a page is 10 rows');
const rows25 = JSON.stringify(Array.from({ length: 25 }, (_, i) => i));
let pg = run('pageSlice(' + rows25 + ', 1)');
check(pg.rows.length === 10 && pg.pages === 3 && pg.from === 1 && pg.to === 10 && pg.total === 25, 'page 1 of 25 rows is rows 1-10 of 3 pages');
pg = run('pageSlice(' + rows25 + ', 3)');
check(pg.rows.length === 5 && pg.from === 21 && pg.to === 25, 'the last page holds the remaining 5');
pg = run('pageSlice(' + rows25 + ', 99)');
check(pg.page === 3, 'a page past the end is brought back to the last one (a list that shrank never shows an empty page)');
pg = run('pageSlice([], 1)');
check(pg.pages === 1 && pg.rows.length === 0 && pg.from === 0, 'an empty list is one empty page');
check(/Showing 1–10 of 25/.test(run('showingHtml(pageSlice(' + rows25 + ', 1))')), 'the line above the table says "Showing 1–10 of 25"');
check(run('pagerHtml(pageSlice([1,2,3], 1), "go")') === '', 'no pager when everything fits on one page');
const p1 = run('pagerHtml(pageSlice(' + rows25 + ', 1), "goX")'), p3 = run('pagerHtml(pageSlice(' + rows25 + ', 3), "goX")');
check(/Page 1 of 3/.test(p1) && /goX\(2\)/.test(p1) && /pg-btn" disabled/.test(p1), 'first page: Prev is disabled and Next goes to page 2');
check(/goX\(2\)/.test(p3) && /primary" disabled/.test(p3), 'last page: Next is disabled and Prev goes to page 2');

// ---- the table ----
const t = run(`rtTable(['Drug', 'Qty', 'Status'], [['A <b>', 'KES 1,200', {t:'Expired', c:'st-bad'}], ['B', '15', {t:'No date', c:'st-ink'}]], { rowClick: i => 'open(' + i + ')' })`);
check(/A &lt;b&gt;/.test(t) && !/A <b>/.test(t), 'cell text is escaped');
check(/data-label="Drug"/.test(t), 'each cell carries its column label (the phone shows it)');
check(/<td data-label="Qty" class="num">/.test(t) && /<th class="num">Qty/.test(t), 'a column of numbers / KES amounts is right-aligned');
check(!/<td data-label="Drug" class="num">/.test(t), 'a text column is not right-aligned');
check(/<span class="st-bad">Expired<\/span>/.test(t), 'status is coloured TEXT (a span with a colour class)');
check(/onclick="open\(1\)"/.test(t) && /rt-click/.test(t), 'a row can be tapped');
check(/Nothing to show/.test(run("rtTable(['A'], [])")) && /Custom empty/.test(run("rtTable(['A'], [], { empty: 'Custom empty' })")), 'an empty table says so');
const cssAll = read('style.css');
const stRules = cssAll.match(/[^{}]*\.st-(bad|warn|ok|ink)[^{}]*\{[^}]*\}/g) || [];
check(stRules.length >= 4 && stRules.every(r => !/background/.test(r)), 'status colour rules set text colour only - no background');
check(!/\.st-(bad|warn|ok)[^{]*\{[^}]*(#[89a-c][0-9a-f]{2}[0-9a-f]?\b)/i.test(cssAll), 'no gray in the status rules');

// ---- date range ----
check(run("rangeError('', '2026-11-08')") !== '' && run("rangeError('2026-11-09', '2026-11-08')") !== '' && run("rangeError('2026-11-01', '2026-11-08')") === '', 'a range needs both dates, in order');
const b = run("rangeBounds('2026-11-01', '2026-11-08')");
check(new Date(b.start).getTime() === new Date(2026, 10, 1).getTime(), 'the range starts at midnight of the From date');
check(new Date(b.end).getTime() === new Date(2026, 10, 9).getTime(), 'it ends at midnight AFTER the To date (the database end is not included), so the whole To day counts');

// ---- print ----
const th = run("letterheadHtml('Sales Report', 'Today', false)");
check(/class="pbadge"/.test(th) && /print-ribbon/.test(th) && /print-rule/.test(th) && /Test &lt;Pharmacy&gt;/.test(th), 'a report head has the badge, name (escaped), gold rule and ribbon title');
const rh = run("letterheadHtml('Receipt', '', true)");
check(/print-title/.test(rh) && !/print-ribbon|pbadge/.test(rh), 'a receipt keeps the plain head for the 80mm roll');
run("printHtml('Sales Report', 'Today', '<p>x</p>', '12 sales')");
check(area.className === 'print-only' && /print-frame/.test(area.innerHTML) && /print-bandfoot/.test(area.innerHTML) && /12 sales/.test(area.innerHTML), 'a report prints with the frame, the footer band and its summary line');
run("printHtml('Receipt', '', '<p>y</p>', null, { receipt: true })");
check(area.className === 'print-only print-receipt' && !/print-frame|print-bandfoot/.test(area.innerHTML) && /print-footer/.test(area.innerHTML), 'a receipt has no frame or band');
const ph = run(`tableHtml(['Drug', 'Qty', 'Status'], [['A', 'KES 5', {t:'Expired', c:'st-bad'}], ['B', 'KES 1,000', 'ok']], 'Total: 2')`);
check(/<th class="no">#<\/th>/.test(ph) && /<td class="no">2<\/td>/.test(ph), 'the printed table is numbered');
check(/<td class="num">KES 1,000/.test(ph) && /st-bad/.test(ph) && /<tfoot>[\s\S]*Total: 2/.test(ph), 'printed numbers are right-aligned, status is coloured text, and the total line is there');
check(/@page receipt80/.test(cssAll) && /print-bandfoot/.test(cssAll) && /\.print-frame/.test(cssAll) && /print-color-adjust: exact/.test(cssAll), 'the print styles are in style.css (frame, footer band, colours forced on)');

// ---- every screen uses the shared table ----
const screens = {
  'js/inventory.js': ['rtTable(', 'pagerHtml(', 'pageSlice(', 'invRows('],
  'js/reports.js': ['rtTable(', 'pagerHtml(', 'rangeBarHtml(', 'rangeBounds('],
  'js/reports-stock.js': ['rtTable(', 'pagerHtml(', 'pageSlice(', 'expiryStatus('],
  'js/claims-settings.js': ['rtTable(', 'pagerHtml(', 'rangeBarHtml(', 'claimsStatus'],
  'js/cash-drawer.js': ['rtTable(', 'pagerHtml(', 'rangeBarHtml(', 'cashPrint'],
  'js/expenses.js': ['rtTable(', 'pagerHtml(', 'rangeBarHtml(', 'printExpenses', 'exportExpensesExcel'],
  'js/suppliers.js': ['rtTable(', 'pagerHtml(', 'supplierStmtCells'],
  'js/customers.js': ['rtTable(', 'pagerHtml(', 'custStmtCells'],
  'js/controlled-stocktake.js': ['rtTable(', 'pagerHtml(', 'ledgerCells'],
  'js/stock-actions.js': ['rtTable(', 'pagerHtml(', 'reorderCells']
};
for (const f of Object.keys(screens)) for (const needle of screens[f]) check(read(f).indexOf(needle) >= 0, f + ' uses ' + needle);
// the old "Load more" button and 20-per-page list are gone from the sales report
check(!/loadMoreReport|TX_PAGE_SIZE/.test(read('js/reports.js')), 'the sales report pages 10 at a time, not "Load more"');
check(/p_end: reportRangeEnd\(\)/.test(read('js/reports.js')), 'the sales report passes the custom end date to the database');
// print and Excel are fed the full list, not the page on screen
check(/function expiryExportRows\(\)[\s\S]{0,120}expirySorted\(/.test(read('js/reports-stock.js')), 'expiry print/Excel use the whole sorted list');
check(/pendingReorderList\.map\(reorderCells\)/.test(read('js/stock-actions.js')), 'the reorder list prints every row');
check(/cashHistory\.map\(cashRowCells\)/.test(read('js/cash-drawer.js')), 'cash closings print every row of the range');

// no letter circles in front of drug names: they only used up space
check(!/row-avatar/.test(read('js/inventory.js')) && !/row-avatar/.test(cssAll), 'the Inventory list has no letter circle before each drug');

// ---- expiry: tiles, lists and status ----
const ectx = { console, esc: ctx.esc, fmt: ctx.fmt, fmtDate: ctx.fmtDate, daysUntil: ctx.daysUntil, stCell: ctx.stCell, STATE: {} };
vm.createContext(ectx);
vm.runInContext(read('js/reports-stock.js'), ectx);
const iso = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const mk = (id, days, unknown) => ({ id, name: 'D' + id, unit: 'tablet', batch_no: 'B' + id, qty: 5, expiry_date: unknown ? null : iso(days), expiry_unknown: !!unknown, days: unknown ? null : days });
ectx.expiryReportData = { total: 7, all: [mk(1, -5), mk(2, 10), mk(3, 60), mk(4, 200), mk(5, 0, true), mk(6, 30), mk(7, 90)] };
const n = c => vm.runInContext("expiryCategoryRows('" + c + "').length", ectx);
check(n('expired') === 1 && n('within30') === 2 && n('within90') === 4 && n('unknown') === 1, 'expired 1, within 30 days 2 (10 and 30), within 90 days 4 (cumulative), unknown 1');
check(n('all') === 6, '"All needing attention" is expired + the next 90 days + unknown, and leaves out the batch 200 days away');
vm.runInContext("expiryCustomFrom = '" + iso(5) + "'; expiryCustomTo = '" + iso(65) + "';", ectx);
check(n('custom') === 3, 'a From-To window lists only batches expiring inside it (10, 30 and 60 days away; not -5, 90 or 200)');
const st = d => vm.runInContext('expiryStatus(' + JSON.stringify(d) + ')', ectx);
check(st(mk(1, -5)).tone === 'bad' && /Expired/.test(st(mk(1, -5)).text), 'expired reads in red text');
check(st(mk(1, 10)).tone === 'bad' && st(mk(1, 60)).tone === 'warn' && st(mk(1, 0, true)).tone === 'ink' && /No date/.test(st(mk(1, 0, true)).text), 'within 30 days red, within 90 days amber, no date plain black');
const sorted = vm.runInContext("expirySorted('all').map(r => r.id)", ectx);
check(sorted.join(',') === '1,2,6,3,7,5', 'soonest first, batches with no date last: ' + sorted.join(','));

// ---- numbered page buttons (desktop; hidden on a phone) ----
check(JSON.stringify(run('pageNumbers(1, 5)')) === '[1,2,3,4,5]', 'a short list shows every page number');
check(JSON.stringify(run('pageNumbers(5, 12)')) === JSON.stringify([1, '…', 4, 5, 6, '…', 12]), 'a long list shows first, last and the pages around the current one: ' + JSON.stringify(run('pageNumbers(5, 12)')));
check(JSON.stringify(run('pageNumbers(1, 12)')) === JSON.stringify([1, 2, '…', 12]), 'near the start there is no gap before the current page');
check(/pg-num on" onclick="goX\(1\)"/.test(p1) && /goX\(3\)/.test(p1), 'the pager has a button per page and marks the current one');
check(/\.pg-nums\s*\{\s*display:\s*none/.test(cssAll), 'the page numbers are hidden on a phone, where Prev / Page 2 of 5 / Next is used');

// ---- Inventory: boxes, search, table, print ----
const inv = read('js/inventory.js');
const ictx = { console, esc: ctx.esc, fmt: ctx.fmt, fmtDate: ctx.fmtDate, daysUntil: ctx.daysUntil, stCell: ctx.stCell,
  qtyUnit: (n, u) => n + ' ' + u, STATE: { pharmacy: { expiry_warn_days: 90 }, drugsCache: [] }, invFilter: '' };
vm.createContext(ictx);
vm.runInContext(['invWarnDays', 'invBoxes', 'invInBox', 'invRows', 'invTitle', 'invStatusCell', 'invExpiryCell', 'invCells', 'daysLeftNote', 'daysLeftLabel']
  .map(f => grab('js/inventory.js', f)).join('\n') + "\nvar invBox = 'all'; var INV_COLS = ['Drug','In stock','Reorder at','Stock value','Soonest expiry','Status'];", ictx);
const drug = (name, qty, reorder, days, unknown, barcode) => ({ drug_id: name, name, unit: 'tablet', qty_in_stock: qty, reorder_level: reorder,
  soonest_expiry: days == null ? null : iso(days), has_unknown_expiry: !!unknown, stock_value_retail: qty * 10, barcode: barcode || null });
ictx.STATE.drugsCache = [drug('Amoxil', 50, 20, 400), drug('Brufen', 5, 20, 400), drug('Cetrizine', 0, 20, null), drug('Dettol', 30, 10, 20), drug('Epanutin', 30, 10, null, true, '999')];
const box = b => { vm.runInContext("invBox = '" + b + "'", ictx); return vm.runInContext('invRows().map(d => d.name).join()', ictx); };
check(box('all') === 'Amoxil,Brufen,Cetrizine,Dettol,Epanutin', 'All drugs lists everything');
check(box('low') === 'Brufen', 'Low stock is at or below the reorder number, and not zero stock');
check(box('out') === 'Cetrizine', 'Out of stock is zero in stock');
check(box('exp') === 'Dettol', 'Expiring lists a drug whose soonest batch is inside the warning window');
check(box('nodate') === 'Epanutin', 'Unknown expiry lists a drug with a batch that has no date');
vm.runInContext("invBox = 'all'; invFilter = '999'", ictx);
check(vm.runInContext('invRows().map(d => d.name).join()', ictx) === 'Epanutin', 'search finds a drug by barcode');
vm.runInContext("invBox = 'low'; invFilter = 'amox'", ictx);
check(vm.runInContext('invRows().length', ictx) === 0, 'search and box both apply (Amoxil is not low stock)');
vm.runInContext("invBox = 'all'; invFilter = ''", ictx);
const cells = vm.runInContext("STATE.drugsCache.map(invCells)", ictx);
check(cells[0].length === 6, 'a row has the six columns of the approved table');
check(cells[2][5].c === 'st-bad' && cells[1][5].c === 'st-warn' && cells[0][5].c === 'st-ok', 'status is plain coloured text: red out, amber low, green in stock');
check(!/badge/.test(inv.slice(inv.indexOf('function invCells'), inv.indexOf('function drawInventory'))), 'no badge background in the Inventory table');
check(/invRows\(\)\.map\(function \(d\) \{\s*return \{\s*'Drug'/.test(inv) && /var list = invRows\(\)/.test(inv), 'Excel and Print carry the whole picked list, not the page on screen');
check(/pageSlice\(rows, invPage\)/.test(inv), 'the desktop Inventory table pages 10 at a time');
// The phone design was approved as it was and must not change: same list rows, Out / Low / OK, notices and Load more.
const phoneSrc = inv.slice(inv.indexOf('function invPhoneHtml'));
check(/class="list-row"/.test(phoneSrc) && /badge bad">Out/.test(phoneSrc) && /badge good">OK/.test(phoneSrc) && /Load more/.test(phoneSrc) && /view list/.test(phoneSrc) && /sq-grid sq-2/.test(phoneSrc),
  'on a phone Inventory keeps its old list (rows, Out / Low / OK, notices, Load more, button grid)');
check(!/row-avatar/.test(phoneSrc), 'the phone list has no letter circle');
check(/inv-desk[^}]*display:\s*none/.test(cssAll) && /min-width:\s*760px\)\s*\{\s*\.inv-phone\s*\{\s*display:\s*none/.test(cssAll), 'the table shows from 760px up and the old list below it');
check(/openReorderList\(\)/.test(inv) && /openUnknownExpiryList\(\)/.test(inv), 'the reorder list and the no-expiry list stay reachable from Inventory');

// ---- the barcode scan button is labelled, and it no longer squashes the search box ----
for (const f of ['js/inventory.js', 'js/sell.js']) {
  const src = read(f);
  check(/class="btn secondary scan-btn"[^>]*>' \+ icon\('barcode', 18\) \+ ' Scan barcode<\/button>/.test(src), f + ': the scan button says "Scan barcode", not just a camera icon');
}
check(/\.scan-btn\s*\{[^}]*width:\s*auto/.test(cssAll) && /\.searchbox input\s*\{\s*min-width:\s*0/.test(cssAll), 'the scan button is only as wide as its label so the search box keeps the rest of the row');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS report tables: 10 a page, coloured text status, date ranges, print header, every screen on the shared table');
