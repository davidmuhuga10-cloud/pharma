// js/reports-stock.js - Expiry, Stock valuation and Low stock reports.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// EXPIRY DATES REPORT — every batch still in stock, bucketed by urgency.
// Reuses the same thresholds/logic as the drug-detail batch list and the
// Inventory "unknown expiry" notice (expiry_unknown, item 26).
// ---------------------------------------------------------------------------

// Item — user punch list: full per-category drill-down lists (not just a
// count), each independently printable/exportable, paginated 10-at-a-time,
// and (for Unknown Expiry) editable right there instead of only from
// Inventory's separate "fix later" list. expiryReportData now holds one
// FLAT array (`all`) rather than pre-split buckets — every category's
// membership (including the summary tiles' own counts) is computed on
// demand by expiryCategoryRows() from that one array, so the tile count,
// the drill-down list and the print/export can never drift out of sync
// with each other. That single source of truth is also the actual fix for
// the "90-day report shows dates out to 2028" bug: the bucketing math
// (days <= 90) was always correct, but the old layout printed every bucket
// — including "later than 90 days", genuinely containing far-future dates
// — one after another on the same unbroken page with no drill-down, so a
// reader scrolling past "Expiring soon" straight into "Later than 90 days"
// could easily read those as still being part of the 90-day report. Now
// clicking "Expiring in 90 Days" opens ONLY that category's own rows.
var expiryCategory = null; // null = summary tiles | 'expired' | 'within30' | 'within90' | 'unknown' | 'custom'
var expiryPage = 1;
var EXPIRY_PAGE_SIZE = 10;
var expiryCustomFrom = '';
var expiryCustomTo = '';

async function loadExpiryReport() {
  expiryCategory = null;
  expiryPage = 1;
  drawReportsShell2('Expiry Dates Report');
  try {
    var { data: batches, error } = await sb.from('batches')
      .select('id, batch_no, quantity_remaining, expiry_date, expiry_unknown, drug_id, drugs(name, unit)')
      .eq('pharmacy_id', STATE.profile.pharmacy_id)
      .gt('quantity_remaining', 0)
      .order('expiry_date');
    if (error) throw error;
    var all = (batches || []).map(function (b) {
      return {
        id: b.id, name: (b.drugs && b.drugs.name) || 'Unknown drug', unit: (b.drugs && b.drugs.unit) || 'unit',
        batch_no: b.batch_no, qty: b.quantity_remaining, expiry_date: b.expiry_date,
        expiry_unknown: !!b.expiry_unknown, days: b.expiry_unknown ? null : daysUntil(b.expiry_date)
      };
    });
    expiryReportData = { all: all, total: all.length };
    drawExpiryReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadExpiryReport');
  }
}

// Cumulative thresholds (0–30, 0–90), not mutually-exclusive bands — a drug
// expiring in 12 days is meant to show up under BOTH "Expiring in 30 Days"
// and "Expiring in 90 Days", since anyone pulling the 90-day list wants
// everything expiring that soon, urgent items included, not just the 31–90
// slice. Expired items are their own bucket and never double up into these.
function expiryCategoryRows(cat) {
  var all = (expiryReportData && expiryReportData.all) || [];
  if (cat === 'expired') return all.filter(function (r) { return !r.expiry_unknown && r.days < 0; });
  if (cat === 'within30') return all.filter(function (r) { return !r.expiry_unknown && r.days >= 0 && r.days <= 30; });
  if (cat === 'within90') return all.filter(function (r) { return !r.expiry_unknown && r.days >= 0 && r.days <= 90; });
  if (cat === 'unknown') return all.filter(function (r) { return r.expiry_unknown; });
  if (cat === 'custom') {
    if (!expiryCustomFrom || !expiryCustomTo) return [];
    return all.filter(function (r) { return !r.expiry_unknown && r.expiry_date >= expiryCustomFrom && r.expiry_date <= expiryCustomTo; });
  }
  return [];
}

var EXPIRY_CATEGORIES = [
  { key: 'expired', label: 'Expired', kind: 't-red' },
  { key: 'within30', label: 'Expiring in 30 Days', kind: 't-red' },
  { key: 'within90', label: 'Expiring in 90 Days', kind: 't-amber' },
  { key: 'unknown', label: 'Unknown Expiry', kind: 't-neutral' }
];

var EXPIRY_CATEGORY_META = {
  expired: { title: 'Expired', badge: 'bad', showDays: true },
  within30: { title: 'Expiring in 30 Days', badge: 'bad', showDays: true },
  within90: { title: 'Expiring in 90 Days', badge: 'warn', showDays: true },
  unknown: { title: 'Unknown Expiry', badge: 'muted', showDays: false },
  custom: { title: 'Custom range', badge: 'warn', showDays: true }
};

