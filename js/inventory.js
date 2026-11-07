// js/inventory.js - the Inventory screen: drug list, add/edit drug.

var invFilter = '';

async function renderInventory() {
  var c = $('#content');
  if (!can('view_inventory')) { c.innerHTML = '<div class="card empty">You do not have access to Inventory.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading inventory…</div>';
  try {
    var { data: stock } = await fetchAllRows(function () { return sb.from('v_drug_stock').select('*').order('name'); }, 'drug_id');
    STATE.drugsCache = stock || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderInventory');
    return;
  }
  drawInventory();
}

var invPage = 1;
var INV_PAGE_SIZE = 50;

// Enter in the search box: if what's typed is exactly one drug's barcode, open
// that drug straight away (typed by hand, or a USB scanner typing it for you).
function invSearchKeydown(e) {
  if (e.key !== 'Enter') return;
  var raw = invFilter.trim();
  if (!raw) return;
  var d = STATE.drugsCache.find(function (x) { return x.barcode === raw; });
  if (!d) return;
  e.preventDefault();
  openDrugDetail(d.drug_id);
}

function invScanBarcode() {
  openBarcodeScan(function (code) {
    var d = STATE.drugsCache.find(function (x) { return x.barcode === code; });
    if (d) { openDrugDetail(d.drug_id); return; }
    invFilter = code;
    var input = $('#invSearchInput');
    if (input) input.value = code;
    invPage = 1;
    drawInventory();
    toast('No drug matches that barcode.', 'bad');
  });
}

function drawInventory() {
  var c = $('#content');
  var raw = invFilter.trim(), q = raw.toLowerCase();
  var allRows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1 || (d.barcode && d.barcode.indexOf(raw) !== -1); });
  var rows = allRows.slice(0, invPage * INV_PAGE_SIZE);
  var reorderCount = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; }).length;
  var unknownExpiryCount = STATE.drugsCache.filter(function (d) { return d.has_unknown_expiry; }).length;
  redrawKeepingFocus(c,
    '<div class="searchbox field" style="display:flex;gap:8px;align-items:center">' +
    '<input id="invSearchInput" placeholder="Search drugs, or scan a barcode…" value="' + esc(invFilter) + '" oninput="invFilter=this.value;invPage=1;drawInventory()" onkeydown="invSearchKeydown(event)" style="flex:1">' +
    (barcodeCameraSupported() ? '<button class="btn secondary" title="Scan barcode" aria-label="Scan barcode" onclick="invScanBarcode()">' + icon('barcode', 18) + '</button>' : '') +
    '</div>' +
    (can('edit_inventory') ? '<button class="btn lime" style="margin-bottom:6px" onclick="openAddDrug()">' + t('addDrug') + '</button>' : '') +
    '<div class="sq-grid sq-2">' +
    (can('edit_inventory') || can('stock_take') ? '<button class="btn sq-green" onclick="openStockSheetMenu()">Count / edit in Excel</button>' : '') +
    (can('stock_take') ? '<button class="btn sq-green" onclick="setTab(\'stocktake\')">Stock Take</button>' : '') +
    (can('edit_inventory') ? '<button class="btn sq-blue" onclick="openImportExcel()">Import</button>' : '') +
    (can('edit_inventory') ? '<button class="btn sq-blue" onclick="openSyncMasterDrugs()">Sync common drugs</button>' : '') +
    '</div>' +
    '<div class="sq-grid sq-3">' +
    (canSeeControlled() ? '<button class="btn sq-red" onclick="setTab(\'controlled\')">Controlled</button>' : '') +
    '<button class="btn" onclick="exportInventoryExcel()">Excel</button>' +
    '<button class="btn" onclick="printInventory()">Print</button>' +
    '</div>' +
    (can('restock') && reorderCount ? '<div class="inline-notice">' + icon('clipboard',15) +
      '<a href="#" onclick="openReorderList();return false;">' + reorderCount + (reorderCount === 1 ? ' drug needs' : ' drugs need') + ' reordering — view list</a></div>' : '') +
    (unknownExpiryCount ? '<div class="inline-notice">' + icon('warn',15) +
      '<a href="#" onclick="openUnknownExpiryList();return false;">' + unknownExpiryCount + (unknownExpiryCount === 1 ? ' drug has' : ' drugs have') + ' a batch with no expiry date set — view list</a></div>' : '') +
    '<div class="card">' + (rows.length ? rows.map(function (d) {
      var kind = d.qty_in_stock === 0 ? 'bad' : d.qty_in_stock <= d.reorder_level ? 'warn' : 'good';
      var badge = kind === 'bad' ? '<span class="badge bad">Out</span>' : kind === 'warn' ? '<span class="badge warn">Low</span>' : '<span class="badge good">OK</span>';
      var expBadge = d.soonest_expiry ? (daysUntil(d.soonest_expiry) <= (STATE.pharmacy.expiry_warn_days || 90)
        ? ' <span class="badge ' + (daysUntil(d.soonest_expiry) <= 30 ? 'bad' : 'warn') + '">exp ' + fmtDate(d.soonest_expiry) + '</span>' : '') : '';
      return '<div class="list-row" onclick="openDrugDetail(\'' + d.drug_id + '\')" style="cursor:pointer">' +
        '<div style="display:flex;align-items:center;gap:12px"><div class="row-avatar ' + (kind === 'good' ? '' : kind) + '">' + esc((d.name || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + fmt(d.stock_value_retail) + ' in stock value' + expBadge + '</div>' + daysLeftNote(d) + '</div></div>' +
        '<div class="right">' + badge + '<div class="meta">' + esc(qtyUnit(d.qty_in_stock, d.unit)) + '</div></div></div>';
    }).join('') : '<div class="empty">No drugs match. Try clearing the search or add a new one.</div>') + '</div>' +
    (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="invPage++;drawInventory()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : '') +
    (can('edit_inventory') ? '<button class="btn ghost small" id="hiddenDrugsBtn" style="margin-top:12px" onclick="openHiddenDrugs()">' + icon('box',15) + ' Hidden drugs</button>' : ''));
}

// "~3 days left" under a drug, shown only when the pharmacy has turned the days alert on.
// A drug with its own number shows that number instead. No sales yet: nothing to show.
function daysLeftLabel(days) {
  var n = Number(days);
  if (n < 1) return 'less than 1 day left';
  if (n >= 90) return '90+ days left';
  var r = Math.round(n);
  return '~' + r + (r === 1 ? ' day' : ' days') + ' left';
}
function daysLeftNote(d) {
  if (!(STATE.pharmacy && STATE.pharmacy.low_stock_days) || !(Number(d.qty_in_stock) > 0)) return '';
  var text = d.reorder_custom ? 'Warns at ' + d.reorder_own + ' (own number)' : (d.days_left != null ? daysLeftLabel(d.days_left) : '');
  return text ? '<div class="meta"><b>' + esc(text) + '</b></div>' : '';
}

function exportInventoryExcel() {
  var rows = STATE.drugsCache.map(function (d) {
    return {
      'Drug': d.name,
      'Unit': d.unit,
      'Qty in stock': d.qty_in_stock,
      'Reorder level': d.reorder_level,
      'Status': d.qty_in_stock === 0 ? 'OUT OF STOCK' : d.qty_in_stock <= d.reorder_level ? 'LOW STOCK' : 'OK',
      'Soonest expiry': d.soonest_expiry ? fmtDate(d.soonest_expiry) : '',
      'Stock value (cost)': Number(d.stock_value_cost || 0),
      'Stock value (retail)': Number(d.stock_value_retail || 0)
    };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - stock - ' + todayStr() + '.xlsx', 'Stock', rows);
}

function printInventory() {
  var rows = STATE.drugsCache.map(function (d) {
    var status = d.qty_in_stock === 0 ? 'OUT OF STOCK' : d.qty_in_stock <= d.reorder_level ? 'LOW STOCK' : 'OK';
    return [d.name, d.qty_in_stock + ' ' + d.unit, status, d.soonest_expiry ? fmtDate(d.soonest_expiry) : '—', fmt(d.stock_value_retail)];
  });
  var totalValue = STATE.drugsCache.reduce(function (a, d) { return a + Number(d.stock_value_retail || 0); }, 0);
  printHtml('Stock Take', todayStr(),
    tableHtml(['Drug', 'Qty in stock', 'Status', 'Soonest expiry', 'Stock value'], rows),
    (STATE.drugsCache.length) + ' drugs · Total stock value ' + fmt(totalValue));
}

function todayStr() { return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }

