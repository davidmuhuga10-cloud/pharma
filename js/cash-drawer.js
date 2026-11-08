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

async function loadCashDrawer() {
  drawReportsShell2('Close the cash drawer');
  cashSummary = null;
  cashHistory = [];
  var pid = STATE.profile.pharmacy_id;
  var closing = can('cash_close');
  var reviewing = can('cash_review');
  var jobs = [];
  if (closing) jobs.push(sb.rpc('cash_drawer_summary', { p_pharmacy_id: pid }));
  else jobs.push(Promise.resolve({ data: null }));
  if (reviewing) {
    jobs.push(sb.from('cash_closings').select('*, profiles:closed_by(full_name)').eq('pharmacy_id', pid)
      .order('closed_at', { ascending: false }).limit(30));
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

function cashHistoryHtml(rows) {
  if (!rows || !rows.length) return '<div class="section-title">Past closings</div><div class="card"><div class="empty">No closings yet. Close the drawer at the end of each day to compare counted cash against what was sold.</div></div>';
  return '<div class="section-title">Past closings</div><div class="card">' + rows.map(function (r) {
    var who = r.profiles && r.profiles.full_name ? ' · ' + esc(r.profiles.full_name) : '';
    var off = Math.abs(Number(r.difference) || 0) >= 0.005;
    return '<div class="list-row"><div><div class="name">' + fmtDateTime(r.closed_at) + who + '</div>' +
      '<div class="meta">Expected ' + fmt(r.expected) + ' · Counted ' + fmt(r.counted) + ' · Left in drawer ' + fmt(r.kept) +
      (r.note ? '<br>' + esc(r.note) : '') + '</div></div>' +
      '<div class="right"' + (off ? ' style="color:var(--red)"' : '') + '>' + esc(cashDifferenceLabel(r.difference)) + '</div></div>';
  }).join('') + '</div>';
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
  if (can('cash_review')) html += cashHistoryHtml(cashHistory);
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