function drawExpiryReportBody() {
  var body = $('#reportBody');
  if (!body) return;
  if (!expiryCategory) { drawExpirySummary(body); return; }
  drawExpiryCategory(body);
}

function drawExpirySummary(body) {
  body.innerHTML =
    (expiryReportData.total ? (
      '<div class="kpi-grid" style="margin-bottom:14px">' +
      EXPIRY_CATEGORIES.map(function (c) {
        return '<button class="kpi kpi-clickable ' + c.kind + '" onclick="openExpiryCategory(\'' + c.key + '\')">' +
          '<div class="label">' + esc(c.label) + '</div><div class="value">' + expiryCategoryRows(c.key).length + '</div></button>';
      }).join('') +
      '</div>' +
      '<div class="card" style="margin-bottom:12px">' +
      '<div class="tiny" style="margin-bottom:8px;font-weight:700">Custom date range</div>' +
      '<div class="row-2">' +
      '<div class="field"><label>From</label><input id="expFrom" type="date" value="' + esc(expiryCustomFrom) + '"></div>' +
      '<div class="field"><label>To</label><input id="expTo" type="date" value="' + esc(expiryCustomTo) + '"></div>' +
      '</div>' +
      '<button class="btn primary small" onclick="applyExpiryCustomRange()">View list</button>' +
      '</div>'
    ) : '<div class="empty">No batches in stock yet.</div>');
}

function applyExpiryCustomRange() {
  var from = $('#expFrom') ? $('#expFrom').value : '';
  var to = $('#expTo') ? $('#expTo').value : '';
  if (!from || !to) { toast('Pick both a from and to date.', 'bad'); return; }
  if (from > to) { toast('The "from" date must be before the "to" date.', 'bad'); return; }
  expiryCustomFrom = from; expiryCustomTo = to;
  openExpiryCategory('custom');
}

function openExpiryCategory(cat) {
  expiryCategory = cat;
  expiryPage = 1;
  drawExpiryReportBody();
}

function closeExpiryCategory() {
  expiryCategory = null;
  drawExpiryReportBody();
}

