// Printing a sale receipt sized for an 80mm thermal till roll, through the browser's own
// print dialog (same as every other report - no new hardware integration). This checks the
// CSS page size/style and the receipt body printReceipt() builds, without a browser.
// Run from the project folder:   node tests/receipt-print.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const css = read('style.css'), sw = read('sw.js');

// --- the page size hint, scoped so it never touches an ordinary report ---
check(/@page receipt80\s*\{[^}]*size:\s*80mm/.test(css), 'an 80mm page size is defined (a named page, so other reports keep their normal size)');
check(/#printArea\.print-receipt\s*\{[^}]*page:\s*receipt80/.test(css), 'only an element marked .print-receipt is sent to that page size');
check(/\.r80-sub\s*\{[^}]*display:\s*flex/.test(css), 'each receipt line lays its two halves out side by side (qty/price and the line total)');

// --- printHtml(): the .print-receipt class is opt-in and never leaks to the next print ---
function grab(file, name) {
  const src = read(file);
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in ' + file);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}

function makePrintCtx() {
  const area = { className: '', innerHTML: '' };
  const ctx = {
    console, $: sel => sel === '#printArea' ? area : null,
    esc: s => String(s == null ? '' : s), STATE: { pharmacy: { name: 'Test Pharmacy' } },
    setTimeout: () => {}, area
  };
  vm.createContext(ctx);
  vm.runInContext(grab('js/export.js', 'letterheadHtml') + '\n' + grab('js/export.js', 'setPrintPageFooter') + '\n' + grab('js/export.js', 'printHtml'), ctx);
  return ctx;
}
{
  const ctx = makePrintCtx();
  vm.runInContext("printHtml('Stock report', '', '<p>x</p>')", ctx);
  check(ctx.area.className === 'print-only', 'an ordinary report prints at normal, full-page size');
  vm.runInContext("printHtml('Receipt', '', '<p>y</p>', null, { receipt: true })", ctx);
  check(ctx.area.className === 'print-only print-receipt', 'a receipt is marked for the 80mm page size');
  vm.runInContext("printHtml('Stock report', '', '<p>z</p>')", ctx);
  check(ctx.area.className === 'print-only', 'the very next report is back to full size - the narrow receipt never leaks into it');
}

// --- printReceipt(): the body it builds for js/export.js's printHtml ---
function makeReceiptCtx(pendingReceipt) {
  let captured = null;
  const ctx = {
    console,
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmt: n => 'KES ' + Number(n || 0).toLocaleString('en-US'),
    payLabel: m => ({ cash: 'Cash', mpesa: 'M-Pesa', credit: 'Credit', insurance: 'Insurance', bank: 'Bank', other: 'Other' }[m] || m),
    printHtml: (title, subtitle, body, footNote, opts) => { captured = { title, subtitle, body, footNote, opts }; },
    pendingReceipt
  };
  vm.createContext(ctx);
  vm.runInContext(grab('js/sell.js', 'printReceipt'), ctx);
  vm.runInContext('printReceipt()', ctx);
  return { ctx, get: () => captured };
}

const sale = {
  items: [
    { name: 'Amoxil 500mg', qty: 2, price: 50, patient_name: 'Jane' },
    { name: 'Panadol', qty: 1, price: 20 }
  ],
  payments: [{ method: 'cash', amount: 100 }, { method: 'mpesa', amount: 20, reference: 'QX1' }],
  customer: 'Jane Doe', invoiceNo: 'INV-5', total: 120
};
const { get } = makeReceiptCtx(sale);
const out = get();
check(!!out && out.opts && out.opts.receipt === true, 'the sale receipt always prints at the 80mm size, never the full page');
check(/r80-row/.test(out.body) && /r80-rule/.test(out.body), 'each item is its own narrow row, with dashed rules instead of a wide table');
check(/Amoxil 500mg \(Jane\)/.test(out.body), 'a prescription line still names the patient');
check(/2 x KES 50/.test(out.body) && /KES 100/.test(out.body), 'quantity and line total are both shown');
check(/Total<\/span><span>KES 120/.test(out.body), 'the printed total is what record_sale actually charged, not a re-added guess');
check(/Invoice: INV-5/.test(out.body) && /Customer: Jane Doe/.test(out.body), 'the invoice number and customer still appear');
check(/Cash/.test(out.body) && /M-Pesa \(QX1\)/.test(out.body), 'every payment line, with its reference, is printed');
check(!/<table/.test(out.body), 'no wide table - it would not fit on an 80mm roll');

// a walk-in cash sale with nothing extra still prints cleanly
const plain = { items: [{ name: 'Panadol', qty: 1, price: 20 }], payments: [{ method: 'cash', amount: 20 }], customer: null, invoiceNo: null, total: 20 };
const { get: get2 } = makeReceiptCtx(plain);
const out2 = get2();
check(!/Invoice:/.test(out2.body) && !/Customer:/.test(out2.body), 'a walk-in sale with no invoice number shows neither line, instead of a blank one');

// nothing pending: printReceipt must not throw or print a blank receipt
{
  let threw = false;
  try { makeReceiptCtx(null); } catch (e) { threw = true; }
  check(!threw, 'calling print with nothing pending does nothing, rather than erroring');
}

// --- offline shell: nothing new to pre-cache (style.css, js/export.js and js/sell.js already are) ---
check(/style\.css/.test(sw) && /js\/export\.js/.test(sw) && /js\/sell\.js/.test(sw), 'the files this feature touches are already in the offline shell');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS 80mm receipt printing: page size, class toggle, receipt body');
