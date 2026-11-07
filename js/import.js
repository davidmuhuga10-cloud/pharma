// js/import.js - bulk import from a spreadsheet, and "Sync common drugs" for a
// new pharmacy.
//
// --- Bulk import ---
// Pharmacies already keep stock in a spreadsheet, so import accepts a flexible
// column layout (Drug, Qty, Price, Expiry...) and the "12.2027" (month.year)
// expiry format used in real stock-take sheets.

// A workbook with several sheets. A sheet is { name, rows: array of arrays, widths: [chars], hidden: [col index] }.
function exportWorkbook(filename, sheets) {
  var write = function () {
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) {
      var ws = XLSX.utils.aoa_to_sheet(s.rows);
      if (s.widths) ws['!cols'] = s.widths.map(function (w, i) { var c = { wch: w }; if ((s.hidden || []).indexOf(i) !== -1) c.hidden = true; return c; });
      XLSX.utils.book_append_sheet(wb, ws, s.name);
    });
    XLSX.writeFile(wb, filename);
  };
  if (window.XLSX) { write(); return; }
  toast('Preparing Excel file…');
  loadXlsx().then(write).catch(function (e) { toast(friendlyError(e), 'bad'); });
}

var IMPORT_FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'cream_ointment', 'drops', 'suppository', 'inhaler', 'iv_fluid', 'other'];

// The blank template: headers only (so nothing sample-like can be imported by mistake) and a
// "How to fill" sheet that spells out every rule the upload checks.
function downloadImportTemplate() {
  var cats = (STATE.categoriesCache || []).map(function (c) { return c.name; });
  exportWorkbook('Pharma - import template.xlsx', [
    { name: 'Stock', rows: [['Drug', 'Category', 'Form', 'Unit', 'Qty', 'Cost Price', 'Sell Price', 'Expiry', 'Batch No', 'Supplier']],
      widths: [30, 30, 16, 12, 8, 12, 12, 12, 14, 20] },
    { name: 'How to fill', rows: [
      ['One row per batch. Delete nothing in the header row. Upload this file in Inventory > Import.'],
      [''],
      ['Drug', 'Required. The drug name, e.g. Amoxiclav 228 susp. If the drug already exists, this row adds a new batch to it.'],
      ['Category', 'Optional. Must be one of: ' + cats.join(', ')],
      ['Form', 'Optional. One of: ' + IMPORT_FORMS.join(', ')],
      ['Unit', 'Required. tablet, bottle, vial, tube...'],
      ['Qty', 'Required. A whole number, 1 or more. The number of units you have now.'],
      ['Cost Price', 'Optional. What you pay for one unit. A number.'],
      ['Sell Price', 'Required. What you sell one unit for. A number above 0.'],
      ['Expiry', 'Required. Month.Year like 12.2027, or a full date like 31/12/2027, or the word UNKNOWN. A date in the past is refused.'],
      ['Batch No', 'Optional.'],
      ['Supplier', 'Optional.'],
      [''],
      ['If any row is wrong, nothing is imported. You get the list of rows to fix, then upload again.']
    ], widths: [14, 110] }
  ]);
}

// Reads an expiry cell. Returns { date: 'YYYY-MM-DD' } | { unknown: true } | { error: '...' }.
// Accepts: an Excel date, 12.2027 (month.year = last day of that month), 2027-12-31, 31/12/2027,
// 31-12-2027 (day first, as in Kenya), or the word UNKNOWN. Anything else is an error, because
// a guessed date is worse than a refused one.
function parseStrictExpiry(val) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var valid = function (y, m, d) { var t = new Date(Date.UTC(y, m - 1, d)); return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  if (val instanceof Date && !isNaN(val)) {
    var t = new Date(val.getTime() + 12 * 3600000);   // an Excel date can come out a few hours off; noon keeps the right day
    return { date: t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) };
  }
  var s = String(val === null || val === undefined ? '' : val).trim();
  if (!s) return { error: 'Expiry is empty (write a date, or UNKNOWN)' };
  if (/^unknown$/i.test(s)) return { unknown: true };
  var m = s.match(/^(\d{1,2})\.(\d{4})$/);
  if (m) {
    var mo = parseInt(m[1], 10), yr = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || yr < 2000 || yr > 2100) return { error: 'Expiry "' + s + '" is not a real month.year' };
    return { date: yr + '-' + pad(mo) + '-' + pad(new Date(Date.UTC(yr, mo, 0)).getUTCDate()) };
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return valid(+m[1], +m[2], +m[3]) ? { date: m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]) } : { error: 'Expiry "' + s + '" is not a real date' };
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1]) ? { date: m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]) } : { error: 'Expiry "' + s + '" is not a real date (write day/month/year)' };
  return { error: 'Expiry "' + s + '" is not a date I can read. Use 12.2027 or 31/12/2027' };
}

