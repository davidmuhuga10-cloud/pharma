// js/reports.js - the Reports hub and the Sales report.
//
// --- Reports ---

// The hub links to Sales, Expiry Dates, Stock Valuation, Low Stock and
// Insurance Claims and Close the cash drawer. Each is a printable report with the pharmacy letterhead
// and the shared print footer (printHtml / letterheadHtml). reportsView says
// which sub-screen shows, the same in-content navigation as Suppliers'
// list/detail (supplierDetailId / openSupplierDetail / closeSupplierDetail).
var reportsView = 'hub'; // 'hub' | 'sales' | 'expiry' | 'valuation' | 'lowstock' | 'claims' | 'cash'
var reportRange = 'today'; // 'today' | 'week' | 'month' | 'custom'
var reportFrom = '';   // custom range, 'YYYY-MM-DD'
var reportTo = '';
var reportData = null; // last-loaded sales report, kept for export/print
var expiryReportData = null;
var valuationReportData = null;
var lowStockReportData = null;

// Which report screens this person may open (Stock Valuation and Sales can be switched off per person).
function reportAllowed(view) {
  if (view === 'valuation') return canSee('rpt_valuation');
  if (view === 'sales') return canSee('rpt_sales');
  return true;
}

async function renderReports() {
  if (!reportAllowed(reportsView)) reportsView = 'hub';  // a hidden report never opens, even from a saved link
  if (reportsView === 'sales') { await loadReport(); return; }
  if (reportsView === 'expiry') { await loadExpiryReport(); return; }
  if (reportsView === 'valuation') { await loadValuationReport(); return; }
  if (reportsView === 'lowstock') { await loadLowStockReport(); return; }
  if (reportsView === 'claims') { await loadClaims(); return; }
  if (reportsView === 'cash') { await loadCashDrawer(); return; }
  drawReportsHub();
}

function openReportView(v) { if (veilBusy) return; reportsView = v; runWithVeil(renderReports); }
function openReportsHub() { if (veilBusy) return; reportsView = 'hub'; runWithVeil(renderReports); }

var REPORT_TILES = [
  { view: 'sales', kind: 't-sales', ico: 'sell', title: 'Sales Report', desc: 'Revenue, payment methods, top sellers and every transaction, by date range.' },
  { view: 'expiry', kind: 't-amber', ico: 'warn', title: 'Expiry Dates Report', desc: 'Every batch by expiry urgency — expired, critical, soon, and unknown-expiry batches still needing a real date.' },
  { view: 'valuation', kind: 't-orange', ico: 'wallet', title: 'Stock Valuation Report', desc: 'What your current stock is worth, at cost and at retail, drug by drug.' },
  { view: 'lowstock', kind: 't-red', ico: 'clipboard', title: 'Low Stock Report', desc: 'Every drug at or below its reorder level, with a suggested order quantity.' },
  { view: 'claims', kind: 't-violet', ico: 'reports', title: 'Insurance Claims', desc: 'Every claim raised at checkout, tracked through to paid or rejected.' },
  { view: 'cash', kind: 't-green', ico: 'wallet', title: 'Close the cash drawer', desc: 'Count the cash at the end of a shift and see if it matches the system.' }
];

function drawReportsHub() {
  var c = $('#content');
  c.innerHTML =
    '<div class="reports-grid">' +
    REPORT_TILES.filter(function (r) {
      if (r.view === 'cash') return can('cash_close') || can('cash_review');
      if (!reportAllowed(r.view)) return false;
      return r.view !== 'claims' || can('claims');
    }).map(function (r) {
      return '<button class="report-tile ' + r.kind + '" onclick="openReportView(\'' + r.view + '\')">' +
        '<div class="r-ico">' + icon(r.ico, 20) + '</div>' +
        '<div><div class="r-title">' + esc(r.title) + '</div><div class="r-desc">' + esc(r.desc) + '</div></div>' +
      '</button>';
    }).join('') +
    '</div>';
}

