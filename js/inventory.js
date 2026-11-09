// js/inventory.js - the Inventory screen: drug list, add/edit drug.

var invFilter = '';

async function renderInventory() {
  var c = $('#content');
  if (!can('view_inventory')) { c.innerHTML = '<div class="card empty">You do not have access to Inventory.</div>'; return; }
  invBox = 'all';
  invPhonePage = 1;
  c.innerHTML = listSkeletonHtml(7);
  try {
    var { data: stock } = await fetchAllRows(function () { return sb.from('v_drug_stock').select('*').order('name'); }, 'drug_id');
    STATE.drugsCache = stock || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderInventory');
    return;
  }
  drawInventory();
}

var invPage = 1;   // 10 drugs a page
var invBox = 'all'; // which box is picked: 'all' | 'low' | 'out' | 'exp' | 'nodate'

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

// The boxes above the table. Low stock is at or below the reorder number; Expiring uses the pharmacy's
// own warning window (90 days unless changed in Settings); Unknown expiry is a batch still without a date.
function invWarnDays() { return (STATE.pharmacy && STATE.pharmacy.expiry_warn_days) || 90; }
function invBoxes() {
  var w = invWarnDays();
  return [
    { key: 'all', label: 'All drugs', caption: 'Everything on the shelf', kind: '' },
    { key: 'low', label: 'Low stock', caption: 'At or below the reorder number', kind: 't-amber' },
    { key: 'out', label: 'Out of stock', caption: 'Nothing left to sell', kind: 't-red' },
    { key: 'exp', label: 'Expiring in ' + w + ' days', caption: 'Or already expired', kind: 't-red' },
    { key: 'nodate', label: 'Unknown expiry', caption: 'A batch still needs a date', kind: 't-neutral' }
  ];
}
function invInBox(box, d) {
  if (box === 'low') return d.qty_in_stock > 0 && d.qty_in_stock <= d.reorder_level;
  if (box === 'out') return d.qty_in_stock === 0;
  if (box === 'exp') return !!d.soonest_expiry && daysUntil(d.soonest_expiry) <= invWarnDays();
  if (box === 'nodate') return !!d.has_unknown_expiry;
  return true;
}
// The drugs in the picked box that also match the search: this is what the table, Print and Excel all show.
function invRows() {
  var raw = invFilter.trim(), q = raw.toLowerCase();
  return STATE.drugsCache.filter(function (d) {
    return invInBox(invBox, d) && (!q || d.name.toLowerCase().indexOf(q) !== -1 || (d.barcode && d.barcode.indexOf(raw) !== -1));
  });
}
function invTitle() {
  var b = invBoxes().filter(function (x) { return x.key === invBox; })[0];
  return b ? b.label : 'All drugs';
}
// Out of stock red, low stock amber, otherwise green: plain coloured text.
function invStatusCell(d) {
  return d.qty_in_stock === 0 ? stCell('Out of stock', 'bad') : d.qty_in_stock <= d.reorder_level ? stCell('Low stock', 'warn') : stCell('In stock', 'ok');
}
function invExpiryCell(d) {
  if (!d.soonest_expiry) return d.has_unknown_expiry ? stCell('Batch has no date', 'ink') : '—';
  var days = daysUntil(d.soonest_expiry);
  var note = days < 0 ? 'expired' : (days <= invWarnDays() ? 'in ' + days + (days === 1 ? ' day' : ' days') : '');
  return { html: '<span><b>' + esc(fmtDate(d.soonest_expiry)) + '</b>' + (note ? ' <span class="' + (days <= 30 ? 'st-bad' : 'st-warn') + '">' + esc(note) + '</span>' : '') + '</span>' };
}
// The Stock value column (and every cost figure) is for people allowed to see prices and stock value.
function invShowValue() { return canSee('see_cost_prices') && canSee('see_stock_value'); }
function invCells(d) {
  var cells = [{ html: esc(d.name) + daysLeftNote(d) }, qtyUnit(d.qty_in_stock, d.unit), String(d.reorder_level), fmt(d.stock_value_retail), invExpiryCell(d), invStatusCell(d)];
  if (!invShowValue()) cells.splice(3, 1);
  return cells;
}
var INV_COLS_ALL = ['Drug', 'In stock', 'Reorder at', 'Stock value', 'Soonest expiry', 'Status'];
function invCols() { return invShowValue() ? INV_COLS_ALL : INV_COLS_ALL.filter(function (c) { return c !== 'Stock value'; }); }
function invNumCols() { return invShowValue() ? [false, true, true, true, false, false] : [false, true, true, false, false]; }
function pickInvBox(key) { invBox = key; invPage = 1; drawInventory(); }
function goInvPage(p) { invPage = p; drawInventory(); }