// Parses "12.2027" (month.year), a date string or an Excel date object.
// Returns 'YYYY-MM-DD' (last day of the month for month.year) or null.
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

// Column-name aliases, matched case-insensitively. 'drugs' (plural) is there
// because real stock-take sheets use that header.
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

// Sheets often have a title row above the real headers. Read plain rows and
// search the first several for one containing a known column name, so nobody
// has to edit their sheet first.
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
// "Nothing was changed" screen, shared by the import and the stock sheet. problems: [{ row, name, message }].
function sheetProblemsView(title, intro, problems, again) {
  var shown = problems.slice(0, 100);
  var body = sheet(title, '');
  body.innerHTML =
    '<div class="inline-notice">' + icon('warn', 15) + '<span><b>Nothing was saved.</b> ' + esc(intro) + '</span></div>' +
    '<div class="card" style="max-height:300px;overflow-y:auto">' +
    shown.map(function (p) {
      return listRow((p.row ? 'Row ' + p.row : 'Sheet') + (p.name ? ' · ' + p.name : ''), esc(p.message), '');
    }).join('') +
    (problems.length > shown.length ? '<div class="tiny" style="margin-top:8px">…and ' + (problems.length - shown.length) + ' more. Fix these first, then upload again to see the rest.</div>' : '') +
    '</div>' +
    '<button class="btn primary" onclick="closeSheet();' + again + '">Choose the fixed file</button>';
}

function readImportBuffer(buffer) {
  var allRows, headerIdx, colMap;
  try {
    var wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
    var ws = wb.Sheets[wb.SheetNames[0]];
    allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    headerIdx = findImportHeaderRow(allRows);
    colMap = buildImportColumnMap(allRows[headerIdx] || []);
  } catch (err) {
    toast('Could not read that file — is it a valid Excel/CSV file?', 'bad');
    return;
  }
  var missing = [['name', 'Drug'], ['unit', 'Unit'], ['qty', 'Qty'], ['sellPrice', 'Sell Price'], ['expiry', 'Expiry']]
    .filter(function (c) { return colMap[c[0]] === undefined; }).map(function (c) { return c[1]; });
  if (missing.length) {
    sheetProblemsView('Cannot import', 'The sheet has no column called ' + missing.join(', ') + '. Use the template so the headers match.',
      missing.map(function (m) { return { row: headerIdx + 1, name: '', message: 'Column "' + m + '" not found' }; }), 'openImportExcel()');
    return;
  }
  checkImportRows(allRows.slice(headerIdx + 1), colMap, headerIdx + 2);
}

