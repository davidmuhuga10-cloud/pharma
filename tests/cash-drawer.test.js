// The cash drawer screen. The money rules are tested in tests/run_tests.js (section "Closing the cash
// drawer"). Run from the project folder:   node tests/cash-drawer.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const src = read('js/cash-drawer.js'), core = read('js/core.js'), reports = read('js/reports.js');
const sw = read('sw.js'), index = read('index.html'), mig = read('migrations/2026-11-07_cash_drawer.sql'), schema = read('schema.sql');

const ctx = { esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), fmt: n => 'KES ' + Number(n),
  fmtDateTime: s => String(s).slice(0, 10), kpi: (l, v) => l + ':' + v, console };
vm.createContext(ctx); vm.runInContext(src, ctx);

// what the person types
check(ctx.cashReadInputs('', '').error, 'an empty count is refused');
check(ctx.cashReadInputs('abc', '').error, 'a count that is not a number is refused');
check(ctx.cashReadInputs('-5', '').error, 'a negative count is refused');
check(ctx.cashReadInputs('100', '-1').error, 'a negative float is refused');
check(ctx.cashReadInputs('100', '150').error, 'leaving more than was counted is refused');
const ok = ctx.cashReadInputs('90.5', '');
check(ok.counted === 90.5 && ok.kept === 0, 'an empty float means nothing is left');
check(ctx.cashReadInputs('0', '0').counted === 0, 'counting zero is allowed (an empty drawer)');

// what is shown
check(ctx.cashFiguresHtml({ blind: true }) === '' && ctx.cashFiguresHtml(null) === '', 'a blind count shows no figures');
const fig = ctx.cashFiguresHtml({ blind: false, opening: 50, cash_sales: 130, customer_payments: 15, refunds: 20, expenses: 20, supplier_payments: 10 });
check(/KES 130/.test(fig) && /- KES 20/.test(fig) && /\+ KES 15/.test(fig), 'the figures show what adds and what is taken off');
check(ctx.cashDifferenceLabel(0) === 'Exact' && /Short by KES 5/.test(ctx.cashDifferenceLabel(-5)) && /Over by KES 3/.test(ctx.cashDifferenceLabel(3)), 'the difference reads exact, short or over');
const hist = ctx.cashHistoryHtml([{ closed_at: '2026-11-07T18:00:00Z', expected: 95, counted: 90, kept: 50, difference: -5, note: 'Change <b>', profiles: { full_name: 'Amina' } }]);
check(/Amina/.test(hist) && /Short by KES 5/.test(hist) && /Change &lt;b>/.test(hist), 'history shows who, the difference and the reason (escaped)');
check(/No closings yet/.test(ctx.cashHistoryHtml([])), 'an empty history says so');
const res = ctx.cashResultHtml({ expected: 95, counted: 90, difference: -5 });
check(/Short by KES 5/.test(res) && /95/.test(res), 'after saving, the seller sees the expected figure and the difference');

// who may do what
check(/cash_close/.test(core.match(/var ATTENDANT_ACTIONS[^;]*;/)[0]), 'a seller can close the drawer');
check(!/cash_review/.test(core.match(/var ATTENDANT_ACTIONS[^;]*;/)[0]), 'a seller cannot read past closings');
check(/cash_review/.test(core.match(/var ACCOUNTANT_ACTIONS[^;]*;/)[0]) && !/cash_close/.test(core.match(/var ACCOUNTANT_ACTIONS[^;]*;/)[0]), 'an accountant reads but cannot close');
check(!/cash_/.test(core.match(/var STOCK_TAKER_ACTIONS[^;]*;/)[0]), 'a stock taker has no cash drawer');
check(/cash_close', 'cash_review'\]/.test(core.match(/var PHARMACIST_ACTIONS[^;]*;/)[0]), 'a pharmacist can close and read');
check(/can\('cash_close'\)[\s\S]*cash_drawer_summary/.test(src) && /can\('cash_review'\)[\s\S]*from\('cash_closings'\)/.test(src), 'the screen asks only for what the role may see');

// wiring
check(/reportsView === 'cash'[^}]*loadCashDrawer/.test(reports) && /view: 'cash'/.test(reports), 'the Reports hub opens the cash drawer');
check(/js\/cash-drawer\.js/.test(index) && /\.\/js\/cash-drawer\.js/.test(sw), 'the script is loaded and kept offline');
check(index.indexOf('cash-drawer.js') < index.indexOf('js/main.js'), 'it loads before main.js');
check(/rpc\('close_cash_drawer'/.test(src) && /act\(this, saveCashClosing\)/.test(src), 'saving goes through the database function with the button locked while it works');
check(!/then 'short'|than the system expects/.test(mig) && /does not match what the system expects/.test(mig), 'the refusal does not hint whether the count was short or over');
check(/Folded in from migrations\/2026-11-07_cash_drawer\.sql/.test(schema), 'schema.sql carries the cash drawer');
if (failed) process.exit(1);
console.log('cash drawer: ok');
