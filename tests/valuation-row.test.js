// The Stock Valuation report shows, for each drug, the quantity with the cost and price of
// ONE unit ("20 tablets · cost KES 50 · price KES 100"). The view gives whole-stock
// values, so the per-unit figures are those divided by the quantity. This checks the
// wording and the maths without a browser. Run from the project folder:
//   node tests/valuation-row.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

// fmt() and esc() come from core.js; cut them out by name so core.js (which touches the page) is not run.
const grab = name => {
  const src = read('js/core.js');
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in js/core.js');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
};
const ctx = vm.createContext({});
vm.runInContext(grab('fmt') + '\n' + grab('esc') + '\n' + read('js/reports-stock.js'), ctx, { filename: 'reports-stock.js' });
const line = r => vm.runInContext('valuationLine(' + JSON.stringify(r) + ')', ctx);
const row = (name, unit, qty, cost, retail) => ({ name, unit, qty_in_stock: qty, stock_value_cost: cost, stock_value_retail: retail });

check(line(row('A', 'tablet', 20, 1000, 2000)) === '20 tablets · cost KES 50 · price KES 100', 'cost and price are per unit: ' + line(row('A', 'tablet', 20, 1000, 2000)));
check(line(row('A', 'bottle', 1, 120, 150)) === '1 bottle · cost KES 120 · price KES 150', 'one unit is not pluralised');
check(line(row('A', 'piece', 55, 0, 1100)) === '55 pieces · cost – · price KES 20', 'a missing cost is just a dash, never KES 0: ' + line(row('A', 'piece', 55, 0, 1100)));
check(!/each/.test(line(row('A', 'tablet', 20, 1000, 2000))), 'the word "each" is not used');
check(line(row('A', 'tablet', 4, 30, 40)) === '4 tablets · cost KES 7.50 · price KES 10', 'blended batches show the average, with cents when needed');
check(line(row('A', 'ml', 3, 30, 60)) === '3 ml · cost KES 10 · price KES 20', 'short units such as ml are left alone');
check(line(row('A', 'tablets', 5, 50, 100)) === '5 tablets · cost KES 10 · price KES 20', 'a unit already plural is not doubled');
check(!/<b>/.test(line(row('A', '<b>box</b>', 2, 20, 40))), 'the unit is escaped');
check(line(row('A', 'tablet', 0, 0, 0)).indexOf('NaN') < 0 && line(row('A', 'tablet', 0, 0, 0)).indexOf('Infinity') < 0, 'zero quantity never prints NaN or Infinity');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS valuation row wording and per-unit maths');
