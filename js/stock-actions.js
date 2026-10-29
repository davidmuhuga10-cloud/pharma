// js/stock-actions.js - Reorder list, and the stock-movement actions: write-off, correction, discount.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// REORDER LIST — a proactive "what to buy" list from what's low/out, instead
// of waiting to notice at the counter.
// ---------------------------------------------------------------------------

var pendingReorderList = [];

function openReorderList() {
  var needed = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; })
    .map(function (d) {
      var suggested = Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5);
      return { name: d.name, unit: d.unit, current: d.qty_in_stock, reorderLevel: d.reorder_level, suggested: suggested };
    });
  pendingReorderList = needed;
  var body = sheet('Reorder List', '');
  body.innerHTML =
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportReorderExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn" onclick="printReorderList()">' + icon('printer',15) + ' Print</button>' +
    '</div></div>' +
    '<div class="card">' + (needed.length ? needed.map(function (n) {
      return listRow(n.name, 'Have ' + n.current + ' ' + esc(n.unit) + ' · reorder level ' + n.reorderLevel, '<b>Order ' + n.suggested + '</b>');
    }).join('') : '<div class="empty">Nothing needs reordering right now.</div>') + '</div>';
}

function exportReorderExcel() {
  var rows = pendingReorderList.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - reorder list.xlsx', 'Reorder', rows);
}

function printReorderList() {
  var needed = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; });
  var rows = needed.map(function (d) {
    var suggested = Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5);
    return [d.name, d.qty_in_stock + ' ' + d.unit, d.reorder_level, suggested];
  });
  printHtml('Reorder List', todayStr(), tableHtml(['Drug', 'Current stock', 'Reorder level', 'Suggested order'], rows), needed.length + ' items');
}

// Drugs brought into stock without a known expiry date (e.g. via a relaxed
// Excel import, item 26) are flagged in v_drug_stock via has_unknown_expiry.
// This lets the pharmacy come back later, look up the exact batch, and fill
// in the real expiry date once they have it.
function openUnknownExpiryList() {
  sheet('Batches with no expiry date', '<div class="empty">Loading…</div>');
  loadUnknownExpiryList();
}

async function loadUnknownExpiryList() {
  var body = $('#sheetBody');
  if (!body) return;
  try {
    var { data: batches, error } = await sb.from('batches')
      .select('id, batch_no, quantity_remaining, drug_id, drugs(name, unit)')
      .eq('pharmacy_id', STATE.profile.pharmacy_id)
      .eq('expiry_unknown', true)
      .gt('quantity_remaining', 0)
      .order('created_at', { ascending: true });
    if (error) throw error;
    STATE.unknownExpiryBatches = batches || [];
    renderUnknownExpiryList();
  } catch (e) {
    body.innerHTML = '<div class="empty">' + esc(friendlyError(e)) + '</div>';
  }
}

function renderUnknownExpiryList() {
  var body = $('#sheetBody');
  if (!body) return;
  var batches = STATE.unknownExpiryBatches || [];
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">These batches were brought into stock without an expiry date. Set the real date once you have it — this only needs doing once per batch.</div>' +
    (batches.length ? '<div class="card">' + batches.map(function (b) {
      var drugName = (b.drugs && b.drugs.name) || 'Unknown drug';
      var unit = (b.drugs && b.drugs.unit) || 'unit';
      return '<div class="list-row"><div><div class="name">' + esc(drugName) + '</div>' +
        '<div class="meta">' + b.quantity_remaining + ' ' + esc(unit) + (b.batch_no ? ' · batch ' + esc(b.batch_no) : '') + '</div></div>' +
        '<div class="right" style="display:flex;gap:8px;align-items:center">' +
        '<input type="date" id="expInput_' + b.id + '">' +
        '<button class="btn small" id="expSaveBtn_' + b.id + '" onclick="saveBatchExpiry(\'' + b.id + '\')">Save</button>' +
        '</div></div>';
    }).join('') + '</div>' : '<div class="empty">Nothing left to flag — every batch has an expiry date.</div>');
}

