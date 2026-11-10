// js/stock-actions.js - reorder list and stock-movement actions: write-off,
// correction, discount.
//
// --- Reorder list ---
// A "what to buy" list from what is low or out, so nobody has to notice at the counter.

var pendingReorderList = [];
var reorderPage = 1;
var REORDER_COLS = ['Drug', 'Current stock', 'Reorder level', 'Suggested order', 'Status'];
function reorderCells(n) {
  return [n.name, n.current + ' ' + n.unit, n.reorderLevel, n.suggested, n.current <= 0 ? stCell('Out of stock', 'bad') : stCell('Low', 'warn')];
}

function openReorderList() {
  var needed = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; })
    .map(function (d) {
      var suggested = Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5);
      return { name: d.name, unit: d.unit, current: d.qty_in_stock, reorderLevel: d.reorder_level, suggested: suggested };
    });
  pendingReorderList = needed;
  reorderPage = 1;
  var body = sheet('Reorder List', '');
  drawReorderList(body);
}

function drawReorderList(body) {
  body = body || $('#sheetBody');
  if (!body) return;
  var pg = pageSlice(pendingReorderList, reorderPage);
  reorderPage = pg.page;
  body.innerHTML =
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportReorderExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn" onclick="printReorderList()">' + icon('printer',15) + ' Print</button>' +
    '</div></div>' +
    showingHtml(pg) +
    rtTable(REORDER_COLS, pg.rows.map(reorderCells), { empty: 'Nothing needs reordering right now.', num: [false, false, true, true, false] }) +
    pagerHtml(pg, 'goReorderPage');
}
function goReorderPage(p) { reorderPage = p; drawReorderList(); }

function exportReorderExcel() {
  var rows = pendingReorderList.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - reorder list.xlsx', 'Reorder', rows);
}

// Print carries the whole list (every page), same as Excel.
function printReorderList() {
  var rows = pendingReorderList.map(reorderCells);
  printHtml('Reorder List', todayStr(), tableHtml(REORDER_COLS, rows, 'Total: ' + rows.length + ' drugs to reorder'), rows.length + ' items');
}

// Drugs brought in without an expiry date (e.g. a relaxed Excel import) are
// flagged by has_unknown_expiry in v_drug_stock. This lets the pharmacy find
// the batch later and enter the real date.
function openUnknownExpiryList() {
  unknownExpiryPage = 1;
  sheet('Batches with no expiry date', '<div class="empty">Loading…</div>');
  loadUnknownExpiryList();
}

async function loadUnknownExpiryList() {
  var body = $('#sheetBody');
  if (!body) return;
  try {
    var { data: batches, error } = await fetchAllRows(function () {
      return sb.from('batches')
        .select('id, batch_no, quantity_remaining, drug_id, drugs(name, unit)')
        .eq('pharmacy_id', STATE.profile.pharmacy_id)
        .eq('expiry_unknown', true)
        .gt('quantity_remaining', 0)
        .order('created_at', { ascending: true });
    }, 'id');
    if (error) throw error;
    STATE.unknownExpiryBatches = batches || [];
    renderUnknownExpiryList();
  } catch (e) {
    body.innerHTML = '<div class="empty">' + esc(friendlyError(e)) + '</div>';
  }
}