// Checks every row. Any problem at all stops the import; the pharmacy fixes the sheet and uploads again.
function checkImportRows(dataRows, colMap, firstRowNo) {
  var problems = [], parsed = [], rowNos = [], seen = {};
  var today = new Date().toISOString().slice(0, 10);
  var normCat = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var catByName = {};
  (STATE.categoriesCache || []).forEach(function (c) { catByName[normCat(c.name)] = c.id; });
  dataRows.forEach(function (row, i) {
    var rowNo = firstRowNo + i;
    var cell = function (field) {
      var idx = colMap[field];
      if (idx === undefined) return '';
      var v = row[idx];
      return (v === undefined || v === null) ? '' : v;
    };
    var txt = function (field) { return String(cell(field)).trim(); };
    var blank = Object.keys(colMap).every(function (f) { return txt(f) === ''; });
    if (blank) return;                                   // an empty row is fine
    var name = txt('name');
    var bad = function (msg) { problems.push({ row: rowNo, name: name, message: msg }); };
    var before = problems.length;
    if (!name) bad('The drug name is empty');
    else if (name.length > 120) bad('The drug name is too long (120 letters at most)');
    var unit = txt('unit');
    if (!unit) bad('Unit is empty (tablet, bottle, vial...)');
    var qtyRaw = txt('qty');
    if (!/^\d+$/.test(qtyRaw) || parseInt(qtyRaw, 10) < 1) bad('Qty must be a whole number, 1 or more' + (qtyRaw ? ' (found "' + qtyRaw + '")' : ' (it is empty)'));
    var sellRaw = txt('sellPrice'), sell = Number(sellRaw);
    if (sellRaw === '' || isNaN(sell) || sell <= 0) bad('Sell Price must be a number above 0' + (sellRaw ? ' (found "' + sellRaw + '")' : ' (it is empty)'));
    var costRaw = txt('costPrice'), cost = null;
    if (costRaw !== '') {
      cost = Number(costRaw);
      if (isNaN(cost) || cost < 0) { bad('Cost Price must be a number, 0 or more (found "' + costRaw + '")'); cost = null; }
      else if (!isNaN(sell) && sell > 0 && sell < cost) bad('Sell Price (' + sell + ') is lower than Cost Price (' + cost + ')');
    }
    var exp = parseStrictExpiry(cell('expiry'));
    if (exp.error) bad(exp.error);
    else if (exp.date && exp.date < today) bad('Expiry ' + exp.date + ' is in the past. Expired stock is not imported');
    var form = txt('form').toLowerCase().replace(/[\s\/]+/g, '_');
    if (form && IMPORT_FORMS.indexOf(form) === -1) bad('Form "' + txt('form') + '" is not one of: ' + IMPORT_FORMS.join(', '));
    var category = txt('category'), catId = null;
    if (category) {
      catId = catByName[normCat(category)] || null;
      if (!catId) bad('Category "' + category + '" is not one of your categories');
    }
    if (name && exp && !exp.error) {
      var key = name.toLowerCase() + '|' + (exp.date || 'unknown') + '|' + txt('batchNo').toLowerCase();
      if (seen[key]) bad('Same drug, expiry and batch as row ' + seen[key] + '. If it is the same stock, remove one row');
      else seen[key] = rowNo;
    }
    if (problems.length > before) return;
    parsed.push({
      name: name, category: category, categoryId: catId, form: form || 'other', unit: unit,
      qty: parseInt(qtyRaw, 10), costPrice: cost, sellPrice: sell, expiry: exp.unknown ? null : exp.date,
      batchNo: txt('batchNo') || null, supplier: txt('supplier') || null
    });
    rowNos.push(rowNo);
  });

  if (problems.length) {
    sheetProblemsView('Cannot import yet', problems.length + (problems.length === 1 ? ' row needs' : ' rows need') + ' fixing. Fix them in Excel and upload again.', problems, 'openImportExcel()');
    return;
  }
  if (!parsed.length) {
    sheetProblemsView('Cannot import', 'No rows were found under the headers.', [{ row: 0, name: '', message: 'The sheet is empty' }], 'openImportExcel()');
    return;
  }
  // The database checks the same rows without saving anything, so the pharmacy hears about every problem now.
  toast('Checking ' + parsed.length + ' rows…');
  dryRunImport(parsed, rowNos).then(function (dbProblems) {
    if (dbProblems.length) {
      sheetProblemsView('Cannot import yet', dbProblems.length + (dbProblems.length === 1 ? ' row was' : ' rows were') + ' refused when checked. Fix them in Excel and upload again.', dbProblems, 'openImportExcel()');
      return;
    }
    importReady(parsed);
  }).catch(function (e) { toast(friendlyError(e), 'bad'); });
}