function drawExpiryCategory(body) {
  var cat = expiryCategory;
  var meta = EXPIRY_CATEGORY_META[cat];
  var allRows = expiryCategoryRows(cat);
  // Soonest/most-overdue first, same urgency ordering the old fixed buckets
  // used; Unknown Expiry keeps insertion order (oldest batch first — same
  // as Inventory's own "fix later" list, so the two never disagree on
  // which one to fix first).
  if (cat !== 'unknown') allRows = allRows.slice().sort(function (a, b) { return a.days - b.days; });
  var rows = allRows.slice(0, expiryPage * EXPIRY_PAGE_SIZE);
  var title = cat === 'custom' ? ('Custom range: ' + fmtDate(expiryCustomFrom) + ' – ' + fmtDate(expiryCustomTo)) : meta.title;
  body.innerHTML =
    '<button class="btn ghost small" style="margin-bottom:10px" onclick="closeExpiryCategory()">&larr; Back to Expiry Dates Report</button>' +
    '<div class="section-title" style="margin-top:0">' + esc(title) + ' (' + allRows.length + ')</div>' +
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportExpiryCategoryExcel()">' + icon('download', 15) + ' Excel</button>' +
    '<button class="btn" onclick="printExpiryCategory()">' + icon('printer', 15) + ' Print</button>' +
    '</div></div>' +
    (cat === 'unknown' && allRows.length ? '<div class="tiny" style="margin-bottom:10px">Set the real expiry date once you have it — this only needs doing once per batch.</div>' : '') +
    (allRows.length ? (
      // Every category but "custom" has one status for all its rows, so
      // meta.badge (fixed red/amber/gray) is right for all of them. Custom
      // range can mix already-expired rows with still-future ones in the
      // same list, so its badge color is worked out per row instead —
      // otherwise an expired item in a custom range would wrongly show the
      // same amber "still has time" color as a not-yet-expired one.
      '<div class="card">' + rows.map(function (r) {
        var kind = meta.badge;
        if (cat === 'custom') kind = r.days < 0 ? 'bad' : (r.days <= 30 ? 'bad' : 'warn');
        return expiryRowHtml(r, kind, meta.showDays, cat === 'unknown');
      }).join('') + '</div>' +
      (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="expiryPage++;drawExpiryReportBody()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : '')
    ) : '<div class="empty">Nothing in this list.</div>');
}

function expiryRowHtml(r, kind, showDays, editable) {
  return '<div class="list-row"><div><div class="name">' + esc(r.name) + (r.batch_no ? ' · batch ' + esc(r.batch_no) : '') + '</div>' +
    '<div class="meta">' + r.qty + ' ' + esc(r.unit) + '</div></div>' +
    (editable ?
      '<div class="right" style="display:flex;gap:8px;align-items:center">' +
      '<input type="date" id="expInput_' + r.id + '">' +
      '<button class="btn small" id="expSaveBtn_' + r.id + '" onclick="saveExpiryReportRowDate(\'' + r.id + '\')">Save</button>' +
      '</div>'
      :
      '<div class="right"><span class="badge ' + kind + '">' + (r.expiry_date ? fmtDate(r.expiry_date) : 'No date set') + (showDays && typeof r.days === 'number' ? (r.days < 0 ? ' · ' + Math.abs(r.days) + 'd ago' : ' · ' + r.days + 'd left') : '') + '</span></div>'
    ) + '</div>';
}

// Lets a batch's expiry date be set right from the Unknown Expiry
// drill-down, not only from Inventory's separate list — same RPC
// (set_batch_expiry), so both places enforce the exact same rules.
async function saveExpiryReportRowDate(batchId) {
  var btn = $('#expSaveBtn_' + batchId);
  act(btn, async function () {
    var input = $('#expInput_' + batchId);
    var val = input ? input.value : '';
    if (!val) { toast('Pick a date first.', 'bad'); return; }
    var { error } = await sb.rpc('set_batch_expiry', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_expiry_date: val
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expiry date saved.', 'good');
    if (expiryReportData) expiryReportData.all = expiryReportData.all.filter(function (r) { return r.id !== batchId; });
    STATE.unknownExpiryBatches = (STATE.unknownExpiryBatches || []).filter(function (b) { return b.id !== batchId; });
    drawExpiryReportBody();
  });
}

function expiryCategoryExportRows(cat) {
  var rows = expiryCategoryRows(cat);
  if (cat !== 'unknown') rows = rows.slice().sort(function (a, b) { return a.days - b.days; });
  return rows.map(function (r) { return [r.name, r.batch_no || '', r.qty + ' ' + r.unit, r.expiry_date && !r.expiry_unknown ? fmtDate(r.expiry_date) : '—']; });
}

function printExpiryCategory() {
  if (!expiryCategory) return;
  var meta = EXPIRY_CATEGORY_META[expiryCategory];
  var title = expiryCategory === 'custom' ? ('Expiry — custom range: ' + fmtDate(expiryCustomFrom) + ' to ' + fmtDate(expiryCustomTo)) : ('Expiry — ' + meta.title);
  var rows = expiryCategoryExportRows(expiryCategory);
  printHtml(title, todayStr(), tableHtml(['Drug', 'Batch', 'Qty', 'Expiry date'], rows), rows.length + ' batches');
}

function exportExpiryCategoryExcel() {
  if (!expiryCategory) return;
  var meta = EXPIRY_CATEGORY_META[expiryCategory];
  var rows = expiryCategoryExportRows(expiryCategory).map(function (r) {
    return { 'Drug': r[0], 'Batch': r[1], 'Qty': r[2], 'Expiry date': r[3] };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - expiry - ' + (meta ? meta.title.toLowerCase().replace(/\s+/g, '-') : expiryCategory) + ' - ' + todayStr() + '.xlsx', 'Expiry', rows);
}

// Whole-report (every category combined) print/export — still reachable
// from the persistent shell toolbar at the top of both the summary and any
// drill-down, for a single combined list when that's what's wanted instead
// of one category at a time.
function expiryReportRows() {
  var all = (expiryReportData && expiryReportData.all) || [];
  function statusLabel(r) {
    if (r.expiry_unknown) return 'Unknown expiry';
    if (r.days < 0) return 'Expired';
    if (r.days <= 30) return 'Critical (≤30d)';
    if (r.days <= 90) return 'Soon (≤90d)';
    return 'Later';
  }
  return all.slice().sort(function (a, b) {
    var da = a.expiry_unknown ? Infinity : a.days, db = b.expiry_unknown ? Infinity : b.days;
    return da - db;
  }).map(function (r) {
    return [r.name, r.batch_no || '', r.qty + ' ' + r.unit, statusLabel(r), r.expiry_date && !r.expiry_unknown ? fmtDate(r.expiry_date) : '—'];
  });
}

function printExpiryReport() {
  if (!expiryReportData) { toast('Report still loading.', 'bad'); return; }
  printHtml('Expiry Dates Report', todayStr(),
    tableHtml(['Drug', 'Batch', 'Qty', 'Status', 'Expiry date'], expiryReportRows()),
    expiryReportData.total + ' batches in stock');
}

function exportExpiryReportExcel() {
  if (!expiryReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = expiryReportRows().map(function (r) {
    return { 'Drug': r[0], 'Batch': r[1], 'Qty': r[2], 'Status': r[3], 'Expiry date': r[4] };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - expiry - ' + todayStr() + '.xlsx', 'Expiry', rows);
}

// ---------------------------------------------------------------------------
// STOCK VALUATION REPORT — what current stock is worth, at cost and retail,
// drug by drug. Reuses v_drug_stock's stock_value_cost/stock_value_retail
// (already computed for Inventory's own export, item 26/27).
// ---------------------------------------------------------------------------

async function loadValuationReport() {
  drawReportsShell2('Stock Valuation Report');
  try {
    var { data, error } = await sb.from('v_drug_stock').select('drug_id, name, unit, qty_in_stock, stock_value_cost, stock_value_retail').order('stock_value_retail', { ascending: false });
    if (error) throw error;
    var rows = (data || []).filter(function (d) { return d.qty_in_stock > 0; });
    var totalCost = rows.reduce(function (a, d) { return a + Number(d.stock_value_cost || 0); }, 0);
    var totalRetail = rows.reduce(function (a, d) { return a + Number(d.stock_value_retail || 0); }, 0);
    valuationReportData = { rows: rows, totalCost: totalCost, totalRetail: totalRetail };
    drawValuationReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadValuationReport');
  }
}

function drawValuationReportBody() {
  var body = $('#reportBody');
  var d = valuationReportData;
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Value at cost', fmt(d.totalCost), 't-orange') +
    kpi('Value at retail', fmt(d.totalRetail), 't-sales') +
    kpi('Est. margin', fmt(d.totalRetail - d.totalCost), 't-green') +
    kpi('Drugs tracked', d.rows.length, 't-neutral') +
    '</div>' +
    '<div class="section-title">By drug</div>' +
    '<div class="card">' + (d.rows.length ? d.rows.map(function (r) {
      return listRow(r.name, r.qty_in_stock + ' ' + esc(r.unit) + ' · cost ' + fmt(r.stock_value_cost), fmt(r.stock_value_retail));
    }).join('') : '<div class="empty">No stock recorded yet.</div>') + '</div>';
}

function printValuationReport() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(function (r) { return [r.name, r.qty_in_stock + ' ' + r.unit, fmt(r.stock_value_cost), fmt(r.stock_value_retail)]; });
  printHtml('Stock Valuation Report', todayStr(),
    tableHtml(['Drug', 'Qty in stock', 'Value (cost)', 'Value (retail)'], rows),
    'Total cost ' + fmt(valuationReportData.totalCost) + ' · Total retail ' + fmt(valuationReportData.totalRetail));
}

function exportValuationReportExcel() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(function (r) {
    return { 'Drug': r.name, 'Unit': r.unit, 'Qty in stock': r.qty_in_stock, 'Value (cost)': Number(r.stock_value_cost || 0), 'Value (retail)': Number(r.stock_value_retail || 0) };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - stock valuation - ' + todayStr() + '.xlsx', 'Valuation', rows);
}

// ---------------------------------------------------------------------------
// LOW STOCK REPORT — every drug at or below its reorder level, with a
// suggested order quantity. Same formula as the Inventory reorder list
// (openReorderList), but as its own formal, printable/exportable report.
// ---------------------------------------------------------------------------

async function loadLowStockReport() {
  drawReportsShell2('Low Stock Report');
  try {
    var { data, error } = await sb.from('v_drug_stock').select('drug_id, name, unit, qty_in_stock, reorder_level').order('name');
    if (error) throw error;
    var rows = (data || []).filter(function (d) { return d.qty_in_stock <= d.reorder_level; }).map(function (d) {
      return { name: d.name, unit: d.unit, current: d.qty_in_stock, reorderLevel: d.reorder_level, suggested: Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5) };
    });
    lowStockReportData = { rows: rows };
    drawLowStockReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadLowStockReport');
  }
}

function drawLowStockReportBody() {
  var body = $('#reportBody');
  var rows = lowStockReportData.rows;
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Need reordering', rows.length, rows.length ? 't-red' : 't-neutral') +
    '</div>' +
    '<div class="card">' + (rows.length ? rows.map(function (n) {
      return listRow(n.name, 'Have ' + n.current + ' ' + esc(n.unit) + ' · reorder level ' + n.reorderLevel, '<b>Order ' + n.suggested + '</b>');
    }).join('') : '<div class="empty">Nothing needs reordering right now.</div>') + '</div>';
}

function printLowStockReport() {
  if (!lowStockReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = lowStockReportData.rows.map(function (n) { return [n.name, n.current + ' ' + n.unit, n.reorderLevel, n.suggested]; });
  printHtml('Low Stock Report', todayStr(), tableHtml(['Drug', 'Current stock', 'Reorder level', 'Suggested order'], rows), rows.length + ' drugs need reordering');
}

function exportLowStockReportExcel() {
  if (!lowStockReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = lowStockReportData.rows.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - low stock - ' + todayStr() + '.xlsx', 'Low stock', rows);
}

// ---------------------------------------------------------------------------
