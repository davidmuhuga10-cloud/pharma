// js/controlled-stocktake.js - Controlled drugs register, Stock take, and small dashboard/drug-detail strips for them.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// CONTROLLED DRUGS — register and ledger
// ---------------------------------------------------------------------------

var CONTROL_LABEL = { dda: 'DDA', psy: 'Psychotropic', none: 'Not controlled' };
var CONTROL_LONG = { dda: 'Dangerous drug (DDA)', psy: 'Psychotropic substance', none: 'Not controlled' };
var LEDGER_KIND = { opening: 'Opening balance', restock: 'Received', sale: 'Sold', 'return': 'Returned', 'void': 'Sale voided',
  correction: 'Count corrected', write_off: 'Written off', expired_disposal: 'Expired, disposed', stock_take: 'Stock take' };
var controlledCache = [];
var controlledDetailId = null;
var controlledLedger = null;   // { drug, rows }
var controlledNames = {};

function canSeeControlled() { return can('controlled') || can('view_controlled'); }

async function renderControlled() {
  var c = $('#content');
  if (!canSeeControlled()) { c.innerHTML = '<div class="card empty">You do not have access to the controlled drugs register.</div>'; return; }
  if (controlledDetailId) { openControlledLedger(controlledDetailId); return; }
  c.innerHTML = '<div class="empty">Loading register…</div>';
  try {
    var r = await sb.from('v_controlled_register').select('*').order('name');
    if (r.error) throw r.error;
    controlledCache = r.data || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderControlled');
    return;
  }
  drawControlled();
}
function drawControlled() {
  var c = $('#content');
  var bad = controlledCache.filter(function (r) { return Number(r.shelf_qty) !== Number(r.ledger_qty); });
  c.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' + kpi('Controlled drugs', controlledCache.length, 't-violet') +
    kpi('Not matching ledger', bad.length, bad.length ? 't-red' : 't-green') + '</div>' +
    '<div class="tiny" style="margin-bottom:10px">Every movement of these drugs (received, sold with patient and prescription, returned, corrected, written off) is recorded automatically and cannot be edited. Selling one asks for the patient, the prescriber and the prescription number.</div>' +
    (can('controlled') ? '<div class="toolbar-row"><button class="btn primary" onclick="openMarkControlled()">+ Mark a drug as controlled</button></div>' : '') +
    (bad.length ? '<div class="inline-notice">' + icon('warn', 15) + '<span>' + bad.length + (bad.length === 1 ? ' drug has' : ' drugs have') + ' a shelf figure that differs from its ledger. Open it, then count it in Stock take.</span></div>' : '') +
    '<div class="card">' + (controlledCache.length ? controlledCache.map(function (r) {
      var diff = Number(r.shelf_qty) !== Number(r.ledger_qty);
      return '<div class="list-row" style="cursor:pointer" onclick="openControlledLedger(\'' + r.drug_id + '\')">' +
        '<div><div class="name">' + esc(r.name) + ' <span class="badge ' + (r.control_class === 'dda' ? 'bad' : 'warn') + '">' + CONTROL_LABEL[r.control_class] + '</span></div>' +
        '<div class="meta">' + (r.last_movement ? 'last movement ' + fmtDateTime(r.last_movement) : 'no movements yet') + '</div></div>' +
        '<div class="right"><div class="name">' + esc(qtyUnit(r.shelf_qty, r.unit)) + '</div>' +
        (diff ? '<span class="badge bad">Ledger says ' + r.ledger_qty + '</span>' : '<span class="badge good">Matches</span>') + '</div></div>';
    }).join('') : '<div class="empty">No drug is marked as controlled yet. Mark morphine, pethidine, diazepam and similar drugs to start their register.</div>') + '</div>';
}
async function openMarkControlled() {
  var body = sheet('Mark a drug as controlled', '<div class="empty">Loading…</div>');
  var list = [];
  try {
    var r = await sb.from('v_drug_stock').select('drug_id,name,control_class').order('name');
    if (r.error) throw r.error;
    list = (r.data || []).filter(function (d) { return d.control_class === 'none'; });
  } catch (e) { $('#sheetBody').innerHTML = '<div class="empty">' + esc(friendlyError(e)) + '</div>'; return; }
  $('#sheetBody').innerHTML =
    '<div class="field"><label>Drug</label><select id="mcDrug">' + list.map(function (d) { return '<option value="' + d.drug_id + '">' + esc(d.name) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>Type</label><select id="mcClass"><option value="dda">Dangerous drug (DDA)</option><option value="psy">Psychotropic substance</option></select></div>' +
    '<div class="tiny" style="margin-bottom:10px">The register starts with what is on the shelf now. From then on every sale needs a patient, prescriber and prescription number.</div>' +
    '<button class="btn primary" id="mcSaveBtn" onclick="doMarkControlled()">Mark as controlled</button>';
  if (!list.length) $('#sheetBody').innerHTML = '<div class="empty">Every drug is already marked, or there are no drugs yet.</div>';
}
function doMarkControlled() {
  act($('#mcSaveBtn'), async function () {
    await rpcCall('set_drug_control', { p_pharmacy_id: STATE.profile.pharmacy_id, p_drug_id: $('#mcDrug').value, p_class: $('#mcClass').value });
    closeSheet();
    toast('Marked as controlled.', 'good');
    renderControlled();
  });
}
function retryControlledLedger() { if (controlledDetailId) openControlledLedger(controlledDetailId); }
async function openControlledLedger(drugId) {
  controlledDetailId = drugId;
  STATE.tab = 'controlled';
  var c = $('#content');
  if (!c) return;
  c.innerHTML = '<div class="empty">Loading ledger…</div>';
  try {
    var reg = await sb.from('v_controlled_register').select('*').eq('drug_id', drugId).maybeSingle();
    if (reg.error) throw reg.error;
    var led = await sb.from('controlled_ledger').select('*, sales(invoice_number), profiles(full_name)').eq('drug_id', drugId).order('seq', { ascending: false }).limit(300);
    if (led.error) throw led.error;
    controlledLedger = { drug: reg.data, rows: led.data || [] };
  } catch (e) {
    errorCard(c, friendlyError(e), 'retryControlledLedger');
    return;
  }
  drawControlledLedger();
}
function closeControlledLedger() { controlledDetailId = null; controlledLedger = null; renderControlled(); }
function ledgerDetailText(r) {
  var bits = [];
  if (r.patient_name) bits.push('Patient: ' + r.patient_name);
  if (r.prescriber_name) bits.push('Prescriber: ' + r.prescriber_name);
  if (r.rx_number) bits.push('Rx ' + r.rx_number);
  if (r.sales && r.sales.invoice_number) bits.push(r.sales.invoice_number);
  if (r.note && r.note !== LEDGER_KIND[r.kind]) bits.push(r.note);
  return bits.join(' · ');
}
function drawControlledLedger() {
  var c = $('#content');
  var d = controlledLedger.drug;
  if (!d) { c.innerHTML = backBtn('closeControlledLedger()', 'Register') + '<div class="card empty">This drug is no longer on the register.</div>'; return; }
  var rows = controlledLedger.rows;
  var diff = Number(d.shelf_qty) !== Number(d.ledger_qty);
  c.innerHTML =
    backBtn('closeControlledLedger()', 'Register') +
    '<div class="card" style="margin-bottom:12px"><div class="name" style="font-size:18px;font-weight:700">' + esc(d.name) + ' <span class="badge ' + (d.control_class === 'dda' ? 'bad' : 'warn') + '">' + CONTROL_LONG[d.control_class] + '</span></div></div>' +
    '<div class="kpi-grid" style="margin-bottom:12px">' + kpi('On the shelf', Number(d.shelf_qty).toLocaleString() + ' <span style="font-size:13px;font-weight:600">' + esc(d.unit) + '</span>', 't-sales') +
    kpi('Ledger balance', Number(d.ledger_qty).toLocaleString() + ' <span style="font-size:13px;font-weight:600">' + esc(d.unit) + '</span>', diff ? 't-red' : 't-green') + '</div>' +
    (diff ? '<div class="inline-notice">' + icon('warn', 15) + '<span>The shelf figure and the ledger differ. Count it in Stock take so the difference is explained and recorded.</span></div>' : '') +
    '<div class="toolbar-row"><button class="btn ghost" onclick="exportControlledLedger()">' + icon('download', 15) + ' Excel</button>' +
    '<button class="btn ghost" onclick="printControlledLedger()">' + icon('printer', 15) + ' Print</button></div>' +
    '<div class="card">' + (rows.length ? rows.map(function (r) {
      var q = Number(r.quantity_delta);
      return '<div class="list-row" style="align-items:flex-start"><div style="min-width:0"><div class="name">' + esc(LEDGER_KIND[r.kind] || r.kind) + '</div>' +
        '<div class="meta wrap">' + esc(ledgerDetailText(r)) + '</div>' +
        '<div class="meta">' + esc(fmtDateTime(r.entry_at) + (r.profiles && r.profiles.full_name ? ' · ' + r.profiles.full_name : '')) + '</div></div>' +
        '<div class="right"><div class="name" style="color:' + (q < 0 ? 'var(--red)' : 'var(--green)') + '">' + (q > 0 ? '+' : '') + q + '</div><div class="meta">Balance ' + r.balance_after + '</div></div></div>';
    }).join('') : '<div class="empty">No movements yet.</div>') + '</div>' +
    (rows.length >= 300 ? '<div class="tiny" style="margin-top:8px">Showing the latest 300 movements.</div>' : '');
}
function ledgerExportRows() {
  var d = controlledLedger.drug;
  return controlledLedger.rows.slice().reverse().map(function (r) {
    return { 'Date': fmtDateTime(r.entry_at), 'Drug': d.name, 'Movement': LEDGER_KIND[r.kind] || r.kind, 'Quantity': r.quantity_delta,
      'Balance after': r.balance_after, 'Patient': r.patient_name || '', 'Prescriber': r.prescriber_name || '', 'Rx number': r.rx_number || '',
      'Invoice': (r.sales && r.sales.invoice_number) || '', 'Note': r.note || '', 'By': (r.profiles && r.profiles.full_name) || '' };
  });
}
function exportControlledLedger() {
  exportExcel('controlled-drug-register-' + controlledLedger.drug.name.replace(/[^a-z0-9]+/gi, '-') + '.xlsx', 'Register', ledgerExportRows());
}
function printControlledLedger() {
  var d = controlledLedger.drug;
  var rows = ledgerExportRows().map(function (r) { return [r['Date'], r['Movement'], r['Quantity'], r['Balance after'], [r['Patient'], r['Prescriber'], r['Rx number'] ? 'Rx ' + r['Rx number'] : '', r['Invoice'], r['Note']].filter(Boolean).join(' · '), r['By']]; });
  printHtml('Controlled drug register', d.name + ' (' + CONTROL_LONG[d.control_class] + ')',
    '<p style="margin:4px 0">Balance now: <b>' + esc(qtyUnit(d.ledger_qty, d.unit)) + '</b></p>' + tableHtml(['Date', 'Movement', 'Qty', 'Balance', 'Details', 'By'], rows));
}

// ---------------------------------------------------------------------------
// STOCK TAKE — count the shelf, see the differences, approve
// ---------------------------------------------------------------------------

var stockTakes = [];        // recent stock takes, newest first
var stOpen = null;          // the open one, if any
var stItems = {};           // drug_id -> { system_qty, counted_qty }
var stDrugs = [];           // v_drug_stock rows
var stFilter = '';
var stPage = 1;
var stViewing = null;       // a closed stock take being read

function canCountStock() { return can('stock_take'); }

async function renderStockTake() {
  var c = $('#content');
  if (!canCountStock() && !can('view_inventory')) { c.innerHTML = '<div class="card empty">You do not have access to Stock take.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading stock take…</div>';
  try {
    var r = await sb.from('stock_takes').select('*').order('created_at', { ascending: false }).limit(20);
    if (r.error) throw r.error;
    stockTakes = r.data || [];
    stOpen = stockTakes.find(function (t) { return t.status === 'open'; }) || null;
    stItems = {};
    if (stOpen) {
      var res = await Promise.all([
        sb.from('stock_take_items').select('drug_id,system_qty,counted_qty').eq('take_id', stOpen.id),
        sb.from('v_drug_stock').select('drug_id,name,unit,qty_in_stock,qty_expired,stock_value_cost').order('name')
      ]);
      if (res[0].error) throw res[0].error;
      if (res[1].error) throw res[1].error;
      (res[0].data || []).forEach(function (i) { stItems[i.drug_id] = i; });
      stDrugs = res[1].data || [];
    }
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderStockTake');
    return;
  }
  stViewing = null;
  drawStockTake();
}
function stCountedN() { return Object.keys(stItems).length; }
function stDiffN() { return Object.keys(stItems).filter(function (k) { return stItems[k].counted_qty !== stItems[k].system_qty; }).length; }

function drawStockTake() {
  var c = $('#content');
  if (stViewing) { drawStockTakeView(); return; }
  if (!stOpen) {
    c.innerHTML =
      '<div class="tiny" style="margin-bottom:10px">Count what is really on the shelves. Pharma shows the difference from what the system says, you give a reason for each, and one approval makes the system match the shelf. Sales can carry on while you count.</div>' +
      (canCountStock() ? '<div class="toolbar-row"><button class="btn primary" onclick="openStartStockTake()">Start a stock take</button></div>' : '') +
      '<div class="section-title">Past stock takes</div>' +
      '<div class="card">' + (stockTakes.length ? stockTakes.map(function (t) {
        var badge = t.status === 'approved' ? '<span class="badge good">Done</span>' : '<span class="badge warn">Cancelled</span>';
        var v = t.total_cost_variance != null ? Number(t.total_cost_variance) : null;
        return '<div class="list-row" style="cursor:pointer" onclick="openStockTakeView(\'' + t.id + '\')"><div><div class="name">' + esc(t.label) + '</div>' +
          '<div class="meta">' + esc(fmtDateTime(t.created_at)) + (v != null ? ' · ' + (v < 0 ? 'lost ' + fmt(-v) : v > 0 ? 'gained ' + fmt(v) : 'no change in value') + ' at cost' : '') + '</div></div>' +
          '<div class="right">' + badge + '</div></div>';
      }).join('') : '<div class="empty">No stock takes yet.</div>') + '</div>';
    return;
  }
  var q = stFilter.toLowerCase();
  var rows = stDrugs.filter(function (d) { return !q || d.name.toLowerCase().indexOf(q) !== -1; });
  // counted ones first, then the rest by name
  rows.sort(function (a, b) { var ca = stItems[a.drug_id] ? 0 : 1, cb = stItems[b.drug_id] ? 0 : 1; return ca - cb || a.name.localeCompare(b.name); });
  var shown = rows.slice(0, stPage * 40);
  c.innerHTML =
    '<div class="card" style="margin-bottom:12px"><div class="name" style="font-weight:700">' + esc(stOpen.label) + '</div>' +
    '<div class="meta" id="stProgress">' + stProgressText() + '</div></div>' +
    '<div class="searchbox field"><input id="stSearchInput" placeholder="Search a drug to count…" value="' + esc(stFilter) + '" oninput="stFilter=this.value;stPage=1;drawStockTake()"></div>' +
    '<div class="toolbar-row">' +
    (can('approve_stock_take') ? '<button class="btn primary" onclick="openStockTakeReview()">Review &amp; approve</button>' : '<div class="tiny">When you have finished counting, a pharmacist or the owner approves the differences.</div>') +
    (can('approve_stock_take') ? '<button class="btn ghost" onclick="openCancelStockTake()">Cancel stock take</button>' : '') + '</div>' +
    '<div class="card">' + (shown.length ? shown.map(stRowHtml).join('') : '<div class="empty">No drug matches that search.</div>') + '</div>' +
    (rows.length > shown.length ? '<button class="btn ghost" style="margin-top:10px" onclick="stPage++;drawStockTake()">Show more (' + (rows.length - shown.length) + ')</button>' : '');
}
function stProgressText() {
  var n = stCountedN(), diff = stDiffN();
  return n + (n === 1 ? ' drug counted' : ' drugs counted') + ' · ' + diff + (diff === 1 ? ' difference' : ' differences');
}
function stDiffBadge(drugId) {
  var it = stItems[drugId];
  if (!it) return '';
  var d = it.counted_qty - it.system_qty;
  return d === 0 ? '<span class="badge good">Matches</span>' : '<span class="badge ' + (d < 0 ? 'bad' : 'warn') + '">' + (d > 0 ? '+' : '') + d + '</span>';
}
function stRowHtml(d) {
  var it = stItems[d.drug_id];
  var sys = Number(d.qty_in_stock) + Number(d.qty_expired);
  return '<div class="list-row" id="strow-' + d.drug_id + '"><div style="min-width:0"><div class="name">' + esc(d.name) + '</div>' +
    '<div class="meta">System says ' + esc(qtyUnit(sys, d.unit)) + (it && it.system_qty !== sys ? ' (was ' + it.system_qty + ' when counted)' : '') + '</div></div>' +
    '<div class="right" style="display:flex;align-items:center;gap:8px"><span id="stbadge-' + d.drug_id + '">' + stDiffBadge(d.drug_id) + '</span>' +
    (canCountStock() ? '<input type="number" min="0" inputmode="numeric" class="stcount" style="width:84px" placeholder="Count" value="' + (it ? it.counted_qty : '') + '" onchange="stCount(\'' + d.drug_id + '\',this)">' : '') + '</div></div>';
}
async function stCount(drugId, el) {
  var raw = el.value.trim();
  try {
    if (raw === '') {
      if (stItems[drugId]) await rpcCall('stock_take_remove_count', { p_pharmacy_id: STATE.profile.pharmacy_id, p_take_id: stOpen.id, p_drug_id: drugId });
      delete stItems[drugId];
    } else {
      var n = Number(raw);
      if (!isFinite(n) || n < 0 || Math.floor(n) !== n) { toast('Enter a whole number, 0 or more.', 'bad'); el.value = stItems[drugId] ? stItems[drugId].counted_qty : ''; return; }
      var r = await rpcCall('stock_take_count', { p_pharmacy_id: STATE.profile.pharmacy_id, p_take_id: stOpen.id, p_drug_id: drugId, p_counted: n });
      stItems[drugId] = { drug_id: drugId, system_qty: r.system_qty, counted_qty: r.counted_qty };
    }
  } catch (e) {
    toast(friendlyError(e), 'bad');
    el.value = stItems[drugId] ? stItems[drugId].counted_qty : '';
    return;
  }
  var b = document.getElementById('stbadge-' + drugId);
  if (b) b.innerHTML = stDiffBadge(drugId);
  var p = document.getElementById('stProgress');
  if (p) p.textContent = stProgressText();
}
function openStartStockTake() {
  var body = sheet('Start a stock take', '');
  body.innerHTML =
    '<div class="field"><label>Name (optional)</label><input id="stLabel" placeholder="e.g. Shelf A, or Month end"></div>' +
    '<button class="btn primary" id="stStartBtn" onclick="doStartStockTake()">Start counting</button>';
}
function doStartStockTake() {
  act($('#stStartBtn'), async function () {
    await rpcCall('start_stock_take', { p_pharmacy_id: STATE.profile.pharmacy_id, p_label: $('#stLabel').value.trim() || null });
    closeSheet();
    stFilter = ''; stPage = 1;
    renderStockTake();
  });
}
function openCancelStockTake() {
  var body = sheet('Cancel this stock take?', '');
  body.innerHTML = '<div class="tiny" style="margin-bottom:10px">The counts are thrown away. Stock does not change.</div>' +
    '<button class="btn danger" id="stCancelBtn" onclick="doCancelStockTake()">Cancel stock take</button>';
}
function doCancelStockTake() {
  act($('#stCancelBtn'), async function () {
    await rpcCall('cancel_stock_take', { p_pharmacy_id: STATE.profile.pharmacy_id, p_take_id: stOpen.id });
    closeSheet();
    toast('Stock take cancelled.', 'good');
    renderStockTake();
  });
}
function stAvgCost(d) {
  var q = Number(d.qty_in_stock);
  return q > 0 ? Number(d.stock_value_cost) / q : 0;
}
function openStockTakeReview() {
  var diffs = stDrugs.filter(function (d) { var it = stItems[d.drug_id]; return it && it.counted_qty !== it.system_qty; });
  var body = sheet('Review differences', '');
  if (!stCountedN()) { body.innerHTML = '<div class="empty">Nothing has been counted yet.</div>'; return; }
  var est = diffs.reduce(function (a, d) { var it = stItems[d.drug_id]; return a + (it.counted_qty - it.system_qty) * stAvgCost(d); }, 0);
  body.innerHTML =
    (diffs.length ? '<div class="tiny" style="margin-bottom:10px">Pick a reason for each difference. Approving changes the stock to match what you counted and cannot be undone.</div>' +
      diffs.map(function (d) {
        var it = stItems[d.drug_id], diff = it.counted_qty - it.system_qty;
        var opts = diff < 0 ? [['missing', 'Missing'], ['damaged', 'Damaged'], ['expired', 'Expired'], ['other', 'Other']] : [['found', 'Found'], ['other', 'Other']];
        return '<div class="card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><div class="name" style="font-weight:700">' + esc(d.name) + '</div>' +
          '<span class="badge ' + (diff < 0 ? 'bad' : 'warn') + '">' + (diff > 0 ? '+' : '') + diff + '</span></div>' +
          '<div class="meta">System ' + it.system_qty + ' · counted ' + it.counted_qty + '</div>' +
          '<div class="field" style="margin:8px 0 0"><select data-drug="' + d.drug_id + '" class="stReason">' + opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select></div></div>';
      }).join('') +
      '<div class="kpi-grid" style="margin:12px 0"><div class="kpi ' + (est < 0 ? 't-red' : 't-green') + '"><div class="label">About ' + (est < 0 ? 'lost' : 'gained') + ' at cost</div><div class="value">' + fmt(Math.abs(est)) + '</div></div>' +
      kpi('Drugs to adjust', diffs.length, 't-violet') + '</div>'
      : '<div class="card empty">Everything counted matches the system.</div>') +
    '<button class="btn primary" id="stApproveBtn" onclick="doApproveStockTake()">' + (diffs.length ? 'Approve &amp; adjust stock' : 'Finish stock take') + '</button>';
}
function doApproveStockTake() {
  act($('#stApproveBtn'), async function () {
    var reasons = {};
    document.querySelectorAll('.stReason').forEach(function (s) { reasons[s.getAttribute('data-drug')] = s.value; });
    var r = await rpcCall('approve_stock_take', { p_pharmacy_id: STATE.profile.pharmacy_id, p_take_id: stOpen.id, p_reasons: reasons });
    closeSheet();
    toast(r.adjusted ? 'Stock updated for ' + r.adjusted + (r.adjusted === 1 ? ' drug.' : ' drugs.') : 'Stock take finished. Everything matched.', 'good');
    renderStockTake();
  });
}
async function openStockTakeView(id) {
  var t = stockTakes.find(function (x) { return x.id === id; });
  var c = $('#content');
  c.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var r = await sb.from('stock_take_items').select('*, drugs(name,unit)').eq('take_id', id);
    if (r.error) throw r.error;
    stViewing = { take: t, items: r.data || [] };
  } catch (e) { errorCard(c, friendlyError(e), 'renderStockTake'); return; }
  drawStockTakeView();
}
function drawStockTakeView() {
  var c = $('#content');
  var t = stViewing.take, items = stViewing.items;
  var diffs = items.filter(function (i) { return i.counted_qty !== i.system_qty; });
  c.innerHTML =
    backBtn('stViewing=null;drawStockTake()', 'Stock takes') +
    '<div class="card" style="margin-bottom:12px"><div class="name" style="font-weight:700">' + esc(t.label) + '</div><div class="meta">' + esc(fmtDateTime(t.created_at)) + ' · ' + (t.status === 'approved' ? 'approved' : 'cancelled') + '</div></div>' +
    '<div class="kpi-grid" style="margin-bottom:12px">' + kpi('Drugs counted', items.length, 't-violet') +
    (t.total_cost_variance != null ? kpi('Change at cost', fmt(t.total_cost_variance), Number(t.total_cost_variance) < 0 ? 't-red' : 't-green') : kpi('Differences', diffs.length, 't-amber')) + '</div>' +
    '<div class="card">' + (diffs.length ? diffs.map(function (i) {
      var d = i.counted_qty - i.system_qty;
      return listRow((i.drugs && i.drugs.name) || 'Drug', 'System ' + i.system_qty + ' · counted ' + i.counted_qty + (i.reason ? ' · ' + esc(i.reason) : ''),
        '<span class="badge ' + (d < 0 ? 'bad' : 'warn') + '">' + (d > 0 ? '+' : '') + d + '</span>');
    }).join('') : '<div class="empty">No differences.</div>') + '</div>';
}

// ---------------------------------------------------------------------------
// Drug detail: controlled status
// ---------------------------------------------------------------------------

function drugControlHtml(drugRow) {
  var cls = (drugRow && drugRow.control_class) || 'none';
  if (!can('controlled')) {
    return cls === 'none' ? '' : '<div style="margin-bottom:12px"><span class="badge ' + (cls === 'dda' ? 'bad' : 'warn') + '">' + CONTROL_LONG[cls] + '</span></div>';
  }
  return '<div class="field" style="margin-bottom:12px"><label>Controlled drug?</label><div style="display:flex;gap:8px"><select id="ddControl" style="flex:1">' +
    ['none', 'dda', 'psy'].map(function (k) { return '<option value="' + k + '"' + (k === cls ? ' selected' : '') + '>' + CONTROL_LONG[k] + '</option>'; }).join('') +
    '</select><button class="btn secondary small" onclick="saveDrugControl(this,\'' + drugRow.id + '\')">Save</button></div></div>';
}
function saveDrugControl(btn, drugId) {
  act(btn, async function () {
    await rpcCall('set_drug_control', { p_pharmacy_id: STATE.profile.pharmacy_id, p_drug_id: drugId, p_class: $('#ddControl').value });
    toast('Saved.', 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
// Dashboard: small strip for the new modules
// ---------------------------------------------------------------------------

function dashExtrasHtml(snap) {
  var x = (snap && snap.extras) || {};
  var rows = [];
  if (Number(x.credit_owed) > 0.5 && canSeeCustomers()) rows.push(["custTab='customers';custOnlyOwing=true;setTab('customers')", 'amber', 'wallet',
    '<b>' + fmt(x.credit_owed) + '</b> owed by ' + x.credit_customers + (Number(x.credit_customers) === 1 ? ' customer' : ' customers')]);
  if (Number(x.refills_due) > 0 && canSeeCustomers()) rows.push(["custTab='refills';refillFilter='due';setTab('customers')", 'amber', 'calendar',
    '<b>' + x.refills_due + (Number(x.refills_due) === 1 ? ' refill' : ' refills') + ' due</b> — remind the customers']);
  if (Number(x.controlled_mismatch) > 0 && canSeeControlled()) rows.push(["setTab('controlled')", '', 'warn',
    '<b>' + x.controlled_mismatch + ' controlled ' + (Number(x.controlled_mismatch) === 1 ? 'drug does' : 'drugs do') + ' not match the ledger</b>']);
  if (x.open_stock_take && canCountStock()) rows.push(["setTab('stocktake')", 'green', 'clipboard',
    '<b>Stock take in progress</b> — tap to continue counting']);
  return rows.map(function (r) {
    return '<div class="dash-alert ' + r[1] + '" onclick="' + r[0] + '">' + icon(r[2], 16) + '<div>' + r[3] + '</div></div>';
  }).join('');
}

