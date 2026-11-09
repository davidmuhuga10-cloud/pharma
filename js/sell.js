// js/sell.js - the Sell screen: search, cart, checkout, receipts, held sales.
//
// --- Sell ---

var sellFilter = '';
var heldSalesCache = [];

async function renderSell() {
  var c = $('#content');
  if (!can('sell')) { c.innerHTML = '<div class="card empty">You do not have access to Sell.</div>'; return; }
  c.innerHTML = listSkeletonHtml(6);
  try {
    var { data: stock } = await fetchAllRows(function () { return sb.from('v_drug_stock').select('*').gt('qty_in_stock', 0).order('name'); }, 'drug_id');
    STATE.drugsCache = stock || [];
    var { data: held } = await sb.from('held_sales').select('*').order('created_at', { ascending: false });
    heldSalesCache = held || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderSell');
    return;
  }
  drawSell();
}

// The search box is drawn once and never rebuilt while typing (rebuilding it
// confuses phone keyboards). Typing only refreshes the lists below it. While
// searching, matches sit directly under the box; with an empty box the full
// stock list sits below the cart.
function sellRowHtml(d) {
  return '<div class="list-row" onclick="addToCart(\'' + d.drug_id + '\')" style="cursor:pointer">' +
    '<div><div class="name">' + esc(d.name) + (isControlledDrug(d) ? ' <span class="badge bad">' + CONTROL_LABEL[d.control_class] + '</span>' : d.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + esc(qtyUnit(d.qty_in_stock, d.unit)) + ' available' + (d.default_price ? ' · ' + fmt(d.default_price) : '') + '</div></div>' +
    '<div class="right btn small secondary">Add</div></div>';
}
var SELL_ROW_CAP = 100;
function sellListsHtml() {
  var raw = sellFilter.trim(), q = raw.toLowerCase();
  var rows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1 || (d.barcode && d.barcode.indexOf(raw) !== -1); });
  // Only the first SELL_ROW_CAP rows are drawn, so thousands of products do not
  // build thousands of rows on every redraw. Typing narrows the list.
  var shown = rows.length > SELL_ROW_CAP ? rows.slice(0, SELL_ROW_CAP) : rows;
  var inner = rows.length ? shown.map(sellRowHtml).join('') +
      (rows.length > shown.length ? '<div class="empty">Showing ' + shown.length + ' of ' + rows.length + '. Type in the search box to find the rest.</div>' : '')
    : '<div class="empty">Nothing in stock matches &ldquo;' + esc(raw) + '&rdquo;. If you expected it, check Inventory: it may be out of stock or not added yet.</div>';
  var head = q ? '<div class="section-title" style="margin-top:0">' + rows.length + (rows.length === 1 ? ' match' : ' matches') + ' in stock</div>' : '';
  return { searching: !!q, html: '<div class="card">' + head + inner + '</div>' };
}
function refreshSellLists() {
  var top = $('#sellMatches'), all = $('#sellAll');
  if (!top || !all) { drawSell(); return; }
  var r = sellListsHtml();
  top.innerHTML = r.searching ? r.html : '';
  all.innerHTML = r.searching ? '' : r.html;
}
function drawSell() {
  var c = $('#content');
  var r = sellListsHtml();
  redrawKeepingFocus(c,
    (heldSalesCache.length ? heldSalesCard() : '') +
    '<div class="searchbox field" style="display:flex;gap:8px;align-items:center">' +
    '<input id="sellSearchInput" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="Search a drug…" value="' + esc(sellFilter) + '" oninput="sellFilter=this.value;refreshSellLists()" onkeydown="sellSearchKeydown(event)" style="flex:1">' +
    (barcodeCameraSupported() ? '<button class="btn secondary scan-btn" title="Scan barcode" aria-label="Scan barcode" onclick="sellScanBarcode()">' + icon('barcode', 18) + ' Scan barcode</button>' : '') +
    '</div>' +
    '<div id="sellMatches">' + (r.searching ? r.html : '') + '</div>' +
    (STATE.cart.length ? cartSummaryCard() : '') +
    '<div id="sellAll">' + (r.searching ? '' : r.html) + '</div>');
  syncCartBar();
}