var IMPORT_BLOCK = 500;   // rows sent to the database per request (it accepts up to 500)

function importRowsPayload(rows) {
  return rows.map(function (r) {
    return { name: r.name, form: r.form, unit: r.unit, category_id: r.categoryId, qty: r.qty, cost_price: r.costPrice,
             sell_price: r.sellPrice, expiry: r.expiry, batch_no: r.batchNo, supplier: r.supplier };
  });
}

async function dryRunImport(parsed, rowNos) {
  var problems = [];
  for (var i = 0; i < parsed.length; i += IMPORT_BLOCK) {
    var res = await sb.rpc('import_stock_rows', { p_pharmacy_id: STATE.profile.pharmacy_id, p_rows: importRowsPayload(parsed.slice(i, i + IMPORT_BLOCK)), p_dry_run: true });
    if (res.error) throw res.error;
    (res.data.errors || []).forEach(function (e) { problems.push({ row: rowNos[i + e.row - 1], name: e.name, message: friendlyError({ message: e.message }) }); });
  }
  return problems;
}

function importReady(parsed) {
  var unknownExpiry = parsed.filter(function (p) { return !p.expiry; }).length;
  var body = sheet('Ready to import', '');
  body.innerHTML =
    '<div class="inline-notice">' + icon('clipboard', 15) + '<span><b>Every row passed the checks.</b> ' + parsed.length + (parsed.length === 1 ? ' row' : ' rows') + ' will be added as new stock.</span></div>' +
    (unknownExpiry ? '<div class="tiny" style="margin-bottom:8px">' + unknownExpiry + ' with expiry UNKNOWN. They are flagged in Inventory so you can fix the date later.</div>' : '') +
    '<div class="card" style="max-height:260px;overflow-y:auto">' +
    parsed.slice(0, 50).map(function (p) {
      return listRow(p.name, p.qty + ' ' + esc(p.unit) + ' · exp ' + (p.expiry ? fmtDate(p.expiry) : 'unknown'), fmt(p.sellPrice));
    }).join('') +
    (parsed.length > 50 ? '<div class="tiny" style="margin-top:8px">…and ' + (parsed.length - 50) + ' more</div>' : '') +
    '</div>' +
    '<button class="btn primary" id="impBtn" onclick="runImport(\'' + btoa(encodeURIComponent(JSON.stringify(parsed))) + '\')">Import ' + parsed.length + ' rows</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="downloadImportTemplate()">Download a blank template</button>';
}

async function runImport(encoded) {
  var rows = JSON.parse(decodeURIComponent(atob(encoded)));
  var btn = $('#impBtn');
  act(btn, async function () {
    // All or nothing for each request: the database undoes the whole block if any row fails.
    var saved = 0;
    for (var i = 0; i < rows.length; i += IMPORT_BLOCK) {
      var res = await sb.rpc('import_stock_rows', { p_pharmacy_id: STATE.profile.pharmacy_id, p_rows: importRowsPayload(rows.slice(i, i + IMPORT_BLOCK)), p_strict: true });
      if (res.error) {
        var msg = friendlyError(res.error);
        toast(saved ? 'Stopped. The first ' + saved + ' rows were saved, the rest were not: ' + msg + ' Do not upload the whole sheet again; remove the saved rows first.' : 'Nothing was imported: ' + msg, 'bad');
        if (saved) renderInventory();
        return;
      }
      saved += res.data.imported;
    }
    toast('Imported ' + saved + ' rows.', 'good');
    closeSheet();
    renderInventory();
  });
}

// --- Sync common drugs ---
// Fast onboarding for a new pharmacy: search a shared catalogue of drugs a
// Kenyan chemist commonly stocks, tick the ones sold here, and enter quantity,
// price, reorder level and optional expiry. An alternative to "+ Add new drug"
// and Excel import. See sync_master_drugs() in schema.sql.

var syncFilter = '';

