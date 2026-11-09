// Per-staff permissions: what one member of staff may see.
//   node tests/staff-access.test.js
// Checks the rules in the browser code (canSee, can, the Seller dashboard, Inventory
// columns, report tiles, Excel/Print buttons) and in the database migration (the
// functions, the guard that stops people editing their own permissions, the presets).
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

// Pull whole top-level functions out of a source file and run them in one sandbox.
function grab(file, name) {
  const src = read(file);
  const i = src.search(new RegExp('(async )?function ' + name + '\\('));
  if (i < 0) return '';
  const m = src.slice(i).match(/\n\}/);
  return src.slice(i, i + m.index + 2);
}
function sandbox(files) {
  const ctx = { console, STATE: { profile: null } };
  vm.createContext(ctx);
  files.forEach(f => vm.runInContext(read(f), ctx, { filename: f }));
  return ctx;
}

// ---------------------------------------------------------------- the browser rules
let core;
try {
  core = sandbox(['js/staff-access.js']);
  vm.runInContext(['staffAccessOf', 'isOwnerRole', 'canSee', 'controlledLevelOf', 'controlledLevel', 'can']
    .map(f => grab('js/core.js', f)).join('\n') +
    "\nvar PHARMACIST_ACTIONS=['sell','export','print','controlled','view_controlled','view_reports'];" +
    "var STOCK_TAKER_ACTIONS=['view_controlled'];var ACCOUNTANT_ACTIONS=['view_controlled'];" +
    "var ATTENDANT_ACTIONS=['sell','view_reports','print','export'];", core);
} catch (e) { check(false, 'js/staff-access.js and the permission helpers in js/core.js load (' + e.message + ')'); core = null; }
const as = (role, access) => { core.STATE.profile = { id: 'u1', role, access: access === undefined ? null : access }; };

if (core) {
  const SALES_ONLY = core.ACCESS_PRESETS.sales_stock;
  as('owner', SALES_ONLY);
  check(core.canSee('see_profit') && core.can('export') && core.controlledLevel() === 'record', 'the owner is never limited, whatever is saved');
  as('co_owner', SALES_ONLY);
  check(core.canSee('see_shop_sales'), 'the co-owner is never limited');
  as('attendant', null);
  check(core.canSee('see_profit') && core.canSee('rpt_valuation'), 'no saved access means everything, as before (existing staff keep what they saw)');
  check(core.controlledLevel() === 'off', 'a Seller with no saved access still has no controlled drugs register');
  as('attendant', SALES_ONLY);
  check(!core.canSee('see_profit') && !core.canSee('see_stock_value') && !core.canSee('see_debt') && !core.canSee('see_shop_sales') && !core.canSee('see_customer_debt'),
    'Sales and stock only hides profit, stock value, debt, whole-shop sales and customer credit');
  check(core.canSee('see_top_sellers') && core.canSee('rpt_sales'), 'Sales and stock only keeps top sellers and the Sales Report');
  check(!core.canSee('rpt_valuation') && !core.canSee('see_cost_prices'), 'Sales and stock only hides the Stock Valuation report and cost prices');
  check(core.can('export') && core.can('print'), 'Sales and stock only keeps Excel and Print');
  check(core.controlledLevel() === 'view' && core.can('view_controlled') && !core.can('controlled'), 'controlled drugs: view only means the register opens but nothing can be recorded');
  as('attendant', Object.assign({}, SALES_ONLY, { controlled: 'record' }));
  check(core.can('controlled') && core.can('view_controlled'), 'controlled drugs: view and record allows recording');
  as('attendant', Object.assign({}, SALES_ONLY, { controlled: 'off' }));
  check(!core.can('view_controlled') && !core.can('controlled'), 'controlled drugs: no access hides the register');
  as('attendant', Object.assign({}, SALES_ONLY, { export: false }));
  check(!core.can('export') && !core.can('print'), 'turning Download to Excel and Print off removes both');
  as('pharmacist', { controlled: 'view' });
  check(core.can('view_controlled') && !core.can('controlled'), 'a Pharmacist can also be limited to viewing the register');
  as('pharmacist', null);
  check(core.controlledLevel() === 'record', 'a Pharmacist with nothing saved can still record controlled drugs');
  as(null, null); core.STATE.profile = null;
  check(!core.canSee('see_profit') && !core.can('export'), 'nobody signed in sees nothing');

  // Presets
  const P = core.ACCESS_PRESETS;
  check(core.accessPresetOf(null) === 'everything', 'saved nothing reads as Everything');
  check(core.accessPresetOf(P.sales_stock) === 'sales_stock' && core.accessPresetOf(P.no_profit) === 'no_profit', 'each preset is recognised when it is read back');
  check(core.accessPresetOf(Object.assign({}, P.sales_stock, { see_debt: true })) === 'custom', 'one switch changed makes it Custom');
  check(P.no_profit.see_profit === false && P.no_profit.see_stock_value === false && P.no_profit.rpt_valuation === false &&
    P.no_profit.see_debt === true && P.no_profit.rpt_sales === true && P.no_profit.see_cost_prices === true,
    '"Everything except profit, margin and stock value" hides exactly those and keeps debt, reports and cost prices');
  check(core.ACCESS_KEYS.length === 10 && core.ACCESS_GROUPS.reduce((n, g) => n + g.items.length, 0) === 10, 'the ten switches (plus controlled drugs) are all listed');
}

