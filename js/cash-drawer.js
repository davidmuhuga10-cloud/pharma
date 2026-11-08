// js/cash-drawer.js - closing the cash drawer at the end of a shift.
//
// The person counts the cash in the drawer; the database works out what should be there
// (cash sales + cash customer payments - cash refunds - cash expenses - cash supplier payments,
// plus the float left last time) and records the difference. A seller counts "blind": the
// expected figure stays hidden until the closing is saved. Owners, co-owners and pharmacists see
// the figures first. Owners, co-owners, pharmacists and accountants can read the history.
// Opened from the Reports hub (view 'cash'). The money rules live in migrations/2026-11-07_cash_drawer.sql.

var cashSummary = null;   // live figures for the open period (null for a seller: blind)
var cashHistory = [];
var cashRange = 'month';   // 'month' | 'all' | 'custom' - which past closings are listed
var cashFrom = '';
var cashTo = '';
var cashPage = 1;
var CASH_RANGES = [{ key: 'month', label: 'This month' }, { key: 'all', label: 'All time' }];

function cashBounds() {
  if (cashRange === 'custom') return rangeBounds(cashFrom, cashTo);
  if (cashRange === 'month') { var n = new Date(); return { start: new Date(n.getFullYear(), n.getMonth(), 1).toISOString(), end: null }; }
  return { start: null, end: null };
}
function cashRangeLabel() {
  if (cashRange === 'custom') return fmtDate(cashFrom) + ' to ' + fmtDate(cashTo);
  return cashRange === 'month' ? 'This month' : 'All time';
}
// Every closing in the chosen dates (not just the latest 30), so Print and Excel are complete.
function fetchCashHistory() {
  var b = cashBounds(), pid = STATE.profile.pharmacy_id;
  return fetchAllRows(function () {
    var q = sb.from('cash_closings').select('*, profiles:closed_by(full_name)').eq('pharmacy_id', pid).order('closed_at', { ascending: false });
    if (b.start) q = q.gte('closed_at', b.start);
    if (b.end) q = q.lt('closed_at', b.end);
    return q;
  }, 'id');
}

async function loadCashDrawer() {
  drawReportsShell2('Close the cash drawer');
  cashSummary = null;
  cashHistory = [];
  cashPage = 1;
  var pid = STATE.profile.pharmacy_id;
  var closing = can('cash_close');
  var reviewing = can('cash_review');
  var jobs = [];
  if (closing) jobs.push(sb.rpc('cash_drawer_summary', { p_pharmacy_id: pid }));
  else jobs.push(Promise.resolve({ data: null }));
  if (reviewing) {
    jobs.push(fetchCashHistory());
  } else jobs.push(Promise.resolve({ data: [] }));
  var res;
  try { res = await Promise.all(jobs); } catch (e) { res = [{ error: e }, { data: [] }]; }
  if (res[0].error) {
    var b = $('#reportBody');
    if (b) b.innerHTML = '<div class="empty">' + esc(friendlyError(res[0].error)) + '</div>';
    return;
  }
  cashSummary = res[0].data;
  cashHistory = res[1].data || [];
  drawCashDrawer();
}

// "Opening 50 + sales 130 ..." as rows. Only shown to people who may see the expected figure.
function cashFiguresHtml(f) {
  if (!f || f.blind) return '';
  function row(label, value, sign) {
    return '<div class="list-row"><div><div class="name">' + esc(label) + '</div></div><div class="right">' +
      (sign || '') + fmt(value) + '</div></div>';
  }
  return '<div class="card">' +
    row('Left in the drawer last time', f.opening, '') +
    row('Cash sales', f.cash_sales, '+ ') +
    row('Cash payments from customers', f.customer_payments, '+ ') +
    row('Cash refunds', f.refunds, '- ') +
    row('Cash expenses', f.expenses, '- ') +
    row('Cash paid to suppliers', f.supplier_payments, '- ') +
    '</div>';
}

function cashDifferenceLabel(d) {
  var n = Number(d) || 0;
  if (Math.abs(n) < 0.005) return 'Exact';
  return (n < 0 ? 'Short by ' : 'Over by ') + fmt(Math.abs(n));
}

var CASH_COLS = ['When', 'By', 'Expected', 'Counted', 'Left in drawer', 'Difference', 'Reason'];
function cashRowCells(r) {
  var d = Number(r.difference) || 0;
  return [fmtDateTime(r.closed_at), (r.profiles && r.profiles.full_name) || '—', fmt(r.expected), fmt(r.counted), fmt(r.kept),
    stCell(cashDifferenceLabel(r.difference), Math.abs(d) < 0.005 ? 'ok' : (d < 0 ? 'bad' : 'warn')), r.note || '—'];
}

// The past closings: 10 to a page. Print and Excel (cashPrint / cashExcel) carry all of `cashHistory`.
function cashHistoryHtml(rows) {
  var pg = pageSlice(rows || [], cashPage);
  cashPage = pg.page;
  return '<div class="section-title">Past closings · ' + esc(cashRangeLabel()) + '</div>' +
    showingHtml(pg) +
    rtTable(CASH_COLS, pg.rows.map(cashRowCells), { empty: 'No closings yet. Close the drawer at the end of each day to compare counted cash against what was sold.', num: [false, false, true, true, true, false, false] }) +
    pagerHtml(pg, 'goCashPage');
}
function goCashPage(p) { cashPage = p; var h = $('#cashHist'); if (h) h.innerHTML = cashHistoryHtml(cashHistory); }