// Same order bootstrap_pharmacy() seeds these 16 categories in.
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

// Field edits write straight into STATE with no re-render; re-rendering on every
// keystroke would reset focus in the other expanded rows.
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

// ===========================================================================
// Count or edit in Excel: download every drug, change cells, upload.
// Quantities you type under "Counted qty" go into a stock take that is reviewed and approved in
// Stock Take (nothing in stock changes by itself). Names, units, reorder numbers and selling
// prices change when you apply the sheet. If any row is wrong, nothing is applied.
// ===========================================================================
var SHEET_COLS = {
  id: ['drug id'], name: ['drug', 'name', 'drug name'], unit: ['unit'],
  counted: ['counted qty', 'counted', 'count'], price: ['sell price', 'price'], reorder: ['reorder level', 'reorder']
};

function openStockSheetMenu() {
  var editor = can('edit_inventory');
  var body = sheet('Count or edit in Excel', '');
  body.innerHTML =
    '<div id="shLastUpload"></div>' +
    '<div class="field"><label>1. Download the stock sheet</label>' +
    '<div class="tiny" style="margin-bottom:8px">Every drug, with what the system has now.</div>' +
    '<button class="btn secondary" onclick="downloadStockSheet()">' + icon('download', 15) + ' Download stock sheet</button></div>' +
    '<div class="field"><label>2. Fill it in Excel</label>' +
    '<div class="tiny">Type the number you counted under <b>Counted qty</b>.' + (editor ? ' You can also change the drug name, unit, <b>Sell price</b> and <b>Reorder level</b>.' : '') + ' Leave a cell empty to change nothing. Do not delete the Drug ID column.</div></div>' +
    '<div class="field"><label>3. Upload it</label>' +
    '<div class="tiny" style="margin-bottom:8px">You see every change before anything is saved. If any row is wrong, nothing is saved and you get the list to fix.</div>' +
    '<button class="btn primary" onclick="closeSheet();openStockSheetUpload()">' + icon('upload', 15) + ' Upload filled sheet</button></div>';
  loadLastStockSheetUpload();
}

// Shows an "Undo" button for the most recent applied sheet, same rule as right
// after applying one: only while it is still the latest, not-yet-undone upload.
async function loadLastStockSheetUpload() {
  if (!can('undo_stock_sheet')) return;   // same set the database lets undo a sheet
  var { data, error } = await sb.from('stock_sheet_uploads').select('id,applied_at,changed,counted')
    .eq('pharmacy_id', STATE.profile.pharmacy_id).is('undone_at', null).order('applied_at', { ascending: false }).limit(1);
  var el = $('#shLastUpload');
  if (error || !el || !data || !data.length) return;
  var u = data[0];
  el.innerHTML =
    '<div class="inline-notice" style="margin-bottom:14px">' + icon('clipboard', 15) +
    '<span>Last upload: ' + fmtDateTime(u.applied_at) + ' (' + (u.changed || 0) + ' change' + (u.changed === 1 ? '' : 's') + (u.counted ? ', ' + u.counted + ' counted' : '') + ').' +
    '<button class="btn ghost small" style="margin-top:8px" onclick="undoStockSheetNow(this,\'' + u.id + '\')">Undo this upload</button></span></div>';
}

async function currentStockForSheet() {
  var r = await fetchAllRows(function () { return sb.from('v_drug_stock').select('drug_id,name,unit,qty_in_stock,qty_expired,default_price,reorder_own,reorder_custom').order('name'); }, 'drug_id');
  if (r.error) throw r.error;
  return r.data || [];
}
// What the Reorder level cell shows: empty when the drug follows the days alert.
function sheetReorderShown(d) {
  var daysOn = !!(STATE.pharmacy && STATE.pharmacy.low_stock_days);
  return (daysOn && !d.reorder_custom) ? '' : d.reorder_own;
}

