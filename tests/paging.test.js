// Lists must not stop at 1000 rows.
// 1) fetchAllRows() really walks every page, in order, without repeats.
// 2) The big list screens use it instead of a plain query.
// 3) The supplier-order lookup sends its drug ids in small groups, newest batch first, and the newest supplier wins.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }

// --- 1) behaviour, against a fake query builder holding 2500 rows
const core = fs.readFileSync(path.join(root, 'js/core.js'), 'utf8');
const m = core.match(/async function fetchAllRows[\s\S]*?\n}\n/);
check(!!m, 'fetchAllRows exists in js/core.js');
if (m) {
  const fetchAllRows = new Function(m[0] + '; return fetchAllRows;')();
  const makeTable = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const fakeQuery = (rows, failAt) => {
    const q = { orderedBy: [] };
    q.order = (c) => { q.orderedBy.push(c); return q; };
    q.range = async (a, b) => {
      if (failAt != null && a >= failAt) return { data: null, error: { message: 'boom' } };
      return { data: rows.slice(a, b + 1), error: null };
    };
    return q;
  };
  (async () => {
    for (const n of [0, 999, 1000, 1001, 2500]) {
      let calls = 0, last;
      const r = await fetchAllRows(() => { calls++; last = fakeQuery(makeTable(n)); return last; }, 'id');
      check(!r.error && r.data.length === n, 'all ' + n + ' rows come back (got ' + (r.data && r.data.length) + ')');
      check(r.data.every((x, i) => x.id === i + 1), n + ' rows arrive in order with no repeats');
      check(last.orderedBy.indexOf('id') !== -1, 'tie-break column is applied');
      check(calls === Math.floor(n / 1000) + 1, n + ' rows take ' + (Math.floor(n / 1000) + 1) + ' requests (took ' + calls + ')');
    }
    const bad = await fetchAllRows(() => fakeQuery(makeTable(2500), 1000), 'id');
    check(bad.error && bad.data === null, 'an error on a later page is returned, not hidden');
    done();
  })();
} else done();

// --- 2) the screens that list a whole table must go through fetchAllRows
function done() {
  const LIST_SOURCES = ['v_drug_stock', 'v_customer_balances', 'v_refills', 'v_expiring_batches',
    // tables that keep growing: a stock take has a row per drug, a supplier keeps its whole history, the drug catalogue is shared
    'stock_take_items', 'master_drugs', 'supplier_lpos', 'supplier_payments', 'supplier_returns'];
  const jsDir = path.join(root, 'js');
  fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const lines = fs.readFileSync(path.join(jsDir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      LIST_SOURCES.forEach((src) => {
        if (line.indexOf(".from('" + src + "')") === -1) return;
        const single = /maybeSingle\(\)|\.single\(\)|\.eq\('(customer_id|drug_id)'/.test(line);
        const paged = line.indexOf('fetchAllRows') !== -1;
        check(single || paged, 'js/' + f + ':' + (i + 1) + ' lists ' + src + ' without fetchAllRows');
      });
    });
  });
  supplierOrderCheck().then(function () {
    console.log(failed ? failed + ' paging checks failed' : 'PASS paging: lists page past 1000 rows, big list screens use fetchAllRows, supplier order sends ids in groups');
    process.exit(failed ? 1 : 0);
  });
}

// --- 3) js/supplier-order.js: loadLastSuppliers
async function supplierOrderCheck() {
  const src = fs.readFileSync(path.join(root, 'js/supplier-order.js'), 'utf8');
  const m = src.match(/var SO_ID_CHUNK[\s\S]*?\nasync function loadLastSuppliers[\s\S]*?\n}\n/);
  check(!!m, 'js/supplier-order.js has loadLastSuppliers with SO_ID_CHUNK');
  if (!m) return;
  const core = fs.readFileSync(path.join(root, 'js/core.js'), 'utf8');
  const fa = core.match(/async function fetchAllRows[\s\S]*?\n}\n/)[0];
  const calls = [];
  // fake batches table: drug d has an old supplier "old-d" and a newer one "new-d"
  const sb = { from: () => {
    const q = { ids: null };
    q.select = () => q; q.not = () => q; q.order = () => q;
    q.in = (c, ids) => { q.ids = ids; calls.push(ids.length); return q; };
    q.range = async () => {
      const rows = [];
      q.ids.forEach((d) => { rows.push({ id: d + 'b2', drug_id: d, supplier_id: 'new-' + d }); rows.push({ id: d + 'b1', drug_id: d, supplier_id: 'old-' + d }); });
      return { data: rows, error: null };
    };
    return q;
  } };
  const load = new Function('sb', fa + m[0] + '; return loadLastSuppliers;')(sb);
  const ids = Array.from({ length: 250 }, (_, i) => 'd' + i);
  const map = await load(ids);
  check(calls.length === 3 && Math.max.apply(null, calls) <= 100, '250 ids go out in 3 groups of at most 100 (got ' + calls.join(',') + ')');
  check(Object.keys(map).length === 250 && map.d0 === 'new-d0' && map.d249 === 'new-d249', 'every drug gets its newest supplier');
  check(Object.keys(await load([])).length === 0, 'no ids, no request');
}
