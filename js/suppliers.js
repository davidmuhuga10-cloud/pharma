// js/suppliers.js - suppliers, supplier detail, payments and the New LPO form.
//
// --- Suppliers ---
// An LPO (Local Purchase Order) records a delivery AND restocks inventory in one
// step, so a delivery is entered once. Payments reduce a supplier's running
// balance, and each supplier has a ledger from first delivery to latest. See
// supplier_lpos, supplier_lpo_items, supplier_payments and the
// record_supplier_lpo / record_supplier_payment functions in schema.sql.

var supplierDetailId = null;  // set while viewing one supplier's ledger instead of the list
var lpoFilter = '';
var lpoDeliveredAt = '';
var lpoNotes = '';
var suppliersPage = 1;     // 10 suppliers per page
var supplierStmtPage = 1;  // 10 statement lines per page

async function renderSuppliers() {
  var c = $('#content');
  if (!can('suppliers') && !can('view_suppliers')) { c.innerHTML = '<div class="card empty">You do not have access to Suppliers.</div>'; return; }
  c.innerHTML = listSkeletonHtml(5);
  try {
    var both = await Promise.all([
      sb.from('suppliers').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id).order('name'),
      sb.rpc('supplier_balances', { p_pharmacy_id: STATE.profile.pharmacy_id })
    ]);
    if (both[0].error) throw both[0].error;
    STATE.suppliersCache = both[0].data || [];
    var balRes = both[1];
    if (balRes.error) throw balRes.error;
    var balMap = {};
    (balRes.data || []).forEach(function (r) { balMap[r.supplier_id] = Number(r.balance || 0); });
    STATE.supplierBalances = balMap;
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderSuppliers');
    return;
  }
  if (supplierDetailId) { openSupplierDetail(supplierDetailId); return; }
  drawSuppliersList();
}

function goSuppliersPage(p) { suppliersPage = p; drawSuppliersList(); }

// Balance as plain coloured text: owed in red, credit in green, settled in black.
function supplierBalanceStatus(bal) {
  return bal > 0.5 ? stCell('Owed', 'bad') : (bal < -0.5 ? stCell('Credit', 'ok') : stCell('Settled', 'ink'));
}

function drawSuppliersList() {
  var c = $('#content');
  var sups = STATE.suppliersCache || [];
  var balMap = STATE.supplierBalances || {};
  var pg = pageSlice(sups, suppliersPage);
  suppliersPage = pg.page;
  c.innerHTML =
    (can('suppliers') ? '<div class="toolbar-row"><button class="btn primary" onclick="openAddSupplier()">+ New supplier</button></div>' : '') +
    showingHtml(pg) +
    rtTable(['Supplier', 'Phone', 'Address', 'Balance', 'Status'], pg.rows.map(function (s) {
      var bal = Number(balMap[s.id] || 0);
      return [s.name, s.phone || '—', s.address || '—', fmt(Math.abs(bal)), supplierBalanceStatus(bal)];
    }), {
      rowClick: function (i) { return "openSupplierDetail('" + pg.rows[i].id + "')"; },
      empty: 'No suppliers yet. Add one to start tracking deliveries and payments.', num: [false, false, false, true, false]
    }) +
    pagerHtml(pg, 'goSuppliersPage');
}

function retrySupplierDetail() { if (supplierDetailId) openSupplierDetail(supplierDetailId); }