async function downloadStockSheet() {
  try {
    await loadXlsx();
    var drugs = await currentStockForSheet();
    if (!drugs.length) { toast('There are no drugs yet. Use Import to add them first.', 'bad'); return; }
    var daysOn = !!(STATE.pharmacy && STATE.pharmacy.low_stock_days);
    var rows = [['Drug ID', 'Drug', 'Unit', 'Qty in system', 'Counted qty', 'Sell price', 'Reorder level']].concat(drugs.map(function (d) {
      return [d.drug_id, d.name, d.unit, Number(d.qty_in_stock) + Number(d.qty_expired), '', d.default_price === null ? '' : Number(d.default_price), sheetReorderShown(d)];
    }));
    exportWorkbook((STATE.pharmacy.name || 'Pharma') + ' - stock sheet - ' + todayStr() + '.xlsx', [
      { name: 'Stock', rows: rows, widths: [38, 34, 12, 14, 14, 12, 14], hidden: [0] },
      { name: 'How to fill', rows: [
        ['Fill this sheet, then upload it in Inventory > Count or edit in Excel.'],
        [''],
        ['Qty in system', 'What the system has now. Do not type here; it is ignored.'],
        ['Counted qty', 'Type what you counted on the shelf. Leave empty for drugs you did not count. Counts go into a stock take that is reviewed and approved in Stock Take.'],
        ['Drug', 'Change the name only to fix a spelling.'],
        ['Unit', 'tablet, bottle, vial...'],
        ['Sell price', 'The price for one unit. Changing it also changes the price on the stock now on the shelf. Past sales keep the price they were sold at.'],
        ['Reorder level', 'Warn me when stock is at or below this number.' + (daysOn ? ' Empty means this drug follows your "' + STATE.pharmacy.low_stock_days + ' days left" setting.' : '')],
        [''],
        ['New drugs are not added here: use Inventory > Import. If any row is wrong, nothing is saved.']
      ], widths: [16, 110] }
    ]);
  } catch (e) { toast(friendlyError(e), 'bad'); }
}

function openStockSheetUpload() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = function () {
    if (!input.files.length) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      loadXlsx().then(function () { return readStockSheet(e.target.result); })
        .catch(function (err) { toast(friendlyError(err), 'bad'); });
    };
    reader.readAsArrayBuffer(input.files[0]);
  };
  input.click();
}

