// js/expenses.js - the Expenses ledger.
//
// --- Expenses ---
// General pharmacy costs (rent, utilities, salaries, transport, licences,
// marketing, maintenance, supplies, other), separate from Suppliers, which is
// about drug deliveries and supplier debt. Same Today/Week/Month/Year filter as
// the dashboard, applied in the browser to one fetch (one pharmacy's expenses
// are few). Voiding is a soft delete, like void_sale (schema.sql).

var expRange = 'month';   // 'today' | 'week' | 'month' | 'year' | 'custom'
var expFrom = '';         // custom range, 'YYYY-MM-DD'
var expTo = '';
var expPage = 1;
var expensesAllCache = [];  // this year's expenses (including voided), newest first; filtered by expRange
var EXP_CATEGORY_LABELS = {
  rent: 'Rent', utilities: 'Utilities', salaries: 'Salaries', transport: 'Transport',
  licenses: 'Licenses & permits', marketing: 'Marketing', maintenance: 'Maintenance & repairs',
  supplies: 'Supplies', other: 'Other'
};

async function renderExpenses() {
  var c = $('#content');
  if (!can('expenses') && !can('view_expenses')) { c.innerHTML = '<div class="card empty">You do not have access to Expenses.</div>'; return; }
  c.innerHTML = listSkeletonHtml(6);
  try {
    // This year is loaded; a custom range loads exactly the dates asked for (any year).
    var yearStart = new Date().getFullYear() + '-01-01';
    var custom = expRange === 'custom';
    var { data, error } = await fetchAllRows(function () {
      var q = sb.from('expenses').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id)
        .gte('expense_date', custom ? expFrom : yearStart);
      if (custom) q = q.lte('expense_date', expTo);
      return q.order('expense_date', { ascending: false }).order('created_at', { ascending: false });
    }, 'id');
    if (error) throw error;
    expensesAllCache = data || [];
    expPage = 1;
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderExpenses');
    return;
  }
  drawExpensesList();
}

function expRangeStart(r) {
  var now = new Date();
  if (r === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (r === 'week') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  if (r === 'year') return new Date(now.getFullYear(), 0, 1);
  return new Date(now.getFullYear(), now.getMonth(), 1);  // month (default)
}

function setExpRange(r) {
  if (r === expRange) return;
  var wasCustom = expRange === 'custom';
  expRange = r;
  expPage = 1;
  if (wasCustom) renderExpenses(); else drawExpensesList();   // a custom range loaded other dates; go back to this year's
}
function applyExpRange() {
  var r = rangeBarRead(), err = rangeError(r.from, r.to);
  if (err) { toast(err, 'bad'); return; }
  expFrom = r.from; expTo = r.to; expRange = 'custom';
  renderExpenses();
}
function goExpPage(p) { expPage = p; drawExpensesList(); }

function expRangeLabel() {
  if (expRange === 'custom') return fmtDate(expFrom) + ' to ' + fmtDate(expTo);
  return DASH_PERIOD_LABEL[expRange];
}

// The expenses of the chosen range, reversed ones included (they show in red text).
function expInRange() {
  if (expRange === 'custom') return expensesAllCache.filter(function (e) { return e.expense_date >= expFrom && e.expense_date <= expTo; });
  var rs = expRangeStart(expRange);  // local date, not toISOString(): in Nairobi that rolled back a day
  var startStr = rs.getFullYear() + '-' + String(rs.getMonth() + 1).padStart(2, '0') + '-' + String(rs.getDate()).padStart(2, '0');
  return expensesAllCache.filter(function (e) { return e.expense_date >= startStr; });
}

var EXP_COLS = ['Date', 'Description', 'Category', 'Method', 'Amount', 'Status'];
function expenseCells(e) {
  return [fmtDate(e.expense_date), e.description, expenseCategoryLabel(e.category), supplierPaymentMethodLabel(e.method), fmt(e.amount),
    e.voided ? stCell('Reversed', 'bad') : stCell('Recorded', 'ok')];
}

function drawExpensesList() {
  var c = $('#content');
  var inRange = expInRange();
  var active = inRange.filter(function (e) { return !e.voided; });
  var total = active.reduce(function (a, e) { return a + Number(e.amount || 0); }, 0);

  var byCategory = {};
  active.forEach(function (e) { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0); });
  var catRows = Object.keys(byCategory).map(function (k) { return { cat: k, total: byCategory[k] }; })
    .sort(function (a, b) { return b.total - a.total; });

  var pg = pageSlice(inRange, expPage);
  expPage = pg.page;
  var rows = pg.rows.map(expenseCells);
  // Reverse sits in its own last column on screen only (it never prints).
  var canReverse = can('expenses');
  var cols = EXP_COLS.concat(canReverse ? ['Action'] : []);
  if (canReverse) rows = rows.map(function (r, i) {
    var e = pg.rows[i];
    return r.concat([{ html: !e.voided ? '<button class="btn danger small" onclick="event.stopPropagation();openReverseExpense(\'' + esc(e.id) + '\')">Reverse</button>' : '' }]);
  });

  c.innerHTML =
    (can('expenses') ? '<div class="toolbar-row"><button class="btn primary" onclick="openAddExpense()">+ New expense</button></div>' : '') +
    reportHeadHtml('Expenses', 'exportExpensesExcel', 'printExpenses') +
    rangeBarHtml({ presets: ['today', 'week', 'month', 'year'].map(function (r) { return { key: r, label: DASH_RANGE_LABELS[r] }; }),
      active: expRange, from: expFrom, to: expTo, pickFn: 'setExpRange', applyFn: 'applyExpRange' }) +
    '<div class="kpi-grid" style="margin-bottom:14px">' +
      kpi('Total spent', fmt(total), 't-red') +
      kpi('Entries', active.length, 't-violet') +
    '</div>' +
    '<div class="section-title">By category</div>' +
    rtTable(['Category', 'Total'], catRows.map(function (r) { return [expenseCategoryLabel(r.cat), fmt(r.total)]; }), { empty: 'No expenses recorded yet for this period.' }) +
    '<div class="section-title">All expenses · ' + esc(expRangeLabel()) + '</div>' +
    showingHtml(pg) +
    rtTable(cols, rows, { empty: 'No expenses recorded yet for this period.', num: cols.map(function (h) { return h === 'Amount'; }) }) +
    pagerHtml(pg, 'goExpPage');
}