async function openSupplierDetail(supplierId) {
  supplierStmtPage = 1;
  supplierDetailId = supplierId;
  var c = $('#content');
  if (!c) return;
  c.innerHTML = '<div class="empty">Loading supplier…</div>';
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  try {
    if (!supplier) {
      var { data: supRow, error: sErr } = await sb.from('suppliers').select('*').eq('id', supplierId).maybeSingle();
      if (sErr) throw sErr;
      supplier = supRow;
    }
    if (!supplier) { c.innerHTML = '<div class="card empty">Supplier not found.</div>'; return; }
    var { data: lpos, error: lErr } = await fetchAllRows(function () { return sb.from('supplier_lpos').select('*, supplier_lpo_items(*, drugs(name, unit))').eq('supplier_id', supplierId).order('delivered_at'); }, 'id');
    if (lErr) throw lErr;
    var { data: pays, error: pErr } = await fetchAllRows(function () { return sb.from('supplier_payments').select('*').eq('supplier_id', supplierId).order('paid_at'); }, 'id');
    if (pErr) throw pErr;
    var { data: rets, error: rErr } = await fetchAllRows(function () { return sb.from('supplier_returns').select('*, drugs(name, unit)').eq('supplier_id', supplierId).order('returned_at'); }, 'id');
    if (rErr) throw rErr;
    STATE.currentSupplierDetail = { supplier: supplier, lpos: lpos || [], payments: pays || [], returns: rets || [] };
  } catch (e) {
    errorCard(c, friendlyError(e), 'retrySupplierDetail');
    return;
  }
  drawSupplierDetail();
}

function closeSupplierDetail() {
  supplierDetailId = null;
  STATE.currentSupplierDetail = null;
  STATE.currentSupplierLedger = null;
  drawSuppliersList();
}

function supplierPaymentMethodLabel(m) {
  var map = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', cheque: 'Cheque', other: 'Other' };
  return map[m] || 'Other';
}

// Merges a supplier's LPOs and payments into one dated ledger with a running
// balance, starting from the opening balance if any.
function buildSupplierLedger(detail) {
  var supplier = detail.supplier;
  var entries = [];
  (detail.lpos || []).forEach(function (l) {
    var items = (l.supplier_lpo_items || []).map(function (it) {
      var name = (it.drugs && it.drugs.name) || 'item';
      return name + ' ×' + it.quantity;
    });
    entries.push({
      date: l.delivered_at, sortKey: l.delivered_at + 'T00:00:01',
      label: l.lpo_number + ' · Delivery',
      detailText: items.join(', '),
      delivered: Number(l.total_amount || 0), paid: 0
    });
  });
  (detail.payments || []).forEach(function (p) {
    entries.push({
      date: p.paid_at, sortKey: p.paid_at + 'T00:00:02',
      label: 'Payment · ' + supplierPaymentMethodLabel(p.method),
      detailText: [p.reference, p.notes].filter(Boolean).join(' — '),
      delivered: 0, paid: Number(p.amount || 0)
    });
  });
  // Stock sent back to the supplier is a credit: it lowers what is owed.
  (detail.returns || []).forEach(function (r) {
    var dn = (r.drugs && r.drugs.name) || 'item';
    entries.push({
      date: r.returned_at, sortKey: r.returned_at + 'T00:00:03',
      label: 'Returned stock · Credit',
      detailText: dn + ' ×' + r.quantity + (r.reason ? ' — ' + r.reason : ''),
      delivered: 0, paid: 0, credit: Number(r.credit_amount || 0)
    });
  });
  entries.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });

  var opening = Number(supplier.opening_balance || 0);
  if (opening) {
    entries.unshift({
      date: supplier.opening_balance_date || null,
      label: 'Opening balance', detailText: '', delivered: null, paid: null, openingValue: opening
    });
  }
  var running = 0;
  entries.forEach(function (e) {
    if (e.openingValue != null) running = e.openingValue;
    else running += e.delivered - e.paid - (e.credit || 0);
    e.runningBalance = running;
  });
  var totalDelivered = (detail.lpos || []).reduce(function (a, l) { return a + Number(l.total_amount || 0); }, 0);
  var totalPaid = (detail.payments || []).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
  var totalCredit = (detail.returns || []).reduce(function (a, r) { return a + Number(r.credit_amount || 0); }, 0);
  return { entries: entries, totalDelivered: totalDelivered, totalPaid: totalPaid, totalCredit: totalCredit, opening: opening, balance: running };
}