// ---------------------------------------------------------------- JS presets = database presets
const mig = read('migrations/2026-11-09_staff_access.sql');
if (core) {
  function sqlPreset(name) {
    const m = mig.match(new RegExp("when '" + name + "' then jsonb_build_object\\(([\\s\\S]*?)\\)\\s*(?:when|else)"));
    if (!m) return null;
    const o = {};
    for (const kv of m[1].matchAll(/'(\w+)',\s*(true|false|'\w+')/g)) o[kv[1]] = kv[2] === 'true' ? true : kv[2] === 'false' ? false : kv[2].slice(1, -1);
    return o;
  }
  ['sales_stock', 'no_profit'].forEach(n => {
    const a = sqlPreset(n), b = core.ACCESS_PRESETS[n];
    check(a && JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]])),
      'the browser preset ' + n + ' is the same as access_preset(\'' + n + '\') in the database');
  });
}

// ---------------------------------------------------------------- the Seller dashboard
const dash = read('js/dashboard.js');
if (core) {
  const dctx = sandbox(['js/staff-access.js']);
  Object.assign(dctx, { esc: s => String(s), fmt: n => 'KES ' + n, DCOLOR: { sales: 'g', salesLight: 'gl', orange: 'o', orangeLight: 'ol', magenta: 'm', magentaLight: 'ml' },
    DASH_VS_LABEL: {}, DASH_PERIOD_LABEL: {}, dashRange: 'today', can: () => true, STATE: { profile: null } });
  vm.runInContext(['canSee', 'staffAccessOf', 'isOwnerRole'].map(f => grab('js/core.js', f)).join('\n') +
    ['dashDeltaText', 'dashStatTiles', 'dashStatTilesHtml', 'dashSellerView'].map(f => grab('js/dashboard.js', f)).join('\n'), dctx);
  const tilesFor = (role, access, seller) => { dctx.STATE.profile = { role, access }; return vm.runInContext('dashStatTiles(' + JSON.stringify({ sales_total: 500, profit_total: 100 }) + ',' + JSON.stringify({ stockValue: 9, supplierOwed: 7, mine: { total: 1200, count: 3, last_sold_at: '2026-11-09T10:00:00Z' } }) + ',' + seller + ').map(function(t){return t.label})', dctx).join(','); };
  check(tilesFor('owner', null, false) === 'Sales,Profit,Stock value,Debt owed', 'the owner keeps all four dashboard tiles');
  check(tilesFor('attendant', core.ACCESS_PRESETS.sales_stock, true) === 'My sales today', 'a restricted Seller sees My sales today and no money tiles');
  check(tilesFor('attendant', core.ACCESS_PRESETS.no_profit, false) === 'Sales,Debt owed', 'Everything except profit and stock value drops the Profit and Stock value tiles but keeps Debt owed');
  dctx.STATE.profile = { role: 'attendant', access: core.ACCESS_PRESETS.sales_stock };
  check(vm.runInContext('dashSellerView()', dctx) === true, 'a person who may not see whole-shop sales gets the Seller dashboard');
  dctx.STATE.profile = { role: 'attendant', access: null };
  check(vm.runInContext('dashSellerView()', dctx) === false, 'a Seller with no limits keeps the normal dashboard');
}
check(/my_sales_today/.test(dash), 'the Seller dashboard asks the database for the person\'s own sales today');
check(/DASH_CACHE_KEY[\s\S]{0,400}uid: STATE\.profile\.id/.test(dash) && /c\.uid !== STATE\.profile\.id/.test(dash), 'the saved dashboard on a phone is kept per person, so a Seller never opens the owner\'s figures');
check(/dashNameListCard\('Out of stock'/.test(dash) && /dashNameListCard\('Low stock'/.test(dash), 'the Seller dashboard lists out-of-stock and low-stock drugs by name');
check(/dashTopTabsHtml\(\)/.test(dash) && /\['today', 'week', 'month'\]/.test(dash), 'the Seller\'s top sellers have Today, 7 Days and Month tabs');
check(/Close cash drawer/.test(dash), 'the Seller dashboard has the Close cash drawer button');

// ---------------------------------------------------------------- Inventory, reports, menu, exports
const inv = read('js/inventory.js');
check(/function invShowValue\(\) \{ return canSee\('see_cost_prices'\) && canSee\('see_stock_value'\); \}/.test(inv), 'Inventory shows stock value only to people allowed cost prices and stock value');
check(/if \(!invShowValue\(\)\) cells\.splice\(3, 1\)/.test(inv), 'the Inventory table drops its Stock value cell when hidden');
check(/if \(showValue\) \{[\s\S]{0,160}Stock value \(cost\)/.test(inv), 'Excel leaves out cost and stock value when hidden');
check(/if \(!can\('export'\)\) return;/.test(inv) && /if \(!can\('print'\)\) return;/.test(inv), 'Inventory Excel and Print refuse to run when switched off');
check(/can\('export'\) \? '<button class="btn" onclick="exportInventoryExcel/.test(inv), 'the Inventory Excel button is hidden when switched off');
const reports = read('js/reports.js'), shell = read('js/shell.js'), exp = read('js/export.js');
check(/function reportAllowed\(view\)[\s\S]{0,200}canSee\('rpt_valuation'\)[\s\S]{0,100}canSee\('rpt_sales'\)/.test(reports), 'the Stock Valuation and Sales reports have their own switch');
check(/if \(!reportAllowed\(reportsView\)\) reportsView = 'hub'/.test(reports), 'a hidden report cannot be opened, even by going straight to it');
check(/if \(!reportAllowed\(r\.view\)\) return false/.test(reports), 'a hidden report has no tile on the Reports page');
check(/seeReports && canSee\('rpt_valuation'\)/.test(shell), 'Stock Valuation is not in the menu when switched off');
check(/can\('export'\)[\s\S]{0,300}can\('print'\)/.test(grab('js/export.js', 'reportHeadHtml')), 'every report\'s Excel and Print buttons follow the export switch');

// ---------------------------------------------------------------- Settings and the admin portal
const set = read('js/claims-settings.js'), adm = read('admin.js');
check(/sb\.rpc\('set_staff_access'/.test(set) && !/from\('profiles'\)\.update\(\{ access/.test(set), 'Settings saves permissions through set_staff_access, never a direct update');
check(/Permissions<\/button>/.test(set) && /limitable/.test(set), 'every non-owner staff member has a Permissions button');
check(/sb\.rpc\('admin_set_staff_access'/.test(adm) && /sb\.rpc\('admin_staff_access'/.test(adm), 'the admin portal reads and saves any pharmacy\'s staff permissions');
check(/js\/staff-access\.js/.test(read('admin.html')) && /js\/staff-access\.js/.test(read('index.html')) && /js\/staff-access\.js/.test(read('sw.js')), 'the permission switches are loaded by the app, the admin portal and the offline cache');

// ---------------------------------------------------------------- the database
check(/alter table public\.profiles add column if not exists access jsonb/.test(mig), 'profiles.access exists (null = everything)');
check(/function public\.staff_can\(p_key text\)[\s\S]{0,300}security definer/.test(mig) && /pr\.role in \('owner', 'co_owner'\) then true/.test(mig), 'staff_can lets owner and co-owner through');
check(/when pr\.access is null then true/.test(mig), 'staff_can treats no saved access as everything');
check(/if new\.access is distinct from old\.access\s+and coalesce\(current_setting\('app\.staff_access_writer', true\), ''\) <> '1'[\s\S]{0,120}raise exception/.test(mig), 'nobody can change profiles.access except through the permission functions');
check(/function public\.set_staff_access[\s\S]{0,400}my_role\(\) not in \('owner', 'co_owner'\)[\s\S]{0,300}pharmacy_id = my_pharmacy_id\(\)/.test(mig), 'set_staff_access is for the owner/co-owner of the same pharmacy only');
check(/function public\.admin_set_staff_access[\s\S]{0,300}is_platform_admin\(\)/.test(mig) && /function public\.admin_staff_access[\s\S]{0,300}is_platform_admin\(\)/.test(mig), 'the admin permission functions check the platform admin');
check(/The owner and co-owner always see everything/.test(mig), 'the owner\'s own access cannot be limited');
check(/Unknown permission: %/.test(mig) && /controlled must be off, view or record/.test(mig) && /must be true or false/.test(mig), 'only known switches with valid values are saved');
check(/insert into staff_access_log/.test(mig) && /changed_by/.test(mig) && /changed_at\s+timestamptz not null default now\(\)/.test(mig), 'every change is logged with who and when');
check(/alter table public\.staff_access_log enable row level security/.test(mig) && /on public\.staff_access_log\s+for select/.test(mig), 'the change log has row level security and is read-only to the owner');
check(/rename to dashboard_data_raw/.test(mig) && /revoke all on function public\.dashboard_data_raw\(uuid, text\) from public, anon, authenticated/.test(mig), 'the old dashboard function is closed to the browser and wrapped');
check(/rename to dashboard_data_custom_raw/.test(mig) && /revoke all on function public\.dashboard_data_custom_raw/.test(mig), 'the custom-range dashboard function is closed and wrapped too');
check(/'cost_total' - 'profit_total' - 'profit_prev_total'/.test(mig) && /'sales_total' - 'sales_prev_total' - 'trend' - 'rush'/.test(mig), 'the dashboard wrapper removes profit and whole-shop sales for people who may not see them');
check(/CASE WHEN staff_can\('see_stock_value'\)/.test(mig), 'v_drug_stock blanks stock value for people who may not see it');
check(/case when staff_can\('see_debt'\)/.test(mig) && /case when staff_can\('see_customer_debt'\)/.test(mig), 'supplier debt and customer credit are blanked in the database too');
check(/function public\.my_sales_today[\s\S]{0,500}s\.created_by = auth\.uid\(\)/.test(mig), 'my_sales_today only counts the signed-in person\'s own sales');
check(/trigger profiles_default_access\s+before insert on public\.profiles/.test(mig) && /new\.role = 'attendant' and new\.access is null/.test(mig), 'a new Seller starts on the Sales and stock only preset');
check(fs.existsSync(path.join(ROOT, 'migrations/2026-11-09_staff_access.ROLLBACK_if_needed.sql')), 'the migration has a rollback file');
check(read('schema.sql').includes('-- Folded in from migrations/2026-11-09_staff_access.sql'), 'the migration is folded into schema.sql');
// every function in the migration that the browser can call revokes the public/anon grant
for (const fnName of ['staff_can', 'set_staff_access', 'admin_set_staff_access', 'admin_staff_access', 'my_sales_today']) {
  check(new RegExp('revoke all on function public\\.' + fnName + '\\([^)]*\\) from public, anon;').test(mig), fnName + ' is not callable by anonymous visitors');
}
for (const fnName of ['staff_access_apply', 'dashboard_filter', 'access_preset', 'profiles_default_access']) {
  check(new RegExp('revoke all on function public\\.' + fnName + '\\([^)]*\\) from public, anon, authenticated;').test(mig), fnName + ' is internal and closed to the browser');
}

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS staff permissions: browser rules, Seller dashboard, Inventory/report/export hiding, Settings and admin screens, database functions');
