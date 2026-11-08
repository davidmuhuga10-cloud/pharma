// Returning stock to a supplier: the screens. The stock and money rules are tested in
// tests/run_tests.js (section "Returning stock to a supplier"). Run from the project folder:
//   node tests/supplier-returns.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const sup = read('js/suppliers.js'), act = read('js/stock-actions.js'), ctl = read('js/controlled-stocktake.js'), schema = read('schema.sql');
const migA = read('migrations/2026-11-07_supplier_returns_a_enum.sql'), mig = read('migrations/2026-11-07_supplier_returns.sql');

const ctx = { console, esc: s => String(s), fmt: n => 'KES ' + Number(n), $: () => null, STATE: {} };
vm.createContext(ctx); vm.runInContext(sup, ctx); vm.runInContext(act, ctx);

// the credit that is suggested
check(ctx.supplierReturnCredit(30, 6) === 180, '30 units at cost 6 suggest a credit of 180');
check(ctx.supplierReturnCredit(3, 0.1) === 0.3, 'the credit is rounded to cents (3 x 0.10)');
check(ctx.supplierReturnCredit(5, null) === null, 'no cost price: nothing is suggested, the person types it');
check(ctx.supplierReturnCredit(0, 6) === null && ctx.supplierReturnCredit('', 6) === null, 'no quantity: nothing is suggested');

// the supplier statement
const detail = {
  supplier: { opening_balance: 100, opening_balance_date: '2026-01-01' },
  lpos: [{ delivered_at: '2026-02-01', lpo_number: 'LPO-1', total_amount: 1000, supplier_lpo_items: [] }],
  payments: [{ paid_at: '2026-02-10', method: 'cash', amount: 200 }],
  returns: [{ returned_at: '2026-02-20', quantity: 30, credit_amount: 180, reason: 'expired', drugs: { name: 'Amoxil' } }]
};
const led = ctx.buildSupplierLedger(detail);
check(led.balance === 720 && led.totalCredit === 180, 'balance = 100 + 1000 - 200 - 180 = 720, and the credit total is 180');
const last = led.entries[led.entries.length - 1];
check(/Returned stock/.test(last.label) && /Amoxil ×30/.test(last.detailText) && /expired/.test(last.detailText) && last.credit === 180 && last.runningBalance === 720, 'the return shows as a credit line with the drug, quantity, reason and running balance');
const none = ctx.buildSupplierLedger({ supplier: { opening_balance: 0 }, lpos: [{ delivered_at: '2026-02-01', lpo_number: 'L', total_amount: 50, supplier_lpo_items: [] }], payments: [] });
check(none.balance === 50 && none.totalCredit === 0, 'a supplier with no returns is worked out exactly as before (and old data without a returns list still works)');

// wiring
check(/from\('supplier_returns'\)[^;]*eq\('supplier_id'/.test(sup), 'the supplier screen reads that supplier\'s returns');
check(/rpc\('record_supplier_return'/.test(act) && /act\(btn, async function/.test(act.slice(act.indexOf('async function saveSupplierReturn'))), 'saving goes through the database function, button locked while it works');
check(/can\('suppliers'\) \? '<button[^']*openSupplierReturn/.test(act), 'the button on a batch is only for people who may manage suppliers');
check(/askConfirm\('Return stock'/.test(act), 'it asks to confirm before removing stock');
check(/Credit/.test(sup.slice(sup.indexOf('function exportSupplierStatement'))) && /SUPPLIER_STMT_COLS = \[[^\]]*'Credit'/.test(sup) && /tableHtml\(SUPPLIER_STMT_COLS/.test(sup.slice(sup.indexOf('function printSupplierStatement'))), 'the Excel and printed statements have a Credit column');
check(/supplier_return: 'Returned to supplier'/.test(ctl), 'the controlled drugs register names the movement');
check(/add value if not exists 'supplier_return'/.test(migA), 'the new movement kind is added in its own migration file');
check(/'supplier_return'\)\);/.test(mig.replace(/\s+/g, ' ')) || /'stock_take', 'supplier_return'/.test(mig), 'the controlled drugs register accepts the new kind');
check(/- coalesce\(\(select sum\(r\.credit_amount\)[\s\S]*function public\.supplier_owed_summary[\s\S]*- coalesce\(\(select sum\(r\.credit_amount\)/.test(mig), 'both the Suppliers list and the dashboard debt take the credits off');
check(/Folded in from migrations\/2026-11-07_supplier_returns\.sql/.test(schema) && /Folded in from migrations\/2026-11-07_supplier_returns_a_enum\.sql/.test(schema), 'schema.sql carries both files');
check(/alter table public\.supplier_returns enable row level security/.test(mig) && /supplier_returns_pharmacy_idx/.test(mig), 'the new table has row-level security and a pharmacy index');
if (failed) process.exit(1);
console.log('supplier returns: ok');