var unknownExpiryPage = 1;
function renderUnknownExpiryList() {
  var body = $('#sheetBody');
  if (!body) return;
  var batches = STATE.unknownExpiryBatches || [];
  var pg = pageSlice(batches, unknownExpiryPage);
  unknownExpiryPage = pg.page;
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">These batches were brought into stock without an expiry date. Set the real date once you have it. This only needs doing once per batch.</div>' +
    showingHtml(pg) +
    rtTable(['Drug', 'Batch', 'Qty', 'Set expiry date'], pg.rows.map(function (b) {
      return [(b.drugs && b.drugs.name) || 'Unknown drug', b.batch_no || '—', b.quantity_remaining + ' ' + ((b.drugs && b.drugs.unit) || 'unit'),
        { html: '<span style="display:inline-flex;gap:8px;align-items:center"><input type="date" id="expInput_' + esc(b.id) + '">' +
          '<button class="btn small" id="expSaveBtn_' + esc(b.id) + '" onclick="saveBatchExpiry(\'' + esc(b.id) + '\')">Save</button></span>' }];
    }), { empty: 'Nothing left to flag. Every batch has an expiry date.', num: [false, false, false, false] }) +
    pagerHtml(pg, 'goUnknownExpiryPage');
}
function goUnknownExpiryPage(p) { unknownExpiryPage = p; renderUnknownExpiryList(); }

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
    '<div class="field"><label>Barcode (optional)</label><div style="display:flex;gap:8px"><input id="dBarcode" placeholder="Scan, or type it in" style="flex:1">' +
    (barcodeCameraSupported() ? '<button type="button" class="btn secondary" title="Scan barcode" aria-label="Scan barcode" onclick="openBarcodeScan(function(c){document.getElementById(\'dBarcode\').value=c;})">' + icon('barcode', 18) + '</button>' : '') + '</div></div>' +
    '<div class="tiny" style="margin-bottom:10px">Lets Sell and Inventory find this drug by scanning it. Leave empty if it has none - nothing changes for it.</div>' +
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
      // a number that differs from the pharmacy default was chosen for this drug, so it stays its own
      reorder_custom: (parseInt($('#dReorder').value, 10) || 5) !== (STATE.pharmacy.low_stock_default || 5),
      is_prescription: $('#dRx').value === 'true',
      pack_size: parseInt($('#dPackSize').value, 10) || null,
      pack_label: $('#dPackLabel').value.trim() || null,
      barcode: $('#dBarcode').value.trim() || null
    };
    var { data, error } = await sb.from('drugs').insert(payload).select().single();
    if (error) {
      if (error.code === '23505' && /barcode/i.test(error.message || '')) {
        toast('Another drug already uses that barcode.', 'bad');
      } else if (error.code === '23505' || /duplicate key|unique constraint/i.test(error.message || '')) {
        // The name is taken: by a drug in the list, or by one that was stopped (hidden).
        toast('A drug with that name already exists. If you stopped selling it, bring it back from Hidden drugs on the Inventory screen.', 'bad');
      } else toast(friendlyError(error), 'bad');
      return;
    }
    toast('Drug added.', 'good');
    openRestock(encodeDrugForRestock(data));
  });
}

function encodeDrugForRestock(drug) { return btoa(encodeURIComponent(JSON.stringify(drug))); }

// --- Edit, stop selling, delete ---
// Fix a mistyped drug or retire one that is no longer sold. A drug with
// history is never deleted (old sales and reports point at it); it is hidden
// and can be brought back. Only a drug with no batch and no sale can be
// deleted. The rules live in the database (edit_drug, set_drug_active,
// delete_drug); the screens just ask.

function drugToolsHtml(drugRow, neverStocked) {
  if (!can('edit_inventory') || !drugRow) return '';
  return '<div class="drug-tools" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
    '<button class="btn secondary small" onclick="openEditDrug(\'' + encodeDrugForRestock(drugRow) + '\')">Edit details</button>' +
    (neverStocked
      ? '<button class="btn danger small" onclick="deleteDrugNow(this,\'' + drugRow.id + '\')">Delete drug</button>'
      : '<button class="btn secondary small" onclick="stopSellingDrug(this,\'' + drugRow.id + '\')">Stop selling</button>') +
    '</div>';
}

