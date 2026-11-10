// Retry safety: the five writes that create money, stock or ledger rows must
// each send a request id, and must only forget it once the write SUCCEEDED.
//
// WHY THIS TEST EXISTS
// act() in js/core.js disables the button while a request is in flight, so a
// double TAP was never the problem. The problem is a lost REPLY: the sale is
// recorded, the answer never arrives, the button comes back, and the seller
// presses Complete again. Before November 2026 that recorded a second real
// sale - proved on a local copy of the database, where two identical calls
// produced 2 sales and took 6 units of stock instead of 3.
//
// The fix is an id generated once per attempt and reused across retries, which
// record_sale and friends use to recognise a repeat and return the original
// row. The database enforces it with a unique index on
// (pharmacy_id, client_request_id), so a duplicate cannot exist even if the
// browser misbehaves.
//
// This test guards the three mistakes that would quietly switch that off:
//   1. a call site that stops sending p_client_request_id at all;
//   2. an id generated INSIDE the request object (a fresh one per attempt,
//      which defeats the whole thing - every retry would look new);
//   3. an id cleared BEFORE the error check, so a retry gets a new id.
//
// Run from the project folder: node tests/retry-safety.test.js

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

// rpc name -> { file, variable }
const GUARDED = [
  { rpc: 'record_sale',             file: 'js/sell.js',          v: 'saleRequestId' },
  { rpc: 'record_customer_payment', file: 'js/customers.js',     v: 'paymentRequestId' },
  { rpc: 'record_restock',          file: 'js/stock-actions.js', v: 'restockRequestId' },
  { rpc: 'record_supplier_lpo',     file: 'js/suppliers.js',     v: 'lpoRequestId' },
  { rpc: 'record_expense',          file: 'js/expenses.js',      v: 'expenseRequestId' }
];

// The helper itself must exist and must not be reachable only through
// crypto.randomUUID (older Android WebViews do not have it).
const core = read('js/core.js');
check(/function newRequestId\s*\(/.test(core), 'newRequestId() exists in js/core.js');
check(/randomUUID/.test(core), 'newRequestId() uses crypto.randomUUID when available');
check(/Math\.random/.test(core.slice(core.indexOf('function newRequestId'))),
  'newRequestId() has a fallback for browsers without crypto.randomUUID');

for (const { rpc, file, v } of GUARDED) {
  const src = read(file);

  // 1. the call must pass the id
  const callIdx = src.indexOf("'" + rpc + "'");
  check(callIdx > -1, rpc + ' is still called from ' + file);
  if (callIdx < 0) continue;

  // the request object: from the rpc name to the closing "});"
  const tail = src.slice(callIdx);
  const endIdx = tail.indexOf('});');
  const callBlock = endIdx > -1 ? tail.slice(0, endIdx) : tail.slice(0, 1500);

  check(/p_client_request_id\s*:/.test(callBlock),
    rpc + ' (' + file + ') must send p_client_request_id, or a lost reply duplicates the write');

  check(new RegExp('p_client_request_id\\s*:\\s*' + v).test(callBlock),
    rpc + ' must pass the reused variable ' + v + ', not a fresh id. ' +
    'An id generated inline would be new on every attempt, which defeats the whole mechanism.');

  // 2. the variable must live OUTSIDE the handler, so it survives a failure
  check(new RegExp('^var ' + v + ' = null;', 'm').test(src),
    v + ' must be declared at the top level of ' + file +
    ' (a variable inside the handler is reset on every press)');

  // 3. it must be assigned only when not already set
  check(new RegExp('if \\(!' + v + '\\) ' + v + ' = newRequestId\\(\\);').test(src),
    file + ' must set ' + v + ' only when it is empty (if (!' + v + ') ...), so a retry reuses it');

  // 4. it must be cleared only on SUCCESS, never before the failure path.
  //
  // The app has two error styles and both are fine, but they have to be
  // checked differently:
  //   sb.rpc(...)   returns { data, error } -> the code tests `error` and
  //                 returns early, so the clear must come AFTER that return.
  //   rpcCall(...)  THROWS on error (see rpcCall in js/customers.js), so the
  //                 line after the await is only ever reached on success and
  //                 no early return exists to look for.
  const clearIdx = src.indexOf(v + ' = null;', src.indexOf('if (!' + v + ')'));
  check(clearIdx > -1, file + ' must clear ' + v + ' after a successful write');

  const throwsOnError = new RegExp('await rpcCall\\(\\s*[\'"]' + rpc + '[\'"]').test(src);
  if (clearIdx > -1) {
    const between = src.slice(callIdx, clearIdx);
    if (throwsOnError) {
      // nothing between the call and the clear may swallow a failure
      check(!/\.catch\(/.test(between),
        file + ' uses rpcCall (which throws on failure), so nothing between the ' +
        'call and clearing ' + v + ' may catch that error — otherwise a failed ' +
        'write would still clear the id and the retry would duplicate it.');
    } else {
      check(/return;/.test(between),
        file + ' must clear ' + v + ' only AFTER the early return on error. ' +
        'Clearing it first means the retry carries a new id and creates a duplicate.');
    }
  }
}

// The migration that adds the database half must be present, or the front-end
// sends an argument no function accepts and every one of these writes breaks.
const migDir = path.join(ROOT, 'migrations');
const migs = fs.existsSync(migDir) ? fs.readdirSync(migDir) : [];
const mig = migs.find(f => /retry_safe_writes\.sql$/.test(f));
check(!!mig, 'the migration adding p_client_request_id exists in migrations/');
if (mig) {
  const sql = read(path.join('migrations', mig));
  for (const t of ['sales', 'customer_payments', 'batches', 'supplier_lpos', 'expenses']) {
    check(new RegExp('create unique index[\\s\\S]{0,120}' + t + ' \\(pharmacy_id, client_request_id\\)').test(sql),
      'the migration puts a unique index on ' + t + ' (pharmacy_id, client_request_id) — ' +
      'this index, not the application code, is what makes a duplicate impossible');
  }
  check(/revoke all on function/.test(sql),
    'the migration revokes the default PUBLIC grant on the recreated functions ' +
    '(a freshly created function is executable by anon otherwise)');
}

if (failed) {
  console.error('\n' + failed + ' problem(s). See the comment at the top of tests/retry-safety.test.js.');
  process.exit(1);
}
console.log('PASS retry safety: all 5 money/stock writes send a reused request id and clear it only on success');