function drawSupplierDetail() {
  var c = $('#content');
  var detail = STATE.currentSupplierDetail;
  if (!detail) { drawSuppliersList(); return; }
  var supplier = detail.supplier;
  var ledger = buildSupplierLedger(detail);
  STATE.currentSupplierLedger = ledger;
  var balanceKind = ledger.balance > 0.5 ? 't-red' : (ledger.balance < -0.5 ? 't-sales' : 't-neutral');
  var contactLine = [supplier.phone, supplier.email, supplier.address].filter(Boolean).join(' · ');

  c.innerHTML =
    '<button class="btn ghost small" style="margin-bottom:10px" onclick="closeSupplierDetail()">&larr; All suppliers</button>' +
    '<div class="section-title" style="margin-top:0">' + esc(supplier.name) + '</div>' +
    (contactLine ? '<div class="tiny" style="margin-bottom:10px">' + esc(contactLine) + '</div>' : '') +
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Opening balance', fmt(ledger.opening), 't-violet') +
    kpi('Total delivered', fmt(ledger.totalDelivered), 't-orange') +
    kpi('Total paid', fmt(ledger.totalPaid), 't-sales') +
    (ledger.totalCredit > 0 ? kpi('Credit for returns', fmt(ledger.totalCredit), 't-green') : '') +
    kpi('Balance owed', fmt(ledger.balance), balanceKind) +
    '</div>' +
    '<div class="toolbar-row"><div class="toolbar-segment">' +
    (can('suppliers') ? '<button class="btn primary small" onclick="openNewLpo(\'' + supplier.id + '\')">+ New LPO</button>' +
    '<button class="btn secondary small" onclick="openRecordSupplierPayment(\'' + supplier.id + '\')">Record payment</button>' : '') +
    '</div><div class="toolbar-segment toolbar-end">' +
    '<button class="btn small" onclick="exportSupplierStatement()">' + icon('download', 15) + ' Excel</button>' +
    '<button class="btn small" onclick="printSupplierStatement()">' + icon('printer', 15) + ' Print</button>' +
    '</div></div>' +
    '<div class="section-title">Statement</div>' +
    (function () {
      // Newest line first on screen; print and Excel run oldest to newest.
      var newestFirst = ledger.entries.slice().reverse();
      var pg = pageSlice(newestFirst, supplierStmtPage);
      supplierStmtPage = pg.page;
      return showingHtml(pg) +
        rtTable(SUPPLIER_STMT_COLS, pg.rows.map(supplierStmtCells), { empty: 'No deliveries, payments or returns recorded yet.', num: [false, false, false, true, true, true, true] }) +
        pagerHtml(pg, 'goSupplierStmtPage');
    })();
}
function goSupplierStmtPage(p) { supplierStmtPage = p; drawSupplierDetail(); }

var SUPPLIER_STMT_COLS = ['Date', 'Entry', 'Detail', 'Delivered', 'Paid', 'Credit', 'Balance'];
function supplierStmtCells(e) {
  return [e.date ? fmtDate(e.date) : '—', e.label, e.detailText || '—', e.delivered ? fmt(e.delivered) : '', e.paid ? fmt(e.paid) : '', e.credit ? fmt(e.credit) : '', fmt(e.runningBalance)];
}

function exportSupplierStatement() {
  var detail = STATE.currentSupplierDetail;
  var ledger = STATE.currentSupplierLedger;
  if (!detail || !ledger) return;
  var rows = ledger.entries.map(function (e) {
    return {
      'Date': e.date ? fmtDate(e.date) : '',
      'Entry': e.label,
      'Detail': e.detailText || '',
      'Delivered': e.delivered || '',
      'Paid': e.paid || '',
      'Credit': e.credit || '',
      'Balance': e.runningBalance
    };
  });
  exportExcel(detail.supplier.name + ' - statement.xlsx', 'Statement', rows);
}

function printSupplierStatement() {
  var detail = STATE.currentSupplierDetail;
  var ledger = STATE.currentSupplierLedger;
  if (!detail || !ledger) return;
  var rows = ledger.entries.map(supplierStmtCells);
  printHtml('Supplier Statement', detail.supplier.name, tableHtml(SUPPLIER_STMT_COLS, rows, 'Balance owed: ' + fmt(ledger.balance)), rows.length + ' lines · Balance owed ' + fmt(ledger.balance));
}