function drawInventory() {
  var c = $('#content');
  var rows = invRows();
  var pg = pageSlice(rows, invPage);
  invPage = pg.page;
  var worth = STATE.drugsCache.reduce(function (a, d) { return a + Number(d.stock_value_retail || 0); }, 0);
  var desk =
    '<div class="report-head"><div><div class="section-title" style="margin:0">Inventory</div>' +
    '<div class="inv-sub">' + STATE.drugsCache.length + ' drugs · ' + (invShowValue() ? 'stock worth ' + esc(fmt(worth)) + ' at selling price. ' : '') + 'Tap a box to filter, tap a row to open the drug.</div></div>' +
    '<div class="toolbar-segment">' +
    (can('export') ? '<button class="btn" onclick="exportInventoryExcel()">' + icon('download', 15) + ' Excel</button>' : '') +
    (can('print') ? '<button class="btn" onclick="printInventory()">' + icon('printer', 15) + ' Print</button>' : '') +
    (can('edit_inventory') ? '<button class="btn lime" onclick="openAddDrug()">' + t('addDrug') + '</button>' : '') +
    '</div></div>' +
    '<div class="kpi-grid five" style="margin-bottom:14px">' + invBoxes().map(function (b) {
      var n = STATE.drugsCache.filter(function (d) { return invInBox(b.key, d); }).length;
      return '<button class="kpi kpi-clickable ' + b.kind + (invBox === b.key ? ' active' : '') + '" onclick="pickInvBox(\'' + b.key + '\')">' +
        '<div class="label">' + esc(b.label) + '</div><div class="value">' + n + '</div><div class="tiny">' + esc(b.caption) + '</div></button>';
    }).join('') + '</div>' +
    '<div class="inv-search searchbox field" style="display:flex;gap:8px;align-items:center">' +
    '<input id="invSearchInput" placeholder="Search drugs…" value="' + esc(invFilter) + '" oninput="invFilter=this.value;invPage=1;invPhonePage=1;drawInventory()" onkeydown="invSearchKeydown(event)" style="flex:1">' +
    (barcodeCameraSupported() ? '<button class="btn secondary scan-btn" title="Scan barcode" aria-label="Scan barcode" onclick="invScanBarcode()">' + icon('barcode', 18) + ' Scan barcode</button>' : '') +
    '</div>' +
    '<div class="inv-tools">' +
    (can('edit_inventory') || can('stock_take') ? '<button class="btn sq-green" onclick="openStockSheetMenu()">Count / edit in Excel</button>' : '') +
    (can('stock_take') ? '<button class="btn sq-green" onclick="setTab(\'stocktake\')">Stock take</button>' : '') +
    (can('edit_inventory') ? '<button class="btn sq-blue" onclick="openImportExcel()">Import</button>' : '') +
    (can('edit_inventory') ? '<button class="btn sq-blue" onclick="openSyncMasterDrugs()">Sync common drugs</button>' : '') +
    (canSeeControlled() ? '<button class="btn sq-red" onclick="setTab(\'controlled\')">Controlled</button>' : '') +
    (can('restock') ? '<button class="btn" onclick="openReorderList()">Reorder list</button>' : '') +
    '<button class="btn" onclick="openUnknownExpiryList()">No-expiry list</button>' +
    '</div>' +
    '<div class="section-title" style="margin-top:6px">' + esc(invTitle()) + '</div>' +
    showingHtml(pg) +
    rtTable(invCols(), pg.rows.map(invCells), {
      rowClick: function (i) { return "openDrugDetail('" + pg.rows[i].drug_id + "')"; },
      empty: STATE.drugsCache.length ? 'No drugs match. Try clearing the search or another box.' : 'No drugs yet. Add one to start.',
      num: invNumCols()
    }) +
    pagerHtml(pg, 'goInvPage') +
    (can('edit_inventory') ? '<button class="btn ghost small" id="hiddenDrugsBtn" style="margin-top:12px" onclick="openHiddenDrugs()">' + icon('box', 15) + ' Hidden drugs</button>' : '');
  // Phone: the list the owner already knows, unchanged. Desktop gets the table above.
  redrawKeepingFocus(c, '<div class="inv-desk">' + desk + '</div><div class="inv-phone">' + invPhoneHtml() + '</div>');
}

