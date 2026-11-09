// "View cart" before payment, and number fields that the mouse wheel cannot change.
// Owner-approved from a sketch, 10 Nov 2026. A seller could not see the drugs while paying, and
// could not remove one, because the blue bar went straight to the payment screen. Now:
//   blue bar "View cart ->" opens a cart pop-up (qty, Remove, total, Continue to payment, Hold sale);
//   the payment pop-up has a "Back to cart" link; Balance only shows for a split or a short payment.
// Separately, scrolling the mouse wheel over a focused number box nudged it (49.95 appeared in an
// Amount box); every number box now lets go of focus when the wheel turns over it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
const sell = read('js/sell.js'), shell = read('js/shell.js'), core = read('js/core.js'), css = read('style.css'), sw = read('sw.js');
function pick(src, name) {
  const i = Math.max(src.indexOf('async function ' + name + '('), src.indexOf('function ' + name + '('));
  if (i < 0) return '';
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  return '';
}

// ---- the blue bar
const fab = pick(shell, 'cartFab');
check(/onclick="viewCart\(\)"/.test(fab), 'the blue bar opens the cart (viewCart), not the payment screen');
check(/View cart/.test(fab) && !/Checkout/.test(fab), 'the blue bar says "View cart", not "Checkout"');

// ---- the cart pop-up
const view = pick(sell, 'viewCart'), draw = pick(sell, 'drawCartSheet'), line = pick(sell, 'cartLineHtml');
check(view.length > 0 && draw.length > 0 && line.length > 0, 'viewCart, drawCartSheet and cartLineHtml exist in js/sell.js');
check(/sheet\('Cart/.test(view), 'viewCart opens a pop-up called Cart');
check(/id\s*=\s*'cartBody'/.test(view), 'the cart pop-up body can be found again (cartBody), so it redraws when a quantity changes');
check(/removeFromCart\(/.test(line), 'every cart line has a Remove button');
check(/changeQty\(/.test(line) && /setQty\(/.test(line), 'every cart line keeps the - / + buttons and the typed quantity');
check(/Continue to payment/.test(draw) && /openCheckout\(\)/.test(draw), 'the cart pop-up has "Continue to payment" that opens payment');
check(/holdSale\(/.test(draw), 'the cart pop-up has Hold sale');
check(/Total/.test(draw), 'the cart pop-up shows the total');
check(/cartLineHtml/.test(pick(sell, 'cartSummaryCard')), 'the cart card on the Sell screen uses the same lines, so it also gets Remove');
check(/drawCartSheet\(\)/.test(pick(sell, 'drawSell')), 'changing the cart redraws the pop-up if it is open');
check(/closeSheet\(\)/.test(pick(sell, 'removeFromCart')) || /closeSheet\(\)/.test(pick(sell, 'drawCartSheet')), 'removing the last drug closes the empty cart pop-up');
check(/closeSheet\(\)/.test(pick(sell, 'holdSale')), 'holding the sale closes the cart pop-up');

// ---- the payment pop-up
const oc = pick(sell, 'openCheckout'), dp = pick(sell, 'drawCheckoutPayments');
check(/Back to cart/.test(dp) && /viewCart\(\)/.test(dp), 'the payment pop-up has a "Back to cart" link');
check(/Payment — /.test(oc) && /Payment — /.test(dp) && !/Checkout — /.test(oc + dp), 'the payment pop-up is titled "Payment", the word Checkout is gone');
check(/viewCart\(\)/.test(oc), 'if stock ran short, the message sends you back to the cart');
const balanceAt = dp.indexOf('>Balance<');
check(balanceAt > 0, 'the Balance row is still there');
const before = dp.slice(Math.max(0, balanceAt - 260), balanceAt);
check(/checkoutPayments\.length\s*>\s*1/.test(before) && /balance\s*!==\s*0/.test(before), 'Balance only shows for a split payment or when the amount is short');

// ---- removing a drug, run for real
const ctx = { STATE: { cart: [{ drug_id: 'a', qty: 2 }, { drug_id: 'b', qty: 1 }, { drug_id: 'c', qty: 5 }] }, drew: 0, toasts: [] };
ctx.drawSell = function () { ctx.drew++; };
vm.createContext(ctx);
vm.runInContext(pick(sell, 'removeFromCart'), ctx);
if (typeof ctx.removeFromCart !== 'function') check(false, 'removeFromCart exists');
else {
  ctx.removeFromCart(1);
  check(ctx.STATE.cart.map(c => c.drug_id).join() === 'a,c', 'Remove takes out exactly that drug, whatever its quantity');
  check(ctx.drew === 1, 'the screen is redrawn after Remove');
  ctx.removeFromCart(9);
  check(ctx.STATE.cart.length === 2, 'a Remove on a line that is gone changes nothing');
}

// ---- mouse wheel over a number box
check(/addEventListener\('wheel'/.test(core), 'core.js listens for the mouse wheel');
const lis = [];
const wctx = { document: { activeElement: null, addEventListener: function (t, f, o) { lis.push({ t: t, f: f, o: o }); } } };
vm.createContext(wctx);
const m = core.match(/\/\/ WHEEL-GUARD-START[\s\S]*?\/\/ WHEEL-GUARD-END/);
check(!!m, 'the wheel guard is marked WHEEL-GUARD-START / WHEEL-GUARD-END in core.js');
if (m) {
  vm.runInContext(m[0], wctx);
  const w = lis.find(l => l.t === 'wheel');
  check(!!w, 'the guard registers a wheel listener on the document');
  if (w) {
    check(!(w.o && w.o.passive === false), 'the listener is passive, so the page still scrolls');
    function spin(type, focused) {
      const el = { tagName: 'INPUT', type: type, blurred: false, blur: function () { this.blurred = true; } };
      wctx.document.activeElement = focused ? el : { tagName: 'DIV' };
      w.f({ target: el });
      return el.blurred;
    }
    check(spin('number', true) === true, 'wheel over the focused number box lets go of it, so the value cannot change');
    check(spin('number', false) === false, 'wheel over a number box that is not focused does nothing');
    check(spin('text', true) === false, 'a text box is left alone');
    w.f({ target: null }); w.f({ target: { tagName: 'DIV' } });
  }
}

// ---- style and cache
check(/\.cart-line[^{]*\.remove|\.cart-remove/.test(css), 'style.css styles the Remove button on a cart line');
const ver = (sw.match(/CACHE_NAME\s*=\s*'hodhi-shell-v(\w+)'/) || [])[1] || '';
check(ver >= '4m' && ver.length === 2, 'sw.js cache name moved on to v4m or later so phones pick up the new screens (now v' + ver + ')');

if (failed) { console.log('view-cart: ' + failed + ' FAILED'); process.exit(1); }
console.log('view-cart: all checks PASS');
