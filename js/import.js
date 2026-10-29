// js/import.js - Bulk import from a spreadsheet, and "sync common drugs" for a new pharmacy.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// BULK IMPORT — the whole reason this app exists is a spreadsheet just like
// this one; re-typing 300 rows by hand defeats the point. Accepts a flexible
// column layout (matches the columns pharmacists already use: Drug, Qty,
// Price, Expiry…) and understands the "12.2027" (month.year) expiry format
// seen in real stock-take sheets, not just proper dates.
// ---------------------------------------------------------------------------

function downloadImportTemplate() {
  var rows = [{
    'Drug': 'Amoxiclav 228 susp', 'Category': 'Antibiotics/Antifungals/Amoebicides', 'Form': 'syrup',
    'Unit': 'bottle', 'Qty': 20, 'Cost Price': 150, 'Sell Price': 200, 'Expiry': '12.2027',
    'Batch No': '', 'Supplier': ''
  }];
  exportExcel('Pharma - import template.xlsx', 'Stock', rows);
}

// Parses "12.2027" (month.year, as seen in real stock-take sheets), a
// proper date string, or an Excel date object — returns 'YYYY-MM-DD' (last
// day of the month for the month.year form) or null if unreadable.
function parseFlexibleExpiry(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10);
  var s = String(val).trim();
  var m = s.match(/^(\d{1,2})\.(\d{4})$/);
  if (m) {
    var month = parseInt(m[1], 10), year = parseInt(m[2], 10);
    if (month >= 1 && month <= 12) {
      var lastDay = new Date(year, month, 0).getDate();
      return year + '-' + String(month).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
    }
  }
  var d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

// Column-name aliases the importer recognizes, matched case-insensitively.
// 'drugs' (plural) is here because that's the header real pharmacy
// stock-take sheets actually use (see IMPORT_COLUMN_ALIASES.name).
var IMPORT_COLUMN_ALIASES = {
  name: ['drug', 'drugs', 'name', 'drug name'],
  category: ['category'],
  form: ['form'],
  unit: ['unit'],
  qty: ['qty', 'quantity'],
  costPrice: ['cost price'],
  sellPrice: ['sell price', 'price', 'price per unit'],
  expiry: ['expiry', 'exp dt', 'expiry date'],
  batchNo: ['batch no', 'batch'],
  supplier: ['supplier']
};

// Real stock-take sheets (like the one this app was built from) often have
// a title row above the real column headers ("RUBAO MUKOTHIMA STOCK TAKE",
// then "DRUGS / QTY / PRICE PER UNIT / …" on the next row). Reading the
// file as plain rows (not assuming row 1 is the header) and searching the
// first several rows for one that actually contains a recognized column
// name handles that without asking the pharmacist to edit their sheet first.
function findImportHeaderRow(rows) {
  for (var i = 0; i < Math.min(rows.length, 10); i++) {
    for (var c = 0; c < rows[i].length; c++) {
      var cell = String(rows[i][c] || '').trim().toLowerCase();
      if (IMPORT_COLUMN_ALIASES.name.indexOf(cell) !== -1) return i;
    }
  }
  return 0;
}

function buildImportColumnMap(headerRow) {
  var map = {};
  headerRow.forEach(function (cell, idx) {
    var v = String(cell || '').trim().toLowerCase();
    Object.keys(IMPORT_COLUMN_ALIASES).forEach(function (field) {
      if (map[field] === undefined && IMPORT_COLUMN_ALIASES[field].indexOf(v) !== -1) map[field] = idx;
    });
  });
  return map;
}

function openImportExcel() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = function () {
    if (!input.files.length) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      loadXlsx().then(function () { readImportBuffer(e.target.result); })
        .catch(function (err) { toast(friendlyError(err), 'bad'); });
    };
    reader.readAsArrayBuffer(input.files[0]);
  };
  input.click();
}
function readImportBuffer(buffer) {
  try {
    var wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    var headerIdx = findImportHeaderRow(allRows);
    var colMap = buildImportColumnMap(allRows[headerIdx] || []);
    var dataRows = allRows.slice(headerIdx + 1);
    previewImport(dataRows, colMap);
  } catch (err) {
    toast('Could not read that file — is it a valid Excel/CSV file?', 'bad');
  }
}

