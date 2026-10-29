// js/inventory.js - The Inventory screen: drug list, add/edit drug.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// INVENTORY
// ---------------------------------------------------------------------------

var invFilter = '';

async function renderInventory() {
  var c = $('#content');
  if (!can('view_inventory')) { c.innerHTML = '<div class="card empty">You do not have access to Inventory.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading inventory…</div>';
  try {
    var { data: stock } = await sb.from('v_drug_stock').select('*').order('name');
    STATE.drugsCache = stock || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderInventory');
    return;
  }
  drawInventory();
}

var invPage = 1;
var INV_PAGE_SIZE = 50;

function drawInventory() {
  var c = $('#content');
  var q = invFilter.toLowerCase();
  var allRows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
  var rows = allRows.slice(0, invPage * INV_PAGE_SIZE);
  var reorderCount = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; }).length;
  var unknownExpiryCount = STATE.drugsCache.filter(function (d) { return d.has_unknown_expiry; }).length;
  redrawKeepingFocus(c,
    '<div class="searchbox field"><input id="invSearchInput" placeholder="Search drugs…" value="' + esc(invFilter) + '" oninput="invFilter=this.value;invPage=1;drawInventory()"></div>' +
    '<div class="toolbar-row">' +
    (can('edit_inventory') ? '<div class="toolbar-segment">' +
      '<button class="btn" onclick="openSyncMasterDrugs()">' + icon('box',15) + ' Sync common drugs</button>' +
      '<button class="btn" onclick="openImportExcel()">' + icon('upload',15) + ' Import</button>' +
      '</div>' : '') +
    (can('stock_take') || canSeeControlled() ? '<div class="toolbar-segment">' +
      (can('stock_take') ? '<button class="btn" onclick="setTab(\'stocktake\')">' + icon('clipboard',15) + ' Stock Take</button>' : '') +
      (canSeeControlled() ? '<button class="btn" onclick="setTab(\'controlled\')">' + icon('warn',15) + ' Controlled</button>' : '') +
      '</div>' : '') +
    '<div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportInventoryExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn" onclick="printInventory()">' + icon('printer',15) + ' Print</button>' +
    '</div>' +
    (can('edit_inventory') ? '<button class="btn primary toolbar-primary" onclick="openAddDrug()">' + t('addDrug') + '</button>' : '') +
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
        '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + fmt(d.stock_value_retail) + ' in stock value' + expBadge + '</div></div></div>' +
        '<div class="right">' + badge + '<div class="meta">' + esc(qtyUnit(d.qty_in_stock, d.unit)) + '</div></div></div>';
    }).join('') : '<div class="empty">No drugs match. Try clearing the search or add a new one.</div>') + '</div>' +
    (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="invPage++;drawInventory()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : ''));
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

// ---------------------------------------------------------------------------
