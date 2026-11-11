// A report/inventory table must never silently clip its right-hand columns.
//
// WHY: .rt-wrap used overflow:hidden. With a long drug name plus no-wrap number
// columns, the table at 860px (where the sidebar appears and the content area
// suddenly narrows) was ~32px wider than its box, and the last column was cut
// off with no way to reach it. Found by measuring at real widths, not by eye.
// overflow-x:auto keeps the rounded corners and makes the table scroll instead.
const fs = require('fs');
const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
const m = css.match(/\.rt-wrap\s*\{([^}]*)\}/);
let fail = 0;
function check(ok, msg) { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; }
check(!!m, '.rt-wrap rule exists');
const body = m ? m[1] : '';
check(!/overflow\s*:\s*hidden/.test(body), '.rt-wrap does not use overflow:hidden (it clips columns)');
check(/overflow-x\s*:\s*auto/.test(body), '.rt-wrap scrolls sideways (overflow-x:auto)');
process.exit(fail ? 1 : 0);