function previewImport(dataRows, colMap) {
  var parsed = [];
  var skipped = 0;
  var currentCategory = '';
  dataRows.forEach(function (row) {
    var cell = function (field) {
      var idx = colMap[field];
      if (idx === undefined) return null;
      var v = row[idx];
      return (v === undefined || v === null || String(v).trim() === '') ? null : v;
    };
    var name = cell('name');
    var qty = parseInt(cell('qty'), 10);
    var sellPrice = parseFloat(cell('sellPrice'));

    // A row that's just a drug name with no quantity and no price at all
    // (written in ALL CAPS, e.g. "ANALGESICS/ANTIPYRETICS", "COUGH SYRUPS")
    // is a section header in the pharmacist's sheet, not a stock line —
    // remember it as the category for the rows underneath, same way a
    // person reading the sheet by eye would.
    if (name && qty !== qty /* NaN */ && !sellPrice) {
      var trimmedName = String(name).trim();
      if (trimmedName === trimmedName.toUpperCase() && /[A-Za-z]/.test(trimmedName)) {
        currentCategory = trimmedName;
        return;
      }
    }

    // Only drug name and current stock quantity are actually required —
    // everything else (price, expiry, category, batch no., supplier) is
    // optional at import time, so a messy real-world stock-take sheet
    // doesn't lose rows over incidental missing columns. A missing sell
    // price defaults to cost price (or 0, visibly flaggable in Inventory —
    // nobody misses a drug priced at KES 0). A missing expiry imports as
    // "expiry unknown" (same placeholder-date pattern record_restock
    // already supports for Sync common drugs / supplier LPOs) rather than
    // being skipped — see openUnknownExpiryList() for how the pharmacy
    // finds and fixes these afterward.
    var expiryRaw = cell('expiry');
    var expiry = parseFlexibleExpiry(expiryRaw);
    if (!name || !qty || qty <= 0) { skipped++; return; }
    var costPrice = parseFloat(cell('costPrice')) || null;
    parsed.push({
      name: String(name).trim(),
      category: cell('category') || currentCategory || '',
      form: (cell('form') || 'other').toString().toLowerCase(),
      unit: cell('unit') || 'unit',
      qty: qty,
      costPrice: costPrice,
      sellPrice: sellPrice || costPrice || 0,
      expiry: expiry,
      expiryUnknown: !expiry,
      batchNo: cell('batchNo') || null,
      supplier: cell('supplier') || null
    });
  });

  var noPriceCount = parsed.filter(function (p) { return !p.sellPrice; }).length;
  var noExpiryCount = parsed.filter(function (p) { return p.expiryUnknown; }).length;
  var body = sheet('Import preview', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + parsed.length + ' rows ready to import' +
    (skipped ? ', ' + skipped + ' skipped (missing drug name or quantity)' : '') + '.' +
    (noExpiryCount ? ' ' + noExpiryCount + ' with no expiry date — they\'ll import as "expiry unknown," flagged in Inventory to fix later.' : '') +
    (noPriceCount ? ' ' + noPriceCount + ' with no price — they\'ll import at KES 0 until you set a price.' : '') +
    '</div>' +
    '<div class="card" style="max-height:260px;overflow-y:auto">' +
    (parsed.length ? parsed.slice(0, 50).map(function (p) {
      // listRow() escapes its name argument but not meta — and p.unit here is
      // a raw cell out of an uploaded spreadsheet.
      return listRow(p.name, p.qty + ' ' + esc(p.unit) + ' · exp ' + (p.expiryUnknown ? 'unknown' : fmtDate(p.expiry)), fmt(p.sellPrice));
    }).join('') : '<div class="empty">Nothing importable was found in that file.</div>') +
    (parsed.length > 50 ? '<div class="tiny" style="margin-top:8px">…and ' + (parsed.length - 50) + ' more</div>' : '') +
    '</div>' +
    (parsed.length ? '<button class="btn primary" id="impBtn" onclick="runImport(' + "'" + btoa(encodeURIComponent(JSON.stringify(parsed))) + "'" + ')">Import ' + parsed.length + ' rows</button>' : '') +
    '<button class="btn ghost" style="margin-top:8px" onclick="downloadImportTemplate()">Download a blank template instead</button>';
}

async function runImport(encoded) {
  var rows = JSON.parse(decodeURIComponent(atob(encoded)));
  var btn = $('#impBtn');
  act(btn, async function () {
    // Normalized (letters/digits only, lowercased) so "Anti-H-Pylori" from
    // the seeded categories matches "ANTI H PYLORI" as written by hand in a
    // real stock-take sheet — punctuation/spacing varies, the category
    // doesn't.
    var normCat = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
    var catByName = {};
    STATE.categoriesCache.forEach(function (c) { catByName[normCat(c.name)] = c.id; });
    var drugByName = {};
    STATE.drugsCache.forEach(function (d) { drugByName[d.name.toLowerCase()] = d.drug_id; });
    // also pick up drugs already in the DB that might not be in the (stock>0) cache
    var { data: allDrugs } = await sb.from('drugs').select('id, name').eq('pharmacy_id', STATE.profile.pharmacy_id);
    (allDrugs || []).forEach(function (d) { drugByName[d.name.toLowerCase()] = d.id; });

    var imported = 0, failed = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      try {
        var drugId = drugByName[r.name.toLowerCase()];
        if (!drugId) {
          var validForms = ['tablet', 'capsule', 'syrup', 'injection', 'cream_ointment', 'drops', 'suppository', 'inhaler', 'iv_fluid', 'other'];
          var { data: newDrug, error: dErr } = await sb.from('drugs').insert({
            pharmacy_id: STATE.profile.pharmacy_id,
            name: r.name,
            form: validForms.indexOf(r.form) !== -1 ? r.form : 'other',
            unit: r.unit,
            category_id: r.category ? (catByName[normCat(r.category)] || null) : null
          }).select().single();
          if (dErr) throw dErr;
          drugId = newDrug.id;
          drugByName[r.name.toLowerCase()] = drugId;
        }
        var { error: rErr } = await sb.rpc('record_restock', {
          p_pharmacy_id: STATE.profile.pharmacy_id,
          p_drug_id: drugId,
          p_quantity: r.qty,
          p_cost_price: r.costPrice,
          p_sell_price: r.sellPrice,
          p_expiry_date: r.expiry,
          p_batch_no: r.batchNo,
          p_supplier: r.supplier,
          p_expiry_unknown: !r.expiry
        });
        if (rErr) throw rErr;
        imported++;
      } catch (e) {
        failed++;
      }
    }
    toast('Imported ' + imported + ' rows' + (failed ? ', ' + failed + ' failed' : '') + '.', failed ? 'warn' : 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
// SYNC COMMON DRUGS — fast onboarding for a fresh pharmacy: instead of
// typing every drug by hand (or preparing an Excel sheet), browse/search a
// shared catalog of the drugs a Kenyan chemist commonly stocks and tick the
// ones this pharmacy actually sells, entering just the current quantity,
// price, reorder threshold and (optionally) expiry per item. An additional
// option alongside "+ Add new drug" and Excel import, not a replacement —
// whichever suits the pharmacy best. See sync_master_drugs() in schema.sql.
// ---------------------------------------------------------------------------

var syncFilter = '';

// Matches the order bootstrap_pharmacy() seeds these 16 categories in, so
// the list reads in the same familiar order as a real stock-take sheet.
var SYNC_CATEGORY_ORDER = [
  'Analgesics/Antipyretics', 'Antibiotics/Antifungals/Amoebicides',
  'Bronchodilators/Anti-Allergy', 'Antacids/Anti-H-Pylori', 'Antimalarials',
  'Anti-DM', 'Hypertensives/Convulsants', 'Antiemetics/Laxatives',
  'Contraceptives', 'Supplements', 'Eye/Ear Drops', 'ORS',
  'Injectables', 'Powders/Creams', 'Non-Pharmaceuticals', 'Others'
];

async function openSyncMasterDrugs() {
  syncFilter = '';
  STATE.syncSelected = {};
  var body = sheet('Sync common drugs', '<div class="empty">Loading catalog…</div>');
  if (!STATE.masterDrugsCache || !STATE.masterDrugsCache.length) {
    try {
      var { data, error } = await sb.from('master_drugs').select('*').order('category_name').order('sort_order');
      if (error) throw error;
      STATE.masterDrugsCache = data || [];
    } catch (e) {
      body.innerHTML = '<div class="card empty">Could not load the catalog. ' + esc(friendlyError(e)) + '</div>';
      return;
    }
  }
  drawSyncMasterDrugs();
}

function drawSyncMasterDrugs() {
  var body = $('#sheetBody');
  if (!body) return;
  var q = syncFilter.trim().toLowerCase();
  var all = STATE.masterDrugsCache || [];
  var matches = q ? all.filter(function (m) { return m.name.toLowerCase().indexOf(q) !== -1; }) : all;

  var byCat = {};
  matches.forEach(function (m) { (byCat[m.category_name] = byCat[m.category_name] || []).push(m); });
  var catNames = SYNC_CATEGORY_ORDER.filter(function (c) { return byCat[c]; });
  Object.keys(byCat).forEach(function (c) { if (catNames.indexOf(c) === -1) catNames.push(c); });

  var selectedCount = Object.keys(STATE.syncSelected).length;

  redrawKeepingFocus(body,
    '<div class="tiny" style="margin-bottom:10px">Tick the drugs this pharmacy sells and enter the current quantity, price and reorder threshold for each. Expiry date is optional.</div>' +
    '<div class="searchbox field"><input id="syncSearchInput" placeholder="Search drugs…" value="' + esc(syncFilter) + '" oninput="syncFilter=this.value;drawSyncMasterDrugs()"></div>' +
    (catNames.length ? catNames.map(function (cat) {
      var items = byCat[cat];
      var hasSelected = items.some(function (m) { return STATE.syncSelected[m.id]; });
      var isOpen = !!q || hasSelected;
      return '<details' + (isOpen ? ' open' : '') + ' style="margin-bottom:8px">' +
        '<summary style="cursor:pointer;padding:8px 4px;font-weight:600">' + esc(cat) + ' (' + items.length + ')</summary>' +
        '<div class="card">' + items.map(drawSyncDrugRow).join('') + '</div>' +
        '</details>';
    }).join('') : '<div class="empty">No drugs match your search.</div>') +
    '<div class="tiny" style="margin:12px 0">' + selectedCount + ' drug' + (selectedCount === 1 ? '' : 's') + ' selected</div>' +
    '<button class="btn primary" id="syncSubmitBtn" onclick="submitMasterDrugsSync()"' + (selectedCount ? '' : ' disabled') + '>Add to inventory</button>');
}

function drawSyncDrugRow(m) {
  var sel = STATE.syncSelected[m.id];
  var row = '<div class="list-row">' +
    '<label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">' +
    '<input type="checkbox"' + (sel ? ' checked' : '') + ' onchange="toggleSyncDrug(\'' + m.id + '\')">' +
    '<div><div class="name">' + esc(m.name) + '</div><div class="meta">' + esc(String(m.form).replace('_', '/')) + ' · ' + esc(m.unit) + (m.is_prescription ? ' · Rx' : '') + '</div></div>' +
    '</label></div>';
  if (!sel) return row;
  row +=
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Quantity (' + esc(m.unit) + ')</label><input type="number" min="1" value="' + esc(sel.qty) + '" oninput="updateSyncField(\'' + m.id + '\',\'qty\',this.value)"></div>' +
    '<div class="field"><label>Sell price</label><input type="number" step="0.01" value="' + esc(sel.sellPrice) + '" oninput="updateSyncField(\'' + m.id + '\',\'sellPrice\',this.value)"></div>' +
    '</div>' +
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Reorder level</label><input type="number" min="0" value="' + esc(sel.reorderLevel) + '" oninput="updateSyncField(\'' + m.id + '\',\'reorderLevel\',this.value)"></div>' +
    '<div class="field"><label>Expiry date (optional)</label><input type="date" value="' + esc(sel.expiry) + '" oninput="updateSyncField(\'' + m.id + '\',\'expiry\',this.value)"></div>' +
    '</div>' +
    '<div class="field" style="padding:0 4px 14px 34px;max-width:200px"><label>Cost price (optional)</label><input type="number" step="0.01" value="' + esc(sel.costPrice) + '" oninput="updateSyncField(\'' + m.id + '\',\'costPrice\',this.value)"></div>';
  return row;
}

function toggleSyncDrug(masterDrugId) {
  if (STATE.syncSelected[masterDrugId]) {
    delete STATE.syncSelected[masterDrugId];
  } else {
    STATE.syncSelected[masterDrugId] = {
      qty: '', sellPrice: '', reorderLevel: STATE.pharmacy.low_stock_default || 5, expiry: '', costPrice: ''
    };
  }
  drawSyncMasterDrugs();
}

// Field edits write straight into STATE, with no re-render — re-rendering
// the whole sheet on every keystroke would reset focus and lose whatever
// the pharmacist is mid-typing in every other expanded row.
function updateSyncField(masterDrugId, field, value) {
  if (STATE.syncSelected[masterDrugId]) STATE.syncSelected[masterDrugId][field] = value;
}

async function submitMasterDrugsSync() {
  var btn = $('#syncSubmitBtn');
  if (!btn) return;
  act(btn, async function () {
    var ids = Object.keys(STATE.syncSelected);
    if (!ids.length) { toast('Select at least one drug.', 'bad'); return; }
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var sel = STATE.syncSelected[id];
      var master = STATE.masterDrugsCache.find(function (m) { return m.id === id; });
      var label = master ? master.name : 'a selected drug';
      var qty = parseInt(sel.qty, 10);
      if (!qty || qty <= 0) { toast('Enter a valid quantity for ' + label + '.', 'bad'); return; }
      var price = parseFloat(sel.sellPrice);
      if (!price || price <= 0) { toast('Enter a sell price for ' + label + '.', 'bad'); return; }
      items.push({
        master_drug_id: id,
        quantity: qty,
        sell_price: price,
        reorder_level: (sel.reorderLevel !== '' && sel.reorderLevel != null) ? parseInt(sel.reorderLevel, 10) : null,
        cost_price: (sel.costPrice !== '' && sel.costPrice != null) ? parseFloat(sel.costPrice) : null,
        expiry_date: sel.expiry || null
      });
    }
    var { error } = await sb.rpc('sync_master_drugs', { p_pharmacy_id: STATE.profile.pharmacy_id, p_items: items });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Added ' + items.length + ' drug' + (items.length === 1 ? '' : 's') + ' to inventory.', 'good');
    STATE.syncSelected = {};
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