async function readStockSheet(buffer) {
  var allRows, colMap = {}, headerIdx = -1;
  try {
    var wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
    allRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  } catch (err) { toast('Could not read that file. Is it a valid Excel/CSV file?', 'bad'); return; }
  for (var i = 0; i < Math.min(allRows.length, 10) && headerIdx < 0; i++) {
    var m = {};
    (allRows[i] || []).forEach(function (cellv, idx) {
      var v = String(cellv || '').trim().toLowerCase();
      Object.keys(SHEET_COLS).forEach(function (f) { if (m[f] === undefined && SHEET_COLS[f].indexOf(v) !== -1) m[f] = idx; });
    });
    if (m.name !== undefined || m.id !== undefined) { headerIdx = i; colMap = m; }
  }
  if (headerIdx < 0 || (colMap.id === undefined && colMap.name === undefined)) {
    sheetProblemsView('Cannot read the sheet', 'This is not a stock sheet. Download one from Inventory > Count or edit in Excel.', [{ row: 0, name: '', message: 'No "Drug" or "Drug ID" column found' }], 'openStockSheetUpload()');
    return;
  }
  toast('Checking the sheet…');
  var drugs = await currentStockForSheet();
  var byId = {}, byName = {};
  drugs.forEach(function (d) { byId[d.drug_id] = d; byName[String(d.name).trim().toLowerCase()] = d; });
  var editor = can('edit_inventory');
  var problems = [], changes = [], seen = {};
  allRows.slice(headerIdx + 1).forEach(function (row, i) {
    var rowNo = headerIdx + 2 + i;
    var raw = function (f) { var idx = colMap[f]; return idx === undefined || row[idx] === undefined || row[idx] === null ? '' : String(row[idx]).trim(); };
    if (Object.keys(colMap).every(function (f) { return raw(f) === ''; })) return;
    var sheetName = raw('name');
    var d = raw('id') ? byId[raw('id')] : byName[sheetName.toLowerCase()];
    var bad = function (msg) { problems.push({ row: rowNo, name: sheetName || (d && d.name) || '', message: msg }); };
    if (!d) { bad('This drug is not in your system. New drugs are added with Import, not with this sheet'); return; }
    if (seen[d.drug_id]) { bad('This drug is also in row ' + seen[d.drug_id]); return; }
    seen[d.drug_id] = rowNo;
    var ch = { drug_id: d.drug_id }, parts = [], before = problems.length;
    if (colMap.name !== undefined && sheetName !== '' && sheetName !== d.name) {
      if (!editor) bad('You can upload counts only'); else { ch.name = sheetName; parts.push('name "' + d.name + '" to "' + sheetName + '"'); }
    } else if (colMap.name !== undefined && sheetName === '' && raw('id')) bad('The drug name is empty');
    var unit = raw('unit');
    if (colMap.unit !== undefined && unit !== '' && unit !== d.unit) {
      if (!editor) bad('You can upload counts only'); else { ch.unit = unit; parts.push('unit ' + d.unit + ' to ' + unit); }
    }
    var counted = raw('counted');
    if (counted !== '') {
      if (!/^\d+$/.test(counted)) bad('Counted qty must be a whole number, 0 or more (found "' + counted + '")');
      else { ch.counted = parseInt(counted, 10); var sys = Number(d.qty_in_stock) + Number(d.qty_expired); parts.push('count ' + sys + ' to ' + counted + ' (' + (ch.counted - sys >= 0 ? '+' : '') + (ch.counted - sys) + ')'); }
    }
    var price = raw('price');
    if (colMap.price !== undefined && price !== '') {
      var pn = Number(price);
      if (isNaN(pn) || pn <= 0) bad('Sell price must be a number above 0 (found "' + price + '")');
      else if (!editor) { if (pn !== Number(d.default_price)) bad('You can upload counts only'); }
      else if (pn !== Number(d.default_price)) { ch.price = pn; parts.push('price ' + (d.default_price === null ? 'none' : Number(d.default_price)) + ' to ' + pn); }
    }
    var reorder = raw('reorder');
    if (colMap.reorder !== undefined && reorder !== '') {
      if (!/^\d+$/.test(reorder)) bad('Reorder level must be a whole number, 0 or more (found "' + reorder + '")');
      else if (String(reorder) !== String(sheetReorderShown(d))) {
        if (!editor) bad('You can upload counts only'); else { ch.reorder = parseInt(reorder, 10); parts.push('reorder level ' + (sheetReorderShown(d) === '' ? 'days alert' : d.reorder_own) + ' to ' + reorder); }
      }
    }
    if (problems.length > before) return;
    if (parts.length) changes.push({ ch: ch, name: d.name, text: parts.join(', ') });
  });
  if (problems.length) {
    sheetProblemsView('Cannot apply yet', problems.length + (problems.length === 1 ? ' row needs' : ' rows need') + ' fixing. Fix them in Excel and upload again.', problems, 'openStockSheetUpload()');
    return;
  }
  if (!changes.length) { toast('The sheet has no changes in it.', 'warn'); return; }
  stockSheetPreview(changes);
}

function stockSheetPreview(changes) {
  var counts = changes.filter(function (c) { return c.ch.counted !== undefined; }).length;
  var body = sheet('Check the changes', '');
  body.innerHTML =
    '<div class="inline-notice">' + icon('clipboard', 15) + '<span><b>' + changes.length + (changes.length === 1 ? ' drug changes.' : ' drugs change.') + '</b> Nothing is saved until you press the button.' +
    (counts ? ' ' + counts + (counts === 1 ? ' count goes' : ' counts go') + ' into a stock take for you to approve; stock does not change yet.' : '') + '</span></div>' +
    '<div class="card" style="max-height:300px;overflow-y:auto">' +
    changes.slice(0, 100).map(function (c) { return listRow(c.name, esc(c.text), ''); }).join('') +
    (changes.length > 100 ? '<div class="tiny" style="margin-top:8px">…and ' + (changes.length - 100) + ' more</div>' : '') + '</div>' +
    '<button class="btn primary" id="shBtn" onclick="applyStockSheetNow(\'' + btoa(encodeURIComponent(JSON.stringify(changes.map(function (c) { return c.ch; })))) + '\')">Apply ' + changes.length + ' changes</button>';
}