async function saveBatchExpiry(batchId) {
  var btn = $('#expSaveBtn_' + batchId);
  act(btn, async function () {
    var input = $('#expInput_' + batchId);
    var val = input ? input.value : '';
    if (!val) { toast('Pick a date first.', 'bad'); return; }
    var { error } = await sb.rpc('set_batch_expiry', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_batch_id: batchId,
      p_expiry_date: val
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expiry date saved.', 'good');
    STATE.unknownExpiryBatches = (STATE.unknownExpiryBatches || []).filter(function (b) { return b.id !== batchId; });
    renderUnknownExpiryList();
    renderInventory();
  });
}

function openAddDrug() {
  var catOptions = STATE.categoriesCache.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
  var body = sheet('Add a drug', '');
  body.innerHTML =
    '<div class="field"><label>Drug name</label><input id="dName" placeholder="e.g. Amoxiclav 228 susp"></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Form</label><select id="dForm">' +
      ['tablet', 'capsule', 'syrup', 'injection', 'cream_ointment', 'drops', 'suppository', 'inhaler', 'iv_fluid', 'other']
        .map(function (f) { return '<option value="' + f + '">' + f.replace('_', '/') + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field"><label>Unit</label><input id="dUnit" placeholder="tablet, bottle, vial…"></div></div>' +
    '<div class="field"><label>Category</label><select id="dCat"><option value="">— none —</option>' + catOptions + '</select></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Reorder level</label><input id="dReorder" type="number" value="' + (STATE.pharmacy.low_stock_default || 5) + '"></div>' +
    '<div class="field"><label>Prescription only?</label><select id="dRx"><option value="false">No</option><option value="true">Yes</option></select></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Pack size (optional)</label><input id="dPackSize" type="number" placeholder="e.g. 100"></div>' +
    '<div class="field"><label>Pack label (optional)</label><input id="dPackLabel" placeholder="e.g. box"></div></div>' +
    '<div class="tiny" style="margin-bottom:10px">Pack size just speeds up restocking later — e.g. "100" + "box" lets you enter "3 boxes" instead of typing 300.</div>' +
    '<button class="btn primary" id="dSaveBtn" onclick="saveNewDrug()">Save drug</button>' +
    '<div class="tiny" style="margin-top:10px">Add its first batch (quantity, price, expiry) right after saving.</div>';
}

async function saveNewDrug() {
  var btn = $('#dSaveBtn');
  act(btn, async function () {
    var name = $('#dName').value.trim();
    if (!name) { toast('Give the drug a name.', 'bad'); return; }
    var payload = {
      pharmacy_id: STATE.profile.pharmacy_id,
      name: name,
      form: $('#dForm').value,
      unit: $('#dUnit').value.trim() || 'unit',
      category_id: $('#dCat').value || null,
      reorder_level: parseInt($('#dReorder').value, 10) || 5,
      is_prescription: $('#dRx').value === 'true',
      pack_size: parseInt($('#dPackSize').value, 10) || null,
      pack_label: $('#dPackLabel').value.trim() || null
    };
    var { data, error } = await sb.from('drugs').insert(payload).select().single();
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Drug added.', 'good');
    openRestock(encodeDrugForRestock(data));
  });
}

function encodeDrugForRestock(drug) { return btoa(encodeURIComponent(JSON.stringify(drug))); }

async function openDrugDetail(drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  if (!d) return;
  var { data: drugRow } = await sb.from('drugs').select('*').eq('id', drugId).single();
  var { data: batches } = await sb.from('batches').select('*').eq('drug_id', drugId).order('expiry_date');
  var body = sheet(d.name, '');
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('In stock', esc(qtyUnit(d.qty_in_stock, d.unit)), 't-sales') +
    kpi('Stock value', fmt(d.stock_value_retail), 't-orange') +
    '</div>' +
    (can('restock') ? '<button class="btn primary" style="margin-bottom:14px" onclick="closeSheet();openRestock(' + "'" + encodeDrugForRestock(drugRow) + "'" + ')">+ Restock this drug</button>' : '') +
    drugControlHtml(drugRow) +
    '<div class="section-title">Batches</div>' +
    (batches && batches.length ? batches.map(function (b) {
      var d2 = daysUntil(b.expiry_date);
      // expiry_unknown batches (from "Sync common drugs", or a restock marked
      // "I don't know the expiry") carry a placeholder date 3 years out —
      // never show that fake date, and never flag it as expiring.
      var kind = b.quantity_remaining === 0 ? 'muted' : b.expiry_unknown ? 'good' : d2 < 0 ? 'bad' : d2 <= 30 ? 'bad' : d2 <= 90 ? 'warn' : 'good';
      var expiryLabel = b.expiry_unknown ? 'Expiry unknown' : fmtDate(b.expiry_date);
      var discountBadge = b.discount_percent > 0 ? ' <span class="badge warn">-' + b.discount_percent + '%</span>' : '';
      return '<div class="batch-row"><div class="batch-head"><div class="name">' + esc(b.batch_no || 'Batch') + ' · ' + expiryLabel + discountBadge + '</div>' +
        '<span class="badge ' + kind + '">' + b.quantity_remaining + ' left</span></div>' +
        '<div class="meta">Received ' + fmtDate(b.received_at) + (b.supplier ? ' from ' + esc(b.supplier) : '') + '</div>' +
        ((can('write_off') || can('correct_stock') || can('edit_expiry')) && b.quantity_remaining > 0 ? '<div class="batch-actions">' +
          (can('write_off') ? '<button class="btn ghost small" onclick="openWriteOff(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.quantity_remaining + ')">Write off</button>' : '') +
          // Was gated on can('write_off') — a real pre-existing bug: this
          // button is "Correct count" (record_correction), a different
          // action from write-off with its own backend permission tier,
          // so it needs its own can('correct_stock') check. Fixed as part
          // of item 3 since stock_taker can correct stock but not write
          // off, and the old gate would have hidden this button from them.
          (can('correct_stock') ? '<button class="btn ghost small" onclick="openCorrection(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.quantity_remaining + ')">Correct count</button>' : '') +
          (can('discount') ? '<button class="btn ghost small" onclick="openDiscount(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.discount_percent + ')">Mark down</button>' : '') +
          // Item 34: owner-only — fixes a batch that already has a real (just
          // wrong) expiry date, e.g. entered as already-past by mistake, which
          // silently drops it out of "in stock" with no other way to correct it.
          (can('edit_expiry') ? '<button class="btn ghost small" onclick="openEditExpiry(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',\'' + (b.expiry_unknown ? '' : b.expiry_date) + '\')">Edit expiry</button>' : '') +
          '</div>' : '') +
        '</div>';
    }).join('') : '<div class="empty">No batches yet.</div>');
}

function openRestock(encodedDrug) {
  var drug = JSON.parse(decodeURIComponent(atob(encodedDrug)));
  var body = sheet('Restock: ' + drug.name, '');
  var supplierOptions = STATE.suppliersCache.map(function (s) { return '<option value="' + esc(s.name) + '">'; }).join('');
  body.innerHTML =
    (drug.pack_size ? '<div class="field"><label>Number of ' + esc(drug.pack_label || 'packs') + ' (× ' + drug.pack_size + ' ' + esc(drug.unit) + ' each)</label>' +
      '<input id="rPacks" type="number" min="1" oninput="document.getElementById(\'rQty\').value = (parseInt(this.value,10)||0) * ' + drug.pack_size + '"></div>' : '') +
    '<div class="row-2">' +
    '<div class="field"><label>Quantity (' + esc(drug.unit) + ')</label><input id="rQty" type="number" min="1"></div>' +
    '<div class="field"><label>Expiry date</label><input id="rExp" type="date"></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Cost price / unit</label><input id="rCost" type="number" step="0.01"></div>' +
    '<div class="field"><label>Sell price / unit</label><input id="rSell" type="number" step="0.01" value="' + (drug.default_price || '') + '"></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Batch no. (optional)</label><input id="rBatch"></div>' +
    '<div class="field"><label>Supplier (optional)</label><input id="rSupplier" list="rSupplierList"><datalist id="rSupplierList">' + supplierOptions + '</datalist></div></div>' +
    '<button class="btn primary" id="rSaveBtn" onclick="saveRestock(\'' + drug.id + '\')">Save restock</button>';
}

async function saveRestock(drugId) {
  var btn = $('#rSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#rQty').value, 10);
    var exp = $('#rExp').value;
    var sell = parseFloat($('#rSell').value);
    if (!qty || qty <= 0) { toast('Enter a valid quantity.', 'bad'); return; }
    if (!exp) { toast('Enter the expiry date.', 'bad'); return; }
    if (!sell) { toast('Enter the sell price.', 'bad'); return; }
    var supplierName = $('#rSupplier').value.trim() || null;
    var matchedSupplier = supplierName ? STATE.suppliersCache.find(function (s) { return s.name.toLowerCase() === supplierName.toLowerCase(); }) : null;
    var { error } = await sb.rpc('record_restock', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_drug_id: drugId,
      p_quantity: qty,
      p_cost_price: parseFloat($('#rCost').value) || null,
      p_sell_price: sell,
      p_expiry_date: exp,
      p_batch_no: $('#rBatch').value.trim() || null,
      p_supplier: supplierName,
      p_supplier_id: matchedSupplier ? matchedSupplier.id : null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Restocked.', 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
// WRITE-OFF, CORRECTION, DISCOUNT — the stock-movement actions the spec was
// missing: disposing of expired/damaged stock, reconciling a physical
// count, and marking down a near-expiry batch instead of a total write-off.
// ---------------------------------------------------------------------------

function openWriteOff(batchId, drugName, maxQty) {
  var body = sheet('Write off: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + maxQty + ' left in this batch.</div>' +
    '<div class="field"><label>Type</label><select id="woType">' +
    '<option value="expired_disposal">Expired — disposed of</option>' +
    '<option value="write_off">Damaged / other write-off</option></select></div>' +
    '<div class="field"><label>Quantity</label><input id="woQty" type="number" min="1" max="' + maxQty + '"></div>' +
    '<div class="field"><label>Reason (required)</label><textarea id="woReason" rows="2" placeholder="e.g. expired, disposed of per PPB"></textarea></div>' +
    '<button class="btn danger" id="woSaveBtn" onclick="saveWriteOff(\'' + batchId + '\')">Write off stock</button>';
}

async function saveWriteOff(batchId) {
  var btn = $('#woSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#woQty').value, 10);
    if (!qty || qty <= 0) { toast('Enter a valid quantity.', 'bad'); return; }
    // The reason is what the stock audit trail carries into a GSDP
    // inspection, so record_write_off now requires it. Catch it here too,
    // before the round trip, so the message points at the right field.
    var woReason = $('#woReason').value.trim();
    if (!woReason) { toast('Give a reason — it goes on the stock audit trail.', 'bad'); return; }
    // Write-offs permanently remove stock with no undo — a fat-fingered tap
    // at a busy counter shouldn't be able to do that with zero friction.
    if (!(await askConfirm('Write off stock', 'Write off ' + qty + ' unit(s)? This cannot be undone.', 'Write off', true))) return;
    var { error } = await sb.rpc('record_write_off', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_quantity: qty,
      p_reason: woReason, p_type: $('#woType').value
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Recorded.', 'good');
    closeSheet();
    renderInventory();
  });
}

function openCorrection(batchId, drugName, currentQty) {
  var body = sheet('Correct count: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">System currently shows ' + currentQty + '. Enter what you actually counted.</div>' +
    '<div class="field"><label>Actual quantity</label><input id="coQty" type="number" min="0" value="' + currentQty + '"></div>' +
    '<div class="field"><label>Reason (required)</label><textarea id="coReason" rows="2" placeholder="e.g. physical stock take, 30 Sep"></textarea></div>' +
    '<button class="btn primary" id="coSaveBtn" onclick="saveCorrection(\'' + batchId + '\')">Save correction</button>';
}

async function saveCorrection(batchId) {
  var btn = $('#coSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#coQty').value, 10);
    if (qty === '' || isNaN(qty) || qty < 0) { toast('Enter a valid quantity.', 'bad'); return; }
    // Same as write-off: a correction overwrites a counted quantity outright,
    // and record_correction now insists on an explanation for the audit row.
    var coReason = $('#coReason').value.trim();
    if (!coReason) { toast('Give a reason — it goes on the stock audit trail.', 'bad'); return; }
    // A correction directly overwrites the batch's counted quantity — cheap
    // to close the same confirmation gap write-off and void already have,
    // so a fat-fingered tap doesn't silently overwrite a real count.
    if (!(await askConfirm('Correct the count', 'Set this batch\'s quantity to ' + qty + '? This overwrites the current count.', 'Set quantity', true))) return;
    var { error } = await sb.rpc('record_correction', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_new_quantity: qty,
      p_reason: coReason
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Corrected.', 'good');
    closeSheet();
    renderInventory();
  });
}

function openDiscount(batchId, drugName, currentDiscount) {
  var body = sheet('Mark down: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Sell this batch below list price instead of writing it off when it expires — the discount applies automatically at checkout.</div>' +
    '<div class="field"><label>Discount %</label><input id="dcPct" type="number" min="0" max="100" value="' + (currentDiscount || 0) + '"></div>' +
    '<button class="btn primary" id="dcSaveBtn" onclick="saveDiscount(\'' + batchId + '\')">Save</button>';
}

async function saveDiscount(batchId) {
  var btn = $('#dcSaveBtn');
  act(btn, async function () {
    var pct = parseFloat($('#dcPct').value);
    if (isNaN(pct) || pct < 0 || pct > 100) { toast('Enter a percent between 0 and 100.', 'bad'); return; }
    var { error } = await sb.from('batches').update({ discount_percent: pct }).eq('id', batchId);
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast(pct > 0 ? 'Markdown set — applies automatically when this batch sells.' : 'Markdown removed.', 'good');
    closeSheet();
    renderInventory();
  });
}

// Item 34 — owner-only fix for a real bug report: a batch restocked with an
// already-past expiry date (e.g. picked yesterday by mistake) silently drops
// out of "in stock" everywhere (dashboard, Inventory, Sell) with no way to
// correct it in the app — set_batch_expiry only covers batches marked
// "expiry unknown", not one that already has a real-but-wrong date. Reopens
// the same drug's detail sheet afterward so the fix is visible immediately.
function openEditExpiry(batchId, drugName, currentExpiry) {
  var body = sheet('Edit expiry: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Only use this to correct a wrongly-entered date — for a batch that was never given a real expiry date, use "Batches with no expiry date" in Inventory instead.</div>' +
    '<div class="field"><label>Correct expiry date</label><input id="eeDate" type="date" value="' + esc(currentExpiry) + '"></div>' +
    '<button class="btn primary" id="eeSaveBtn" onclick="saveEditExpiry(\'' + batchId + '\')">Save</button>';
}

async function saveEditExpiry(batchId) {
  var btn = $('#eeSaveBtn');
  act(btn, async function () {
    var val = $('#eeDate').value;
    if (!val) { toast('Pick a date first.', 'bad'); return; }
    var { error } = await sb.rpc('correct_batch_expiry', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_new_expiry_date: val
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expiry date corrected.', 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