// --- New LPO ---
// Multi-drug delivery entry. Like openSyncMasterDrugs: ticking a drug shows its
// fields, and each keystroke writes straight into STATE.lpoSelected with no
// re-render, so typing in one row is never disturbed. Submits one jsonb array
// to record_supplier_lpo, which creates the LPO and its batches in a single
// transaction.

async function openNewLpo(supplierId) {
  lpoFilter = '';
  STATE.lpoSelected = {};
  lpoDeliveredAt = new Date().toISOString().slice(0, 10);
  lpoNotes = '';
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  var body = sheet('New LPO' + (supplier ? ': ' + supplier.name : ''), '<div class="empty">Loading drugs…</div>');
  if (!STATE.drugsCache || !STATE.drugsCache.length) {
    try {
      var { data, error } = await fetchAllRows(function () { return sb.from('v_drug_stock').select('*').order('name'); }, 'drug_id');
      if (error) throw error;
      STATE.drugsCache = data || [];
    } catch (e) {
      body.innerHTML = '<div class="card empty">Could not load drugs. ' + esc(friendlyError(e)) + '</div>';
      return;
    }
  }
  drawNewLpo(supplierId);
}

function drawNewLpo(supplierId) {
  var body = $('#sheetBody');
  if (!body) return;
  var q = lpoFilter.trim().toLowerCase();
  var all = STATE.drugsCache || [];
  var selectedIds = Object.keys(STATE.lpoSelected);
  var selectedDrugs = selectedIds.map(function (id) { return all.find(function (d) { return d.id === id; }); }).filter(Boolean);
  var searchMatches = q ? all.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1 && !STATE.lpoSelected[d.id]; }) : [];
  var runningTotal = selectedIds.reduce(function (sum, id) {
    var sel = STATE.lpoSelected[id];
    return sum + (parseFloat(sel.qty) || 0) * (parseFloat(sel.costPrice) || 0);
  }, 0);

  redrawKeepingFocus(body,
    '<div class="row-2">' +
    '<div class="field"><label>Delivery date</label><input type="date" value="' + esc(lpoDeliveredAt) + '" onchange="lpoDeliveredAt=this.value"></div>' +
    '<div class="field"><label>Notes (optional)</label><input value="' + esc(lpoNotes) + '" oninput="lpoNotes=this.value"></div>' +
    '</div>' +
    (selectedDrugs.length ? '<div class="tiny" style="margin-bottom:6px">On this delivery</div><div class="card" style="margin-bottom:12px">' +
      selectedDrugs.map(function (d) { return drawLpoDrugRow(d, supplierId, true); }).join('') + '</div>' : '') +
    '<div class="searchbox field"><input id="lpoSearchInput" placeholder="Search drugs to add…" value="' + esc(lpoFilter) + '" oninput="lpoFilter=this.value;drawNewLpo(\'' + supplierId + '\')"></div>' +
    (q ? (searchMatches.length ? '<div class="card">' + searchMatches.map(function (d) { return drawLpoDrugRow(d, supplierId, false); }).join('') + '</div>' : '<div class="empty">No drugs match your search.</div>') : '') +
    '<div class="tiny" style="margin:12px 0">' + selectedIds.length + ' item' + (selectedIds.length === 1 ? '' : 's') + ' selected' + (selectedIds.length ? ' · running total ' + fmt(runningTotal) : '') + '</div>' +
    '<button class="btn primary" id="lpoSaveBtn" onclick="saveLpo(\'' + supplierId + '\')"' + (selectedIds.length ? '' : ' disabled') + '>Save delivery</button>');
}