// The phone screen exactly as it was before the desktop table: search, Add drug, the button grid, the two
// notices, then one row per drug (name, stock value, Out / Low / OK) with "Load more".
var INV_PAGE_SIZE = 50;
var invPhonePage = 1;
function invPhoneHtml() {
  var raw = invFilter.trim(), q = raw.toLowerCase();
  var allRows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1 || (d.barcode && d.barcode.indexOf(raw) !== -1); });
  var rows = allRows.slice(0, invPhonePage * INV_PAGE_SIZE);
  var reorderCount = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; }).length;
  var unknownExpiryCount = STATE.drugsCache.filter(function (d) { return d.has_unknown_expiry; }).length;
  return '<div class="searchbox field" style="display:flex;gap:8px;align-items:center">' +
    '<input id="invSearchInputPhone" placeholder="Search drugs…" value="' + esc(invFilter) + '" oninput="invFilter=this.value;invPage=1;invPhonePage=1;drawInventory()" onkeydown="invSearchKeydown(event)" style="flex:1">' +
    (barcodeCameraSupported() ? '<button class="btn secondary scan-btn" title="Scan barcode" aria-label="Scan barcode" onclick="invScanBarcode()">' + icon('barcode', 18) + ' Scan barcode</button>' : '') +
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
    (can('export') ? '<button class="btn" onclick="exportInventoryExcel()">Excel</button>' : '') +
    (can('print') ? '<button class="btn" onclick="printInventory()">Print</button>' : '') +
    '</div>' +
    (can('restock') && reorderCount ? '<div class="inline-notice">' + icon('clipboard', 15) +
      '<a href="#" onclick="openReorderList();return false;">' + reorderCount + (reorderCount === 1 ? ' drug needs' : ' drugs need') + ' reordering — view list</a></div>' : '') +
    (unknownExpiryCount ? '<div class="inline-notice">' + icon('warn', 15) +
      '<a href="#" onclick="openUnknownExpiryList();return false;">' + unknownExpiryCount + (unknownExpiryCount === 1 ? ' drug has' : ' drugs have') + ' a batch with no expiry date set — view list</a></div>' : '') +
    '<div class="card">' + (rows.length ? rows.map(function (d) {
      var kind = d.qty_in_stock === 0 ? 'bad' : d.qty_in_stock <= d.reorder_level ? 'warn' : 'good';
      var badge = kind === 'bad' ? '<span class="badge bad">Out</span>' : kind === 'warn' ? '<span class="badge warn">Low</span>' : '<span class="badge good">OK</span>';
      var expBadge = d.soonest_expiry ? (daysUntil(d.soonest_expiry) <= (STATE.pharmacy.expiry_warn_days || 90)
        ? ' <span class="badge ' + (daysUntil(d.soonest_expiry) <= 30 ? 'bad' : 'warn') + '">exp ' + fmtDate(d.soonest_expiry) + '</span>' : '') : '';
      return '<div class="list-row" onclick="openDrugDetail(\'' + d.drug_id + '\')" style="cursor:pointer">' +
        '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + (invShowValue() ? fmt(d.stock_value_retail) + ' in stock value' : esc(qtyUnit(d.qty_in_stock, d.unit)) + ' in stock') + expBadge + '</div>' + daysLeftNote(d) + '</div>' +
        '<div class="right">' + badge + '<div class="meta">' + esc(qtyUnit(d.qty_in_stock, d.unit)) + '</div></div></div>';
    }).join('') : '<div class="empty">No drugs match. Try clearing the search or add a new one.</div>') + '</div>' +
    (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="invPhonePage++;drawInventory()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : '') +
    (can('edit_inventory') ? '<button class="btn ghost small" style="margin-top:12px" onclick="openHiddenDrugs()">' + icon('box', 15) + ' Hidden drugs</button>' : '');
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
  if (!can('export')) return;
  var showValue = invShowValue();
  var rows = invRows().map(function (d) {
    var r = {
      'Drug': d.name,
      'Unit': d.unit,
      'Qty in stock': d.qty_in_stock,
      'Reorder level': d.reorder_level,
      'Status': d.qty_in_stock === 0 ? 'OUT OF STOCK' : d.qty_in_stock <= d.reorder_level ? 'LOW STOCK' : 'OK',
      'Soonest expiry': d.soonest_expiry ? fmtDate(d.soonest_expiry) : ''
    };
    if (showValue) {
      r['Stock value (cost)'] = Number(d.stock_value_cost || 0);
      r['Stock value (retail)'] = Number(d.stock_value_retail || 0);
    }
    return r;
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - stock - ' + invTitle().toLowerCase().replace(/[^a-z0-9]+/g, '-') + ' - ' + todayStr() + '.xlsx', 'Stock', rows);
}

// Print and Excel carry every drug in the picked box that matches the search, not just the page on screen.
function printInventory() {
  if (!can('print')) return;
  var showValue = invShowValue();
  var list = invRows();
  var rows = list.map(function (d) {
    var cells = [d.name, qtyUnit(d.qty_in_stock, d.unit), String(d.reorder_level), fmt(d.stock_value_retail), d.soonest_expiry ? fmtDate(d.soonest_expiry) : '—', invStatusCell(d)];
    if (!showValue) cells.splice(3, 1);
    return cells;
  });
  var totalValue = list.reduce(function (a, d) { return a + Number(d.stock_value_retail || 0); }, 0);
  printHtml('Inventory', invTitle() + ' · ' + todayStr(),
    tableHtml(invCols(), rows, showValue ? 'Total stock value: ' + fmt(totalValue) : ''),
    list.length + ' drugs' + (showValue ? ' · Total stock value ' + fmt(totalValue) : ''));
}

function todayStr() { return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }

