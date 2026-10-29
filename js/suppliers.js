// js/suppliers.js - Suppliers, supplier detail, payments and the New LPO form.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// SUPPLIERS — opening balances, LPOs (Local Purchase Orders) that record a
// delivery AND restock inventory in one step (integrated by design, so a
// pharmacist enters a delivery once rather than in both Suppliers and
// Stock), payments against a supplier's running balance, and a full
// running-ledger statement per supplier: first delivery to most recent,
// running debt owed, what's been paid and when. See schema.sql's
// supplier_lpos/supplier_lpo_items/supplier_payments tables and the
// record_supplier_lpo/record_supplier_payment functions.
// ---------------------------------------------------------------------------

var supplierDetailId = null;   // set while viewing one supplier's ledger instead of the list
var lpoFilter = '';
var lpoDeliveredAt = '';
var lpoNotes = '';

async function renderSuppliers() {
  var c = $('#content');
  if (!can('suppliers') && !can('view_suppliers')) { c.innerHTML = '<div class="card empty">You do not have access to Suppliers.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading suppliers…</div>';
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

function drawSuppliersList() {
  var c = $('#content');
  var sups = STATE.suppliersCache || [];
  var balMap = STATE.supplierBalances || {};
  function balanceFor(s) { return Number(balMap[s.id] || 0); }
  c.innerHTML =
    (can('suppliers') ? '<div class="toolbar-row"><button class="btn primary" onclick="openAddSupplier()">+ New supplier</button></div>' : '') +
    '<div class="card">' +
    (sups.length ? sups.map(function (s) {
      var bal = balanceFor(s);
      var badgeKind = bal > 0.5 ? 'bad' : (bal < -0.5 ? 'good' : 'muted');
      var badgeText = bal > 0.5 ? fmt(bal) + ' owed' : (bal < -0.5 ? fmt(-bal) + ' credit' : 'Settled');
      return '<div class="list-row" style="cursor:pointer" onclick="openSupplierDetail(\'' + s.id + '\')">' +
        '<div><div class="name">' + esc(s.name) + '</div><div class="meta">' + esc([s.phone, s.address].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="right"><span class="badge ' + badgeKind + '">' + badgeText + '</span></div></div>';
    }).join('') : '<div class="empty">No suppliers yet. Add one to start tracking deliveries and payments.</div>') +
    '</div>';
}

function retrySupplierDetail() { if (supplierDetailId) openSupplierDetail(supplierDetailId); }

async function openSupplierDetail(supplierId) {
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
    var { data: lpos, error: lErr } = await sb.from('supplier_lpos').select('*, supplier_lpo_items(*, drugs(name, unit))').eq('supplier_id', supplierId).order('delivered_at');
    if (lErr) throw lErr;
    var { data: pays, error: pErr } = await sb.from('supplier_payments').select('*').eq('supplier_id', supplierId).order('paid_at');
    if (pErr) throw pErr;
    STATE.currentSupplierDetail = { supplier: supplier, lpos: lpos || [], payments: pays || [] };
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

// Merges a supplier's LPOs and payments into one chronological ledger with
// a running balance, starting from the supplier's opening balance (if any).
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
    else running += e.delivered - e.paid;
    e.runningBalance = running;
  });
  var totalDelivered = (detail.lpos || []).reduce(function (a, l) { return a + Number(l.total_amount || 0); }, 0);
  var totalPaid = (detail.payments || []).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
  return { entries: entries, totalDelivered: totalDelivered, totalPaid: totalPaid, opening: opening, balance: running };
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
    '<div class="card">' +
    (ledger.entries.length ? ledger.entries.map(function (e) {
      var metaBits = [];
      if (e.date) metaBits.push(fmtDate(e.date));
      if (e.detailText) metaBits.push(e.detailText);
      var right = '';
      if (e.delivered) right += '<div>+' + fmt(e.delivered) + '</div>';
      if (e.paid) right += '<div style="color:var(--green)">−' + fmt(e.paid) + '</div>';
      right += '<div class="tiny">Bal ' + fmt(e.runningBalance) + '</div>';
      return '<div class="list-row"><div><div class="name">' + esc(e.label) + '</div><div class="meta">' + esc(metaBits.join(' · ')) + '</div></div>' +
        '<div class="right">' + right + '</div></div>';
    }).join('') : '<div class="empty">No deliveries or payments recorded yet.</div>') +
    '</div>';
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
      'Balance': e.runningBalance
    };
  });
  exportExcel(detail.supplier.name + ' - statement.xlsx', 'Statement', rows);
}