function drawLpoDrugRow(d, supplierId, selected) {
  var sel = STATE.lpoSelected[d.id];
  var row = '<div class="list-row">' +
    '<label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">' +
    '<input type="checkbox"' + (selected ? ' checked' : '') + ' onchange="toggleLpoDrug(\'' + d.id + '\',\'' + supplierId + '\')">' +
    '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + esc(d.unit) + ' · in stock: ' + d.qty_in_stock + '</div></div>' +
    '</label></div>';
  if (!selected || !sel) return row;
  row +=
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Quantity (' + esc(d.unit) + ')</label><input type="number" min="1" value="' + esc(sel.qty) + '" oninput="updateLpoField(\'' + d.id + '\',\'qty\',this.value)"></div>' +
    '<div class="field"><label>Cost price / unit</label><input type="number" step="0.01" value="' + esc(sel.costPrice) + '" oninput="updateLpoField(\'' + d.id + '\',\'costPrice\',this.value)"></div>' +
    '</div>' +
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Sell price / unit</label><input type="number" step="0.01" value="' + esc(sel.sellPrice) + '" oninput="updateLpoField(\'' + d.id + '\',\'sellPrice\',this.value)"></div>' +
    '<div class="field"><label>Batch no. (optional)</label><input value="' + esc(sel.batchNo) + '" oninput="updateLpoField(\'' + d.id + '\',\'batchNo\',this.value)"></div>' +
    '</div>' +
    '<div class="row-2" style="padding:0 4px 14px 34px">' +
    '<div class="field"><label>Expiry date</label><input type="date" value="' + esc(sel.expiry) + '"' + (sel.expiryUnknown ? ' disabled' : '') + ' oninput="updateLpoField(\'' + d.id + '\',\'expiry\',this.value)"></div>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-top:22px"><input type="checkbox"' + (sel.expiryUnknown ? ' checked' : '') + ' onchange="toggleLpoExpiryUnknown(\'' + d.id + '\',\'' + supplierId + '\',this.checked)"> Expiry unknown</label>' +
    '</div>';
  return row;
}

// Search results (searchMatches in drawNewLpo) exclude drugs already in
// STATE.lpoSelected, which show in "On this delivery". If the ticked drug was
// the only match, the next render showed "No drugs match your search". So
// clear the search box when a drug is selected (not when deselected).
function toggleLpoDrug(drugId, supplierId) {
  if (STATE.lpoSelected[drugId]) {
    delete STATE.lpoSelected[drugId];
  } else {
    var d = (STATE.drugsCache || []).find(function (x) { return x.id === drugId; });
    STATE.lpoSelected[drugId] = { qty: '', costPrice: '', sellPrice: d && d.default_price ? String(d.default_price) : '', expiry: '', expiryUnknown: false, batchNo: '' };
    lpoFilter = '';
  }
  drawNewLpo(supplierId);
}

// Field edits write straight into STATE with no re-render (see updateSyncField).
function updateLpoField(drugId, field, value) {
  if (STATE.lpoSelected[drugId]) STATE.lpoSelected[drugId][field] = value;
}

function toggleLpoExpiryUnknown(drugId, supplierId, checked) {
  if (STATE.lpoSelected[drugId]) { STATE.lpoSelected[drugId].expiryUnknown = checked; drawNewLpo(supplierId); }
}

// Retry safety for recording a delivery - see newRequestId() in js/core.js.
var lpoRequestId = null;

async function saveLpo(supplierId) {
  var btn = $('#lpoSaveBtn');
  if (!btn) return;
  act(btn, async function () {
    var ids = Object.keys(STATE.lpoSelected);
    if (!ids.length) { toast('Select at least one drug.', 'bad'); return; }
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var sel = STATE.lpoSelected[id];
      var drug = (STATE.drugsCache || []).find(function (d) { return d.id === id; });
      var label = drug ? drug.name : 'a selected drug';
      var qty = parseInt(sel.qty, 10);
      if (!qty || qty <= 0) { toast('Enter a valid quantity for ' + label + '.', 'bad'); return; }
      var cost = parseFloat(sel.costPrice);
      if (!cost || cost <= 0) { toast('Enter a cost price for ' + label + '.', 'bad'); return; }
      var sell = parseFloat(sel.sellPrice) || cost;
      if (!sel.expiryUnknown && !sel.expiry) { toast('Enter the expiry date for ' + label + ', or mark it unknown.', 'bad'); return; }
      items.push({
        drug_id: id, quantity: qty, cost_price: cost, sell_price: sell,
        expiry_date: sel.expiryUnknown ? null : sel.expiry,
        expiry_unknown: !!sel.expiryUnknown,
        batch_no: sel.batchNo ? sel.batchNo.trim() : null
      });
    }
    // Retry safety - see newRequestId() in js/core.js. Without this, a lost
    // reply meant the whole delivery was recorded twice and stock doubled.
    if (!lpoRequestId) lpoRequestId = newRequestId();
    var { error } = await sb.rpc('record_supplier_lpo', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_supplier_id: supplierId,
      p_items: items,
      p_delivered_at: lpoDeliveredAt || null,
      p_notes: lpoNotes.trim() || null,
      p_client_request_id: lpoRequestId
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    lpoRequestId = null;   // recorded; the next delivery is a new request
    toast('Delivery recorded.', 'good');
    STATE.lpoSelected = {};
    closeSheet();
    openSupplierDetail(supplierId);
  });
}

