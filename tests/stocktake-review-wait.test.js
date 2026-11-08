// Stock take: "Review & approve" tapped right after typing the last count used to say
// "Nothing has been counted yet", because that count was still being saved in the
// background. The review now waits for pending saves ("Please wait...") and then shows
// the real result. Run from the project folder:   node tests/stocktake-review-wait.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'controlled-stocktake.js'), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

(async () => {
  const body = { innerHTML: '' };
  let finishSave;
  const ctx = {
    console, setTimeout, Promise, Object, Number, isFinite, Math,
    esc: s => String(s), fmt: n => 'KES ' + n, kpi: () => '', can: () => true, toast: () => {},
    sheet: () => body, friendlyError: e => String(e), document: { getElementById: () => null },
    STATE: { profile: { pharmacy_id: 'p' } },
    rpcCall: () => new Promise(res => { finishSave = () => res({ system_qty: 10, counted_qty: 7 }); })
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext("stOpen = { id: 't1' }; stDrugs = [{ drug_id: 'd1', name: 'Amoxil', unit: 'tablet', qty_in_stock: 10, qty_expired: 0, stock_value_cost: 100 }];", ctx);

  // the person types a count, then taps Review before the save has come back
  vm.runInContext("stCount('d1', { value: '7' })", ctx);
  const review = vm.runInContext('openStockTakeReview()', ctx);
  await Promise.resolve();
  check(/Please wait/.test(body.innerHTML), 'while the last count is saving, the review says "Please wait"');
  check(!/Nothing has been counted/.test(body.innerHTML), 'it does not claim nothing was counted while a save is running');
  finishSave();
  await review;
  check(!/Nothing has been counted/.test(body.innerHTML), 'once the save is done the review shows the counted drug');
  check(/Amoxil/.test(body.innerHTML), 'the drug that was just counted is in the review');

  // and when truly nothing was counted, it still says so
  vm.runInContext('stItems = {}', ctx);
  await vm.runInContext('openStockTakeReview()', ctx);
  check(/Nothing has been counted yet/.test(body.innerHTML), 'with no counts at all the review still says so');

  if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
  console.log('PASS stock take review waits for the last count to save');
})();
