// Strict Excel: a sheet with any bad row is refused as a whole, nothing is half-imported, and
// the stock sheet (download, fill, upload). Database rules are in tests/run_tests.js (section
// "Excel in and out"). Run from the project folder:   node tests/excel-sheets.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const src = read('js/import.js'), inv = read('js/inventory.js'), mig = read('migrations/2026-11-07_excel_sheets.sql'), schema = read('schema.sql');

// Run the real functions with the page's helpers stubbed out.
const shown = [];
const ctx = {
  STATE: { categoriesCache: [{ id: 'c1', name: 'Analgesics/Antipyretics' }], pharmacy: {}, profile: {} },
  sheet: () => { const b = {}; shown.push(b); return b; }, listRow: (n, m) => n + ' | ' + m, esc: s => String(s), icon: () => '', fmt: String, fmtDate: String,
  toast: () => {}, $: () => null, can: () => true, closeSheet() {}, friendlyError: e => e.message, loadXlsx: () => Promise.resolve(), btoa: s => Buffer.from(s).toString('base64'),
  encodeURIComponent, sb: {}, Date, console
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const dry = [];
ctx.dryRunImport = async (parsed) => { dry.push(parsed.length); return []; };
const map = { name: 0, category: 1, form: 2, unit: 3, qty: 4, costPrice: 5, sellPrice: 6, expiry: 7, batchNo: 8, supplier: 9 };
const problemsOf = rows => { shown.length = 0; dry.length = 0; ctx.checkImportRows(rows, map, 2); return shown.length ? shown[shown.length - 1].innerHTML : ''; };
const good = ['Panadol', 'Analgesics/Antipyretics', 'tablet', 'tablet', 100, 5, 10, '12.2099', '', ''];
const withCell = (i, v) => { const r = good.slice(); r[i] = v; return r; };

// Expiry reading
const pe = ctx.parseStrictExpiry;
check(pe('12.2099').date === '2099-12-31' && pe('31/12/2099').date === '2099-12-31' && pe('2099-12-31').date === '2099-12-31', 'expiry: 12.2099, 31/12/2099 and 2099-12-31 all read as 31 Dec 2099');
check(pe('unknown').unknown === true && pe('').error && pe('soon').error && pe('32/13/2099').error, 'expiry: UNKNOWN is allowed; empty, words and impossible dates are refused');

// Every kind of bad row stops the whole sheet
const cases = [
  ['empty drug name', withCell(0, ''), /drug name is empty/],
  ['empty unit', withCell(3, ''), /Unit is empty/],
  ['qty with words', withCell(4, '10 tabs'), /Qty must be a whole number/],
  ['qty zero', withCell(4, 0), /Qty must be a whole number/],
  ['qty decimal', withCell(4, 2.5), /Qty must be a whole number/],
  ['no sell price', withCell(6, ''), /Sell Price must be a number above 0/],
  ['sell price zero', withCell(6, 0), /Sell Price must be a number above 0/],
  ['cost not a number', withCell(5, 'abc'), /Cost Price must be a number/],
  ['sell below cost', withCell(5, 50), /lower than Cost Price/],
  ['no expiry', withCell(7, ''), /Expiry is empty/],
  ['past expiry', withCell(7, '01.2020'), /in the past/],
  ['wrong form', withCell(2, 'pill'), /Form "pill" is not one of/],
  ['unknown category', withCell(1, 'Nope'), /not one of your categories/]
];
cases.forEach(([name, row, re]) => check(re.test(problemsOf([good, row])) && dry.length === 0, 'a sheet with ' + name + ' is refused before anything is sent'));
check(/Same drug, expiry and batch as row 2/.test(problemsOf([good, good])), 'the same drug, expiry and batch twice is refused');
check(/Row 3 · /.test(problemsOf([good, withCell(4, 'x')])), 'each problem names its Excel row (header is row 1)');
check(!/skipped|Skipped/.test(src), 'the importer no longer skips rows quietly');
problemsOf([good, ['', '', '', '', '', '', '', '', '', '']]);
check(dry.length === 1 && dry[0] === 1, 'a good sheet (an empty row is ignored) goes on to the database check');

// The code paths
check(/p_dry_run: true/.test(src) && /p_strict: true/.test(src), 'the check runs on the database without saving, and the real import is strict');
const tpl = src.slice(src.indexOf("{ name: 'Stock', rows: "), src.indexOf('widths: [30'));
check(/^\{ name: 'Stock', rows: \[\[[^\[\]]*\]\],\s*$/.test(tpl) && /'Supplier'\]\]/.test(tpl), 'the blank template has the header row only, no sample row that could be imported by mistake');
check(/function downloadStockSheet/.test(src) && /function readStockSheet/.test(src) && /apply_stock_sheet/.test(src), 'the stock sheet: download, read, apply');
check(/hidden: \[0\]/.test(src) && /'Drug ID'/.test(src), 'the stock sheet carries the Drug ID in a hidden first column');
check(/Counts go into a stock take|go into a stock take/.test(src) && !/stock_take_count|approve_stock_take/.test(src), 'counts go to a stock take for approval; the sheet never approves them');
check(/onclick="openStockSheetMenu\(\)"/.test(inv), 'Inventory has the "Count / edit in Excel" button');

// Database side
check(/p_dry_run     boolean default false/.test(mig) && /p_strict      boolean default false/.test(mig), 'import_stock_rows keeps working for older app versions (extra arguments are optional)');
check(/alter table public\.price_changes enable row level security/.test(mig) && /price_changes_pharmacy_idx/.test(mig), 'price_changes has row-level security and a pharmacy index');
check(/Folded in from migrations\/2026-11-07_excel_sheets\.sql/.test(schema), 'schema.sql carries the Excel change');
if (failed) process.exit(1);
console.log('excel sheets: ok');
