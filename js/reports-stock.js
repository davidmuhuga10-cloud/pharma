// js/reports-stock.js - Expiry, Stock valuation and Low stock reports.
//
// --- Expiry dates report ---
// Every batch still in stock, grouped by urgency. Uses the same thresholds as
// the drug-detail batch list and Inventory's "unknown expiry" notice.

// One screen: five tiles pick what to list (All needing attention, Expired, 30 days,
// 90 days, Unknown expiry), a From-To bar lists the batches expiring in any window, and
// the table shows 10 rows at a time. Excel and Print carry the WHOLE selected list.
// expiryReportData holds one flat array (`all`); every tile count and every list is
// worked out from it by expiryCategoryRows(), so a tile, its list, its print and its
// Excel can never disagree.
var expiryCategory = 'all'; // 'all' (needing attention) | 'expired' | 'within30' | 'within90' | 'unknown' | 'custom' | 'full' (every batch)
var expiryPage = 1;
var expiryCustomFrom = '';
var expiryCustomTo = '';

async function loadExpiryReport() {
  expiryCategory = 'all';
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

// "All batches" ('full') is every batch in stock, whatever its date, so the whole list can be printed.
// Thresholds are cumulative (0-30, 0-90), not separate bands: a drug expiring
// in 12 days appears under both "30 Days" and "90 Days". Expired items are
// their own bucket, and "All needing attention" is expired + the next 90 days + unknown.
function expiryCategoryRows(cat) {
  var all = (expiryReportData && expiryReportData.all) || [];
  if (cat === 'all') return all.filter(function (r) { return r.expiry_unknown || r.days <= 90; });
  if (cat === 'full') return all.slice();
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

// Soonest or most overdue first; batches with no date go last, oldest batch first.
function expirySorted(cat) {
  return expiryCategoryRows(cat).slice().sort(function (a, b) {
    var da = a.expiry_unknown ? Infinity : a.days, db = b.expiry_unknown ? Infinity : b.days;
    return da === db ? 0 : (da < db ? -1 : 1);
  });
}

var EXPIRY_CATEGORIES = [
  { key: 'all', label: 'All needing attention', kind: 't-neutral', title: 'All needing attention' },
  { key: 'expired', label: 'Expired', kind: 't-red', title: 'Expired' },
  { key: 'within30', label: 'Expiring in 30 days', kind: 't-red', title: 'Expiring in 30 days' },
  { key: 'within90', label: 'Expiring in 90 days', kind: 't-amber', title: 'Expiring in 90 days' },
  { key: 'unknown', label: 'Unknown expiry', kind: 't-neutral', title: 'Unknown expiry' },
  { key: 'full', label: 'All batches', kind: '', title: 'All batches (full list)' }
];

function expiryTitle(cat) {
  if (cat === 'custom') return 'Expiring ' + fmtDate(expiryCustomFrom) + ' to ' + fmtDate(expiryCustomTo);
  var m = EXPIRY_CATEGORIES.filter(function (c) { return c.key === cat; })[0];
  return m ? m.title : cat;
}

// Status is plain coloured text: red for expired and the next 30 days, amber for
// the next 90, black for no date or later.
function expiryStatus(r) {
  if (r.expiry_unknown) return { text: 'No date', tone: 'ink' };
  if (r.days < 0) return { text: 'Expired · ' + Math.abs(r.days) + 'd ago', tone: 'bad' };
  if (r.days <= 30) return { text: 'Within 30 days · ' + r.days + 'd left', tone: 'bad' };
  if (r.days <= 90) return { text: 'Within 90 days · ' + r.days + 'd left', tone: 'warn' };
  return { text: 'Later · ' + r.days + 'd left', tone: 'ink' };
}

function expiryRowCells(r, editable) {
  var st = expiryStatus(r);
  var dateCell = editable ?
    { html: '<span style="display:inline-flex;gap:8px;align-items:center"><input type="date" id="expInput_' + esc(r.id) + '">' +
      '<button class="btn small" id="expSaveBtn_' + esc(r.id) + '" onclick="saveExpiryReportRowDate(\'' + esc(r.id) + '\')">Save</button></span>' }
    : (r.expiry_date && !r.expiry_unknown ? fmtDate(r.expiry_date) : 'No date set');
  return [r.name, r.batch_no || '—', r.qty + ' ' + r.unit, dateCell, stCell(st.text, st.tone)];
}

function drawExpiryReportBody() {
  var body = $('#reportBody');
  if (!body) return;
  if (!expiryReportData.total) { body.innerHTML = '<div class="empty">No batches in stock yet.</div>'; return; }
  var cat = expiryCategory;
  var rows = expirySorted(cat);
  var pg = pageSlice(rows, expiryPage);
  expiryPage = pg.page;
  body.innerHTML =
    '<div class="kpi-grid six" style="margin-bottom:14px">' +
    EXPIRY_CATEGORIES.map(function (c) {
      return '<button class="kpi kpi-clickable ' + c.kind + (cat === c.key ? ' active' : '') + '" onclick="openExpiryCategory(\'' + c.key + '\')">' +
        '<div class="label">' + esc(c.label) + '</div><div class="value">' + expiryCategoryRows(c.key).length + '</div></button>';
    }).join('') +
    '</div>' +
    '<div class="range-bar"><div class="range-dates">' +
    '<label>Expiring from <input type="date" id="rbFrom" value="' + esc(expiryCustomFrom) + '"></label>' +
    '<label>to <input type="date" id="rbTo" value="' + esc(expiryCustomTo) + '"></label>' +
    '<button class="btn small' + (cat === 'custom' ? ' primary' : '') + '" onclick="applyExpiryCustomRange()">Apply</button>' +
    '</div></div>' +
    '<div class="section-title" style="margin-top:6px">' + esc(expiryTitle(cat)) + '</div>' +
    (cat === 'unknown' && rows.length ? '<div class="rt-note">Set the real expiry date once you have it. This only needs doing once per batch.</div>' : '') +
    showingHtml(pg) +
    rtTable(['Drug', 'Batch', 'Qty', 'Expiry date', 'Status'], pg.rows.map(function (r) { return expiryRowCells(r, r.expiry_unknown); }),
      { empty: 'Nothing in this list.', num: [false, false, false, false, false] }) +
    pagerHtml(pg, 'goExpiryPage');
}

function goExpiryPage(p) { expiryPage = p; drawExpiryReportBody(); }

function applyExpiryCustomRange() {
  var r = rangeBarRead(), err = rangeError(r.from, r.to);
  if (err) { toast(err, 'bad'); return; }
  expiryCustomFrom = r.from; expiryCustomTo = r.to;
  openExpiryCategory('custom');
}

function openExpiryCategory(cat) {
  expiryCategory = cat;
  expiryPage = 1;
  drawExpiryReportBody();
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
    // The batch now has a real date: put it back in the list with that date instead of dropping it.
    if (expiryReportData) {
      expiryReportData.all.forEach(function (r) {
        if (r.id === batchId) { r.expiry_unknown = false; r.expiry_date = val; r.days = daysUntil(val); }
      });
    }
    STATE.unknownExpiryBatches = (STATE.unknownExpiryBatches || []).filter(function (b) { return b.id !== batchId; });
    drawExpiryReportBody();
  });
}