async function pickCashRange(key) { cashRange = key; await reloadCashHistory(); }
async function applyCashRange() {
  var r = rangeBarRead(), err = rangeError(r.from, r.to);
  if (err) { toast(err, 'bad'); return; }
  cashFrom = r.from; cashTo = r.to; cashRange = 'custom';
  await reloadCashHistory();
}
// Only the history changes with the dates, so the closing form above keeps what was typed.
async function reloadCashHistory() {
  var res = await fetchCashHistory();
  if (res.error) { toast(friendlyError(res.error), 'bad'); return; }
  cashHistory = res.data || []; cashPage = 1;
  var h = $('#cashHistWrap');
  if (h) h.innerHTML = cashHistoryBlock();
}
function cashHistoryBlock() {
  return rangeBarHtml({ presets: CASH_RANGES, active: cashRange, from: cashFrom, to: cashTo, pickFn: 'pickCashRange', applyFn: 'applyCashRange' }) +
    '<div id="cashHist">' + cashHistoryHtml(cashHistory) + '</div>';
}

function cashPrint() {
  if (!can('cash_review')) return;
  var rows = cashHistory.map(cashRowCells);
  var short = cashHistory.filter(function (r) { return Number(r.difference) < -0.004; }).length;
  printHtml('Cash Drawer Closings', cashRangeLabel(), tableHtml(CASH_COLS, rows, 'Total: ' + rows.length + ' closings'),
    rows.length + ' closings · ' + short + ' short');
}
function cashExcel() {
  if (!can('cash_review')) return;
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - cash closings - ' + todayStr() + '.xlsx', 'Cash closings', cashHistory.map(function (r) {
    return { 'When': fmtDateTime(r.closed_at), 'By': (r.profiles && r.profiles.full_name) || '', 'Expected': Number(r.expected || 0), 'Counted': Number(r.counted || 0),
      'Left in drawer': Number(r.kept || 0), 'Difference': Number(r.difference || 0), 'Reason': r.note || '' };
  }));
}

function drawCashDrawer() {
  var body = $('#reportBody');
  if (!body) return;
  var html = '';
  if (can('cash_close')) {
    var blind = !cashSummary || cashSummary.blind;
    html +=
      (blind
        ? '<div class="card" style="padding:14px;margin-bottom:12px">Count all the cash in the drawer, then type it below. The system will compare it with what it expects and show you the result.</div>'
        : '<div class="kpi-grid" style="margin-bottom:12px">' + kpi('Should be in the drawer', fmt(cashSummary.expected), 't-green') + '</div>' + cashFiguresHtml(cashSummary)) +
      '<div class="card" style="padding:14px;margin:12px 0">' +
      '<div class="field"><label>Cash you counted</label><input id="cdCounted" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0"></div>' +
      '<div class="field"><label>Cash you leave in the drawer for the next shift</label><input id="cdKept" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0"></div>' +
      '<div class="field"><label>Reason for any difference (write it if the count is not exact)</label><input id="cdNote" maxlength="300" placeholder="e.g. change given wrongly, cash taken to bank"></div>' +
      '<button class="btn primary block" onclick="act(this, saveCashClosing)">Close the drawer</button>' +
      '</div>';
  } else {
    html += '<div class="card" style="padding:14px;margin-bottom:12px">You can read past closings here. Sellers, pharmacists and owners close the drawer.</div>';
  }
  if (can('cash_review')) html += '<div id="cashHistWrap">' + cashHistoryBlock() + '</div>';
  body.innerHTML = html;
}

// What the person types, checked before anything is sent. Returns { counted, kept } or { error }.
function cashReadInputs(countedText, keptText) {
  var ct = String(countedText == null ? '' : countedText).trim();
  var kt = String(keptText == null ? '' : keptText).trim();
  if (ct === '' || isNaN(Number(ct)) || Number(ct) < 0) return { error: 'Type the cash you counted (0 or more).' };
  var counted = Number(ct);
  var kept = kt === '' ? 0 : Number(kt);
  if (isNaN(kept) || kept < 0) return { error: 'The cash you leave must be 0 or more.' };
  if (kept > counted) return { error: 'You cannot leave more cash than you counted.' };
  return { counted: counted, kept: kept };
}

function cashResultHtml(r) {
  var d = Number(r.difference) || 0;
  var exact = Math.abs(d) < 0.005;
  return '<div class="kpi-grid" style="margin-bottom:12px">' +
    kpi('System expected', fmt(r.expected), 't-sales') +
    kpi('You counted', fmt(r.counted), 't-sales') +
    '</div>' +
    '<div class="card" style="padding:14px;margin-bottom:12px;font-weight:700;' + (exact ? '' : 'color:var(--red)') + '">' +
    (exact ? 'The count is exact.' : esc(cashDifferenceLabel(d)) + '.') + '</div>' +
    '<button class="btn primary block" onclick="closeSheet()">Done</button>';
}

async function saveCashClosing() {
  var v = cashReadInputs($('#cdCounted').value, $('#cdKept').value);
  if (v.error) { toast(v.error, 'bad'); return; }
  var { data, error } = await sb.rpc('close_cash_drawer', {
    p_pharmacy_id: STATE.profile.pharmacy_id,
    p_counted: v.counted,
    p_kept: v.kept,
    p_note: $('#cdNote').value.trim() || null
  });
  if (error) { toast(friendlyError(error), 'bad'); return; }
  var body = sheet('Drawer closed', cashResultHtml(data));
  await loadCashDrawer();
  return body;
}