// Print and Excel carry every expense of the range, not just the page on screen.
function printExpenses() {
  var list = expInRange();
  var total = list.filter(function (e) { return !e.voided; }).reduce(function (a, e) { return a + Number(e.amount || 0); }, 0);
  printHtml('Expenses Report', expRangeLabel(), tableHtml(EXP_COLS, list.map(expenseCells), 'Total spent: ' + fmt(total) + ' (reversed entries not counted)'),
    list.length + ' entries · ' + fmt(total));
}
function exportExpensesExcel() {
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - expenses - ' + todayStr() + '.xlsx', 'Expenses', expInRange().map(function (e) {
    return { 'Date': fmtDate(e.expense_date), 'Description': e.description, 'Category': expenseCategoryLabel(e.category), 'Method': supplierPaymentMethodLabel(e.method),
      'Amount': Number(e.amount || 0), 'Status': e.voided ? 'Reversed' : 'Recorded' };
  }));
}

function expenseCategoryLabel(cat) {
  if (EXP_CATEGORY_LABELS[cat]) return EXP_CATEGORY_LABELS[cat];
  var s = String(cat || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Other';
}

// Every category this pharmacy has used beyond the presets. Feeds the "New
// expense" category list so a custom category shows up as a quick pick next
// time, without a separate categories table.
function expCustomCategories() {
  var seen = {};
  (expensesAllCache || []).forEach(function (e) { if (e.category) seen[e.category] = true; });
  return Object.keys(seen).filter(function (c) { return !EXP_CATEGORY_LABELS[c]; }).sort();
}

function openAddExpense() {
  var body = sheet('New expense', '');
  var customCats = expCustomCategories();
  body.innerHTML =
    '<div class="field"><label>Description</label><input id="exDescription" placeholder="e.g. September rent"></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Amount</label><input id="exAmount" type="number" step="0.01" min="0"></div>' +
    '<div class="field"><label>Category</label><input id="exCategory" list="exCategoryList" placeholder="e.g. Rent" value="Other">' +
      '<datalist id="exCategoryList">' +
        Object.keys(EXP_CATEGORY_LABELS).map(function (k) { return '<option value="' + esc(EXP_CATEGORY_LABELS[k]) + '">'; }).join('') +
        customCats.map(function (c) { return '<option value="' + esc(expenseCategoryLabel(c)) + '">'; }).join('') +
      '</datalist>' +
    '</div></div>' +
    '<div class="tiny" style="margin:-6px 0 12px">Pick one from the list or type your own — a new category is remembered for next time.</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Method</label><select id="exMethod">' +
      '<option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="cheque">Cheque</option><option value="other">Other</option>' +
    '</select></div>' +
    '<div class="field"><label>Date</label><input id="exDate" type="date" value="' + esc(new Date().toISOString().slice(0, 10)) + '"></div></div>' +
    '<div class="field"><label>Notes (optional)</label><input id="exNotes"></div>' +
    '<button class="btn primary" id="exSaveBtn" onclick="saveExpense()">Save expense</button>';
}

// Retry safety - see newRequestId() in js/core.js. Without this, a lost reply
// meant the same expense was counted twice and profit understated.
var expenseRequestId = null;

async function saveExpense() {
  var btn = $('#exSaveBtn');
  act(btn, async function () {
    var description = $('#exDescription').value.trim();
    if (!description) { toast('Give the expense a short description.', 'bad'); return; }
    var amount = parseFloat($('#exAmount').value);
    if (!amount || amount <= 0) { toast('Enter a valid amount.', 'bad'); return; }
    // Free-text category, stored lowercase and trimmed so "Rent" and "rent" group
    // together. Shown through expenseCategoryLabel(), which title-cases anything
    // not in EXP_CATEGORY_LABELS.
    var categoryRaw = $('#exCategory').value.trim();
    var category = categoryRaw.toLowerCase().replace(/\s+/g, ' ') || 'other';
    if (!expenseRequestId) expenseRequestId = newRequestId();
    var { error } = await sb.rpc('record_expense', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_category: category,
      p_description: description,
      p_amount: amount,
      p_method: $('#exMethod').value,
      p_expense_date: $('#exDate').value || null,
      p_notes: $('#exNotes').value.trim() || null,
      p_client_request_id: expenseRequestId
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    expenseRequestId = null;   // recorded; the next expense is a new request
    toast('Expense recorded.', 'good');
    closeSheet();
    renderExpenses();
  });
}

function openReverseExpense(expenseId) {
  var body = sheet('Reverse this expense?', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">This marks the expense reversed so it drops out of totals — it stays in the list for the record. Cannot be undone.</div>' +
    '<div class="field"><label>Reason</label><input id="exReverseReason" placeholder="Required"></div>' +
    '<button class="btn danger" id="exReverseBtn" onclick="doReverseExpense(\'' + expenseId + '\')">Reverse expense</button>';
}

async function doReverseExpense(expenseId) {
  var btn = $('#exReverseBtn');
  act(btn, async function () {
    var reason = $('#exReverseReason').value.trim();
    if (!reason) { toast('A reason is required.', 'bad'); return; }
    var { error } = await sb.rpc('void_expense', { p_pharmacy_id: STATE.profile.pharmacy_id, p_expense_id: expenseId, p_reason: reason });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expense reversed.', 'good');
    closeSheet();
    renderExpenses();
  });
}

// Invite staff: pick a role (all 5 invitable roles) and an account time limit.
// The limit is required (and never permanent) for accountant, optional for the
// rest. This is the lifespan of the account, separate from the 7-day window
// to redeem the code.
function openInviteStaff(btn) {
  btn.disabled = true;
  var body = sheet('Invite staff', '');
  body.innerHTML =
    '<div class="field"><label>Role</label>' +
    '<select id="invRole" onchange="onInviteRoleChange()">' +
    '<option value="pharmacist">Pharmacist</option>' +
    '<option value="attendant">Seller</option>' +
    '<option value="stock_taker">Stock taker</option>' +
    '<option value="co_owner">Co-owner / director (full access)</option>' +
    '<option value="accountant">Accountant (temporary)</option>' +
    '</select></div>' +
    '<div class="field"><label>Account time limit</label>' +
    '<select id="invExpiry">' +
    '<option value="" id="invExpiryPermanent">No time limit (permanent)</option>' +
    '<option value="24">24 hours</option>' +
    '<option value="72">3 days</option>' +
    '<option value="168">7 days</option>' +
    '<option value="720">30 days</option>' +
    '</select>' +
    '<div class="tiny" style="margin-top:6px">An accountant is always temporary — pick how long their access should last. The invite CODE itself is separately only redeemable for 7 days either way.</div>' +
    '</div>' +
    '<div id="invErr" class="error-text"></div>' +
    '<button class="btn primary" id="invGenBtn" onclick="generateStaffInvite()">Generate code</button>';
  btn.disabled = false;
}

function onInviteRoleChange() {
  var role = $('#invRole').value;
  var expSel = $('#invExpiry');
  var permOpt = $('#invExpiryPermanent');
  if (!expSel || !permOpt) return;
  if (role === 'accountant') {
    permOpt.disabled = true;
    if (!expSel.value) expSel.value = '24';
  } else {
    permOpt.disabled = false;
  }
}

function inviteExpiryLabel(hours) {
  if (!hours) return 'permanent';
  if (hours % 24 === 0 && hours >= 24) return (hours / 24) + (hours === 24 ? ' day' : ' days');
  return hours + 'h';
}

function generateStaffInvite() {
  var btn = $('#invGenBtn');
  act(btn, async function () {
    var err = $('#invErr'); err.textContent = '';
    var role = $('#invRole').value;
    var hoursVal = $('#invExpiry').value;
    var hours = hoursVal ? parseInt(hoursVal, 10) : null;
    if (role === 'accountant' && !hours) { err.textContent = "An accountant's account must have a time limit."; return; }
    var res = await sb.rpc('create_staff_invite', { p_pharmacy_id: STATE.profile.pharmacy_id, p_role: role, p_expires_hours: hours });
    if (res.error) { err.textContent = friendlyError(res.error); return; }
    var body = $('#sheetBody');
    if (!body) return;
    body.innerHTML =
      '<div class="tiny" style="margin-bottom:10px">Share this code with them — they enter it under "Staff Login" when they sign up. The code itself expires in 7 days' +
      (hours ? ', and once redeemed their account will stop working after ' + inviteExpiryLabel(hours) + '.' : '.') + '</div>' +
      '<div style="font-size:32px;font-weight:800;letter-spacing:4px;text-align:center;padding:20px;background:var(--green-light);border-radius:12px;color:var(--green)">' + esc(res.data) + '</div>' +
      '<button class="btn ghost" style="margin-top:14px" onclick="closeSheet()">Done</button>';
  });
}

async function toggleStaffActive(btn, profileId, makeActive) {
  act(btn, async function () {
    var { error } = await sb.from('profiles').update({ active: makeActive }).eq('id', profileId);
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast(makeActive ? 'Reactivated.' : 'Access disabled.', 'good');
    renderSettings();
  });
}

async function saveSettings() {
  var btn = $('#stSaveBtn') || $('#stSaveThresholdsBtn');
  act(btn, async function () {
    var daysRaw = $('#stLowDays') ? $('#stLowDays').value.trim() : '';
    var lowDays = daysRaw === '' ? null : parseInt(daysRaw, 10);
    if (lowDays !== null && (isNaN(lowDays) || lowDays < 1 || lowDays > 90)) { toast('Enter a number of days from 1 to 90, or leave it empty.', 'bad'); return; }
    var payload = {
      name: $('#stName').value.trim(),
      address: $('#stAddress').value.trim() || null,
      town: $('#stTown').value.trim() || null,
      phone: $('#stPhone').value.trim() || null,
      email: $('#stEmail').value.trim() || null,
      kra_pin: $('#stKra').value.trim() || null,
      low_stock_default: parseInt($('#stLowDefault').value, 10) || 5,
      expiry_warn_days: parseInt($('#stExpiryDays').value, 10) || 90,
      vat_rate: parseFloat($('#stVat').value) || 16,
      low_stock_days: lowDays
    };
    var { error } = await sb.from('pharmacies').update(payload).eq('id', STATE.profile.pharmacy_id);
    if (error) { toast(friendlyError(error), 'bad'); return; }
    STATE.pharmacy = Object.assign({}, STATE.pharmacy, payload);
    toast('Saved.', 'good');
    render();
  });
}