function reportsBackBtn() {
  return '<button class="btn ghost small" style="margin-bottom:10px" onclick="openReportsHub()">&larr; All Reports</button>';
}

var REPORT_RANGES = [{ key: 'today', label: 'Today' }, { key: 'week', label: 'This week' }, { key: 'month', label: 'This month' }];

function drawReportsShell() {
  var c = $('#content');
  c.innerHTML =
    reportsBackBtn() +
    reportHeadHtml('Sales Report', 'exportReportExcel', 'printReport') +
    rangeBarHtml({ presets: REPORT_RANGES, active: reportRange, from: reportFrom, to: reportTo, pickFn: 'pickReportRange', applyFn: 'applyReportRange' }) +
    '<div id="reportBody"><div class="empty">Loading…</div></div>';
}

function pickReportRange(key) { reportRange = key; loadReport(); }
function applyReportRange() {
  var r = rangeBarRead(), err = rangeError(r.from, r.to);
  if (err) { toast(err, 'bad'); return; }
  reportFrom = r.from; reportTo = r.to; reportRange = 'custom';
  loadReport();
}
// "Today", "This week", or "01 Nov 2026 to 08 Nov 2026" - for titles and file names.
function reportRangeLabel() {
  if (reportRange === 'custom') return fmtDate(reportFrom) + ' to ' + fmtDate(reportTo);
  for (var i = 0; i < REPORT_RANGES.length; i++) if (REPORT_RANGES[i].key === reportRange) return REPORT_RANGES[i].label;
  return reportRange;
}

// Shared shell for the Expiry, Valuation, Low Stock and Claims reports: no
// date range (each is a live snapshot), just a back button and an Excel/Print
// toolbar wired to that view's own functions.
var REPORT_SHELL_HANDLERS = {
  expiry: { excel: 'exportExpiryReportExcel', print: 'printExpiryReport' },
  valuation: { excel: 'exportValuationReportExcel', print: 'printValuationReport' },
  lowstock: { excel: 'exportLowStockReportExcel', print: 'printLowStockReport' },
  claims: { excel: 'exportClaimsExcel', print: 'printClaimsReport' },
  cash: { excel: 'cashExcel', print: 'cashPrint', need: 'cash_review' }
};

function drawReportsShell2(title) {
  var c = $('#content');
  var h = REPORT_SHELL_HANDLERS[reportsView] || {};
  if (h.need && !can(h.need)) h = {};
  c.innerHTML =
    reportsBackBtn() +
    reportHeadHtml(title, h.excel, h.print) +
    '<div id="reportBody"><div class="empty">Loading…</div></div>';
}

