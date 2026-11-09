// js/staff-access.js - what each member of staff may see: the list of switches,
// the three presets, and the editor that shows them. Used by Settings -> Staff ->
// Permissions (index.html) and by the platform admin portal (admin.html), so the
// two screens can never disagree. Plain data and HTML only; it needs esc() from
// whichever page loads it. The same presets are in the database as access_preset()
// (migrations/2026-11-09_staff_access.sql); tests/staff-access.test.js checks they agree.

var ACCESS_GROUPS = [
  { title: 'On the dashboard', items: [
    { key: 'see_profit', label: 'Profit and margin' },
    { key: 'see_stock_value', label: 'Stock value' },
    { key: 'see_debt', label: 'Debt the shop owes suppliers' },
    { key: 'see_shop_sales', label: 'Whole-shop sales and the sales graph' },
    { key: 'see_top_sellers', label: 'Top sellers' },
    { key: 'see_customer_debt', label: 'What customers owe on credit' }
  ] },
  { title: 'Reports and screens', items: [
    { key: 'rpt_valuation', label: 'Stock Valuation report' },
    { key: 'rpt_sales', label: 'Sales Report' },
    { key: 'see_cost_prices', label: 'Cost prices and stock value on Inventory' },
    { key: 'export', label: 'Download to Excel and Print' }
  ] }
];
var ACCESS_KEYS = ['see_profit', 'see_stock_value', 'see_debt', 'see_shop_sales', 'see_top_sellers', 'see_customer_debt',
  'rpt_valuation', 'rpt_sales', 'see_cost_prices', 'export'];
var ACCESS_PRESETS = {
  sales_stock: { see_profit: false, see_stock_value: false, see_debt: false, see_shop_sales: false, see_top_sellers: true,
    see_customer_debt: false, rpt_valuation: false, rpt_sales: true, see_cost_prices: false, export: true, controlled: 'view' },
  no_profit: { see_profit: false, see_stock_value: false, see_debt: true, see_shop_sales: true, see_top_sellers: true,
    see_customer_debt: true, rpt_valuation: false, rpt_sales: true, see_cost_prices: true, export: true, controlled: 'record' },
  everything: null
};
var ACCESS_PRESET_LABELS = [
  ['sales_stock', 'Sales and stock only'],
  ['no_profit', 'Everything except profit, margin and stock value'],
  ['everything', 'Everything, like the owner'],
  ['custom', 'Custom']
];
var ACCESS_CONTROLLED_LABELS = [['off', 'No access'], ['view', 'View only'], ['record', 'View and record']];

// Which preset a saved access object equals ('custom' when none). null = everything.
function accessPresetOf(a) {
  if (!a) return 'everything';
  function norm(x) {
    var o = {};
    ACCESS_KEYS.forEach(function (k) { o[k] = x[k] !== false; });
    o.controlled = x.controlled || 'record';
    return JSON.stringify(o);
  }
  var mine = norm(a);
  if (norm(ACCESS_PRESETS.sales_stock) === mine) return 'sales_stock';
  if (norm(ACCESS_PRESETS.no_profit) === mine) return 'no_profit';
  return norm({}) === mine ? 'everything' : 'custom';
}

// The editor. p is a prefix so two editors never share element ids.
function accessEditorHtml(access, p) {
  var preset = accessPresetOf(access);
  var a = access || {};
  var presetOpts = ACCESS_PRESET_LABELS.map(function (o) {
    return '<option value="' + o[0] + '"' + (o[0] === preset ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
  }).join('');
  var groups = ACCESS_GROUPS.map(function (g) {
    return '<div class="acc-group"><div class="acc-title">' + esc(g.title) + '</div>' + g.items.map(function (it) {
      return '<label class="acc-row" for="' + p + '_' + it.key + '"><span>' + esc(it.label) + '</span>' +
        '<input type="checkbox" id="' + p + '_' + it.key + '"' + (a[it.key] !== false ? ' checked' : '') + ' onchange="accessEdited(\'' + p + '\')"></label>';
    }).join('') + '</div>';
  }).join('');
  var lvl = a.controlled || 'record';
  var ctlOpts = ACCESS_CONTROLLED_LABELS.map(function (o) {
    return '<option value="' + o[0] + '"' + (o[0] === lvl ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
  }).join('');
  return '<div class="acc-ed">' +
    '<div class="field"><label for="' + p + 'Preset">Start from</label>' +
    '<select id="' + p + 'Preset" onchange="accessPresetPicked(\'' + p + '\')">' + presetOpts + '</select></div>' +
    groups +
    '<div class="acc-group"><div class="acc-title">Controlled drugs (DDA register)</div>' +
    '<div class="field"><select id="' + p + '_controlled" aria-label="Controlled drugs register" onchange="accessEdited(\'' + p + '\')">' + ctlOpts + '</select></div></div>' +
    '</div>';
}

function accessSetEditor(p, a) {
  ACCESS_KEYS.forEach(function (k) { var el = document.getElementById(p + '_' + k); if (el) el.checked = !a || a[k] !== false; });
  var c = document.getElementById(p + '_controlled');
  if (c) c.value = (a && a.controlled) || 'record';
}
// Reads the editor. 'Everything' is saved as null (no limits at all).
function accessFromEditor(p) {
  var o = {};
  ACCESS_KEYS.forEach(function (k) { var el = document.getElementById(p + '_' + k); o[k] = !!(el && el.checked); });
  var c = document.getElementById(p + '_controlled');
  o.controlled = c ? c.value : 'record';
  return accessPresetOf(o) === 'everything' ? null : o;
}
// A preset was picked: tick the switches to match (Custom leaves them as they are).
function accessPresetPicked(p) {
  var name = document.getElementById(p + 'Preset').value;
  if (name !== 'custom') accessSetEditor(p, ACCESS_PRESETS[name]);
}
// A switch was changed by hand: the preset box follows (it falls back to Custom).
function accessEdited(p) {
  var sel = document.getElementById(p + 'Preset');
  var o = {};
  ACCESS_KEYS.forEach(function (k) { var el = document.getElementById(p + '_' + k); o[k] = !!(el && el.checked); });
  var c = document.getElementById(p + '_controlled');
  o.controlled = c ? c.value : 'record';
  if (sel) sel.value = accessPresetOf(o);
}
// One line for a staff list: what this person is limited to.
function accessSummary(a) {
  var names = { sales_stock: 'Sales and stock only', no_profit: 'Everything except profit and stock value', everything: 'Everything', custom: 'Custom' };
  return names[accessPresetOf(a)];
}
// One line for the change log.
function accessLogLine(row) {
  return accessSummary(row.new_access);
}