// Print and Excel carry the whole selected list (every page), in the order on screen.
function expiryExportRows() {
  return expirySorted(expiryCategory).map(function (r) { return expiryRowCells(r, false); });
}

function printExpiryReport() {
  if (!expiryReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = expiryExportRows();
  printHtml('Expiry Dates Report', expiryTitle(expiryCategory),
    tableHtml(['Drug', 'Batch', 'Qty', 'Expiry date', 'Status'], rows, 'Total: ' + rows.length + ' batches'),
    rows.length + ' batches · ' + expiryCategoryRows('expired').length + ' expired · ' + expiryCategoryRows('within30').length + ' within 30 days · ' +
    expiryCategoryRows('unknown').length + ' with no date');
}

function exportExpiryReportExcel() {
  if (!expiryReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = expiryExportRows().map(function (r) {
    return { 'Drug': r[0], 'Batch': r[1] === '—' ? '' : r[1], 'Qty': r[2], 'Expiry date': r[3], 'Status': r[4].t };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - expiry - ' + expiryTitle(expiryCategory).toLowerCase().replace(/[^a-z0-9]+/g, '-') + ' - ' + todayStr() + '.xlsx', 'Expiry', rows);
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
    valuationPage = 1;
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

// One drug as table cells (screen, print and valuationRow's older one-line form agree on the maths).
var valuationPage = 1;
function valuationCells(r) {
  var cost = valuationUnitCost(r);
  return [r.name, r.qty_in_stock + ' ' + valuationUnitWord(r.unit, r.qty_in_stock), cost > 0 ? fmt(cost) : '–',
    fmt(valuationUnitPrice(r)), fmt(r.stock_value_cost), fmt(r.stock_value_retail)];
}
var VALUATION_COLS = ['Drug', 'Qty in stock', 'Unit cost', 'Unit price', 'Value (cost)', 'Value (retail)'];

function drawValuationReportBody() {
  var body = $('#reportBody');
  var d = valuationReportData;
  var pg = pageSlice(d.rows, valuationPage);
  valuationPage = pg.page;
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Value at cost', fmt(d.totalCost), 't-orange') +
    kpi('Value at retail', fmt(d.totalRetail), 't-sales') +
    kpi('Est. margin', fmt(d.totalRetail - d.totalCost), 't-green') +
    kpi('Drugs tracked', d.rows.length, 't-neutral') +
    '</div>' +
    '<div class="section-title">By drug</div>' +
    showingHtml(pg) +
    rtTable(VALUATION_COLS, pg.rows.map(valuationCells), { empty: 'No stock recorded yet.', num: [false, true, true, true, true, true] }) +
    pagerHtml(pg, 'goValuationPage');
}
function goValuationPage(p) { valuationPage = p; drawValuationReportBody(); }

function printValuationReport() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(valuationCells);
  printHtml('Stock Valuation Report', todayStr(),
    tableHtml(VALUATION_COLS, rows, 'Total cost ' + fmt(valuationReportData.totalCost) + ' · Total retail ' + fmt(valuationReportData.totalRetail)),
    rows.length + ' drugs in stock');
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
    lowStockPage = 1;
    drawLowStockReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadLowStockReport');
  }
}

var lowStockPage = 1;
var LOWSTOCK_COLS = ['Drug', 'Current stock', 'Reorder level', 'Suggested order', 'Status'];
function lowStockCells(n) {
  return [n.name, n.current + ' ' + n.unit, n.reorderLevel, n.suggested, n.current <= 0 ? stCell('Out of stock', 'bad') : stCell('Low', 'warn')];
}

function drawLowStockReportBody() {
  var body = $('#reportBody');
  var rows = lowStockReportData.rows;
  var pg = pageSlice(rows, lowStockPage);
  lowStockPage = pg.page;
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Need reordering', rows.length, rows.length ? 't-red' : 't-neutral') +
    kpi('Out of stock', rows.filter(function (n) { return n.current <= 0; }).length, 't-neutral') +
    '</div>' +
    (rows.length && can('suppliers') ? '<button class="btn primary small" style="margin-bottom:10px" onclick="openSupplierOrder()">' + icon('wallet', 15) + ' Order by WhatsApp</button>' : '') +
    showingHtml(pg) +
    rtTable(LOWSTOCK_COLS, pg.rows.map(lowStockCells), { empty: 'Nothing needs reordering right now.', num: [false, false, true, true, false] }) +
    pagerHtml(pg, 'goLowStockPage');
}
function goLowStockPage(p) { lowStockPage = p; drawLowStockReportBody(); }

function printLowStockReport() {
  if (!lowStockReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = lowStockReportData.rows.map(lowStockCells);
  printHtml('Low Stock Report', todayStr(), tableHtml(LOWSTOCK_COLS, rows, 'Total: ' + rows.length + ' drugs need reordering'), rows.length + ' drugs need reordering');
}

function exportLowStockReportExcel() {
  if (!lowStockReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = lowStockReportData.rows.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - low stock - ' + todayStr() + '.xlsx', 'Low stock', rows);
}

