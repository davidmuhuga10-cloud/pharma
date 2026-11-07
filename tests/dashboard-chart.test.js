// The Sales graph sits on a green card, so its line must not be green. This checks that the
// line uses its own dark navy colour and that it differs from the green card. Run from the
// project folder:
//   node tests/dashboard-chart.test.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const line = (src.match(/salesLine:\s*'(#[0-9A-Fa-f]{6})'/) || [])[1];
const green = (src.match(/\bsales:\s*'(#[0-9A-Fa-f]{6})'/) || [])[1];
check(!!line, 'DCOLOR.salesLine is defined');
check(!!green && line !== green, 'the line colour differs from the green card colour');
const call = (src.match(/axisLineChart\(values, labels, dashChartW\(\)[^;]*isEmpty\)/) || [''])[0];
check(/DCOLOR\.salesLine/.test(call), 'the Sales graph draws its line with DCOLOR.salesLine');
check(!/DCOLOR\.sales\b(?!Line)/.test(call), 'the Sales graph line is not drawn in the card green');
if (failed) process.exit(1);
console.log('dashboard chart: ok');