function printSupplierStatement() {
  var detail = STATE.currentSupplierDetail;
  var ledger = STATE.currentSupplierLedger;
  if (!detail || !ledger) return;
  var rows = ledger.entries.map(function (e) {
    return [e.date ? fmtDate(e.date) : '—', e.label, e.detailText || '—', e.delivered ? fmt(e.delivered) : '—', e.paid ? fmt(e.paid) : '—', fmt(e.runningBalance)];
  });
  printHtml('Supplier Statement', detail.supplier.name, tableHtml(['Date', 'Entry', 'Detail', 'Delivered', 'Paid', 'Balance'], rows), 'Balance owed: ' + fmt(ledger.balance));
}

// ---------------------------------------------------------------------------
// NEW LPO — multi-drug delivery entry. Same STATE-keyed-by-id pattern as
// openSyncMasterDrugs: ticking a drug reveals its own fields, and every
// keystroke writes straight into STATE.lpoSelected with no re-render, so
// focus/typing in one row is never disturbed by editing another. Submits as
// one jsonb array to record_supplier_lpo, which creates the LPO AND the
// matching batches in a single transaction (integrated, per the owner's
// choice — one entry records both the debt and the stock received).
// ---------------------------------------------------------------------------

async function openNewLpo(supplierId) {
  lpoFilter = '';
  STATE.lpoSelected = {};
  lpoDeliveredAt = new Date().toISOString().slice(0, 10);
  lpoNotes = '';
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  var body = sheet('New LPO' + (supplier ? ': ' + supplier.name : ''), '<div class="empty">Loading drugs…</div>');
  if (!STATE.drugsCache || !STATE.drugsCache.length) {
    try {
      var { data, error } = await sb.from('v_drug_stock').select('*').order('name');
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

// BUG FIX: the search-results list (searchMatches, in drawNewLpo) always
// excludes anything already in STATE.lpoSelected, since a selected drug is
// meant to show only in the "On this delivery" card above instead. Ticking
// a drug that was the search's only match used to leave lpoFilter
// unchanged, so the very next render recomputed searchMatches against that
// same query, found it now excluded, and landed on "No drugs match your
// search" — even though the tick had just worked and the drug was sitting
// right there in "On this delivery". Clearing the search box on a genuine
// selection (not on de-selecting) sidesteps that: the search section
// collapses back to nothing instead of showing a contradictory empty state,
// and the user can see their pick in "On this delivery" right away.
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

// Field edits write straight into STATE, with no re-render — see the note
// on updateSyncField above for why (re-rendering would reset focus/typing
// in every other expanded row).
function updateLpoField(drugId, field, value) {
  if (STATE.lpoSelected[drugId]) STATE.lpoSelected[drugId][field] = value;
}

function toggleLpoExpiryUnknown(drugId, supplierId, checked) {
  if (STATE.lpoSelected[drugId]) { STATE.lpoSelected[drugId].expiryUnknown = checked; drawNewLpo(supplierId); }
}

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
    var { error } = await sb.rpc('record_supplier_lpo', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_supplier_id: supplierId,
      p_items: items,
      p_delivered_at: lpoDeliveredAt || null,
      p_notes: lpoNotes.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
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

// ---------------------------------------------------------------------------
