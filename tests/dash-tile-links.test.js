// The 4 dashboard stat tiles (Sales, Profit, Stock value, Debt owed) tap through to
// the detailed, printable/Excel-able screen that already covers each one, instead of
// sitting there as numbers only. Checked at the source level (no browser needed), the
// same way tests/dashboard-chart.test.js checks dashboard.js. Run from the project folder:
//   node tests/dash-tile-links.test.js
const fs = require('fs'), path = require('path');
const dash = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

// --- each tile names a click handler, and every handler it names is actually defined ---
// A tile only taps through when the person may open that screen: click: canSee(...) ? 'handler' : null.
const clicks = [...dash.matchAll(/\?\s*'(dashGo\w+)'\s*:\s*null/g)].map((m) => m[1]);
check(clicks.length === 4, 'all 4 stat tiles (Sales, Profit, Stock value, Debt owed) name a click handler');
check(clicks[0] === 'dashGoSales' && clicks[1] === 'dashGoSales', 'Sales and Profit both go to the Sales Report (the only sales detail there is - profit is not broken out sale by sale)');
check(clicks[2] === 'dashGoStockValue', 'Stock value goes to its own Stock Valuation Report');
check(clicks[3] === 'dashGoDebtOwed', 'Debt owed goes to the Suppliers list (its balances, not a dated report)');
for (const name of clicks) {
  check(new RegExp('function ' + name + '\\s*\\(').test(dash), name + '() is actually defined, not just named');
}

// --- the handlers call the right, already-existing navigation ---
check(/function dashGoSales\(\)\s*\{\s*goReport\('sales'\);\s*\}/.test(dash), "dashGoSales() calls goReport('sales') - the existing Sales Report screen");
check(/function dashGoStockValue\(\)\s*\{\s*goReport\('valuation'\);\s*\}/.test(dash), "dashGoStockValue() calls goReport('valuation') - the existing Stock Valuation Report");
check(/function dashGoDebtOwed\(\).*setTab\('suppliers'\)/.test(dash), "dashGoDebtOwed() calls setTab('suppliers')");
check(/function dashGoDebtOwed\(\)\s*\{\s*if\s*\(!veilBusy\)/.test(dash), 'Debt owed guards against double-navigating while something else is loading, same as every other nav click in the app');

// --- the markup: every tile is marked clickable and wired to its handler, with keyboard/role hints ---
const tileHtml = (dash.match(/return tiles\.map\(function \(p\) \{[\s\S]*?\}\)\.join\(''\);/) || [''])[0];
check(/class="dash-stat'/.test(tileHtml) && /clickable"/.test(tileHtml), 'each tile carries the clickable class (for the hover/press styling)');
check(/onclick="'\s*\+\s*p\.click\s*\+\s*'\(\)"/.test(tileHtml), "each tile's onclick calls its own handler (p.click)");
check(/role="button"/.test(tileHtml) && /tabindex="0/.test(tileHtml), 'each tile is reachable and announced as a button, not just a styled div (role/tabindex)');

// --- styling: a clickable tile looks pressable, same recipe as the Reports hub tiles ---
check(/\.dash-stat\.clickable\s*\{[^}]*cursor:\s*pointer/.test(css), 'a clickable tile shows a pointer cursor');
check(/\.dash-stat\.clickable:hover\s*\{[^}]*box-shadow/.test(css), 'a clickable tile lifts slightly on hover, like the Reports hub tiles');
check(/\.dash-stat\.clickable:active\s*\{[^}]*scale\(0\.98\)/.test(css), 'a clickable tile presses down slightly on tap, like every other button');

// --- the destinations themselves already exist and already have Excel/Print (browser "Save as PDF") ---
const reports = fs.readFileSync(path.join(__dirname, '..', 'js', 'reports.js'), 'utf8');
check(/function goReport\(view\)/.test(fs.readFileSync(path.join(__dirname, '..', 'js', 'shell.js'), 'utf8')), 'goReport() already exists (used elsewhere by the side menu) - nothing new had to be invented for navigation');
check(/view:\s*'sales'/.test(reports) && /exportReportExcel/.test(reports) && /printReport/.test(reports), "the Sales Report tile lands on has its own Excel export and Print (the browser's own 'Save as PDF' is one of the destinations in that dialog, same as every other report in this app)");
check(/view:\s*'valuation'/.test(reports) && /exportValuationReportExcel/.test(reports) && /printValuationReport/.test(reports), 'the Stock Valuation Report has the same Excel/Print pair');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS dashboard tile links: Sales, Profit, Stock value, Debt owed all tap through, styled as pressable, to a screen that already has Excel + Print/PDF');
