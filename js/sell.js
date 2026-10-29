// js/sell.js - The Sell screen: search, cart, checkout, receipts, held sales.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// SELL
// ---------------------------------------------------------------------------

var sellFilter = '';
var heldSalesCache = [];

async function renderSell() {
  var c = $('#content');
  if (!can('sell')) { c.innerHTML = '<div class="card empty">You do not have access to Sell.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading drugs…</div>';
  try {
    var { data: stock } = await sb.from('v_drug_stock').select('*').gt('qty_in_stock', 0).order('name');
    STATE.drugsCache = stock || [];
    var { data: held } = await sb.from('held_sales').select('*').order('created_at', { ascending: false });
    heldSalesCache = held || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderSell');
    return;
  }
  drawSell();
}

// The search box is drawn once and never rebuilt while typing: typing only
// refreshes the result lists beneath it (rebuilding the box on every key press
// confuses phone keyboards and can drop letters). While a search is active the
// matches sit directly under the box, above the cart, so they are always in
// view; with an empty box the full stock list sits below the cart as before.
function sellRowHtml(d) {
  return '<div class="list-row" onclick="addToCart(\'' + d.drug_id + '\')" style="cursor:pointer">' +
    '<div><div class="name">' + esc(d.name) + (isControlledDrug(d) ? ' <span class="badge bad">' + CONTROL_LABEL[d.control_class] + '</span>' : d.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + esc(qtyUnit(d.qty_in_stock, d.unit)) + ' available' + (d.default_price ? ' · ' + fmt(d.default_price) : '') + '</div></div>' +
    '<div class="right btn small secondary">Add</div></div>';
}
var SELL_ROW_CAP = 100;
function sellListsHtml() {
  var raw = sellFilter.trim(), q = raw.toLowerCase();
  var rows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
  // Only the first SELL_ROW_CAP rows are drawn: a pharmacy with thousands of
  // products would otherwise build thousands of rows on every redraw. Typing
  // narrows the list, so nothing is out of reach.
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
    '<div class="searchbox field"><input id="sellSearchInput" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="Search a drug to sell…" value="' + esc(sellFilter) + '" oninput="sellFilter=this.value;refreshSellLists()"></div>' +
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

// addToCart caps at available stock, but the cart's own "+" button did not —
// so a seller could push a line past what is on the shelf and only find out at
// Confirm, when record_sale refused the whole sale. Cap it here too, against
// the live figure rather than the one cached when the item was added. Two
// lines for the same drug (two prescriptions of one drug, say) draw on the
// same stock, so they are counted together.
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
// The server's own pricing of the current cart — see openCheckout below.
var lastQuote = null;

// The Sell screen prices a cart from drugs.default_price, which record_restock
// overwrites with the LATEST restock price. record_sale charges something
// different: whatever the batch FEFO lands on costs, with that batch's
// markdown (batches.discount_percent) applied. Those two agree only while a
// drug has exactly one batch at the current price. The moment an older batch
// is still on the shelf at a different price, or any batch is marked down, the
// client asked for payments summing to the wrong number and record_sale
// rejected the entire sale with "Payments (x) do not add up to the sale total
// (y)" — which made the markdown feature unusable and broke the ordinary
// restock-at-a-new-price case too. So: ask the database what this cart
// actually comes to (quote_sale, same FEFO loop, read-only) and collect money
// against THAT. The cart's own figure stays as the indicative shelf price.
async function openCheckout() {
  if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
  var indicative = STATE.cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  var body = sheet('Checkout', '<div class="card empty">Checking stock and prices…</div>');
  body.id = 'checkoutBody';
  lastQuote = null;

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
  checkoutPayments = [{ method: 'cash', amount: total, reference: '' }];
  checkoutCustomerId = '';
  // Saved customers, for the credit (kopa) option. If this fails the sale
  // still works for cash; only credit needs the list.
  // A copy loaded in the last minute is reused: reloading every customer's
  // balance before each checkout slowed down every sale.
  try { if (Date.now() - customersLoadedAt > 60000) await loadCustomers(); } catch (e) { /* keep whatever was loaded before */ }
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
  var total = parseFloat(body.dataset.total);
  var paid = checkoutPayments.reduce(function (a, p) { return a + (parseFloat(p.amount) || 0); }, 0);
  var balance = Math.round((total - paid) * 100) / 100;
  // What was typed in the customer boxes survives a redraw (the whole sheet
  // is rebuilt whenever a payment line changes).
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
  var canConfirm = balance === 0 && overBy <= 0.005 && !needCustomer;
  redrawKeepingFocus(body,
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
  checkoutPayments.push({ method: 'cash', amount: Math.max(0, Math.round((total - paid) * 100) / 100), reference: '' });
  drawCheckoutPayments();
}

function removePaymentLine(i) {
  checkoutPayments.splice(i, 1);
  drawCheckoutPayments();
}

async function completeSale() {
  var btn = $('#pSaveBtn');
  act(btn, async function () {
    // Re-price the receipt lines from the quote the sale was confirmed
    // against, so the printed receipt shows what was actually charged (batch
    // price with markdown) rather than the cart's indicative shelf price.
    var perDrug = {};
    if (lastQuote && lastQuote.lines) {
      lastQuote.lines.forEach(function (l) {
        var a = perDrug[l.drug_id] || { qty: 0, total: 0 };
        a.qty += Number(l.quantity) || 0;
        a.total += Number(l.line_total) || 0;
        perDrug[l.drug_id] = a;
      });
    }
    var quotedTotal = lastQuote ? Number(lastQuote.total) || 0 : null;
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
      // Created first, so a failed sale (say, over the limit) does not make
      // the seller type them in again.
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
      p_customer_id: customerId
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    // The insurance claim used to be inserted here, as a second round trip
    // after the sale had already committed — so if that call failed (dropped
    // connection at the till, tab closed) the sale stood but the claim never
    // existed and the pharmacy quietly lost money it was owed. record_sale
    // now creates it inside the same transaction, for every insurance payment
    // line rather than only the first one.
    toast('Sale recorded.', 'good');
    customersLoadedAt = 0;   // a credit sale changes a customer's balance
    STATE.cart = [];
    var invoiceNo = null;
    try { var { data: s } = await sb.from('sales').select('invoice_number').eq('id', saleId).single(); invoiceNo = s ? s.invoice_number : null; } catch (e) {}
    showReceipt(soldItems, payments, customer, invoiceNo, quotedTotal);
    lastQuote = null;
    renderSell();
  });
}

var pendingReceipt = null; // holds the last completed sale for the print button below

function showReceipt(items, payments, customer, invoiceNo, chargedTotal) {
  // chargedTotal is what record_sale actually billed (see openCheckout). Only
  // fall back to summing the lines when it isn't available.
  var total = (chargedTotal == null)
    ? items.reduce(function (a, c) { return a + c.qty * c.price; }, 0)
    : chargedTotal;
  pendingReceipt = { items: items, payments: payments, customer: customer, invoiceNo: invoiceNo, total: total };
  var body = sheet('Sale complete' + (invoiceNo ? ' — ' + invoiceNo : ''), '');
  body.innerHTML =
    // listRow() escapes its first argument, so patient_name is passed raw here
    // — it used to be esc()'d first and then escaped again, printing a
    // customer's apostrophe as "&#39;" on the screen receipt.
    '<div class="card">' + items.map(function (it) {
      return listRow(it.name + (it.patient_name ? ' (' + it.patient_name + ')' : ''), it.qty + ' × ' + fmt(it.price), fmt(it.qty * it.price));
    }).join('') + '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(total) + '</div></div></div>' +
    '<button class="btn primary" onclick="printReceipt()">' + icon('printer',15) + ' Print receipt</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="closeSheet()">Done</button>';
}

function printReceipt() {
  var d = pendingReceipt;
  if (!d) return;
  var rows = d.items.map(function (it) { return [it.name + (it.patient_name ? ' (' + it.patient_name + ')' : ''), it.qty, fmt(it.price), fmt(it.qty * it.price)]; });
  var extra = [];
  if (d.invoiceNo) extra.push('Invoice: ' + esc(d.invoiceNo));
  if (d.customer) extra.push('Customer: ' + esc(d.customer));
  // extra[] is dropped straight into the print area's HTML, so every piece of
  // it has to be escaped — the payment reference is free text a seller types
  // at checkout (M-Pesa code, scheme/member note), and was going in raw.
  extra.push('Payment: ' + d.payments.map(function (p) {
    return esc(payLabel(p.method)) + (p.reference ? ' (' + esc(p.reference) + ')' : '') + ' ' + fmt(p.amount);
  }).join(', '));
  printHtml('Receipt', new Date().toLocaleString('en-GB'),
    '<p style="margin:4px 0">' + extra.join(' · ') + '</p>' +
    tableHtml(['Item', 'Qty', 'Unit price', 'Line total'], rows) +
    '<p style="text-align:right;font-weight:700;margin-top:10px">Total: ' + fmt(d.total) + '</p>');
}

// ---------------------------------------------------------------------------
