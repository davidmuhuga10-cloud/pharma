// js/customers.js - Customers, credit (kopa), refills and SMS.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// CUSTOMERS, CREDIT (KOPA), REFILLS, SMS, CONTROLLED DRUGS, STOCK TAKE
// (2026-10-29 — see schema.sql section "2026-10-29 modules" and the matching
// migrations; every write below goes through a database function that checks
// the caller's role again, so the can() checks here only decide what to show.)
// ---------------------------------------------------------------------------

function rpcCall(name, args) {
  return sb.rpc(name, args).then(function (r) { if (r.error) throw r.error; return r.data; });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
// 254712345678 -> 0712 345 678
function showPhone(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (/^254[17]\d{8}$/.test(d)) d = '0' + d.slice(3);
  return d.length === 10 ? d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7) : String(p || '');
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function pharmName() { return (STATE.pharmacy && STATE.pharmacy.name) || 'our pharmacy'; }
function tabsHtml(items, current, handler) {
  return '<div class="dash-filter-row"><div class="dash-tabs">' + items.map(function (i) {
    return '<button class="dash-tab' + (current === i[0] ? ' active' : '') + '" onclick="' + handler + '(\'' + i[0] + '\')">' + i[1] + '</button>';
  }).join('') + '</div></div>';
}
function backBtn(handler, label) {
  return '<div class="toolbar-row"><button class="btn ghost small" onclick="' + handler + '">&larr; ' + esc(label) + '</button></div>';
}

// ---------------------------------------------------------------------------
// SMS — messages are written here, approved and logged by sms_queue() in the
// database, and sent by the send-sms Edge Function.
// ---------------------------------------------------------------------------

function refillMessage(r) {
  return 'Hello ' + firstName(r.customer_name) + ', your ' + r.drug_name + ' is due for refill. Please visit ' +
    pharmName() + (STATE.pharmacy && STATE.pharmacy.phone ? ' or call ' + STATE.pharmacy.phone : '') + '. Thank you.';
}
function creditMessage(name, balance) {
  return 'Hello ' + firstName(name) + ', you have an outstanding balance of ' + fmt(balance) + ' at ' + pharmName() +
    '. Kindly clear it at your earliest convenience' + (STATE.pharmacy && STATE.pharmacy.phone ? ' or call ' + STATE.pharmacy.phone : '') + '. Thank you.';
}
async function sendSms(messages) {
  var r = await sb.functions.invoke('send-sms', { body: { pharmacy_id: STATE.profile.pharmacy_id, messages: messages } });
  if (r.error) throw new Error('Could not reach the SMS service. Check your connection and try again.');
  var d = r.data || {};
  if (!d.ok) throw new Error(d.message || 'Could not send the message.');
  return d;
}
function smsOutcomeText(d) {
  var parts = [];
  if (d.sent) parts.push(d.sent + (d.sent === 1 ? ' message sent' : ' messages sent'));
  if (d.failed) parts.push(d.failed + ' failed');
  var skip = (d.skipped || []).length;
  if (skip) parts.push(skip + ' skipped (no phone, opted out, or already reminded today)');
  return parts.length ? parts.join(', ') + '.' : 'Nothing was sent.';
}
function whatsappLink(phone, text) {
  return 'https://wa.me/' + String(phone || '').replace(/\D/g, '') + '?text=' + encodeURIComponent(text);
}

// One message, shown first so the sender can read (and change) it.
function openSmsPreview(customerId, kind, refId, text, phone, name) {
  var body = sheet('Send SMS to ' + name, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:8px">To ' + esc(showPhone(phone)) + '</div>' +
    '<div class="field"><label>Message</label><textarea id="smsText" rows="5" maxlength="459" oninput="smsCount()">' + esc(text) + '</textarea>' +
    '<div class="tiny" id="smsCounter" style="margin-top:4px"></div></div>' +
    '<button class="btn primary" id="smsSendBtn" onclick="doSendOneSms(\'' + customerId + '\',\'' + kind + '\',' + (refId ? '\'' + refId + '\'' : 'null') + ')">Send SMS</button>' +
    '<a class="btn secondary" style="margin-top:8px;display:block;text-align:center;text-decoration:none" id="smsWaBtn" target="_blank" rel="noopener" href="' + esc(whatsappLink(phone, text)) + '">Send on WhatsApp instead (free)</a>';
  smsCount();
}
function smsCount() {
  var t = $('#smsText');
  if (!t) return;
  var n = t.value.length;
  var segs = n <= 160 ? 1 : Math.ceil(n / 153);
  var c = $('#smsCounter');
  if (c) c.textContent = n + ' characters · ' + segs + (segs === 1 ? ' message' : ' messages');
  var wa = $('#smsWaBtn');
  if (wa) wa.href = wa.href.split('?text=')[0] + '?text=' + encodeURIComponent(t.value);
}
function doSendOneSms(customerId, kind, refId) {
  var btn = $('#smsSendBtn');
  act(btn, async function () {
    var text = $('#smsText').value.trim();
    if (!text) { toast('Write a message first.', 'bad'); return; }
    var d = await sendSms([{ customer_id: customerId, body: text, kind: kind, ref_id: refId }]);
    closeSheet();
    toast(smsOutcomeText(d), d.sent ? 'good' : 'bad');
    refreshCustomersScreen();
  });
}
function refreshCustomersScreen() { if (STATE.tab === 'customers') renderCustomers(); }

// ---------------------------------------------------------------------------
// CUSTOMERS screen: Customers (with what they owe) | Refills | Messages
// ---------------------------------------------------------------------------

var customersCache = [];
var custTab = 'customers';
var custFilter = '';
var custOnlyOwing = false;
var custDetailId = null;
var custDetail = null;      // { row, statement, refills }
var refillsCache = [];
var refillFilter = 'due';
var smsLogCache = [];
var refillDrugNames = [];   // [{id, name}] for the refill form's suggestions

function canSeeCustomers() { return can('customers') || can('view_customers'); }

var customersLoadedAt = 0;   // when customersCache was last fetched; 0 = stale, fetch again
async function loadCustomers() {
  var r = await sb.from('v_customer_balances').select('*').order('name');
  if (r.error) throw r.error;
  customersCache = r.data || [];
  customersLoadedAt = Date.now();
}
async function loadRefills() {
  var r = await sb.from('v_refills').select('*').order('next_due');
  if (r.error) throw r.error;
  refillsCache = r.data || [];
}
async function loadSmsLog() {
  var r = await sb.from('sms_log').select('*, customers(name)').order('created_at', { ascending: false }).limit(60);
  if (r.error) throw r.error;
  smsLogCache = r.data || [];
}

async function renderCustomers() {
  var c = $('#content');
  if (!canSeeCustomers()) { c.innerHTML = '<div class="card empty">You do not have access to Customers.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading customers…</div>';
  try {
    await loadCustomers();
    if (custTab === 'refills' && !custDetailId) await loadRefills();
    if (custTab === 'messages' && !custDetailId) await loadSmsLog();
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderCustomers');
    return;
  }
  if (custDetailId) { openCustomerDetail(custDetailId); return; }
  drawCustomers();
}

function setCustTab(t) { custTab = t; custDetailId = null; renderCustomers(); }

function drawCustomers() {
  var c = $('#content');
  var dueCount = refillsCache.filter(function (r) { return Number(r.days_overdue) >= 0; }).length;
  var head = tabsHtml([['customers', 'Customers'], ['refills', 'Refills' + (custTab === 'refills' && dueCount ? ' (' + dueCount + ')' : '')],
    ['messages', 'Messages']], custTab, 'setCustTab');
  if (custTab === 'refills') c.innerHTML = head + refillsHtml();
  else if (custTab === 'messages') c.innerHTML = head + messagesHtml();
  else c.innerHTML = head + customersListHtml();
}

function balanceBadge(b) {
  b = Number(b) || 0;
  if (b > 0.5) return '<span class="badge bad">Owes ' + fmt(b) + '</span>';
  if (b < -0.5) return '<span class="badge good">Overpaid ' + fmt(-b) + '</span>';
  return '<span class="badge good">Settled</span>';
}

function customersListHtml() {
  var q = custFilter.toLowerCase();
  var rows = customersCache.filter(function (r) {
    if (!r.active && !(Number(r.balance) > 0.5)) return false;
    if (custOnlyOwing && !(Number(r.balance) > 0.5)) return false;
    return !q || String(r.name || '').toLowerCase().indexOf(q) !== -1 || String(r.phone || '').indexOf(q.replace(/\D/g, '') || '\u0000') !== -1;
  });
  var owed = customersCache.reduce(function (a, r) { return a + Math.max(0, Number(r.balance) || 0); }, 0);
  var owing = customersCache.filter(function (r) { return Number(r.balance) > 0.5; }).length;
  return '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Owed to you', fmt(owed), owed > 0.5 ? 't-red' : 't-green') +
    kpi('Customers owing', owing, 't-amber') + '</div>' +
    '<div class="searchbox field"><input id="custSearchInput" placeholder="Search by name or phone…" value="' + esc(custFilter) + '" oninput="custFilter=this.value;drawCustomersList()"></div>' +
    '<div class="toolbar-row">' +
    (can('customers') ? '<button class="btn primary" onclick="openCustomerForm()">+ New customer</button>' : '') +
    '<button class="btn ' + (custOnlyOwing ? 'secondary' : 'ghost') + '" onclick="custOnlyOwing=!custOnlyOwing;drawCustomersList()">' + (custOnlyOwing ? 'Showing owing only' : 'Owing only') + '</button>' +
    '</div><div id="custList">' + customerRowsHtml(rows) + '</div>';
}
function customerRowsHtml(rows) {
  return '<div class="card">' + (rows.length ? rows.map(function (r) {
    var meta = [r.phone ? showPhone(r.phone) : 'No phone', Number(r.balance) > 0.5 && r.last_payment_at ? 'last paid ' + fmtDate(String(r.last_payment_at).slice(0, 10)) : null].filter(Boolean).join(' · ');
    return '<div class="list-row" style="cursor:pointer" onclick="openCustomerDetail(\'' + r.customer_id + '\')">' +
      '<div style="display:flex;align-items:center;gap:12px"><div class="row-avatar ' + (Number(r.balance) > 0.5 ? 'bad' : '') + '">' + esc((r.name || '?').charAt(0).toUpperCase()) + '</div>' +
      '<div><div class="name">' + esc(r.name) + (r.active ? '' : ' <span class="badge warn">Closed</span>') + '</div><div class="meta">' + esc(meta) + '</div></div></div>' +
      '<div class="right">' + balanceBadge(r.balance) + '</div></div>';
  }).join('') : '<div class="empty">' + (customersCache.length ? 'No customers match.' : 'No customers yet. Add the people who buy on credit (kopa) or come back for regular medicine.') + '</div>') + '</div>';
}
function drawCustomersList() {
  if (custTab !== 'customers') return;
  var q = custFilter.toLowerCase();
  var rows = customersCache.filter(function (r) {
    if (!r.active && !(Number(r.balance) > 0.5)) return false;
    if (custOnlyOwing && !(Number(r.balance) > 0.5)) return false;
    return !q || String(r.name || '').toLowerCase().indexOf(q) !== -1 || String(r.phone || '').indexOf(q.replace(/\D/g, '') || '\u0000') !== -1;
  });
  var el = $('#custList');
  if (el) el.innerHTML = customerRowsHtml(rows);
  // the filter button's label changes, so redraw only that one button
  var btns = document.querySelectorAll('#content .toolbar-row .btn');
  btns.forEach(function (b) { if (/owing only/i.test(b.textContent)) { b.className = 'btn ' + (custOnlyOwing ? 'secondary' : 'ghost'); b.textContent = custOnlyOwing ? 'Showing owing only' : 'Owing only'; } });
}

// ----- add / edit a customer ------------------------------------------------

function openCustomerForm(id) {
  var cu = id ? customersCache.find(function (x) { return x.customer_id === id; }) : null;
  var canLimit = can('credit_limit');
  var body = sheet(cu ? 'Edit customer' : 'New customer', '');
  body.innerHTML =
    '<div class="field"><label>Name</label><input id="cuName" value="' + esc(cu ? cu.name : '') + '" placeholder="e.g. Jane Wanjiru"></div>' +
    '<div class="field"><label>Phone (for reminders)</label><input id="cuPhone" type="tel" value="' + esc(cu && cu.phone ? showPhone(cu.phone) : '') + '" placeholder="07XXXXXXXX"></div>' +
    (canLimit ? '<div class="field"><label>Credit limit (optional)</label><input id="cuLimit" type="number" min="0" step="1" value="' + (cu && cu.credit_limit != null ? cu.credit_limit : '') + '" placeholder="Most they can owe at once. Empty = no limit"></div>' : '') +
    '<div class="field"><label>Notes (optional)</label><input id="cuNotes" value="' + esc(cu && cu.notes ? cu.notes : '') + '" placeholder="e.g. neighbour, pays at month end"></div>' +
    '<div class="field"><label>Reminders by SMS</label><select id="cuSms"><option value="true"' + (!cu || cu.sms_ok ? ' selected' : '') + '>Allowed</option><option value="false"' + (cu && !cu.sms_ok ? ' selected' : '') + '>Never text this person</option></select></div>' +
    (cu && canLimit ? '<div class="field"><label>Account</label><select id="cuActive"><option value="true"' + (cu.active ? ' selected' : '') + '>Open</option><option value="false"' + (!cu.active ? ' selected' : '') + '>Closed (only when they owe nothing)</option></select></div>' : '') +
    '<button class="btn primary" id="cuSaveBtn" onclick="saveCustomerForm(' + (id ? '\'' + id + '\'' : 'null') + ')">Save customer</button>';
}
function saveCustomerForm(id) {
  act($('#cuSaveBtn'), async function () {
    var name = $('#cuName').value.trim();
    if (!name) { toast('Enter the customer\'s name.', 'bad'); return; }
    var limitEl = $('#cuLimit');
    var cu = id ? customersCache.find(function (x) { return x.customer_id === id; }) : null;
    var limit = limitEl ? (limitEl.value.trim() === '' ? null : Number(limitEl.value)) : (cu ? cu.credit_limit : null);
    var activeEl = $('#cuActive');
    await rpcCall('save_customer', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_name: name, p_phone: $('#cuPhone').value.trim() || null,
      p_credit_limit: limit, p_notes: $('#cuNotes').value.trim() || null, p_id: id || null,
      p_sms_ok: $('#cuSms').value === 'true', p_active: activeEl ? activeEl.value === 'true' : (cu ? cu.active : true)
    });
    closeSheet();
    toast('Customer saved.', 'good');
    if (custDetailId) openCustomerDetail(custDetailId); else renderCustomers();
  });
}

// ----- one customer: balance, payments, statement, refills -------------------

function retryCustomerDetail() { if (custDetailId) openCustomerDetail(custDetailId); }

async function openCustomerDetail(id) {
  custDetailId = id;
  STATE.tab = 'customers';
  var c = $('#content');
  if (!c) return;
  c.innerHTML = '<div class="empty">Loading customer…</div>';
  try {
    var rowRes = await sb.from('v_customer_balances').select('*').eq('customer_id', id).maybeSingle();
    if (rowRes.error) throw rowRes.error;
    if (!rowRes.data) { custDetailId = null; c.innerHTML = '<div class="card empty">Customer not found.</div>'; return; }
    var res = await Promise.all([
      rpcCall('customer_statement', { p_pharmacy_id: STATE.profile.pharmacy_id, p_customer_id: id }),
      sb.from('v_refills').select('*').eq('customer_id', id).order('next_due')
    ]);
    if (res[1].error) throw res[1].error;
    custDetail = { row: rowRes.data, statement: res[0] || [], refills: res[1].data || [] };
  } catch (e) {
    errorCard(c, friendlyError(e), 'retryCustomerDetail');
    return;
  }
  drawCustomerDetail();
}
function closeCustomerDetail() { custDetailId = null; custDetail = null; renderCustomers(); }

function drawCustomerDetail() {
  var c = $('#content');
  var d = custDetail, r = d.row;
  var bal = Number(r.balance) || 0;
  var canPay = can('customers');
  var rowsHtml = d.statement.length ? d.statement.slice().reverse().map(function (s) {
    var isPay = s.kind === 'payment';
    var label = s.kind === 'credit' ? 'On credit · ' + s.ref : s.kind === 'credit_note' ? 'Return credited' + (s.note ? ' · ' + s.note : '') : 'Payment' + (s.ref ? ' · ' + s.ref : '');
    var meta = fmtDateTime(s.entry_at) + (s.voided ? ' · reversed' + (s.note ? ': ' + s.note : '') : (isPay && s.note ? ' · ' + s.note : ''));
    return '<div class="list-row"' + (s.voided ? ' style="text-decoration:line-through"' : '') + '><div><div class="name">' + esc(label) + '</div><div class="meta">' + esc(meta) + '</div></div>' +
      '<div class="right"><div class="name" style="color:' + (s.kind === 'credit' ? 'var(--red)' : 'var(--green)') + '">' + (s.kind === 'credit' ? '+' : '−') + fmt(s.amount) + '</div>' +
      (s.voided ? '' : '<div class="meta">Balance ' + fmt(s.running) + '</div>') +
      (isPay && !s.voided && can('void') ? '<button class="btn ghost small" style="margin-top:4px" onclick="openVoidCustomerPayment(\'' + s.pay_id + '\')">Reverse</button>' : '') +
      '</div></div>';
  }).join('') : '<div class="empty">Nothing on this account yet.</div>';
  var refillsHtml = d.refills.length ? d.refills.map(function (p) { return refillRowHtml(p, false); }).join('') : '<div class="empty">No refills set up for this customer.</div>';

  c.innerHTML =
    backBtn('closeCustomerDetail()', 'All customers') +
    '<div class="card" style="margin-bottom:12px"><div class="name" style="font-size:18px;font-weight:700">' + esc(r.name) + (r.active ? '' : ' <span class="badge warn">Closed</span>') + '</div>' +
    '<div class="meta">' + esc(r.phone ? showPhone(r.phone) : 'No phone number') + (r.sms_ok ? '' : ' · no SMS') + '</div>' +
    (r.notes ? '<div class="tiny" style="margin-top:6px">' + esc(r.notes) + '</div>' : '') + '</div>' +
    '<div class="kpi-grid" style="margin-bottom:12px">' +
    kpi(bal < -0.5 ? 'Overpaid' : 'Owes now', fmt(Math.abs(bal)), bal > 0.5 ? 't-red' : 't-green') +
    kpi('Credit limit', r.credit_limit != null ? fmt(r.credit_limit) : 'No limit', 't-violet') + '</div>' +
    '<div class="toolbar-row">' +
    (canPay && bal > 0.5 ? '<button class="btn primary" onclick="openCustomerPayment()">Record payment</button>' : '') +
    (can('sms') && bal > 0.5 && r.phone && r.sms_ok ? '<button class="btn secondary" onclick="remindCustomerBalance()">Remind by SMS</button>' : '') +
    (r.phone && bal > 0.5 ? '<a class="btn ghost" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(whatsappLink(r.phone, creditMessage(r.name, bal))) + '">WhatsApp</a>' : '') +
    (canPay ? '<button class="btn ghost" onclick="openCustomerForm(\'' + r.customer_id + '\')">Edit</button>' : '') +
    '</div>' +
    '<div class="section-title">Refills' + (canPay ? ' <button class="btn secondary small" style="margin-left:8px" onclick="openRefillForm(\'' + r.customer_id + '\')">+ Add</button>' : '') + '</div>' +
    '<div class="card">' + refillsHtml + '</div>' +
    '<div class="section-title">Statement' + (d.statement.length ? ' <button class="btn ghost small" style="margin-left:8px" onclick="printCustomerStatement()">' + icon('printer', 14) + ' Print</button>' : '') + '</div>' +
    '<div class="card">' + rowsHtml + '</div>';
}

function openCustomerPayment() {
  var r = custDetail.row;
  var body = sheet('Payment from ' + r.name, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Owes ' + fmt(r.balance) + '. A payment cannot be more than that.</div>' +
    '<div class="row-2"><div class="field"><label>Amount</label><input id="cpAmount" type="number" min="1" step="0.01" value="' + Math.round(Number(r.balance) * 100) / 100 + '"></div>' +
    '<div class="field"><label>Paid by</label><select id="cpMethod"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="other">Other</option></select></div></div>' +
    '<div class="field"><label>Reference (M-Pesa code, optional)</label><input id="cpRef"></div>' +
    '<div class="field"><label>Note (optional)</label><input id="cpNote"></div>' +
    '<button class="btn primary" id="cpSaveBtn" onclick="saveCustomerPayment()">Record payment</button>';
}
function saveCustomerPayment() {
  act($('#cpSaveBtn'), async function () {
    var amount = parseFloat($('#cpAmount').value);
    if (!(amount > 0)) { toast('Enter an amount greater than zero.', 'bad'); return; }
    await rpcCall('record_customer_payment', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_customer_id: custDetail.row.customer_id, p_amount: amount,
      p_method: $('#cpMethod').value, p_reference: $('#cpRef').value.trim() || null, p_note: $('#cpNote').value.trim() || null
    });
    closeSheet();
    toast('Payment recorded.', 'good');
    openCustomerDetail(custDetailId);
  });
}
function openVoidCustomerPayment(payId) {
  var body = sheet('Reverse this payment', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Use this only for a payment entered by mistake. The debt comes back and the entry stays on the statement, marked reversed.</div>' +
    '<div class="field"><label>Reason</label><input id="vpReason" placeholder="e.g. entered twice"></div>' +
    '<button class="btn danger" id="vpSaveBtn" onclick="doVoidCustomerPayment(\'' + payId + '\')">Reverse payment</button>';
}
function doVoidCustomerPayment(payId) {
  act($('#vpSaveBtn'), async function () {
    var reason = $('#vpReason').value.trim();
    if (!reason) { toast('Give a reason.', 'bad'); return; }
    await rpcCall('void_customer_payment', { p_pharmacy_id: STATE.profile.pharmacy_id, p_payment_id: payId, p_reason: reason });
    closeSheet();
    toast('Payment reversed.', 'good');
    openCustomerDetail(custDetailId);
  });
}
function remindCustomerBalance() {
  var r = custDetail.row;
  openSmsPreview(r.customer_id, 'credit', null, creditMessage(r.name, r.balance), r.phone, r.name);
}
function printCustomerStatement() {
  var d = custDetail;
  var rows = d.statement.map(function (s) {
    return [fmtDateTime(s.entry_at), s.kind === 'credit' ? 'On credit ' + s.ref : s.kind === 'credit_note' ? 'Return credited' : 'Payment ' + (s.ref || ''),
      s.kind === 'credit' ? fmt(s.amount) : '', s.kind === 'credit' ? '' : fmt(s.amount), s.voided ? 'Reversed' : fmt(s.running)];
  });
  printHtml('Customer statement', d.row.name,
    '<p style="margin:4px 0">Balance owed: <b>' + esc(fmt(d.row.balance)) + '</b></p>' + tableHtml(['Date', 'Details', 'Credit given', 'Paid', 'Balance'], rows));
}

// ----- refills ---------------------------------------------------------------

function refillStatus(p) {
  var n = Number(p.days_overdue);
  if (n > 0) return '<span class="badge bad">' + n + (n === 1 ? ' day late' : ' days late') + '</span>';
  if (n === 0) return '<span class="badge warn">Due today</span>';
  return '<span class="badge ' + (n >= -7 ? 'warn' : 'good') + '">in ' + (-n) + (n === -1 ? ' day' : ' days') + '</span>';
}
function refillRowHtml(p, withCustomer) {
  var reminded = p.last_reminded_on ? ' · reminded ' + fmtDate(p.last_reminded_on) : '';
  var canAct = can('customers');
  var msg = refillMessage(p);
  var buttons =
    (can('sms') && p.phone && p.sms_ok ? '<button class="btn secondary small" onclick="openRefillReminder(\'' + p.plan_id + '\')">Remind</button>' : '') +
    (p.phone ? '<a class="btn ghost small" style="text-decoration:none;text-align:center" target="_blank" rel="noopener" href="' + esc(whatsappLink(p.phone, msg)) + '">WhatsApp</a>' : '') +
    (canAct ? '<button class="btn ghost small" onclick="doMarkRefilled(this,\'' + p.plan_id + '\')">Refilled</button>' +
      '<button class="btn ghost small" onclick="openRefillForm(\'' + p.customer_id + '\',\'' + p.plan_id + '\')">Edit</button>' : '');
  return '<div class="list-row" style="flex-direction:column;align-items:stretch;gap:0">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div style="min-width:0"><div class="name">' + esc(withCustomer ? p.customer_name : p.drug_name) + '</div>' +
    '<div class="meta wrap">' + esc((withCustomer ? p.drug_name + (p.qty ? ' × ' + p.qty : '') + ' · ' : 'every ' + p.interval_days + ' days · ') + (p.phone ? showPhone(p.phone) : 'no phone') + reminded) + '</div></div>' +
    '<div class="right">' + refillStatus(p) + '</div></div>' +
    (buttons ? '<div class="batch-actions">' + buttons + '</div>' : '') + '</div>';
}
function refillsHtml() {
  var f = refillFilter;
  var rows = refillsCache.filter(function (p) {
    var n = Number(p.days_overdue);
    return f === 'due' ? n >= 0 : f === 'soon' ? n < 0 && n >= -7 : true;
  });
  var dueNow = refillsCache.filter(function (p) { return Number(p.days_overdue) >= 0 && p.phone && p.sms_ok && p.last_reminded_on !== todayKe(); });
  var bulk = can('sms') && f === 'due' && dueNow.length
    ? '<button class="btn primary" onclick="openBulkRefillReminder()">Remind all due (' + dueNow.length + ')</button>' : '';
  return '<div class="tiny" style="margin-bottom:10px">People who come back for the same medicine (blood pressure, diabetes, family planning). Add a refill from a customer, or press <b>+ New refill</b>. Selling that medicine to that customer moves the date on by itself.</div>' +
    '<div class="toolbar-row">' + (can('customers') ? '<button class="btn ' + (bulk ? 'secondary' : 'primary') + '" onclick="openRefillForm()">+ New refill</button>' : '') + bulk + '</div>' +
    '<div class="dash-filter-row"><div class="dash-tabs">' + [['due', 'Due'], ['soon', 'Next 7 days'], ['all', 'All']].map(function (i) {
      return '<button class="dash-tab' + (f === i[0] ? ' active' : '') + '" onclick="refillFilter=\'' + i[0] + '\';drawCustomers()">' + i[1] + '</button>';
    }).join('') + '</div></div>' +
    '<div class="card">' + (rows.length ? rows.map(function (p) { return refillRowHtml(p, true); }).join('') :
      '<div class="empty">' + (f === 'due' ? 'Nobody is due for a refill right now.' : f === 'soon' ? 'Nobody is due in the next 7 days.' : 'No refills set up yet.') + '</div>') + '</div>';
}
function todayKe() {
  // Nairobi's date as YYYY-MM-DD, the same "today" the database uses
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function openRefillForm(customerId, planId) {
  var plan = planId ? refillsCache.concat(custDetail ? custDetail.refills : []).find(function (p) { return p.plan_id === planId; }) : null;
  var body = sheet(plan ? 'Edit refill' : 'New refill', '<div class="empty">Loading…</div>');
  try {
    if (!customersCache.length) await loadCustomers();
    if (!refillDrugNames.length) {
      var dr = await sb.from('v_drug_stock').select('drug_id,name').order('name');
      refillDrugNames = (dr.data || []).map(function (x) { return { id: x.drug_id, name: x.name }; });
    }
  } catch (e) { /* the form still works without suggestions */ }
  var custs = customersCache.filter(function (x) { return x.active; });
  var cid = plan ? plan.customer_id : customerId;
  body = $('#sheetBody');
  body.innerHTML =
    '<div class="field"><label>Customer</label><select id="rfCustomer"' + (customerId && !plan ? ' disabled' : '') + '>' +
    (cid ? '' : '<option value="">Choose a customer…</option>') +
    custs.map(function (x) { return '<option value="' + x.customer_id + '"' + (x.customer_id === cid ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>Medicine</label><input id="rfDrug" list="rfDrugList" autocomplete="off" value="' + esc(plan ? plan.drug_name : '') + '" placeholder="e.g. Amlodipine 5mg">' +
    '<datalist id="rfDrugList">' + refillDrugNames.map(function (d) { return '<option value="' + esc(d.name) + '">'; }).join('') + '</datalist></div>' +
    '<div class="row-2"><div class="field"><label>Refill every (days)</label><input id="rfDays" type="number" min="1" max="365" value="' + (plan ? plan.interval_days : 30) + '"></div>' +
    '<div class="field"><label>Quantity each time (optional)</label><input id="rfQty" type="number" min="1" value="' + (plan && plan.qty ? plan.qty : '') + '"></div></div>' +
    '<div class="field"><label>Last bought on</label><input id="rfLast" type="date" max="' + todayKe() + '" value="' + (plan ? plan.last_filled : todayKe()) + '"></div>' +
    '<div class="field"><label>Notes (optional)</label><input id="rfNotes" value="' + esc(plan && plan.notes ? plan.notes : '') + '"></div>' +
    '<button class="btn primary" id="rfSaveBtn" onclick="saveRefillForm(' + (planId ? '\'' + planId + '\'' : 'null') + ')">Save refill</button>' +
    (plan ? '<button class="btn danger" style="margin-top:8px" onclick="doStopRefill(this,\'' + planId + '\')">Stop this refill</button>' : '');
}
function saveRefillForm(planId) {
  act($('#rfSaveBtn'), async function () {
    var cid = $('#rfCustomer').value;
    var name = $('#rfDrug').value.trim();
    if (!cid) { toast('Choose the customer.', 'bad'); return; }
    if (!name) { toast('Say which medicine.', 'bad'); return; }
    var match = refillDrugNames.find(function (d) { return d.name === name; });
    await rpcCall('save_refill_plan', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_customer_id: cid, p_drug_name: name,
      p_interval_days: parseInt($('#rfDays').value, 10), p_drug_id: match ? match.id : null,
      p_last_filled: $('#rfLast').value || null, p_qty: parseInt($('#rfQty').value, 10) || null,
      p_notes: $('#rfNotes').value.trim() || null, p_id: planId || null
    });
    closeSheet();
    toast('Refill saved.', 'good');
    if (custDetailId) openCustomerDetail(custDetailId); else renderCustomers();
  });
}
function doStopRefill(btn, planId) {
  act(btn, async function () {
    await rpcCall('stop_refill_plan', { p_pharmacy_id: STATE.profile.pharmacy_id, p_plan_id: planId });
    closeSheet();
    toast('Refill stopped.', 'good');
    if (custDetailId) openCustomerDetail(custDetailId); else renderCustomers();
  });
}
function doMarkRefilled(btn, planId) {
  act(btn, async function () {
    await rpcCall('mark_refilled', { p_pharmacy_id: STATE.profile.pharmacy_id, p_plan_id: planId });
    toast('Marked as refilled today.', 'good');
    if (custDetailId) openCustomerDetail(custDetailId); else renderCustomers();
  });
}
function openRefillReminder(planId) {
  var p = refillsCache.concat(custDetail ? custDetail.refills : []).find(function (x) { return x.plan_id === planId; });
  if (!p) return;
  openSmsPreview(p.customer_id, 'refill', p.plan_id, refillMessage(p), p.phone, p.customer_name);
}
function openBulkRefillReminder() {
  var due = refillsCache.filter(function (p) { return Number(p.days_overdue) >= 0 && p.phone && p.sms_ok && p.last_reminded_on !== todayKe(); }).slice(0, 50);
  var cap = STATE.pharmacy && STATE.pharmacy.sms_daily_cap;
  var body = sheet('Remind everyone who is due', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + due.length + (due.length === 1 ? ' person' : ' people') + ' will get a message like this (their own name and medicine go in):</div>' +
    '<div class="card" style="margin-bottom:12px">' + esc(refillMessage(due[0])) + '</div>' +
    '<div class="card" style="margin-bottom:12px">' + due.map(function (p) { return listRow(p.customer_name, esc(p.drug_name), refillStatus(p)); }).join('') + '</div>' +
    (cap ? '<div class="tiny" style="margin-bottom:10px">Your pharmacy can send up to ' + cap + ' messages a day.</div>' : '') +
    '<button class="btn primary" id="bulkSendBtn" onclick="doBulkRefillReminder()">Send ' + due.length + (due.length === 1 ? ' message' : ' messages') + '</button>';
}
function doBulkRefillReminder() {
  act($('#bulkSendBtn'), async function () {
    var due = refillsCache.filter(function (p) { return Number(p.days_overdue) >= 0 && p.phone && p.sms_ok && p.last_reminded_on !== todayKe(); }).slice(0, 50);
    var d = await sendSms(due.map(function (p) { return { customer_id: p.customer_id, body: refillMessage(p), kind: 'refill', ref_id: p.plan_id }; }));
    closeSheet();
    toast(smsOutcomeText(d), d.sent ? 'good' : 'bad');
    refreshCustomersScreen();
  });
}

// ----- messages --------------------------------------------------------------

function messagesHtml() {
  var p = STATE.pharmacy || {};
  var start = todayKe();
  var usedToday = smsLogCache.filter(function (m) { return m.status !== 'failed' && String(new Date(new Date(m.created_at).getTime() + 3 * 3600 * 1000).toISOString()).slice(0, 10) === start; }).length;
  var enabled = p.sms_enabled !== false;
  var isOwner = STATE.profile.role === 'owner' || STATE.profile.role === 'co_owner';
  return '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Sent today', usedToday + (p.sms_daily_cap ? ' of ' + p.sms_daily_cap : ''), 't-sales') +
    kpi('SMS', enabled ? 'On' : 'Off', enabled ? 't-green' : 't-red') + '</div>' +
    '<div class="toolbar-row">' +
    (can('sms') && enabled ? '<button class="btn primary" onclick="openComposeSms()">+ New message</button>' : '') +
    (isOwner ? '<button class="btn ghost" onclick="toggleSmsEnabled(this)">' + (enabled ? 'Turn SMS off' : 'Turn SMS on') + '</button>' : '') + '</div>' +
    '<div class="tiny" style="margin-bottom:10px">Messages go out from the Pharma SMS service. Every message is listed here with who sent it. Customers marked "never text" are skipped.</div>' +
    '<div class="card">' + (smsLogCache.length ? smsLogCache.map(function (m) {
      var badge = m.status === 'sent' ? '<span class="badge good">Sent</span>' : m.status === 'failed' ? '<span class="badge bad">Failed</span>' : '<span class="badge warn">Waiting</span>';
      var who = (m.customers && m.customers.name) || showPhone(m.to_phone);
      return '<div class="list-row" style="align-items:flex-start"><div style="min-width:0"><div class="name">' + esc(who) + '</div>' +
        '<div class="meta wrap">' + esc(m.body) + '</div>' +
        '<div class="meta">' + esc(fmtDateTime(m.created_at) + (m.error ? ' · ' + m.error : '')) + '</div></div>' +
        '<div class="right">' + badge + '</div></div>';
    }).join('') : '<div class="empty">No messages yet.</div>') + '</div>';
}
function toggleSmsEnabled(btn) {
  act(btn, async function () {
    var on = !(STATE.pharmacy && STATE.pharmacy.sms_enabled !== false);
    await rpcCall('set_sms_enabled', { p_pharmacy_id: STATE.profile.pharmacy_id, p_enabled: on });
    STATE.pharmacy = Object.assign({}, STATE.pharmacy, { sms_enabled: on });
    saveProfileCache();
    toast(on ? 'SMS is on.' : 'SMS is off.', 'good');
    drawCustomers();
  });
}
function openComposeSms() {
  var withPhone = customersCache.filter(function (x) { return x.active && x.phone && x.sms_ok; });
  var body = sheet('New message', '');
  body.innerHTML = withPhone.length
    ? '<div class="field"><label>To</label><select id="csCustomer">' + withPhone.map(function (x) { return '<option value="' + x.customer_id + '">' + esc(x.name) + ' · ' + esc(showPhone(x.phone)) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Message</label><textarea id="smsText" rows="5" maxlength="459" oninput="smsCount()"></textarea><div class="tiny" id="smsCounter" style="margin-top:4px"></div></div>' +
      '<button class="btn primary" id="csSendBtn" onclick="doComposeSms()">Send SMS</button>'
    : '<div class="empty">No customer has a phone number that accepts messages yet.</div>';
  smsCount();
}
function doComposeSms() {
  act($('#csSendBtn'), async function () {
    var text = $('#smsText').value.trim();
    if (!text) { toast('Write a message first.', 'bad'); return; }
    var d = await sendSms([{ customer_id: $('#csCustomer').value, body: text, kind: 'custom', ref_id: null }]);
    closeSheet();
    toast(smsOutcomeText(d), d.sent ? 'good' : 'bad');
    refreshCustomersScreen();
  });
}

// ---------------------------------------------------------------------------