function heldSalesCard() {
  return '<div class="card"><div class="section-title" style="margin-top:0">Held sales (' + heldSalesCache.length + ')</div>' +
    heldSalesCache.map(function (h) {
      var cart = h.cart || [];
      var total = cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
      return '<div class="list-row"><div><div class="name">' + esc(h.label || 'Held sale') + '</div><div class="meta">' + cart.length + (cart.length === 1 ? ' item · ' : ' items · ') + fmt(total) + ' · ' + new Date(h.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</div></div>' +
        '<div class="right" style="display:flex;gap:6px"><button class="btn small secondary" onclick="resumeHeldSale(this,\'' + h.id + '\')">Resume</button><button class="btn small danger" title="Discard" aria-label="Discard held sale" onclick="deleteHeldSale(this,\'' + h.id + '\')">' + icon('close',14) + '</button></div></div>';
    }).join('') + '</div>';
}

async function holdSale(btn) {
  if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
  var label = await askText('Hold this sale', 'Add a label if you like (optional), for example the customer\'s name or a counter number.', 'Label (optional)', 'Hold sale');
  if (label === null) return;
  label = label || null;
  act(btn, async function () {
    if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
    var { error } = await sb.from('held_sales').insert({
      pharmacy_id: STATE.profile.pharmacy_id, label: label, cart: STATE.cart, created_by: STATE.session.user.id
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    STATE.cart = [];
    toast('Sale held. Resume it any time from the Sell tab.', 'good');
    renderSell();
  });
}

async function resumeHeldSale(btn, id) {
  var h = heldSalesCache.find(function (x) { return x.id === id; });
  if (!h) return;
  if (STATE.cart.length && !(await askConfirm('Replace the cart?', 'This will replace your current cart with the held sale.', 'Continue'))) return;
  act(btn, async function () {
    STATE.cart = h.cart || [];
    await sb.from('held_sales').delete().eq('id', id);
    heldSalesCache = heldSalesCache.filter(function (x) { return x.id !== id; });
    drawSell();
  });
}

async function deleteHeldSale(btn, id) {
  if (!(await askConfirm('Discard this held sale?', 'Its items were never taken off the stock, so there is nothing to undo.', 'Discard', true))) return;
  act(btn, async function () {
    await sb.from('held_sales').delete().eq('id', id);
    heldSalesCache = heldSalesCache.filter(function (x) { return x.id !== id; });
    drawSell();
  });
}

function cartSummaryCard() {
  var total = STATE.cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  return '<div class="card"><div class="section-title" style="margin-top:0">Cart</div>' +
    STATE.cart.map(function (item, i) {
      return '<div class="cart-line"><div><div class="name">' + esc(item.name) + (isControlledDrug(item) ? ' <span class="badge bad">' + CONTROL_LABEL[item.control_class] + '</span>' : item.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + fmt(item.price) + ' each' + (item.patient_name ? ' · Patient: ' + esc(item.patient_name) : '') + '</div></div>' +
        '<div class="qty-ctrl"><button onclick="changeQty(' + i + ',-1)">−</button><span>' + item.qty + '</span><button onclick="changeQty(' + i + ',1)">+</button></div></div>';
    }).join('') +
    '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(total) + '</div></div>' +
    '<div class="toolbar-row" style="margin-top:10px"><button class="btn ghost" onclick="holdSale(this)">Hold sale</button><button class="btn primary" onclick="openCheckout()">Checkout</button></div></div>';
}

// Enter in the search box: if what's typed is exactly one drug's barcode (typed
// by hand, or a USB scanner typing fast and pressing Enter for you), add it
// straight to the cart and clear the box for the next item.
function sellSearchKeydown(e) {
  if (e.key !== 'Enter') return;
  var raw = sellFilter.trim();
  if (!raw) return;
  var d = STATE.drugsCache.find(function (x) { return x.barcode === raw; });
  if (!d) return; // not a recognised barcode - leave the normal name search showing
  e.preventDefault();
  addToCart(d.drug_id);
  sellFilter = '';
  var input = $('#sellSearchInput');
  if (input) input.value = '';
  refreshSellLists();
}

function sellScanBarcode() {
  openBarcodeScan(function (code) {
    var d = STATE.drugsCache.find(function (x) { return x.barcode === code; });
    if (d) {
      addToCart(d.drug_id);
      toast(d.name + ' added.', 'good');
    } else {
      sellFilter = code;
      var input = $('#sellSearchInput');
      if (input) input.value = code;
      refreshSellLists();
      toast('No drug in stock has that barcode.', 'bad');
    }
  });
}

function addToCart(drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  if (!d) return;
  var existing = STATE.cart.find(function (c) { return c.drug_id === drugId && !d.is_prescription; });
  if (existing) { if (existing.qty < d.qty_in_stock) existing.qty++; else toast('No more ' + d.name + ' in stock.', 'bad'); drawSell(); return; }
  if (d.is_prescription) { openRxCapture(d); return; }
  STATE.cart.push({ drug_id: drugId, name: d.name, unit: d.unit, price: d.default_price || 0, qty: 1, stock: d.qty_in_stock, is_prescription: false });
  drawSell();
}

function isControlledDrug(d) { return !!d && !!d.control_class && d.control_class !== 'none'; }
function openRxCapture(d) {
  var body = sheet('Prescription details — ' + d.name, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + (isControlledDrug(d)
      ? 'This is a controlled drug (' + CONTROL_LONG[d.control_class] + '). The patient, the prescriber and the prescription number are all recorded in its register.'
      : 'This is a prescription-only drug. Record who it is for.') + '</div>' +
    '<div class="field"><label>Patient name</label><input id="rxPatient" placeholder="Required"></div>' +
    '<div class="field"><label>Prescriber name' + (isControlledDrug(d) ? '' : ' (optional)') + '</label><input id="rxPrescriber"' + (isControlledDrug(d) ? ' placeholder="Required"' : '') + '></div>' +
    (isControlledDrug(d) ? '<div class="field"><label>Prescription number</label><input id="rxNumber" placeholder="Required"></div>' : '') +
    '<button class="btn primary" id="rxSaveBtn" onclick="confirmRxCapture(\'' + d.drug_id + '\')">Add to cart</button>';
}

function confirmRxCapture(drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  if (!d) return;
  var patient = $('#rxPatient').value.trim();
  if (!patient) { toast('Patient name is required for a prescription drug.', 'bad'); return; }
  var prescriber = $('#rxPrescriber').value.trim() || null;
  var rxNumber = $('#rxNumber') ? $('#rxNumber').value.trim() : '';
  if (isControlledDrug(d) && (!prescriber || !rxNumber)) { toast('A controlled drug needs the prescriber and the prescription number.', 'bad'); return; }
  STATE.cart.push({
    drug_id: drugId, name: d.name, unit: d.unit, price: d.default_price || 0, qty: 1, stock: d.qty_in_stock,
    is_prescription: true, patient_name: patient, prescriber_name: prescriber, rx_number: rxNumber || null,
    control_class: d.control_class || 'none'
  });
  closeSheet();
  drawSell();
}

// Cap the cart's "+" at live stock, like addToCart does, so a seller cannot go
// past the shelf and have record_sale refuse the whole sale at Confirm. Lines
// for the same drug (e.g. two prescriptions) share stock and are counted together.
function changeQty(i, delta) {
  var item = STATE.cart[i];
  if (delta > 0) {
    var live = STATE.drugsCache.find(function (x) { return x.drug_id === item.drug_id; });
    var available = Number(live ? live.qty_in_stock : item.stock);
    var inCart = STATE.cart.reduce(function (a, c) { return a + (c.drug_id === item.drug_id ? c.qty : 0); }, 0);
    if (isFinite(available) && inCart + delta > available) {
      toast('Only ' + qtyUnit(available, item.unit) + ' of ' + item.name + ' in stock.', 'bad');
      return;
    }
  }
  item.qty += delta;
  if (item.qty <= 0) STATE.cart.splice(i, 1);
  drawSell();
}

var checkoutPayments = [];
// The server's own price for the current cart (see openCheckout).
var lastQuote = null;
// Shillings taken off the whole bill, as typed ('' = none). Not per drug.
var checkoutDiscount = '';
function checkoutDiscountValue() {
  var v = parseFloat(checkoutDiscount);
  return isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
// A discount is fine when it is 0 or more and leaves something to pay.
function checkoutDiscountOk(gross) {
  var d = checkoutDiscountValue();
  return d >= 0 && d < gross;
}
function setCheckoutDiscount(v) {
  checkoutDiscount = v;
  var body = $('#checkoutBody');
  var gross = parseFloat(body.dataset.gross);
  var total = checkoutDiscountOk(gross) ? Math.round((gross - checkoutDiscountValue()) * 100) / 100 : gross;
  // The amount to collect changed, so start the payment again as one line for the new total.
  var first = checkoutPayments[0] || { method: 'mpesa', reference: '' };
  checkoutPayments = [{ method: first.method, amount: total, reference: first.reference || '' }];
  drawCheckoutPayments();
}

// The cart is priced from drugs.default_price, which record_restock sets to the
// LATEST restock price. record_sale instead charges what the batch it takes
// from (FEFO) costs, minus that batch's markdown. These differ when an older
// batch at another price is still on the shelf, or a batch is marked down, and
// then record_sale rejected the sale ("Payments do not add up to the total").
// So ask the database for the real total (quote_sale: same FEFO loop,
// read-only) and take payment against that. The cart figure stays an
// indicative shelf price.
async function openCheckout() {
  if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
  var indicative = STATE.cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  var body = sheet('Checkout', '<div class="card empty">Checking stock and prices…</div>');
  body.id = 'checkoutBody';
  lastQuote = null;
  checkoutDiscount = '';

  var items = STATE.cart.map(function (c) { return { drug_id: c.drug_id, quantity: c.qty }; });
  var quote;
  try {
    var { data, error } = await sb.rpc('quote_sale', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_items: items
    });
    if (error) throw error;
    quote = data;
  } catch (e) {
    body.innerHTML = '<div class="card empty">' + esc(friendlyError(e)) +
      '<div style="margin-top:12px"><button class="btn secondary small" onclick="openCheckout()">Try again</button></div></div>';
    return;
  }

  if (!quote || quote.ok === false) {
    var shortItem = (quote && quote.short_drug_id)
      ? STATE.cart.find(function (c) { return c.drug_id === quote.short_drug_id; })
      : null;
    body.innerHTML = '<div class="card empty">' +
      (shortItem
        ? 'Not enough ' + esc(shortItem.name) + ' left — short by ' + (quote.short_by || 0) + '. Someone may have sold it while this cart was open.'
        : 'Some of these items are no longer in stock.') +
      '<div style="margin-top:12px"><button class="btn ghost small" onclick="closeSheet()">Back to the cart</button></div></div>';
    return;
  }

  lastQuote = quote;
  var total = Math.round((Number(quote.total) || 0) * 100) / 100;
  checkoutPayments = [{ method: 'mpesa', amount: total, reference: '' }];
  checkoutCustomerId = '';
  // Saved customers for credit (kopa). If this fails, cash sales still work.
  // A copy loaded in the last minute is reused, so each checkout does not reload
  // every balance.
  try { if (Date.now() - customersLoadedAt > 60000) await loadCustomers(); } catch (e) { /* keep whatever was loaded before */ }
  body.dataset.gross = total;
  body.dataset.total = total;
  body.dataset.priceNote = Math.abs(total - indicative) > 0.01 ? '1' : '';
  var head = document.querySelector('.mask .sheet-head h2');
  if (head) head.textContent = 'Checkout — ' + fmt(total);
  drawCheckoutPayments();
}

var checkoutCustomerId = '';   // '' = walk-in, '__new' = add one now, otherwise a saved customer's id

function checkoutCreditTotal() {
  return checkoutPayments.reduce(function (a, p) { return a + (p.method === 'credit' ? (parseFloat(p.amount) || 0) : 0); }, 0);
}
function setCheckoutCustomer(v) { checkoutCustomerId = v; drawCheckoutPayments(); }

function drawCheckoutPayments() {
  var body = $('#checkoutBody');
  var gross = parseFloat(body.dataset.gross);
  var discountOk = checkoutDiscountOk(gross);
  var discount = discountOk ? checkoutDiscountValue() : 0;
  var total = Math.round((gross - discount) * 100) / 100;
  body.dataset.total = total;
  var head = document.querySelector('.mask .sheet-head h2');
  if (head) head.textContent = 'Checkout — ' + fmt(total);
  var paid = checkoutPayments.reduce(function (a, p) { return a + (parseFloat(p.amount) || 0); }, 0);
  var balance = Math.round((total - paid) * 100) / 100;
  // Typed customer details survive a redraw (the sheet is rebuilt whenever a
  // payment line changes).
  var keep = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
  var typedName = keep('pCustomer'), newName = keep('pNewName'), newPhone = keep('pNewPhone');
  var credit = checkoutCreditTotal();
  var cust = (checkoutCustomerId && checkoutCustomerId !== '__new')
    ? customersCache.find(function (x) { return x.customer_id === checkoutCustomerId; }) : null;
  var overBy = 0;
  if (credit > 0 && cust && cust.credit_limit != null) {
    overBy = Math.round((Number(cust.balance) + credit - Number(cust.credit_limit)) * 100) / 100;
  }
  var needCustomer = credit > 0 && !cust && checkoutCustomerId !== '__new';
  var custHtml =
    '<div class="field"><label>Customer' + (credit > 0 ? '' : ' (optional)') + '</label><select id="pCustSel" onchange="setCheckoutCustomer(this.value)">' +
    '<option value="">' + (credit > 0 ? 'Choose who is taking this on credit…' : 'Walk-in customer') + '</option>' +
    customersCache.filter(function (x) { return x.active; }).map(function (x) {
      return '<option value="' + x.customer_id + '"' + (x.customer_id === checkoutCustomerId ? ' selected' : '') + '>' + esc(x.name) + (Number(x.balance) > 0.5 ? ' — owes ' + fmt(x.balance) : '') + '</option>';
    }).join('') +
    '<option value="__new"' + (checkoutCustomerId === '__new' ? ' selected' : '') + '>+ New customer…</option></select></div>' +
    (!checkoutCustomerId && credit <= 0
      ? '<div class="field"><label>Customer name (optional)</label><input id="pCustomer" value="' + esc(typedName) + '"></div>' : '') +
    (checkoutCustomerId === '__new'
      ? '<div class="row-2"><div class="field"><label>Name</label><input id="pNewName" value="' + esc(newName) + '"></div>' +
        '<div class="field"><label>Phone (optional)</label><input id="pNewPhone" type="tel" value="' + esc(newPhone) + '" placeholder="07XXXXXXXX"></div></div>' : '') +
    (cust && credit > 0
      ? '<div class="tiny" style="margin-bottom:10px">Owes ' + fmt(cust.balance) + (cust.credit_limit != null ? ' · limit ' + fmt(cust.credit_limit) : ' · no limit') +
        ' · after this sale ' + fmt(Number(cust.balance) + credit) + '</div>' : '') +
    (overBy > 0.005 ? '<div class="inline-notice" style="color:var(--red)">' + icon('warn', 15) + '<span>This is ' + fmt(overBy) + ' over their credit limit. Take more cash, or ask the owner or pharmacist to raise the limit.</span></div>' : '');
  var canConfirm = balance === 0 && overBy <= 0.005 && !needCustomer && discountOk;
  redrawKeepingFocus(body,
    '<div class="field"><label for="pDiscount"' + (discountOk ? '' : ' style="color:var(--red)"') + '>Discount (KES)' + (discountOk ? '' : ' — must be less than ' + fmt(gross)) + '</label>' +
    '<input id="pDiscount" type="number" min="0" step="0.01" inputmode="decimal" value="' + esc(checkoutDiscount) + '" oninput="setCheckoutDiscount(this.value)"></div>' +
    '<div class="section-title" style="margin-top:0">Payment</div>' +
    (body.dataset.priceNote
      ? '<div class="tiny" style="margin-bottom:8px">This total is priced from the batches the sale will actually come out of — soonest expiry first, with any markdown applied — so it differs from the shelf price shown in the cart.</div>'
      : '') +
    checkoutPayments.map(function (p, i) {
      var needsRef = p.method === 'mpesa' || p.method === 'insurance' || p.method === 'bank';
      return '<div class="card" style="margin-bottom:8px">' +
        '<div class="row-2">' +
        '<div class="field" style="margin-bottom:6px"><label>Method</label><select onchange="setPaymentField(' + i + ',\'method\',this.value)">' +
        ['cash', 'mpesa', 'credit', 'insurance', 'bank', 'other'].map(function (m) {
          return '<option value="' + m + '"' + (p.method === m ? ' selected' : '') + '>' + esc(m === 'credit' ? 'Credit' : payLabel(m)) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field" style="margin-bottom:6px"><label>Amount</label><input id="pAmt' + i + '" type="number" step="0.01" value="' + p.amount + '" oninput="setPaymentField(' + i + ',\'amount\',this.value)"></div>' +
        '</div>' +
        (needsRef ? '<div class="field" style="margin-bottom:0"><label>' + (p.method === 'insurance' ? 'Scheme / member no.' : 'Reference') + '</label><input id="pRef' + i + '" value="' + esc(p.reference || '') + '" oninput="setPaymentField(' + i + ',\'reference\',this.value)"></div>' : '') +
        (checkoutPayments.length > 1 ? '<button class="btn small danger" style="margin-top:8px" onclick="removePaymentLine(' + i + ')">Remove</button>' : '') +
        '</div>';
    }).join('') +
    '<button class="btn ghost small" onclick="addPaymentLine()">+ Split into another payment method</button>' +
    '<div class="list-row"><div class="name">Balance</div><div class="name" style="color:' + (balance === 0 ? 'var(--green)' : 'var(--red)') + '">' + fmt(balance) + '</div></div>' +
    custHtml +
    '<button class="btn primary" id="pSaveBtn" ' + (canConfirm ? '' : 'disabled') + ' onclick="completeSale()">Confirm sale — ' + fmt(total) + '</button>');
}

function setPaymentField(i, field, value) {
  checkoutPayments[i][field] = field === 'amount' ? value : value;
  drawCheckoutPayments();
}

function addPaymentLine() {
  var body = $('#checkoutBody');
  var total = parseFloat(body.dataset.total);
  var paid = checkoutPayments.reduce(function (a, p) { return a + (parseFloat(p.amount) || 0); }, 0);
  checkoutPayments.push({ method: 'mpesa', amount: Math.max(0, Math.round((total - paid) * 100) / 100), reference: '' });
  drawCheckoutPayments();
}

function removePaymentLine(i) {
  checkoutPayments.splice(i, 1);
  drawCheckoutPayments();
}

async function completeSale() {
  var btn = $('#pSaveBtn');
  act(btn, async function () {
    // Re-price the receipt lines from the confirmed quote, so the receipt shows
    // what was charged (batch price with markdown), not the shelf price.
    var perDrug = {};
    if (lastQuote && lastQuote.lines) {
      lastQuote.lines.forEach(function (l) {
        var a = perDrug[l.drug_id] || { qty: 0, total: 0 };
        a.qty += Number(l.quantity) || 0;
        a.total += Number(l.line_total) || 0;
        perDrug[l.drug_id] = a;
      });
    }
    var discount = checkoutDiscountOk(parseFloat($('#checkoutBody').dataset.gross)) ? checkoutDiscountValue() : 0;
    var quotedTotal = lastQuote ? (Number(lastQuote.total) || 0) - discount : null;
    var soldItems = STATE.cart.map(function (c) {
      var a = perDrug[c.drug_id];
      return {
        drug_id: c.drug_id, name: c.name, unit: c.unit, qty: c.qty,
        price: (a && a.qty) ? a.total / a.qty : c.price,
        patient_name: c.patient_name || null, prescriber_name: c.prescriber_name || null,
        is_prescription: !!c.is_prescription
      };
    });
    var items = STATE.cart.map(function (c) {
      return { drug_id: c.drug_id, quantity: c.qty, patient_name: c.patient_name || null, prescriber_name: c.prescriber_name || null, rx_number: c.rx_number || null };
    });
    var payments = checkoutPayments.map(function (p) {
      return { method: p.method, amount: parseFloat(p.amount) || 0, reference: p.reference || null };
    });
    var customer = $('#pCustomer') ? $('#pCustomer').value.trim() || null : null;
    var customerId = (checkoutCustomerId && checkoutCustomerId !== '__new') ? checkoutCustomerId : null;
    if (checkoutCustomerId === '__new') {
      var nn = $('#pNewName') ? $('#pNewName').value.trim() : '';
      if (!nn) { toast('Enter the new customer\'s name.', 'bad'); return; }
      // Created first, so a failed sale (e.g. over the credit limit) does not make
      // the seller retype them.
      customerId = await rpcCall('save_customer', {
        p_pharmacy_id: STATE.profile.pharmacy_id, p_name: nn, p_phone: ($('#pNewPhone').value.trim() || null),
        p_credit_limit: null, p_notes: null, p_id: null, p_sms_ok: true, p_active: true
      });
      checkoutCustomerId = customerId;
      try { await loadCustomers(); } catch (e) { /* the id is what matters */ }
    }
    if (customerId) {
      var picked = customersCache.find(function (x) { return x.customer_id === customerId; });
      if (picked) customer = picked.name;
    }
    if (payments.some(function (p) { return p.method === 'credit'; }) && !customerId) { toast('Choose the customer who is taking this on credit.', 'bad'); return; }
    var insuranceLine = payments.find(function (p) { return p.method === 'insurance'; });
    var { data: saleId, error } = await sb.rpc('record_sale', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_items: items,
      p_payments: payments,
      p_customer_name: customer,
      p_insurance_scheme: insuranceLine ? insuranceLine.reference : null,
      p_customer_id: customerId,
      p_discount: discount
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    // record_sale creates the insurance claim in the same transaction, for every
    // insurance payment line. Doing it here as a second request could leave a sale
    // with no claim if the connection dropped in between.
    toast('Sale recorded.', 'good');
    customersLoadedAt = 0;   // a credit sale changes a customer's balance
    STATE.cart = [];
    var invoiceNo = null;
    try { var { data: s } = await sb.from('sales').select('invoice_number').eq('id', saleId).single(); invoiceNo = s ? s.invoice_number : null; } catch (e) {}
    showReceipt(soldItems, payments, customer, invoiceNo, quotedTotal, discount);
    lastQuote = null;
    renderSell();
  });
}

var pendingReceipt = null; // holds the last completed sale for the print button below

function showReceipt(items, payments, customer, invoiceNo, chargedTotal, discount) {
  // chargedTotal is what record_sale billed (see openCheckout). Fall back to
  // summing the lines only if it is missing.
  var total = (chargedTotal == null)
    ? items.reduce(function (a, c) { return a + c.qty * c.price; }, 0)
    : chargedTotal;
  discount = Number(discount) || 0;
  pendingReceipt = { items: items, payments: payments, customer: customer, invoiceNo: invoiceNo, total: total, discount: discount };
  var body = sheet('Sale complete' + (invoiceNo ? ' — ' + invoiceNo : ''), '');
  body.innerHTML =
    // listRow() escapes its first argument, so patient_name is passed raw here
    // (escaping twice printed an apostrophe as "&#39;").
    '<div class="card">' + items.map(function (it) {
      return listRow(it.name + (it.patient_name ? ' (' + it.patient_name + ')' : ''), it.qty + ' × ' + fmt(it.price), fmt(it.qty * it.price));
    }).join('') +
    (discount > 0 ? '<div class="list-row"><div class="name">Discount</div><div class="name">−' + fmt(discount) + '</div></div>' : '') +
    '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(total) + '</div></div></div>' +
    '<button class="btn primary" onclick="printReceipt()">' + icon('printer',15) + ' Print receipt</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="closeSheet()">Done</button>';
}

// Printed narrow, for an 80mm thermal till roll (see style.css) - one line per
// drug, qty × price under its name, running totals instead of a wide table.
// The browser's own print dialog still lets anyone print it on an ordinary
// printer instead, so nothing here needs a setting of its own.
function printReceipt() {
  var d = pendingReceipt;
  if (!d) return;
  var extra = [];
  if (d.invoiceNo) extra.push('Invoice: ' + esc(d.invoiceNo));
  if (d.customer) extra.push('Customer: ' + esc(d.customer));
  var itemsHtml = d.items.map(function (it) {
    return '<div class="r80-row"><div class="r80-name">' + esc(it.name + (it.patient_name ? ' (' + it.patient_name + ')' : '')) + '</div>' +
      '<div class="r80-sub"><span>' + it.qty + ' x ' + fmt(it.price) + '</span><span>' + fmt(it.qty * it.price) + '</span></div></div>';
  }).join('');
  var payHtml = d.payments.map(function (p) {
    return '<div class="r80-sub"><span>' + esc(payLabel(p.method)) + (p.reference ? ' (' + esc(p.reference) + ')' : '') + '</span><span>' + fmt(p.amount) + '</span></div>';
  }).join('');
  var body =
    (extra.length ? '<div class="r80-meta">' + extra.join(' · ') + '</div>' : '') +
    '<div class="r80-rule"></div>' + itemsHtml + '<div class="r80-rule"></div>' +
    (d.discount > 0 ? '<div class="r80-sub"><span>Discount</span><span>-' + fmt(d.discount) + '</span></div>' : '') +
    '<div class="r80-row r80-total r80-sub"><span>Total</span><span>' + fmt(d.total) + '</span></div>' +
    '<div class="r80-rule"></div>' + payHtml;
  printHtml('Receipt', '', body, null, { receipt: true });
}

