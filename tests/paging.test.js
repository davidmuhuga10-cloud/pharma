// Lists must not stop at 1000 rows.
// 1) fetchAllRows() really walks every page, in order, without repeats.
// 2) The big list screens use it instead of a plain query.
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
  const LIST_SOURCES = ['v_drug_stock', 'v_customer_balances', 'v_refills', 'v_expiring_batches'];
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
  console.log(failed ? failed + ' paging checks failed' : 'PASS paging: lists page past 1000 rows, big list screens use fetchAllRows');
  process.exit(failed ? 1 : 0);
}