function applyStockSheetNow(encoded) {
  var rows = JSON.parse(decodeURIComponent(atob(encoded)));
  act($('#shBtn'), async function () {
    var res = await sb.rpc('apply_stock_sheet', { p_pharmacy_id: STATE.profile.pharmacy_id, p_rows: rows });
    if (res.error) { toast(friendlyError(res.error), 'bad'); return; }
    if (!res.data.ok) {
      closeSheet();
      sheetProblemsView('Cannot apply yet', 'The system refused these rows. Fix them and upload again.', res.data.errors || [], 'openStockSheetUpload()');
      return;
    }
    clearDashCache();
    closeSheet();
    renderInventory();
    // upload_id is only there when something was actually changed or counted -
    // same thing an Undo button would need to put back. The 'undo_stock_sheet'
    // action is exactly the same owner/co-owner/pharmacist set the database
    // allows to undo a sheet, so it doubles as the gate for showing this button.
    var undoBtn = (res.data.upload_id && can('undo_stock_sheet')) ?
      '<button class="btn ghost" style="margin-top:10px" onclick="undoStockSheetNow(this,\'' + res.data.upload_id + '\')">Undo this upload</button>' : '';
    if (res.data.take_id) {
      var body = sheet('Sheet applied', '');
      body.innerHTML =
        '<div class="inline-notice">' + icon('clipboard', 15) + '<span>' + res.data.counted + (res.data.counted === 1 ? ' count is' : ' counts are') + ' waiting in a new stock take. Open Stock Take to review the differences and approve. Stock changes only when you approve.</span></div>' +
        (res.data.changed ? '<div class="tiny" style="margin-bottom:10px">' + res.data.changed + ' other change' + (res.data.changed === 1 ? '' : 's') + ' saved.</div>' : '') +
        (can('stock_take') ? '<button class="btn primary" onclick="closeSheet();setTab(\'stocktake\')">Open Stock Take</button>' : '') +
        undoBtn;
    } else if (undoBtn) {
      var body2 = sheet('Sheet applied', '');
      body2.innerHTML =
        '<div class="tiny" style="margin-bottom:10px">Saved ' + res.data.changed + ' change' + (res.data.changed === 1 ? '' : 's') + '.</div>' + undoBtn;
    } else {
      toast('Saved ' + res.data.changed + ' changes.', 'good');
    }
  });
}

// Puts back the sheet just applied - only while it is still the most recent
// upload, and only the fields nothing else has touched again since (see
// undo_stock_sheet() in schema.sql for exactly what that means).
function undoStockSheetNow(btn, uploadId) {
  act(btn, async function () {
    var res = await sb.rpc('undo_stock_sheet', { p_pharmacy_id: STATE.profile.pharmacy_id, p_upload_id: uploadId });
    if (res.error) { toast(friendlyError(res.error), 'bad'); return; }
    clearDashCache();
    closeSheet();
    renderInventory();
    var leftAlone = res.data.left_alone || [];
    var msg = res.data.reverted + (res.data.reverted === 1 ? ' change' : ' changes') + ' undone.' +
      (res.data.count_status === 'cancelled' ? ' The stock take it opened was cancelled too.' : '') +
      (res.data.count_status === 'already_approved' ? ' Its stock take was already approved, so that count was left as it is.' : '') +
      (leftAlone.length ? ' ' + leftAlone.length + (leftAlone.length === 1 ? ' drug was' : ' drugs were') + ' left alone because something changed it again since.' : '');
    toast(msg, 'good');
  });
}