// Print and Excel need every sale of the period, not just the page on screen,
// so they fetch the full list (1000 at a time) when the button is tapped.
async function fetchAllReportSales() {
  var all = [], offset = 0, pageSize = 1000;
  while (true) {
    var page = await reportPageRpc(pageSize, offset);
    all = all.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function reportMethodLabel(s) {
  var pays = s.payments || [];
  return pays.map(function (p) { return p.method; }).join('+') || s.payment_method;
}

async function exportReportExcel() {
  if (!reportData) { toast('Report still loading.', 'bad'); return; }
  var sales;
  try { sales = await fetchAllReportSales(); } catch (e) { toast(friendlyError(e), 'bad'); return; }
  var rows = sales.map(function (s) {
    var pays = s.payments || [];
    return {
      'Invoice': s.invoice_number || '',
      'Date/time': new Date(s.sold_at).toLocaleString('en-GB'),
      'Discount': Number(s.discount_amount || 0),
      'Amount': Number(s.total_amount || 0),
      'Payment method(s)': reportMethodLabel(s),
      'Reference(s)': pays.map(function (p) { return p.reference || ''; }).filter(Boolean).join('; '),
      'Customer': s.customer_name || '',
      'Insurance scheme': s.insurance_scheme || '',
      'Reversed': s.voided ? 'Yes' : '',
      'Reversed by': s.voided ? (s.voided_by_name || '') : ''
    };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - sales - ' + reportRangeLabel() + ' - ' + todayStr() + '.xlsx', 'Sales', rows);
}

async function printReport() {
  if (!reportData) { toast('Report still loading.', 'bad'); return; }
  var sales;
  try { sales = await fetchAllReportSales(); } catch (e) { toast(friendlyError(e), 'bad'); return; }
  var rows = sales.map(reportSaleRow);
  printHtml('Sales Report', reportRangeLabel(),
    tableHtml(['Invoice', 'Date/time', 'Payment', 'Customer', 'Status', 'Amount'], rows,
      'Total sales: ' + fmt(reportData.total) + ' · ' + reportData.count + ' transactions'),
    reportData.count + ' transactions');
}

// One sale as table cells (screen and print share this): voided sales read in red text.
function reportSaleRow(s) {
  return [s.invoice_number || '—',
    new Date(s.sold_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    reportMethodLabel(s) ? payLabel(reportMethodLabel(s)) : '—', s.customer_name || '—',
    s.voided ? stCell('Reversed', 'bad') : stCell('Completed', 'ok'), fmt(s.total_amount)];
}

var reportTxPage = 1;
var reportLoadSeq = 0;  // bumped on every load so a slow, older answer never overwrites a newer one

// Where the chosen range begins (the device's own midnight / Sunday / 1st of the month,
// or the start of the custom From date).
function reportRangeStart() {
  if (reportRange === 'custom') return rangeBounds(reportFrom, reportTo).start;
  var start = new Date();
  if (reportRange === 'today') start.setHours(0, 0, 0, 0);
  else if (reportRange === 'week') { start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay()); }
  else { start = new Date(start.getFullYear(), start.getMonth(), 1); }
  return start.toISOString();
}
// Where it ends, NOT included: midnight after the custom To date. The presets run up to now (null).
function reportRangeEnd() {
  return reportRange === 'custom' ? rangeBounds(reportFrom, reportTo).end : null;
}

// One page of the transaction list, each sale carrying its payment lines.
async function reportPageRpc(limit, offset) {
  var res = await sb.rpc('sales_report_page', {
    p_pharmacy_id: STATE.profile.pharmacy_id, p_start: reportRangeStart(), p_end: reportRangeEnd(),
    p_limit: limit, p_offset: offset
  });
  if (res.error) throw res.error;
  return res.data || [];
}

// The database adds up the period (totals, payment methods, top drugs) and
// hands over only the first page of the list, so this stays fast and never
// hits URL-length limits however many sales the period holds.
async function loadReport() {
  drawReportsShell();
  reportTxPage = 1;
  var seq = ++reportLoadSeq;
  var sum, firstPage;
  try {
    var results = await Promise.all([
      sb.rpc('sales_report', { p_pharmacy_id: STATE.profile.pharmacy_id, p_start: reportRangeStart(), p_end: reportRangeEnd() }),
      reportPageRpc(REPORT_PAGE_SIZE, 0)
    ]);
    if (results[0].error) throw results[0].error;
    sum = results[0].data || {};
    firstPage = results[1];
  } catch (e) {
    if (seq !== reportLoadSeq) return;
    errorCard($('#reportBody'), friendlyError(e), 'loadReport');
    return;
  }
  if (seq !== reportLoadSeq) return;

  reportData = {
    sales: firstPage,
    total: Number(sum.total || 0),
    count: Number(sum.count || 0),
    byMethod: sum.by_method || {},
    topDrugs: (sum.top_drugs || []).map(function (t) { return { name: t.name, qty: Number(t.qty), value: Number(t.value) }; }),
    loadingMore: false
  };
  reportTxPage = 1;
  drawReportBody();
}

// Prev / Next on the transactions table: fetch just that page of 10.
async function goReportPage(page) {
  if (!reportData || reportData.loadingMore) return;
  var pages = Math.max(1, Math.ceil(reportData.count / REPORT_PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  reportData.loadingMore = true;
  var seq = reportLoadSeq;
  try {
    var rows = await reportPageRpc(REPORT_PAGE_SIZE, (page - 1) * REPORT_PAGE_SIZE);
    if (seq !== reportLoadSeq) return;
    reportData.sales = rows;
    reportTxPage = page;
  } catch (e) {
    toast(friendlyError(e), 'bad');
  }
  reportData.loadingMore = false;
  drawReportBody();
}

function drawReportBody() {
  var body = $('#reportBody');
  var sales = reportData.sales, byMethod = reportData.byMethod, topDrugs = reportData.topDrugs;
  var methods = Object.keys(byMethod);
  var pages = Math.max(1, Math.ceil(reportData.count / REPORT_PAGE_SIZE));
  var pg = { rows: sales, page: Math.min(reportTxPage, pages), pages: pages, total: reportData.count,
    from: reportData.count ? (reportTxPage - 1) * REPORT_PAGE_SIZE + 1 : 0,
    to: Math.min(reportTxPage * REPORT_PAGE_SIZE, reportData.count) };
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Total sales', fmt(reportData.total), 't-sales') +
    kpi('Transactions', reportData.count, 't-violet') +
    '</div>' +
    '<div class="section-title">By payment method</div>' +
    rtTable(['Method', 'Amount'], methods.map(function (m) { return [payLabel(m), fmt(byMethod[m])]; }), { empty: 'No sales in this period yet.' }) +
    '<div class="section-title">Top-selling drugs</div>' +
    rtTable(['Drug', 'Units sold', 'Value'], topDrugs.map(function (t) { return [t.name, String(t.qty), fmt(t.value)]; }), { empty: 'No sales in this period yet.' }) +
    '<div class="section-title">Transactions · ' + esc(reportRangeLabel()) + '</div>' +
    showingHtml(pg) +
    rtTable(['Invoice', 'Date/time', 'Payment', 'Customer', 'Status', 'Amount'], sales.map(reportSaleRow), {
      rowClick: function (i) { return "openSaleDetail('" + sales[i].id + "')"; }, empty: 'Nothing recorded in this period.' }) +
    pagerHtml(pg, 'goReportPage');
}

// The items of a sale are fetched only when someone opens it (one small query),
// instead of for every sale of the period up front.
async function openSaleDetail(saleId) {
  var s = reportData.sales.find(function (x) { return x.id === saleId; });
  if (!s) return;
  var pays = s.payments || [];
  var body = sheet((s.invoice_number || 'Sale detail') + (s.voided ? ' — REVERSED' : ''), '');
  body.innerHTML = '<div class="empty">Loading…</div>';
  var itemsRes = await sb.from('sale_items')
    .select('id, drug_id, quantity, unit_price, line_total, patient_name, prescriber_name, rx_number, drugs(name)')
    .eq('sale_id', saleId);
  if (itemsRes.error) { body.innerHTML = '<div class="empty">' + esc(friendlyError(itemsRes.error)) + '</div>'; return; }
  var items = itemsRes.data || [];
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:8px">' + new Date(s.sold_at).toLocaleString('en-GB') + (s.customer_name ? ' · ' + esc(s.customer_name) : '') + '</div>' +
    (s.voided ? '<div style="margin-bottom:10px;color:var(--red)">Reversed' + (s.voided_by_name ? ' by ' + esc(s.voided_by_name) : '') +
      (s.voided_at ? ' · ' + new Date(s.voided_at).toLocaleString('en-GB') : '') + (s.void_reason ? ' · ' + esc(s.void_reason) : '') + '</div>' : '') +
    '<div class="section-title" style="margin-top:0">Items</div>' +
    '<div class="card">' + items.map(function (it) {
      var name = it.drugs ? it.drugs.name : 'Unknown';
      return '<div class="list-row"><div><div class="name">' + esc(name) + (it.patient_name ? ' (' + esc(it.patient_name) + ')' : '') + (it.rx_number ? ' <span class="badge warn">Rx ' + esc(it.rx_number) + '</span>' : '') + '</div>' +
        '<div class="meta">' + it.quantity + ' × ' + fmt(it.unit_price) + '</div></div>' +
        '<div class="right">' + fmt(it.line_total) +
        (!s.voided && can('return') ? '<div><button class="btn small ghost" style="margin-top:4px" onclick="openReturnItem(\'' + it.id + '\',' + it.quantity + ',\'' + esc(name).replace(/'/g, "\\'") + '\')">Return</button></div>' : '') +
        '</div></div>';
    }).join('') + '</div>' +
    '<div class="section-title">Payments</div>' +
    '<div class="card">' + pays.map(function (p) {
      // listRow() escapes its name argument but not meta, and the reference is
      // free text typed at the till (M-Pesa code, scheme/member note).
      return listRow(payLabel(p.method), esc(p.reference || ''), fmt(p.amount));
    }).join('') +
    (Number(s.discount_amount) > 0
      ? '<div class="list-row"><div class="name">Bill</div><div class="name">' + fmt(s.subtotal) + '</div></div>' +
        '<div class="list-row"><div class="name">Discount</div><div class="name">−' + fmt(s.discount_amount) + '</div></div>' : '') +
    '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(s.total_amount) + '</div></div></div>' +
    (canReverseSale(s) ? '<button class="btn danger" onclick="openVoidSale(\'' + saleId + '\')">Reverse sale</button>' : '');
}

// The owner and pharmacists can reverse any sale. Everyone else can reverse the
// sale they made themselves today (the database enforces the same rule).
function canReverseSale(s) {
  if (s.voided) return false;
  if (can('void')) return true;
  return !!(STATE.profile && s.created_by && s.created_by === STATE.profile.id &&
    new Date(s.sold_at).toDateString() === new Date().toDateString());
}

function openReturnItem(saleItemId, maxQty, drugName) {
  var body = sheet('Return — ' + drugName, '');
  body.innerHTML =
    '<div class="field"><label>Quantity to return (max ' + maxQty + ')</label><input id="retQty" type="number" min="1" max="' + maxQty + '" value="1"></div>' +
    '<div class="field"><label>Reason (optional)</label><input id="retReason"></div>' +
    '<button class="btn danger" id="retSaveBtn" onclick="doReturnItem(\'' + saleItemId + '\')">Confirm return</button>';
}

async function doReturnItem(saleItemId) {
  var btn = $('#retSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#retQty').value, 10);
    if (!qty || qty < 1) { toast('Enter a valid quantity.', 'bad'); return; }
    var { error } = await sb.rpc('record_return', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_sale_item_id: saleItemId, p_quantity: qty,
      p_reason: $('#retReason').value.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Return recorded — stock restored.', 'good');
    closeSheet();
    loadReport();
  });
}

function openVoidSale(saleId) {
  var body = sheet('Reverse this sale?', '');
  body.innerHTML =
    '<div class="field"><label>Reason</label><input id="voidReason" placeholder="Required"></div>' +
    '<button class="btn danger" id="voidSaveBtn" onclick="doVoidSale(\'' + saleId + '\')">Reverse sale</button>';
}

async function doVoidSale(saleId) {
  var btn = $('#voidSaveBtn');
  act(btn, async function () {
    var reason = $('#voidReason').value.trim();
    if (!reason) { toast('A reason is required.', 'bad'); return; }
    var { error } = await sb.rpc('void_sale', { p_pharmacy_id: STATE.profile.pharmacy_id, p_sale_id: saleId, p_reason: reason });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Sale reversed.', 'good');
    closeSheet();
    loadReport();
  });
}