function openEditDrug(encodedDrug) {
  var drug = JSON.parse(decodeURIComponent(atob(encodedDrug)));
  var catOptions = STATE.categoriesCache.map(function (c) {
    return '<option value="' + c.id + '"' + (c.id === drug.category_id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
  }).join('');
  var forms = ['tablet', 'capsule', 'syrup', 'injection', 'cream_ointment', 'drops', 'suppository', 'inhaler', 'iv_fluid', 'other'];
  // With the days alert on, a drug that has no number of its own shows an empty box.
  window.__editDrugWas = { id: drug.id, custom: !!drug.reorder_custom, level: drug.reorder_level };
  var daysOn = !!(STATE.pharmacy && STATE.pharmacy.low_stock_days);
  var shownLevel = (daysOn && !drug.reorder_custom) ? null : drug.reorder_level;
  var body = sheet('Edit: ' + drug.name, '');
  body.innerHTML =
    '<div class="field"><label>Drug name</label><input id="eName" value="' + esc(drug.name) + '"></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Form</label><select id="eForm">' +
      forms.map(function (f) { return '<option value="' + f + '"' + (f === drug.form ? ' selected' : '') + '>' + f.replace('_', '/') + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field"><label>Unit</label><input id="eUnit" value="' + esc(drug.unit || '') + '"></div></div>' +
    '<div class="field"><label>Category</label><select id="eCat"><option value="">— none —</option>' + catOptions + '</select></div>' +
    (daysOn ? '' : '<div class="row-2">') +
    '<div class="field"><label>' + (daysOn ? 'Warn me at (optional)' : 'Reorder level') + '</label><input id="eReorder" type="number" min="0" value="' + (shownLevel == null ? '' : shownLevel) + '"' + (daysOn ? ' placeholder="Empty: uses ' + STATE.pharmacy.low_stock_days + ' days left"' : '') + '>' +
      (daysOn ? '<div class="tiny" style="margin-top:4px">A number here always wins for this drug. Leave it empty to warn when the drug will last fewer than ' + STATE.pharmacy.low_stock_days + ' days.</div>' : '') + '</div>' +
    '<div class="field"><label>Prescription only?</label><select id="eRx"><option value="false"' + (drug.is_prescription ? '' : ' selected') + '>No</option><option value="true"' + (drug.is_prescription ? ' selected' : '') + '>Yes</option></select></div>' + (daysOn ? '' : '</div>') +
    '<div class="row-2">' +
    '<div class="field"><label>Pack size (optional)</label><input id="ePackSize" type="number" min="1" value="' + (drug.pack_size || '') + '"></div>' +
    '<div class="field"><label>Pack label (optional)</label><input id="ePackLabel" value="' + esc(drug.pack_label || '') + '"></div></div>' +
    '<div class="field"><label>Barcode (optional)</label><div style="display:flex;gap:8px"><input id="eBarcode" value="' + esc(drug.barcode || '') + '" placeholder="Scan, or type it in" style="flex:1">' +
    (barcodeCameraSupported() ? '<button type="button" class="btn secondary" title="Scan barcode" aria-label="Scan barcode" onclick="openBarcodeScan(function(c){document.getElementById(\'eBarcode\').value=c;})">' + icon('barcode', 18) + '</button>' : '') + '</div></div>' +
    '<button class="btn primary" id="eSaveBtn" onclick="saveEditedDrug(\'' + drug.id + '\')">Save changes</button>' +
    '<div class="tiny" style="margin-top:10px">Stock and past sales are not touched. Past sales and reports will show the new name.</div>';
}

function saveEditedDrug(drugId) {
  act($('#eSaveBtn'), async function () {
    var name = $('#eName').value.trim();
    if (!name) { toast('Give the drug a name.', 'bad'); return; }
    var daysOn = !!(STATE.pharmacy && STATE.pharmacy.low_stock_days);
    var raw = $('#eReorder').value.trim();
    var reorder = raw === '' ? null : parseInt(raw, 10);
    // custom: true = this drug has its own number; false = use the days alert; null = leave as it is.
    var custom = null;
    if (reorder === null) {
      if (!daysOn) { toast('Enter a reorder level of 0 or more.', 'bad'); return; }
      custom = false;
    } else {
      if (isNaN(reorder) || reorder < 0) { toast('Enter a reorder level of 0 or more.', 'bad'); return; }
      var was = window.__editDrugWas || {};
      // Saving the box untouched must not pin a drug that was using the days alert.
      custom = (was.id === drugId && !was.custom && reorder === was.level) ? null : true;
    }
    await rpcCall('edit_drug', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_drug_id: drugId,
      p_name: name,
      p_category_id: $('#eCat').value || null,
      p_form: $('#eForm').value,
      p_unit: $('#eUnit').value.trim(),
      p_reorder_level: reorder,
      p_reorder_custom: custom,
      p_is_prescription: $('#eRx').value === 'true',
      p_pack_size: parseInt($('#ePackSize').value, 10) || null,
      p_pack_label: $('#ePackLabel').value.trim() || null,
      p_barcode: $('#eBarcode').value.trim() || null
    });
    toast('Drug updated.', 'good');
    clearDashCache();
    closeSheet();
    renderInventory();
  });
}

async function stopSellingDrug(btn, drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  var name = d ? d.name : 'this drug';
  var left = d ? Number(d.qty_in_stock || 0) + Number(d.qty_expired || 0) : 0;
  if (left > 0) {
    toast(qtyUnit(left, d.unit) + ' still in stock (expired stock counts). Sell it or write it off first, then stop selling ' + name + '.', 'bad');
    return;
  }
  var ok = await askConfirm('Stop selling ' + name + '?',
    'It will disappear from Sell and Inventory. Its sales history stays, and you can bring it back from Hidden drugs.', 'Stop selling', true);
  if (!ok) return;
  act(btn, async function () {
    await rpcCall('set_drug_active', { p_pharmacy_id: STATE.profile.pharmacy_id, p_drug_id: drugId, p_active: false });
    toast(name + ' is hidden.', 'good');
    clearDashCache();
    closeSheet();
    renderInventory();
  });
}

async function deleteDrugNow(btn, drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  var name = d ? d.name : 'this drug';
  var ok = await askConfirm('Delete ' + name + ' for good?',
    'It never had any stock or sales, so nothing else is affected. This cannot be undone.', 'Delete', true);
  if (!ok) return;
  act(btn, async function () {
    await rpcCall('delete_drug', { p_pharmacy_id: STATE.profile.pharmacy_id, p_drug_id: drugId });
    toast('Drug deleted.', 'good');
    clearDashCache();
    closeSheet();
    renderInventory();
  });
}

function openHiddenDrugs() {
  sheet('Hidden drugs', '<div class="empty">Loading…</div>');
  loadHiddenDrugs();
}

async function loadHiddenDrugs() {
  var body = $('#sheetBody');
  if (!body) return;
  try {
    var { data, error } = await fetchAllRows(function () {
      return sb.from('drugs').select('id, name, unit')
        .eq('pharmacy_id', STATE.profile.pharmacy_id).eq('active', false).order('name');
    }, 'id');
    if (error) throw error;
    body.innerHTML =
      '<div class="tiny" style="margin-bottom:10px">Drugs you stopped selling. They stay out of Sell and Inventory until you bring them back; their old sales are kept.</div>' +
      ((data || []).length ? '<div class="card">' + data.map(function (x) {
        return '<div class="list-row"><div><div class="name">' + esc(x.name) + '</div><div class="meta">' + esc(x.unit || '') + '</div></div>' +
          '<div class="right"><button class="btn secondary small" onclick="restoreDrug(this,\'' + x.id + '\')">Bring back</button></div></div>';
      }).join('') + '</div>' : '<div class="empty">No hidden drugs.</div>');
  } catch (e) {
    errorCard(body, friendlyError(e), 'loadHiddenDrugs');
  }
}

function restoreDrug(btn, drugId) {
  act(btn, async function () {
    await rpcCall('set_drug_active', { p_pharmacy_id: STATE.profile.pharmacy_id, p_drug_id: drugId, p_active: true });
    toast('Drug is back on the list.', 'good');
    clearDashCache();
    loadHiddenDrugs();
    renderInventory();
  });
}

async function openDrugDetail(drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  if (!d) return;
  // All batches with stock are shown, but only the latest few used-up ones, so
  // a drug restocked hundreds of times still opens fast. The three requests run
  // together.
  var DONE_BATCHES_SHOWN = 5;
  var detail = await Promise.all([
    sb.from('drugs').select('*').eq('id', drugId).single(),
    sb.from('batches').select('*').eq('drug_id', drugId).gt('quantity_remaining', 0).order('expiry_date').limit(300),
    sb.from('batches').select('*').eq('drug_id', drugId).eq('quantity_remaining', 0).order('received_at', { ascending: false }).order('created_at', { ascending: false }).limit(DONE_BATCHES_SHOWN),
    sb.from('price_changes').select('old_price,new_price,changed_at,source,profiles(full_name)').eq('drug_id', drugId).order('changed_at', { ascending: false }).limit(10)
  ]);
  var drugRow = detail[0].data;
  var batches = (detail[1].data || []).concat(detail[2].data || []).sort(function (a, b) { return String(a.expiry_date) < String(b.expiry_date) ? -1 : 1; });
  var usedUpNote = (detail[2].data || []).length >= DONE_BATCHES_SHOWN ? '<div class="tiny" style="margin-top:8px">Showing the latest ' + DONE_BATCHES_SHOWN + ' used-up batches.</div>' : '';
  var body = sheet(d.name, '');
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('In stock', esc(qtyUnit(d.qty_in_stock, d.unit)), 't-sales') +
    kpi('Stock value', fmt(d.stock_value_retail), 't-orange') +
    '</div>' +
    (can('restock') ? '<button class="btn primary" style="margin-bottom:14px" onclick="closeSheet();openRestock(' + "'" + encodeDrugForRestock(drugRow) + "'" + ')">+ Restock this drug</button>' : '') +
    drugControlHtml(drugRow) +
    drugToolsHtml(drugRow, !(detail[1].data || []).length && !(detail[2].data || []).length) +
    '<div class="section-title">Batches</div>' +
    (batches && batches.length ? batches.map(function (b) {
      var d2 = daysUntil(b.expiry_date);
      // expiry_unknown batches (from "Sync common drugs" or a restock marked "I don't
      // know the expiry") hold a placeholder date 3 years out. Never show that date
      // and never flag it as expiring.
      var kind = b.quantity_remaining === 0 ? 'muted' : b.expiry_unknown ? 'good' : d2 < 0 ? 'bad' : d2 <= 30 ? 'bad' : d2 <= 90 ? 'warn' : 'good';
      var expiryLabel = b.expiry_unknown ? 'Expiry unknown' : fmtDate(b.expiry_date);
      var discountBadge = b.discount_percent > 0 ? ' <span class="badge warn">-' + b.discount_percent + '%</span>' : '';
      return '<div class="batch-row"><div class="batch-head"><div class="name">' + esc(b.batch_no || 'Batch') + ' · ' + expiryLabel + discountBadge + '</div>' +
        '<span class="badge ' + kind + '">' + b.quantity_remaining + ' left</span></div>' +
        '<div class="meta">Received ' + fmtDate(b.received_at) + (b.supplier ? ' from ' + esc(b.supplier) : '') + '</div>' +
        ((can('write_off') || can('correct_stock') || can('edit_expiry') || can('edit_price')) && b.quantity_remaining > 0 ? '<div class="batch-actions">' +
          (can('write_off') ? '<button class="btn ghost small" onclick="openWriteOff(\'' + b.id + '\',\'' + jsArg(d.name) + '\',' + b.quantity_remaining + ')">Write off</button>' : '') +
          // "Correct count" is record_correction, which has its own permission
          // (correct_stock), separate from write_off. A stock_taker can correct but not
          // write off.
          (can('suppliers') ? '<button class="btn ghost small" onclick="openSupplierReturn(\'' + b.id + '\',\'' + jsArg(d.name) + '\',' + b.quantity_remaining + ',' + (b.cost_price == null ? 'null' : Number(b.cost_price)) + ',\'' + (b.supplier_id || '') + '\')">Return to supplier</button>' : '') +
          (can('correct_stock') ? '<button class="btn ghost small" onclick="openCorrection(\'' + b.id + '\',\'' + jsArg(d.name) + '\',' + b.quantity_remaining + ')">Correct count</button>' : '') +
          (can('discount') ? '<button class="btn ghost small" onclick="openDiscount(\'' + b.id + '\',\'' + jsArg(d.name) + '\',' + b.discount_percent + ')">Mark down</button>' : '') +
          // Owner only: fixes a batch with a real but wrong expiry date (e.g. already
          // past by mistake), which otherwise drops out of "in stock" with no way back.
          (can('edit_expiry') ? '<button class="btn ghost small" onclick="openEditExpiry(\'' + b.id + '\',\'' + jsArg(d.name) + '\',\'' + (b.expiry_unknown ? '' : b.expiry_date) + '\')">Edit expiry</button>' : '') +
          // Owner only, same reasoning as Edit expiry: fixes a batch that was
          // typed in at the wrong price, without voiding a sale or going
          // through Correct count + a fresh restock.
          (can('edit_price') ? '<button class="btn ghost small" onclick="openEditBatchPrice(\'' + b.id + '\',\'' + jsArg(d.name) + '\',' + Number(b.sell_price) + ',' + (b.cost_price == null ? 'null' : Number(b.cost_price)) + ')">Edit price</button>' : '') +
          '</div>' : '') +
        '</div>';
    }).join('') + usedUpNote : '<div class="empty">No batches yet.</div>') +
    priceHistoryHtml(detail[3].data);
}

// The last price changes of a drug: old price, new price, when, who, and where it came from.
function priceHistoryHtml(rows) {
  if (!rows || !rows.length) return '';
  var how = { sheet: 'Excel sheet', restock: 'Restock', batch: 'Batch fix', undo: 'Undo' };
  return '<div class="section-title">Price history</div><div class="card">' + rows.map(function (r) {
    var who = r.profiles && r.profiles.full_name ? ' · ' + esc(r.profiles.full_name) : '';
    return '<div class="list-row"><div><div class="name">' + fmt(r.old_price) + ' to ' + fmt(r.new_price) + '</div>' +
      '<div class="meta">' + fmtDateTime(r.changed_at) + who + ' · ' + esc(how[r.source] || 'Edit') + '</div></div></div>';
  }).join('') + '</div>';
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

// --- Write-off, correction, discount ---
// Dispose of expired or damaged stock, reconcile a physical count, or mark
// down a near-expiry batch instead of writing it off.

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
    // The reason goes into the stock audit trail (needed for a GSDP inspection), so
    // record_write_off requires it. Check here too so the message names the right field.
    var woReason = $('#woReason').value.trim();
    if (!woReason) { toast('Give a reason — it goes on the stock audit trail.', 'bad'); return; }
    // A write-off removes stock for good, so ask for confirmation first.
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

// --- Return stock to a supplier ---
// Sends part or all of a batch back and records the credit, which lowers what the supplier is owed.
// The credit starts as quantity x the batch's cost price and can be changed (the supplier may
// give less, or more). The checks that matter run again in record_supplier_return.

// quantity x cost, to 2 places; null when the cost was never recorded or the quantity is not valid
function supplierReturnCredit(qty, cost) {
  var q = Number(qty);
  if (cost == null || cost === '' || !(q > 0) || isNaN(Number(cost))) return null;
  return Math.round(q * Number(cost) * 100) / 100;
}

function openSupplierReturn(batchId, drugName, maxQty, cost, supplierId) {
  var sups = STATE.suppliersCache || [];
  var fixed = supplierId ? sups.filter(function (s) { return s.id === supplierId; }) : sups;
  var body = sheet('Return to supplier: ' + drugName, '');
  if (!fixed.length) {
    body.innerHTML = '<div class="empty">Add this supplier under Suppliers first, then come back to return the stock.</div>';
    return;
  }
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + maxQty + ' left in this batch.</div>' +
    '<div class="field"><label>Supplier</label><select id="srSupplier"' + (supplierId ? ' disabled' : '') + '>' +
    (supplierId ? '' : '<option value="">Choose the supplier</option>') +
    fixed.map(function (s) { return '<option value="' + esc(s.id) + '"' + (supplierId ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Quantity</label><input id="srQty" type="number" min="1" max="' + maxQty + '" oninput="srRefreshCredit(' + (cost == null ? 'null' : Number(cost)) + ')"></div>' +
    '<div class="field"><label>Credit (KES)</label><input id="srCredit" type="number" min="0" step="0.01" placeholder="' + (cost == null ? 'Type the credit' : 'Quantity x cost') + '" oninput="this.dataset.touched=1"></div>' +
    '</div>' +
    '<div class="field"><label>Reason (required)</label><textarea id="srReason" rows="2" placeholder="e.g. expired, damaged, wrong item delivered"></textarea></div>' +
    '<button class="btn primary" id="srSaveBtn" onclick="saveSupplierReturn(\'' + batchId + '\',' + maxQty + ',' + (cost == null ? 'null' : Number(cost)) + ')">Return stock</button>';
}

function srRefreshCredit(cost) {
  var el = $('#srCredit');
  if (!el || el.dataset.touched) return;
  var v = supplierReturnCredit($('#srQty').value, cost);
  el.value = v == null ? '' : v;
}

async function saveSupplierReturn(batchId, maxQty, cost) {
  var btn = $('#srSaveBtn');
  act(btn, async function () {
    var supplierId = $('#srSupplier').value;
    var qty = parseInt($('#srQty').value, 10);
    var reason = $('#srReason').value.trim();
    var creditText = $('#srCredit').value.trim();
    if (!supplierId) { toast('Choose the supplier.', 'bad'); return; }
    if (!qty || qty <= 0) { toast('Enter a valid quantity.', 'bad'); return; }
    if (qty > maxQty) { toast('Only ' + maxQty + ' left in this batch.', 'bad'); return; }
    if (!reason) { toast('Give a reason. It goes on the stock audit trail.', 'bad'); return; }
    if (creditText === '' && cost == null) { toast('This batch has no cost price. Type the credit (0 if none).', 'bad'); return; }
    var credit = creditText === '' ? null : Number(creditText);
    if (credit != null && (isNaN(credit) || credit < 0)) { toast('The credit must be 0 or more.', 'bad'); return; }
    var shown = credit == null ? supplierReturnCredit(qty, cost) : credit;
    if (!(await askConfirm('Return stock', 'Return ' + qty + ' unit(s) for a credit of ' + fmt(shown) + '? This cannot be undone.', 'Return stock', true))) return;
    var { error } = await sb.rpc('record_supplier_return', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_supplier_id: supplierId, p_batch_id: batchId,
      p_quantity: qty, p_reason: reason, p_credit_amount: credit
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Returned. The supplier balance is updated.', 'good');
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
    // A correction overwrites a counted quantity, and record_correction requires a
    // reason for the audit row.
    var coReason = $('#coReason').value.trim();
    if (!coReason) { toast('Give a reason — it goes on the stock audit trail.', 'bad'); return; }
    // Confirm first, like write-off and void, so a mis-tap cannot overwrite a real count.
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

// Owner only: set a new expiry on a batch that already has a (wrong) real date.
// set_batch_expiry only handles "expiry unknown" batches. Reopens the drug's
// detail sheet afterwards so the fix shows immediately.
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

// Owner only: fixes a batch that was typed in at the wrong sell or cost price,
// in one step - no voiding a sale, no Correct count, no fresh restock. Reopens
// the drug's detail sheet afterwards so the fix shows immediately, same as
// Edit expiry.
function openEditBatchPrice(batchId, drugName, currentSell, currentCost) {
  var body = sheet('Edit price: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Only use this to correct a wrongly-typed price on this batch. A deliberate price change for everything still on the shelf is the Excel stock sheet or a fresh restock.</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Cost price / unit</label><input id="epCost" type="number" step="0.01" value="' + (currentCost == null ? '' : currentCost) + '"></div>' +
    '<div class="field"><label>Sell price / unit</label><input id="epSell" type="number" step="0.01" value="' + currentSell + '"></div></div>' +
    '<button class="btn primary" id="epSaveBtn" onclick="saveEditBatchPrice(\'' + batchId + '\')">Save</button>';
}

async function saveEditBatchPrice(batchId) {
  var btn = $('#epSaveBtn');
  act(btn, async function () {
    var sell = parseFloat($('#epSell').value);
    if (!sell || sell <= 0) { toast('Enter a sell price above zero.', 'bad'); return; }
    var costText = $('#epCost').value.trim();
    var cost = costText === '' ? null : parseFloat(costText);
    if (cost != null && (isNaN(cost) || cost < 0)) { toast('Cost price cannot be negative.', 'bad'); return; }
    var { error } = await sb.rpc('correct_batch_price', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_new_sell_price: sell, p_new_cost_price: cost
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Price corrected.', 'good');
    closeSheet();
    renderInventory();
  });
}

