// The "days of stock left" alert: screens and the files that carry it. The database rules are
// tested in tests/run_tests.js (section "Days-of-stock-left alert"). Run from the project folder:
//   node tests/days-alert.test.js
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const settings = read('js/claims-settings.js'), exp = read('js/expenses.js'), sa = read('js/stock-actions.js'),
      inv = read('js/inventory.js'), schema = read('schema.sql'), mig = read('migrations/2026-11-07_days_left_alert.sql');

check(/id="stLowDays"/.test(settings) && /placeholder="Off"/.test(settings), 'Settings has the days box, empty means off');
check(/low_stock_days:\s*lowDays/.test(exp) && /lowDays < 1 \|\| lowDays > 90/.test(exp), 'Settings saves the days (1 to 90) or empty');
check(/p_reorder_custom:\s*custom/.test(sa), 'Edit drug sends whether the drug has its own number');
check(/reorder_custom:\s*\(parseInt/.test(sa), 'Add drug marks a number that differs from the pharmacy default as its own');
check(/custom = false;/.test(sa) && /custom = \(was\.id === drugId && !was\.custom && reorder === was\.level\) \? null : true/.test(sa), 'saving Edit drug untouched does not pin a drug that uses the days alert');
check(/function daysLeftNote\(d\)/.test(inv) && /low_stock_days/.test(inv) && /\+ daysLeftNote\(d\)/.test(inv), 'the stock list shows days left only when the days alert is on');
check(!/#8A837C|#6B6560/i.test(settings + inv), 'no retired gray text colours');

// Database side: the migration and schema.sql carry the same change, and it is off by default.
check(/low_stock_days integer check \(low_stock_days between 1 and 90\)/.test(mig) && !/low_stock_days integer[^;]*default/.test(mig.replace(/--[^\n]*/g, '')), 'low_stock_days is empty (off) by default and limited to 1..90');
check(/Folded in from migrations\/2026-11-07_days_left_alert\.sql/.test(schema), 'schema.sql carries the days alert');
check(/grant update \(low_stock_days\) on public\.pharmacies to authenticated/.test(mig), 'owners may change low_stock_days');
check(/where p\.low_stock_days is not null/.test(mig), 'sales speed is only worked out for pharmacies that turned the alert on');
check(/p_reorder_custom boolean default null/.test(mig), 'edit_drug keeps working for older app versions');

if (failed) process.exit(1);
console.log('days alert: ok');