function openRecordSupplierPayment(supplierId) {
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  var body = sheet('Record payment' + (supplier ? ': ' + supplier.name : ''), '');
  body.innerHTML =
    '<div class="row-2">' +
    '<div class="field"><label>Amount</label><input id="spmAmount" type="number" step="0.01" min="0"></div>' +
    '<div class="field"><label>Method</label><select id="spmMethod">' +
    '<option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="cheque">Cheque</option><option value="other">Other</option>' +
    '</select></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Date</label><input id="spmDate" type="date" value="' + esc(new Date().toISOString().slice(0, 10)) + '"></div>' +
    '<div class="field"><label>Reference (optional)</label><input id="spmReference" placeholder="e.g. M-Pesa code"></div></div>' +
    '<div class="field"><label>Notes (optional)</label><input id="spmNotes"></div>' +
    '<button class="btn primary" id="spmSaveBtn" onclick="saveSupplierPayment(\'' + supplierId + '\')">Save payment</button>';
}

async function saveSupplierPayment(supplierId) {
  var btn = $('#spmSaveBtn');
  act(btn, async function () {
    var amount = parseFloat($('#spmAmount').value);
    if (!amount || amount <= 0) { toast('Enter a valid amount.', 'bad'); return; }
    var { error } = await sb.rpc('record_supplier_payment', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_supplier_id: supplierId,
      p_amount: amount,
      p_method: $('#spmMethod').value,
      p_reference: $('#spmReference').value.trim() || null,
      p_paid_at: $('#spmDate').value || null,
      p_notes: $('#spmNotes').value.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Payment recorded.', 'good');
    closeSheet();
    openSupplierDetail(supplierId);
  });
}

function openAddSupplier() {
  var body = sheet('New supplier', '');
  body.innerHTML =
    '<div class="field"><label>Name</label><input id="spName"></div>' +
    '<div class="row-2"><div class="field"><label>Phone</label><input id="spPhone"></div>' +
    '<div class="field"><label>Email</label><input id="spEmail"></div></div>' +
    '<div class="field"><label>Address</label><input id="spAddress"></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Opening balance owed (optional)</label><input id="spOpening" type="number" step="0.01" min="0" placeholder="0"></div>' +
    '<div class="field"><label>As of date</label><input id="spOpeningDate" type="date"></div></div>' +
    '<div class="tiny" style="margin-bottom:10px">Leave the opening balance at 0 if there was no outstanding debt with this supplier before you started tracking it here.</div>' +
    '<button class="btn primary" id="spSaveBtn" onclick="saveSupplier()">Save supplier</button>';
}

async function saveSupplier() {
  var btn = $('#spSaveBtn');
  act(btn, async function () {
    var name = $('#spName').value.trim();
    if (!name) { toast('Give the supplier a name.', 'bad'); return; }
    var opening = parseFloat($('#spOpening').value) || 0;
    var { error } = await sb.from('suppliers').insert({
      pharmacy_id: STATE.profile.pharmacy_id, name: name,
      phone: $('#spPhone').value.trim() || null, email: $('#spEmail').value.trim() || null,
      address: $('#spAddress').value.trim() || null,
      opening_balance: opening,
      opening_balance_date: opening ? ($('#spOpeningDate').value || new Date().toISOString().slice(0, 10)) : null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    var { data: sups } = await sb.from('suppliers').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id).order('name');
    STATE.suppliersCache = sups || [];
    toast('Supplier added.', 'good');
    closeSheet();
    renderSuppliers();
  });
}

