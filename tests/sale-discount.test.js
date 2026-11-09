// Discount on the whole bill, and reversing a sale.
// Rules (agreed with the owner): one amount in SHILLINGS off the final bill, never per drug and
// never a percentage; no cap, no reason, no permission switch (every role can use it); it cannot
// bring the bill to zero or below; it cannot be edited after the sale; checkout starts on M-Pesa;
// a sale can be reversed (not edited) and the owner can see who reversed it and when; a seller
// can reverse their OWN sale from today, the owner and pharmacists any sale.
// The database half is exercised against the live database in a rolled-back test (see
// migrations/2026-11-09_sale_discount.sql); this file pins the pieces that live in the repo.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const mig = fs.existsSync(path.join(root, 'migrations/2026-11-09_sale_discount.sql')) ? read('migrations/2026-11-09_sale_discount.sql') : '';
const rb = fs.existsSync(path.join(root, 'migrations/2026-11-09_sale_discount.ROLLBACK_if_needed.sql')) ? read('migrations/2026-11-09_sale_discount.ROLLBACK_if_needed.sql') : '';
const schema = read('schema.sql');
const sell = read('js/sell.js');
const reports = read('js/reports.js');

// ---- the database change
check(mig.length > 0, 'migration 2026-11-09_sale_discount.sql exists');
check(rb.length > 0, 'its ROLLBACK_if_needed file exists');
check(/add column if not exists discount_amount numeric\(10,2\) not null default 0/.test(mig), 'sales.discount_amount, never null, 0 for old sales');
check(/check \(discount_amount >= 0\)/.test(mig), 'discount_amount cannot be negative');
check(/add column if not exists voided_by uuid/.test(mig), 'sales.voided_by records who reversed a sale');
check(/drop function if exists public\.record_sale\(uuid, jsonb, jsonb, text, text, uuid\)/.test(mig), 'the old 6-argument record_sale is dropped (an overload would be ambiguous for the API)');
check(/p_discount numeric DEFAULT 0/.test(mig), 'record_sale takes p_discount with a default of 0, so the previous app version keeps working');
check(/v_discount >= v_subtotal/.test(mig) && /v_discount < 0/.test(mig), 'a discount may not bring the bill to zero or below, or be negative');
check(/total_amount = v_total/.test(mig) && /vat_amount = round\(v_total/.test(mig), 'total and VAT use the discounted total, so takings and profit are right');
check(/abs\(v_payments_total - v_total\)/.test(mig), 'payments must add up to the discounted total');
check(/v_sale\.total_amount \/ v_sale\.subtotal/.test(mig), 'a return refunds the discounted share of a line');
check(/voided_by = auth\.uid\(\)/.test(mig), 'void_sale records who reversed the sale');
check(/my_role\(\) = 'attendant'/.test(mig) && /created_by is distinct from auth\.uid\(\)/.test(mig) && /today_ke\(\)/.test(mig), 'a seller may reverse only their OWN sale made TODAY');
check(/revoke all on function public\.record_sale\(uuid, jsonb, jsonb, text, text, uuid, numeric\) from public, anon/.test(mig), 'record_sale (new signature) is closed to anon');
check(/s\.discount_amount/.test(mig) && /voided_by_name/.test(mig) && /sold_by/.test(mig) && /s\.created_by/.test(mig), 'the sales report page carries the discount and who sold / reversed');
check(/drop column if exists discount_amount/.test(rb) && /drop column if exists voided_by/.test(rb), 'the rollback removes both columns');
check(/record_sale\(p_pharmacy_id uuid, p_items jsonb, p_payments jsonb, p_customer_name text DEFAULT NULL::text, p_insurance_scheme text DEFAULT NULL::text, p_customer_id uuid DEFAULT NULL::uuid\)/.test(rb), 'the rollback restores the 6-argument record_sale');
check(/-- Folded in from migrations\/2026-11-09_sale_discount\.sql/.test(schema) && /discount_amount/.test(schema.slice(schema.indexOf('-- Folded in from migrations/2026-11-09_sale_discount.sql'))), 'schema.sql carries the change under its folded-in banner');

// ---- whole shillings in the database too
const wholeMig = fs.existsSync(path.join(root, 'migrations/2026-11-09_sale_discount_whole.sql')) ? read('migrations/2026-11-09_sale_discount_whole.sql') : '';
const wholeRb = fs.existsSync(path.join(root, 'migrations/2026-11-09_sale_discount_whole.ROLLBACK_if_needed.sql')) ? read('migrations/2026-11-09_sale_discount_whole.ROLLBACK_if_needed.sql') : '';
check(/sales_discount_whole/.test(wholeMig) && /discount_amount = trunc\(discount_amount\)/.test(wholeMig), 'the database refuses a discount with cents (sales_discount_whole)');
check(/drop constraint if exists sales_discount_whole/.test(wholeRb), 'its rollback removes the constraint');
check(/-- Folded in from migrations\/2026-11-09_sale_discount_whole\.sql/.test(schema), 'schema.sql carries the whole-shilling rule under its folded-in banner');

// ---- the checkout
check(/p_discount: discount/.test(sell), 'checkout sends the discount to record_sale');
check(/id="pDiscount" type="number"/.test(sell), 'checkout has a number box for the discount');
check(/id="pDiscount"[^>]*step="1"/.test(sell) && /whole shillings/.test(sell), 'the discount box steps in whole shillings and says so when it is not');
check(/Discount \(KES\)/.test(sell) && !/Discount \(%\)|percent/i.test(sell.slice(sell.indexOf('var checkoutDiscount'), sell.indexOf('async function completeSale'))), 'the discount is typed in shillings, not as a percentage');
check(/checkoutPayments = \[\{ method: 'mpesa'/.test(sell), 'checkout starts on M-Pesa');
check(/checkoutPayments\.push\(\{ method: 'mpesa'/.test(sell), 'a split payment line also starts on M-Pesa');
check(!/method: 'cash'/.test(sell.slice(sell.indexOf('async function openCheckout'), sell.indexOf('async function completeSale'))), 'no checkout path still defaults to cash');
check(!/can\('discount'\)|canSee\('discount/.test(sell), 'no permission switch gates the discount (every role can give one)');
check(!/discount[a-z_]*Reason|reason[^\n]*discount/i.test(sell), 'no reason is asked for a discount');
check(/Discount<\/div>[^\n]*−/.test(sell) && /<span>Discount<\/span>/.test(sell), 'the receipt (screen and printed) shows the discount line');
check(/dataset\.gross/.test(sell), 'the bill before discount is kept separately from the amount to collect');

// ---- the discount rules in the browser, run for real
function pick(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  return '';
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext('var checkoutDiscount = "";\n' + pick(sell, 'checkoutDiscountValue') + '\n' + pick(sell, 'checkoutDiscountOk'), ctx);
if (typeof ctx.checkoutDiscountOk !== 'function') { check(false, 'checkoutDiscountOk / checkoutDiscountValue exist in js/sell.js'); }
else {
  function ok(v, gross) { ctx.checkoutDiscount = v; return ctx.checkoutDiscountOk(gross); }
  check(ok('', 400) === true, 'an empty discount is fine (no discount)');
  check(ok('0', 400) === true, 'a zero discount is fine');
  check(ok('7', 400) === true, '7 off 400 is fine');
  check(ok('399', 400) === true, 'up to the last whole shilling below the bill is fine');
  check(ok('10.5', 400) === false && ok('399.99', 400) === false && ok('0.1', 400) === false, 'a discount must be whole shillings: 10.5, 399.99 and 0.1 are refused');
  check(ok('10.0', 400) === true, '10.0 is the whole number 10');
  check(ok('400', 400) === false, 'a discount equal to the bill is refused');
  check(ok('450', 400) === false, 'a discount above the bill is refused');
  check(ok('-5', 400) === false, 'a negative discount is refused');
  check(ok('abc', 400) === true && ctx.checkoutDiscountValue() === 0, 'text that is not a number counts as no discount');
}

// ---- reversing a sale
check(/function canReverseSale\(s\)/.test(reports), 'reports.js decides who sees the Reverse button');
const crs = pick(reports, 'canReverseSale');
const rctx = { STATE: { profile: { id: 'u1', role: 'attendant' } }, can: (a) => false };
vm.createContext(rctx);
vm.runInContext(crs, rctx);
if (typeof rctx.canReverseSale === 'function') {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  check(rctx.canReverseSale({ created_by: 'u1', sold_at: now }) === true, 'a seller sees Reverse on their own sale from today');
  check(rctx.canReverseSale({ created_by: 'u2', sold_at: now }) === false, 'a seller does not see Reverse on someone else\'s sale');
  check(rctx.canReverseSale({ created_by: 'u1', sold_at: old }) === false, 'a seller does not see Reverse on their own older sale');
  check(rctx.canReverseSale({ created_by: 'u1', sold_at: now, voided: true }) === false, 'a reversed sale cannot be reversed again');
  rctx.can = (a) => a === 'void';
  check(rctx.canReverseSale({ created_by: 'u2', sold_at: old }) === true, 'the owner / pharmacist can reverse any sale');
}
check(/Reversed' \+ \(s\.voided_by_name \? ' by '/.test(reports) && /s\.voided_at/.test(reports), 'the sale detail shows who reversed the sale and when (the owner\'s trail)');
check(/Discount<\/div>/.test(reports) && /s\.subtotal/.test(reports), 'the sale detail shows the bill, the discount and the total');
check(/'Discount': Number\(s\.discount_amount/.test(reports), 'the Excel export carries the discount');
check(!/Void entire sale|Void this sale/.test(reports), 'the sale screens say Reverse, like the rest of the app');

// ---- where the box sits, and that checkout keeps the pop-up's side margins
const iDisc = sell.indexOf('id="pDiscount"'), iPays = sell.indexOf('checkoutPayments.map(function (p, i)'), iSplit = sell.indexOf('onclick="addPaymentLine()">+ Split');
check(iDisc > iPays && iDisc < iSplit, 'the Discount box sits under the payment lines and above "Split into another payment method" (not at the top, as if it were required)');
check(/placeholder="0"/.test(sell.slice(iDisc - 100, iDisc + 300)), 'the Discount box shows a faint 0 so it reads as optional');
const css = read('style.css');
check(/#sheetBody, body:has\(\.topbar\) #checkoutBody \{ padding: 20px; \}/.test(css), 'checkout renames its pop-up body, so the side padding rule must name #checkoutBody too (otherwise it runs edge to edge)');
// An M-Pesa reference is never required to confirm a sale.
const canLine = (sell.match(/var canConfirm = [^\n]*/) || [''])[0];
check(canLine.length > 0 && !/ref|pRef/i.test(canLine), 'Confirm does not wait for a payment reference (M-Pesa code is optional)');
check(/reference: p\.reference \|\| null/.test(sell), 'a blank reference is sent as null');

// ---- phone, tablet and the printed receipt
check(/@media \(pointer: coarse\) \{ \.qty-ctrl button \{ width: 40px; height: 40px; \}/.test(css), 'on a touch screen the cart - / + and quantity box are 40px, not 28px');
check(/\.r80-sub \{[^}]*font-size: 11px/.test(css), 'receipt lines that are not items (Discount, payments) print at the same size as the items');
check(/\.r80-sub span:last-child \{ white-space: nowrap; \}/.test(css), 'a receipt amount never wraps under its label');

// ---- typing a quantity into the cart
check(/class="qty-input" type="number"/.test(sell) && /onchange="setQty\(/.test(sell), 'each cart line has a box to type the quantity');
const sq = pick(sell, 'setQty');
if (!sq) check(false, 'setQty exists in js/sell.js');
else {
  const log = { toasts: [], draws: 0 };
  const qctx = {
    STATE: { cart: [{ drug_id: 'd1', name: 'Panadol', unit: 'tab', qty: 1, stock: 100 }, { drug_id: 'd2', name: 'Other', unit: 'tab', qty: 3, stock: 5 }], drugsCache: [{ drug_id: 'd1', qty_in_stock: 100 }, { drug_id: 'd2', qty_in_stock: 5 }] },
    toast: (m) => log.toasts.push(m), drawSell: () => { log.draws++; }, qtyUnit: (n, u) => n + ' ' + u + 's'
  };
  vm.createContext(qctx); vm.runInContext(sq, qctx);
  qctx.setQty(0, '20'); check(qctx.STATE.cart[0].qty === 20, 'typing 20 sets the quantity to 20 in one go');
  qctx.setQty(0, '500'); check(qctx.STATE.cart[0].qty === 100 && log.toasts.length === 1, 'more than the shelf holds is cut back to the stock, with a message');
  qctx.setQty(0, 'abc'); check(qctx.STATE.cart[0].qty === 100, 'text that is not a number leaves the line as it was');
  qctx.setQty(0, '-4'); check(qctx.STATE.cart[0].qty === 100, 'a negative number leaves the line as it was');
  qctx.setQty(1, '9'); check(qctx.STATE.cart[1].qty === 5, 'the cap uses the stock of that drug');
  qctx.setQty(0, '0'); check(qctx.STATE.cart.length === 1 && qctx.STATE.cart[0].drug_id === 'd2', 'typing 0 takes the line out of the cart');
}

// ---- whole-app screen check: small taps and cut-off names
check(/\.rt-wrap td select \{[^}]*min-height: 36px/.test(css), 'a dropdown inside a report table (claim status) is at least 36px tall');
check(/\.sheet \.dash-bar-label \{[^}]*white-space: normal/.test(css), 'in a full-list pop-up a long drug name wraps instead of being cut off');
check(/\.auth-forgot a \{[^}]*padding: 10px 6px; margin: -10px -6px/.test(css), '"Forgot password?" has a bigger tap area without moving anything');

console.log(failed ? failed + ' sale-discount checks failed' : 'PASS sale-discount: bill discount, M-Pesa default and sale reversal rules hold');
process.exit(failed ? 1 : 0);
