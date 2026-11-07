// js/reports-stock.js - Expiry, Stock valuation and Low stock reports.
//
// --- Expiry dates report ---
// Every batch still in stock, grouped by urgency. Uses the same thresholds as
// the drug-detail batch list and Inventory's "unknown expiry" notice.

// Each category opens its own drill-down list, printable and exportable,
// 10 rows per page. Unknown-expiry rows can be edited right there.
// expiryReportData holds one flat array (`all`); every category, including the
// summary tile counts, is worked out from it by expiryCategoryRows(), so a
// tile, its list and its print can never disagree. Each category shows only
// its own rows, so far-future dates never read as part of the 90-day report.
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
    var { data: batches, error } = await fetchAllRows(function () {
      return sb.from('batches')
        .select('id, batch_no, quantity_remaining, expiry_date, expiry_unknown, drug_id, drugs(name, unit)')
        .eq('pharmacy_id', STATE.profile.pharmacy_id)
        .gt('quantity_remaining', 0)
        .order('expiry_date');
    }, 'id');
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

// Thresholds are cumulative (0-30, 0-90), not separate bands: a drug expiring
// in 12 days appears under both "30 Days" and "90 Days". Expired items are
// their own bucket.
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
  // Soonest or most overdue first. Unknown Expiry keeps insertion order (oldest
  // batch first), the same as Inventory's "fix later" list.
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
      // Every category except "custom" has one status, so meta.badge fits all rows.
      // A custom range can mix expired and future rows, so its badge colour is
      // chosen per row.
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

// Set a batch's expiry from the Unknown Expiry list. Uses the same RPC
// (set_batch_expiry) as Inventory, so the rules are identical.
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

// Print/export of the whole report (all categories). Reachable from the toolbar
// on the summary and on every drill-down.
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

// --- Stock valuation report ---
// What current stock is worth at cost and retail, drug by drug. Uses
// v_drug_stock's stock_value_cost and stock_value_retail.

async function loadValuationReport() {
  drawReportsShell2('Stock Valuation Report');
  try {
    var { data, error } = await fetchAllRows(function () { return sb.from('v_drug_stock').select('drug_id, name, unit, qty_in_stock, stock_value_cost, stock_value_retail').order('stock_value_retail', { ascending: false }); }, 'drug_id');
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

// One drug's figures. The view gives the value of ALL of a drug's stock; the
// per-unit cost and price are those values divided by quantity (an average when
// batches were bought at different prices). A cost of 0 means none was entered
// (sheet imports have selling prices only) and shows as a dash, not "KES 0".
function valuationUnitCost(r) {
  var q = Number(r.qty_in_stock) || 0;
  return q > 0 ? Number(r.stock_value_cost || 0) / q : 0;
}
function valuationUnitPrice(r) {
  var q = Number(r.qty_in_stock) || 0;
  return q > 0 ? Number(r.stock_value_retail || 0) / q : 0;
}
// "tablet" -> "tablets" unless the quantity is 1; short codes (ml, mg, g) stay as typed.
function valuationUnitWord(unit, qty) {
  var u = String(unit || 'unit');
  if (Number(qty) !== 1 && /^[A-Za-z]{4,}$/.test(u) && !/s$/i.test(u)) u += 's';
  return u;
}
function valuationLine(r) {
  var cost = valuationUnitCost(r);
  return r.qty_in_stock + ' ' + esc(valuationUnitWord(r.unit, r.qty_in_stock)) +
    ' · cost ' + (cost > 0 ? fmt(cost) : '–') +
    ' · price ' + fmt(valuationUnitPrice(r));
}

// One drug row: name and total value on the top line; quantity, cost and price
// on a line that never wraps (it shrinks a little on narrow phones).
function valuationRow(r) {
  return '<div class="val-row"><div class="val-top"><span class="name">' + esc(r.name) + '</span><span class="right">' + fmt(r.stock_value_retail) + '</span></div>' +
    '<div class="val-meta">' + valuationLine(r) + '</div></div>';
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
      return valuationRow(r);
    }).join('') : '<div class="empty">No stock recorded yet.</div>') + '</div>';
}

function printValuationReport() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(function (r) {
    var cost = valuationUnitCost(r);
    return [r.name, r.qty_in_stock + ' ' + valuationUnitWord(r.unit, r.qty_in_stock), cost > 0 ? fmt(cost) : '–', fmt(valuationUnitPrice(r)), fmt(r.stock_value_cost), fmt(r.stock_value_retail)];
  });
  printHtml('Stock Valuation Report', todayStr(),
    tableHtml(['Drug', 'Qty in stock', 'Unit cost', 'Unit price', 'Value (cost)', 'Value (retail)'], rows),
    'Total cost ' + fmt(valuationReportData.totalCost) + ' · Total retail ' + fmt(valuationReportData.totalRetail));
}

function exportValuationReportExcel() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(function (r) {
    return { 'Drug': r.name, 'Unit': r.unit, 'Qty in stock': r.qty_in_stock, 'Unit cost': Math.round(valuationUnitCost(r) * 100) / 100, 'Unit price': Math.round(valuationUnitPrice(r) * 100) / 100, 'Value (cost)': Number(r.stock_value_cost || 0), 'Value (retail)': Number(r.stock_value_retail || 0) };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - stock valuation - ' + todayStr() + '.xlsx', 'Valuation', rows);
}

// --- Low stock report ---
// Every drug at or below its reorder level with a suggested order quantity.
// Same formula as Inventory's reorder list (openReorderList), as a printable,
// exportable report.

async function loadLowStockReport() {
  drawReportsShell2('Low Stock Report');
  try {
    var { data, error } = await fetchAllRows(function () { return sb.from('v_drug_stock').select('drug_id, name, unit, qty_in_stock, reorder_level').order('name'); }, 'drug_id');
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

