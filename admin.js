/* Pharma Admin — the platform portal at /admin. Same idea as Kodi's admin:
   same Supabase project, same phone + password login as the main app, and
   an account only gets in if it's listed in platform_admins (checked by the
   database, not just here). All cross-pharmacy data comes from two
   SECURITY DEFINER functions — admin_overview() and
   admin_pharmacy_detail() — see schema.sql section 10. Reading is open to
   any platform admin; changing a pharmacy (trial days, mark as paid, delete)
   goes through admin_extend_trial / admin_activate_pharmacy /
   admin_delete_pharmacy, which re-check admin rights in the database. */

var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

var A = {
  session: null,
  overview: null,
  loadedAt: null,
  detail: {},          // pharmacy_id -> admin_pharmacy_detail() result
  filter: 'all',       // all | active | setting_up | quiet | dormant | not_started
  q: '',
  sort: 'active'       // active | newest | name | sales | signins
};

var STATUS = {
  active_today: { label: 'Active today', cls: 'good' },
  active_week:  { label: 'Active this week', cls: 'good' },
  setting_up:   { label: 'Setting up', cls: 'info' },
  quiet:        { label: 'Quiet', cls: 'warn' },
  dormant:      { label: 'Dormant', cls: 'bad' },
  not_started:  { label: 'Not started', cls: 'muted' }
};
var AVATAR_CLS = { good: '', info: 'blue', warn: 'warn', bad: 'bad', muted: 'muted' };
var ROLE_LABELS = { owner: 'Owner', co_owner: 'Co-owner', pharmacist: 'Pharmacist', stock_taker: 'Stock taker', attendant: 'Seller', accountant: 'Accountant' };

// ---------------------------------------------------------------------------
// Helpers (phone/email mapping MUST match app.js exactly, or the same
// person couldn't sign in here with the same phone number).
// ---------------------------------------------------------------------------
function $(s, c) { return (c || document).querySelector(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
}); }
function normalizePhone(raw) {
  var digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.charAt(0) === '0') digits = '254' + digits.slice(1);
  else if (digits.length === 9) digits = '254' + digits;
  return digits;
}
function phoneToAuthEmail(phone) { return 'p' + normalizePhone(phone) + '@hodhi.local'; }
function kes(n) { return 'KES ' + Math.round(Number(n) || 0).toLocaleString(); }
function num(n) { return (Number(n) || 0).toLocaleString(); }
// "1 sale" / "3 sales"
function pl(n, one, many) { n = Number(n) || 0; return num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
function roleLabel(r) { return ROLE_LABELS[r] || r || '—'; }
function initials(name) {
  var w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  return ((w[0] || '?').charAt(0) + (w.length > 1 ? w[1].charAt(0) : '')).toUpperCase();
}
function toast(msg, kind) {
  var t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, 2800);
}
// Disable a button and show "Please wait…" for the length of an async action,
// so it can't be double-tapped; restores the original label afterwards.
function act(btn, fn) {
  if (!btn) { fn().catch(function (e) { toast(friendlyError(e), 'bad'); }); return; }
  var original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Please wait…';
  fn().catch(function (e) { toast(friendlyError(e), 'bad'); })
    .finally(function () { btn.disabled = false; btn.innerHTML = original; });
}
// Small centered dialog. Returns the overlay element; onOpen(overlay) wires
// its buttons. closeModal() removes it. Clicking the backdrop or pressing
// Escape cancels.
function closeModal() { var m = document.querySelector('.adm-modal'); if (m) m.remove(); }
function modal(title, bodyHtml, opts) {
  opts = opts || {};
  closeModal();
  var m = document.createElement('div');
  m.className = 'adm-modal';
  m.innerHTML =
    '<div class="adm-modal-box" role="dialog" aria-modal="true">' +
      '<div class="adm-modal-head"><h3>' + esc(title) + '</h3>' +
      '<button class="adm-modal-x" aria-label="Close" onclick="closeModal()">&times;</button></div>' +
      '<div class="adm-modal-body">' + bodyHtml + '</div>' +
    '</div>';
  m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
  document.addEventListener('keydown', function esc0(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', esc0); }
  });
  document.body.appendChild(m);
  if (opts.onOpen) opts.onOpen(m);
  return m;
}
function friendlyError(e) {
  var msg = (e && e.message) || String(e || '');
  if (/failed to fetch|network|load failed/i.test(msg)) return 'No internet connection — check your connection and try again.';
  if (/Not authorized/i.test(msg)) return 'This account does not have admin access.';
  if (/jwt|refresh token|session (has )?expired|not authenticated/i.test(msg)) return 'Your session has ended. Please log in again.';
  if (/row-level security|permission denied/i.test(msg)) return 'You do not have permission to do that.';
  if (/timeout|timed out/i.test(msg)) return 'That took too long. Please try again.';
  if (/supabase|netlify|postgres|postgrest|pgrst|sqlstate|schema cache|edge function|functionshttp|non-2xx|does not exist|syntax error|typeerror|referenceerror|is not a function|is not defined|cannot read|undefined|unexpected token|<html/i.test(msg)) return 'Something went wrong on our side. Please try again in a moment.';
  return msg || 'Something went wrong.';
}

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function toDate(iso) {
  if (!iso) return null;
  return new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso);
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function daysBetween(a, b) { return Math.round((dayStart(b) - dayStart(a)) / 86400000); }
// "17 Sep 2026"
function fmtDate(iso) {
  var d = toDate(iso); if (!d) return '—';
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}
// "Today, 09:23" / "Yesterday, 18:10" / "Mon, 14:02" / "23 Sep, 12:06" / "23 Sep 2025"
function fmtWhen(iso) {
  var d = toDate(iso); if (!d) return 'Never';
  var now = new Date(), diff = daysBetween(d, now);
  if (diff === 0) return 'Today, ' + hm(d);
  if (diff === 1) return 'Yesterday, ' + hm(d);
  if (diff > 1 && diff < 7) return DOW[d.getDay()] + ', ' + hm(d);
  if (d.getFullYear() === now.getFullYear()) return d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + hm(d);
  return fmtDate(iso);
}
// "just now" / "12 min ago" / "3 h ago" / "4 days ago" / "2 months ago"
function ago(iso) {
  var d = toDate(iso); if (!d) return 'never';
  var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  var days = Math.round(s / 86400);
  if (days < 45) return days + (days === 1 ? ' day ago' : ' days ago');
  var m = Math.round(days / 30);
  return m < 12 ? m + ' months ago' : Math.round(days / 365) + (days < 730 ? ' year ago' : ' years ago');
}
function exactTime(iso) {
  var d = toDate(iso); if (!d) return '';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function statusBadge(s) {
  var m = STATUS[s] || { label: s, cls: 'muted' };
  return '<span class="badge ' + m.cls + '"><span class="dot"></span>' + esc(m.label) + '</span>';
}
// Plan = free trial or paid. Days left come from the database so the admin
// screen and the lock-out in the app always agree.
function planInfo(p) {
  var left = p.trial_days_left, paid = p.subscription_status === 'active';
  if (left == null) return { label: paid ? 'Active' : 'Trial', cls: paid ? 'good' : 'info', ended: false, left: null };
  if (left <= 0) return { label: paid ? 'Paid plan ended' : 'Trial ended', cls: 'bad', ended: true, left: left };
  var txt = left + (left === 1 ? ' day left' : ' days left');
  return { label: (paid ? 'Active · ' : 'Trial · ') + txt, cls: paid ? 'good' : (left <= 7 ? 'warn' : 'info'), ended: false, left: left };
}
function planBadge(p) {
  var pi = planInfo(p);
  return '<span class="badge ' + pi.cls + '"><span class="dot"></span>' + esc(pi.label) + '</span>';
}
// Which signal made a pharmacy "last active" — shown next to the time.
function activeVia(p) {
  if (!p.last_active_at) return '';
  var t = toDate(p.last_active_at).getTime();
  function same(x) { return x && Math.abs(toDate(x).getTime() - t) < 1000; }
  if (same(p.last_sale_at)) return 'made a sale';
  if (same(p.last_sign_in_at)) return 'signed in';
  if (same(p.last_seen_at)) return 'had the app open';
  if (same(p.last_stock_at)) return 'updated stock';
  return '';
}
function telHref(phone) { return 'tel:' + String(phone || '').replace(/[^\d+]/g, ''); }
function waHref(phone) { return 'https://wa.me/' + normalizePhone(phone); }

var ICON = {
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5"/><line x1="15" y1="12" x2="3" y2="12"/>',
  back: '<path d="M15 18 9 12l6-6"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  download: '<path d="M12 4v12"/><path d="M6.5 10.5 12 16l5.5-5.5"/><path d="M4 20h16"/>',
  warn: '<path d="M12 3 22 20H2Z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><circle cx="12" cy="16.5" r="1"/>'
};
function icon(n, s) {
  s = s || 16;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[n] || '') + '</svg>';
}

// ---------------------------------------------------------------------------
// Boot, auth & routing
// ---------------------------------------------------------------------------
async function init() {
  try {
    var res = await sb.auth.getSession();
    A.session = res.data.session;
  } catch (e) {
    return renderFatal(friendlyError(e));
  }
  sb.auth.onAuthStateChange(function (evt, session) {
    A.session = session;
    if (!session && evt === 'SIGNED_OUT') { A.overview = null; A.detail = {}; renderLogin(); }
  });
  if (!A.session) return renderLogin();
  await gate();
}

async function gate() {
  renderLoading();
  var res;
  try { res = await sb.rpc('is_platform_admin'); } catch (e) { return renderFatal(friendlyError(e)); }
  if (res.error) return renderFatal(friendlyError(res.error));
  if (res.data !== true) return renderNoAccess();
  if (!A.routing) { A.routing = true; window.addEventListener('hashchange', route); }
  route();
}

function route() {
  var m = location.hash.match(/^#\/p\/([0-9a-f-]{36})$/i);
  if (m) showDetail(m[1]); else showOverview();
}

function renderLogin(errorMsg) {
  document.title = 'Pharma Admin — Sign in';
  $('#admin').innerHTML =
    '<div class="adm-auth"><div class="box">' +
      '<div class="brand"><div class="brand-badge" style="width:48px;height:48px;font-size:24px">P</div>' +
      '<div class="t1">Pharma Admin</div><div class="t2">Sign in with your usual Pharma phone number and password</div></div>' +
      '<form class="card" id="loginForm" style="padding:18px">' +
        (errorMsg ? '<div class="err">' + esc(errorMsg) + '</div>' : '') +
        '<div class="field"><label for="lgPhone">Phone number</label><input id="lgPhone" type="tel" inputmode="tel" autocomplete="username" placeholder="07XX XXX XXX" required></div>' +
        '<div class="field"><label for="lgPw">Password</label><div class="pw-wrap"><input id="lgPw" type="password" autocomplete="current-password" required>' +
          '<button type="button" class="pw-eye" aria-label="Show password" aria-pressed="false">' + EYE_ON + '</button></div></div>' +
        '<button class="btn primary" id="lgBtn" type="submit">Sign in</button>' +
      '</form>' +
    '</div></div>';
  wirePwEyes($('#loginForm'));
  $('#loginForm').addEventListener('submit', doLogin);
  $('#lgPhone').focus();
}

async function doLogin(e) {
  e.preventDefault();
  var phone = $('#lgPhone').value.trim(), pw = $('#lgPw').value;
  if (normalizePhone(phone).length !== 12) return renderLoginKeep('Enter a valid phone number, e.g. 0712345678.', phone);
  var btn = $('#lgBtn');
  btn.disabled = true; btn.textContent = 'Please wait…';
  var res;
  try {
    res = await sb.auth.signInWithPassword({ email: phoneToAuthEmail(phone), password: pw });
  } catch (err) {
    return renderLoginKeep(friendlyError(err), phone);
  }
  if (res.error) return renderLoginKeep(/invalid/i.test(res.error.message) ? 'Wrong phone number or password.' : friendlyError(res.error), phone);
  A.session = res.data.session;
  gate();
}
function renderLoginKeep(msg, phone) {
  renderLogin(msg);
  $('#lgPhone').value = phone || '';
  $('#lgPw').focus();
}

async function logout() {
  try { await sb.auth.signOut(); } catch (e) {}
  A.session = null; A.overview = null; A.detail = {};
  location.hash = '';
  renderLogin();
}

function renderNoAccess() {
  $('#admin').innerHTML =
    '<div class="adm-auth"><div class="box"><div class="brand"><div class="brand-badge" style="width:48px;height:48px;font-size:24px">P</div>' +
    '<div class="t1">Pharma Admin</div></div>' +
    '<div class="card" style="padding:18px"><div style="display:flex;gap:8px;align-items:flex-start;font-weight:600">' + icon('warn', 18) +
    '<div>This account doesn\'t have admin access.<div style="font-weight:400;font-size:13px;margin-top:6px">You\'re signed in, but only accounts added as platform admins can open this page. Your pharmacy app is still at the main site.</div></div></div>' +
    '<div style="display:flex;gap:8px;margin-top:14px"><a class="btn secondary" href="./" style="text-decoration:none">Open Pharma</a>' +
    '<button class="btn ghost" onclick="logout()">Sign out</button></div></div></div></div>';
}

function renderFatal(msg) {
  $('#admin').innerHTML =
    '<div class="adm-auth"><div class="box"><div class="card" style="padding:18px"><div style="display:flex;gap:8px;align-items:flex-start;font-weight:600">' +
    icon('warn', 18) + esc(msg) + '</div><div style="margin-top:12px"><button class="btn primary" onclick="location.reload()">Reload</button></div></div></div></div>';
}

function shell(sub, body) {
  return '<header class="adm-head"><div class="adm-head-in">' +
      '<a class="adm-id" href="#/" style="color:inherit;text-decoration:none"><div class="brand-badge" style="width:36px;height:36px;font-size:18px">P</div>' +
      '<div style="min-width:0"><div class="t1">Pharma <span>Admin</span></div><div class="t2">' + esc(sub) + '</div></div></a>' +
      '<div class="adm-actions">' +
        '<button id="btnRefresh" onclick="refresh()" title="Refresh">' + icon('refresh') + '<span class="lbl">Refresh</span></button>' +
        '<button onclick="logout()" title="Sign out">' + icon('logout') + '<span class="lbl">Sign out</span></button>' +
      '</div></div></header>' +
    '<main class="adm-wrap">' + body + '</main>';
}

// Same loading screen as the pharmacy app (markup in loadScreenHtml, js/core.js;
// styles in style.css), so signing in looks the same on both sides.
function renderLoading() {
  document.title = 'Pharma Admin';
  $('#admin').innerHTML = '<div class="loadscreen" role="status" aria-label="Opening Pharma Admin"><div class="loadscreen-mark"><svg viewBox="0 0 48 48" aria-hidden="true"><polygon points="18,6 30,6 30,18 42,18 42,30 30,30 30,42 18,42 18,30 6,30 6,18 18,18" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg></div><p class="loadscreen-word">Pharma</p><svg class="loadscreen-ecg" viewBox="0 0 200 34" fill="none" stroke="#E7C76A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M0 18h54l8-14 10 28 10-20 6 6h112"/></svg><p class="loadscreen-tag">Admin</p></div>';
}

function errorBlock(msg, retry) {
  return '<div class="card" style="padding:18px"><div style="display:flex;gap:8px;align-items:flex-start;font-weight:600">' + icon('warn', 18) + esc(msg) + '</div>' +
    '<div style="margin-top:12px"><button class="btn secondary small" onclick="' + retry + '">Try again</button></div></div>';
}

async function refresh() {
  var b = $('#btnRefresh'); if (b) b.disabled = true;
  A.overview = null; A.detail = {};
  route();
}

// ---------------------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------------------
async function showOverview() {
  document.title = 'Pharma Admin';
  if (!A.overview) {
    renderLoading();
    var res;
    try { res = await sb.rpc('admin_overview'); } catch (e) { res = { error: e }; }
    if (res.error) {
      $('#admin').innerHTML = shell('Platform overview', errorBlock(friendlyError(res.error), 'refresh()'));
      return;
    }
    A.overview = res.data; A.loadedAt = new Date();
  }
  drawOverview();
}

function drawOverview() {
  var o = A.overview, s = o.summary;
  var followUp = (s.quiet || 0) + (s.dormant || 0) + (s.not_started || 0);
  var tiles =
    '<div class="adm-kpis">' +
      kpi('t-violet', 'Pharmacies signed up', num(s.pharmacies), (s.new_30d ? '+' + num(s.new_30d) + ' joined in the last 30 days' : 'None joined in the last 30 days')) +
      kpi('t-green', 'Active this week', num(s.active_week), num(s.active_today) + ' active today' + (s.setting_up ? ' · ' + num(s.setting_up) + ' setting up' : '')) +
      kpi(followUp ? 't-amber' : 't-neutral', 'Need a follow-up', num(followUp),
          num(s.quiet) + ' quiet · ' + num(s.dormant) + ' dormant · ' + num(s.not_started) + ' not started') +
      kpi('t-blue', 'Sign-ins · 7 days', num(o.sign_ins_7d), num(o.sign_ins_30d) + ' in the last 30 days · ' + pl(s.staff, 'staff account')) +
      kpi('t-sales', 'Sales recorded · 30 days', kes(s.sales_value_30d), pl(s.sales_30d, 'sale') + ' across all pharmacies', true) +
    '</div>';

  var chart =
    '<div class="card"><div class="card-head"><div><h2>Active pharmacies per day</h2>' +
    '<div class="sub">Last 30 days. A pharmacy counts as active on a day if anyone there signed in, made a sale or moved stock.</div></div></div>' +
    '<div class="chart-box" id="chartOverview" data-empty="No activity in the last 30 days"></div>' +
    '</div>';

  var body = tiles + chart +
    '<div class="card adm-section" id="phCard"></div>';
  $('#admin').innerHTML = shell('Platform overview · updated ' + hm(A.loadedAt), body);
  barChart($('#chartOverview'), o.daily, 'active_pharmacies', function (d) {
    return '<b>' + esc(fmtDate(d.day)) + '</b><br><span class="sw"></span>' + num(d.active_pharmacies) + ' active ' + (d.active_pharmacies === 1 ? 'pharmacy' : 'pharmacies') +
      '<br>' + num(d.sign_ins) + ' sign-ins · ' + num(d.sales) + ' sales';
  });
  drawPharmacies();
}

function kpi(tint, label, value, sub, smallValue) {
  return '<div class="kpi ' + tint + '"><div class="label">' + esc(label) + '</div>' +
    '<div class="value' + (smallValue ? ' small' : '') + '">' + esc(value) + '</div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
}

function filteredPharmacies() {
  var list = (A.overview.pharmacies || []).slice();
  var q = A.q.trim().toLowerCase();
  if (A.filter !== 'all') {
    list = list.filter(function (p) {
      return A.filter === 'active' ? (p.status === 'active_today' || p.status === 'active_week') : p.status === A.filter;
    });
  }
  if (q) {
    var qd = q.replace(/\D/g, '');
    list = list.filter(function (p) {
      return [p.name, p.town, p.owner_name].join(' ').toLowerCase().indexOf(q) !== -1 ||
        (qd.length >= 3 && (normalizePhone(p.owner_phone).indexOf(qd) !== -1 || normalizePhone(p.phone).indexOf(qd) !== -1 ||
          String(p.owner_phone || '').replace(/\D/g, '').indexOf(qd) !== -1));
    });
  }
  function t(x) { return x ? toDate(x).getTime() : 0; }
  var sorters = {
    active: function (a, b) { return t(b.last_active_at) - t(a.last_active_at); },
    newest: function (a, b) { return t(b.created_at) - t(a.created_at); },
    name: function (a, b) { return String(a.name).localeCompare(String(b.name)); },
    sales: function (a, b) { return (Number(b.sales_value_30d) || 0) - (Number(a.sales_value_30d) || 0); },
    signins: function (a, b) { return (b.sign_ins_30d || 0) - (a.sign_ins_30d || 0); }
  };
  list.sort(sorters[A.sort] || sorters.active);
  return list;
}

function drawPharmacies() {
  var all = A.overview.pharmacies || [];
  var counts = { all: all.length, active: 0, setting_up: 0, quiet: 0, dormant: 0, not_started: 0 };
  all.forEach(function (p) {
    if (p.status === 'active_today' || p.status === 'active_week') counts.active++;
    else if (counts[p.status] !== undefined) counts[p.status]++;
  });
  var chips = [['all', 'All'], ['active', 'Active'], ['setting_up', 'Setting up'], ['quiet', 'Quiet'], ['dormant', 'Dormant'], ['not_started', 'Not started']];
  var list = filteredPharmacies();

  var head =
    '<div class="card-head"><div><h2>Pharmacies<span class="count-pill">' + num(all.length) + '</span></h2>' +
    '<div class="sub">Every pharmacy that has signed up. Tap one to see its staff, sign-in history and activity.</div></div>' +
    '<button class="btn ghost small" onclick="exportCsv()" title="Download this list as a spreadsheet (CSV)">' + icon('download', 15) + 'CSV</button></div>' +
    '<div class="adm-toolbar"><div class="searchbox"><input id="phSearch" type="search" placeholder="Search pharmacy, owner, town or phone" value="' + esc(A.q) + '" aria-label="Search pharmacies"></div>' +
    '<select id="phSort" aria-label="Sort pharmacies">' +
      [['active', 'Last active'], ['newest', 'Newest sign-up'], ['name', 'Name A–Z'], ['sales', 'Sales (30 days)'], ['signins', 'Sign-ins (30 days)']].map(function (o) {
        return '<option value="' + o[0] + '"' + (A.sort === o[0] ? ' selected' : '') + '>Sort: ' + o[1] + '</option>';
      }).join('') + '</select></div>' +
    '<div class="chips" role="group" aria-label="Filter by status">' + chips.map(function (c) {
      return '<button class="chip' + (A.filter === c[0] ? ' on' : '') + '" data-f="' + c[0] + '" aria-pressed="' + (A.filter === c[0]) + '">' + c[1] + '<span class="n">' + counts[c[0]] + '</span></button>';
    }).join('') + '</div>' +
    '<div class="howto"><b>Active</b> = someone signed in, sold or moved stock in the last 7 days · <b>Quiet</b> = last activity 8–30 days ago · <b>Dormant</b> = over 30 days · <b>Setting up / Not started</b> = no drugs or sales yet (with / without recent activity).</div>';

  var rows;
  if (!list.length) {
    rows = '<div class="empty-note">' + (all.length ? 'No pharmacies match this filter.' : 'No pharmacies have signed up yet.') + '</div>';
  } else {
    rows =
      '<div class="only-wide"><div class="table-scroll"><table class="adm-table"><thead><tr>' +
        '<th>Pharmacy</th><th>Owner</th><th>Joined</th><th>Last sign-in</th><th>Last active</th>' +
        '<th class="num">Staff</th><th class="num">Drugs</th><th class="num">Sales · 30d</th><th>Plan</th><th>Status</th></tr></thead><tbody>' +
      list.map(function (p) {
        var st = STATUS[p.status] || { cls: 'muted' };
        var via = activeVia(p);
        return '<tr class="link" onclick="location.hash=\'#/p/' + p.id + '\'">' +
          '<td><div class="cell-id"><div class="row-avatar ' + (AVATAR_CLS[st.cls] || '') + '">' + esc(initials(p.name)) + '</div>' +
            '<div><a class="nm" href="#/p/' + esc(p.id) + '">' + esc(p.name) + '</a>' + (p.town ? '<div class="mt">' + esc(p.town) + '</div>' : '') + '</div></div></td>' +
          '<td>' + esc(p.owner_name || '—') + '<div class="mt">' + esc(p.owner_phone || p.phone || '') + '</div></td>' +
          '<td title="' + esc(exactTime(p.created_at)) + '">' + esc(fmtDate(p.created_at)) + '<div class="mt">' + esc(ago(p.created_at)) + '</div></td>' +
          '<td title="' + esc(exactTime(p.last_sign_in_at)) + '">' + esc(fmtWhen(p.last_sign_in_at)) + '<div class="mt">' + num(p.sign_ins_30d) + ' in 30 days</div></td>' +
          '<td title="' + esc(exactTime(p.last_active_at)) + '">' + esc(p.last_active_at ? ago(p.last_active_at) : 'Never') + (via ? '<div class="mt">' + esc(via) + '</div>' : '') + '</td>' +
          '<td class="num">' + num(p.active_staff) + (p.staff_count !== p.active_staff ? '<div class="mt">of ' + num(p.staff_count) + '</div>' : '') + '</td>' +
          '<td class="num">' + num(p.drugs_count) + '</td>' +
          '<td class="num">' + kes(p.sales_value_30d) + '<div class="mt">' + pl(p.sales_30d, 'sale') + '</div></td>' +
          '<td>' + planBadge(p) + (p.subscription_expires_at ? '<div class="mt">to ' + esc(fmtDate(p.subscription_expires_at)) + '</div>' : '') + '</td>' +
          '<td>' + statusBadge(p.status) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="only-narrow">' + list.map(function (p) {
        var st = STATUS[p.status] || { cls: 'muted' };
        return '<a class="ph-row" href="#/p/' + esc(p.id) + '"><div class="row-avatar ' + (AVATAR_CLS[st.cls] || '') + '">' + esc(initials(p.name)) + '</div>' +
          '<div class="body"><div class="top"><div class="nm">' + esc(p.name) + '</div>' + statusBadge(p.status) + '</div>' +
          '<div style="margin:2px 0 4px">' + planBadge(p) + '</div>' +
          '<div class="mt">' + esc(p.owner_name || '—') + (p.owner_phone ? ' · ' + esc(p.owner_phone) : '') + (p.town ? ' · ' + esc(p.town) : '') + '</div>' +
          '<div class="mt">Joined ' + esc(fmtDate(p.created_at)) + ' · Last sign-in ' + esc(fmtWhen(p.last_sign_in_at)) + '</div>' +
          '<div class="stats"><span><b>' + num(p.active_staff) + '</b> staff</span><span><b>' + num(p.drugs_count) + '</b> drugs</span>' +
          '<span><b>' + kes(p.sales_value_30d) + '</b> sales · 30d</span></div></div></a>';
      }).join('') + '</div>';
  }

  var card = $('#phCard');
  var hadFocus = document.activeElement && document.activeElement.id === 'phSearch';
  var caret = hadFocus ? document.activeElement.selectionStart : null;
  card.innerHTML = head + rows;
  var input = $('#phSearch');
  if (hadFocus) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (e) {} }
  input.addEventListener('input', function () { A.q = input.value; drawPharmacies(); });
  $('#phSort').addEventListener('change', function (e) { A.sort = e.target.value; drawPharmacies(); });
  card.querySelectorAll('.chip').forEach(function (b) {
    b.addEventListener('click', function () { A.filter = b.getAttribute('data-f'); drawPharmacies(); });
  });
}

function exportCsv() {
  var list = filteredPharmacies();
  var cols = [
    ['Pharmacy', 'name'], ['Town', 'town'], ['Owner', 'owner_name'], ['Owner phone', 'owner_phone'],
    ['Joined', function (p) { return fmtDate(p.created_at); }], ['Last sign-in', function (p) { return p.last_sign_in_at ? exactTime(p.last_sign_in_at) : ''; }],
    ['Last active', function (p) { return p.last_active_at ? exactTime(p.last_active_at) : ''; }],
    ['Status', function (p) { return (STATUS[p.status] || {}).label || p.status; }],
    ['Plan', function (p) { return planInfo(p).label; }], ['Plan ends', function (p) { return p.subscription_expires_at ? fmtDate(p.subscription_expires_at) : ''; }],
    ['Staff (active)', 'active_staff'], ['Staff (total)', 'staff_count'], ['Drugs', 'drugs_count'],
    ['Sign-ins (30d)', 'sign_ins_30d'], ['Sales (30d)', 'sales_30d'], ['Sales value KES (30d)', 'sales_value_30d'], ['Sales (all time)', 'sales_count']
  ];
  function cell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  var csv = cols.map(function (c) { return cell(c[0]); }).join(',') + '\n' +
    list.map(function (p) { return cols.map(function (c) { return cell(typeof c[1] === 'function' ? c[1](p) : p[c[1]]); }).join(','); }).join('\n');
  var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  var d = new Date();
  a.download = 'pharma-pharmacies-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

// ---------------------------------------------------------------------------
// PHARMACY DETAIL
// ---------------------------------------------------------------------------
async function showDetail(id) {
  A.histAll = false;
  var cached = A.detail[id];
  if (!cached) {
    renderLoading();
    var res;
    try { res = await sb.rpc('admin_pharmacy_detail', { p_pharmacy_id: id }); } catch (e) { res = { error: e }; }
    if (res.error) {
      $('#admin').innerHTML = shell('Pharmacy', '<a class="back-link" href="#/">' + icon('back') + 'All pharmacies</a>' + errorBlock(friendlyError(res.error), "A.detail={};route()"));
      return;
    }
    cached = A.detail[id] = res.data;
    if (!A.loadedAt) A.loadedAt = new Date();
  }
  drawDetail(cached);
  window.scrollTo(0, 0);
}

function drawDetail(d) {
  var p = d.pharmacy, c = d.counts;
  document.title = p.name + ' — Pharma Admin';
  var st = STATUS[p.status] || { cls: 'muted' };
  var via = activeVia(p);
  var phone = p.owner_phone || p.phone;

  var hero =
    '<div class="card"><div class="ph-hero">' +
      '<div class="row-avatar lg ' + (AVATAR_CLS[st.cls] || '') + '">' + esc(initials(p.name)) + '</div>' +
      '<div class="body"><h1>' + esc(p.name) + '</h1>' +
        '<div style="margin-bottom:6px">' + planBadge(p) + ' ' + statusBadge(p.status) + '</div>' +
        '<div class="mt">Joined <b>' + esc(fmtDate(p.created_at)) + '</b> (' + esc(ago(p.created_at)) + ') · Last active <b>' + esc(p.last_active_at ? ago(p.last_active_at) : 'never') + '</b>' + (via ? ' — ' + esc(via) : '') + '</div>' +
        '<div class="mt">Owner: <b>' + esc(p.owner_name || '—') + '</b>' + (phone ? ' · ' + esc(phone) : '') + (p.town ? ' · ' + esc(p.town) : '') + '</div>' +
        (phone ? '<div class="ph-contact"><a class="btn secondary small" href="' + esc(telHref(phone)) + '">' + icon('phone', 15) + 'Call</a>' +
          '<a class="btn secondary small" href="' + esc(waHref(phone)) + '" target="_blank" rel="noopener">' + icon('chat', 15) + 'WhatsApp</a></div>' : '') +
      '</div>' +
      ((p.address || p.email || p.kra_pin) ? '<dl class="kv" style="flex:1 1 220px">' +
        (p.address ? '<dt>Address</dt><dd>' + esc(p.address) + '</dd>' : '') +
        (p.email ? '<dt>Email</dt><dd>' + esc(p.email) + '</dd>' : '') +
        (p.kra_pin ? '<dt>KRA PIN</dt><dd>' + esc(p.kra_pin) + '</dd>' : '') + '</dl>' : '') +
    '</div></div>';

  var tiles = '<div class="adm-kpis six">' +
    kpi('t-blue', 'Last sign-in', fmtWhen(p.last_sign_in_at), pl(p.sign_ins_30d, 'sign-in') + ' in 30 days', true) +
    kpi('t-violet', 'Staff accounts', num(p.active_staff), p.staff_count !== p.active_staff ? num(p.staff_count) + ' total, ' + num(p.staff_count - p.active_staff) + ' disabled or expired' : 'all active') +
    kpi('t-orange', 'Drugs in catalog', num(p.drugs_count), pl(c.batches_in_stock, 'batch', 'batches') + ' in stock') +
    kpi('t-sales', 'Sales · 30 days', kes(p.sales_value_30d), pl(p.sales_30d, 'sale'), true) +
    kpi('t-green', 'Sales · all time', kes(c.sales_value_all), pl(p.sales_count, 'sale') + (c.first_sale_at ? ' since ' + fmtDate(c.first_sale_at) : ''), true) +
    kpi('t-neutral', 'Other records', pl(c.suppliers, 'supplier'), pl(c.lpos, 'LPO') + ' · ' + pl(c.expenses, 'expense'), true) +
    '</div>';

  var chart =
    '<div class="card"><div class="card-head"><div><h2>Sales per day</h2><div class="sub">Last 30 days · hover a bar for the amount and that day\'s sign-ins</div></div></div>' +
    '<div class="chart-box" id="chartDetail" data-empty="No sales in the last 30 days"></div>' +
    '</div>';

  var history = d.sign_ins || [];
  var anyBackfill = history.some(function (x) { return x.source === 'backfill'; });
  var signins =
    '<div class="card"><div class="card-head"><div><h2>Sign-in history</h2><div class="sub">' + (history.length > 1 ? 'Latest ' + pl(Math.min(history.length, 50), 'sign-in') : 'Sign-ins') + ' by anyone at this pharmacy</div></div></div>' +
    (history.length ? (A.histAll ? history : history.slice(0, 8)).map(function (x) {
      return '<div class="feed-row"><div class="row-avatar">' + esc(initials(x.full_name)) + '</div>' +
        '<div class="body"><div class="nm">' + esc(x.full_name || 'Unnamed') + '</div><div class="mt">' + esc(roleLabel(x.role)) + '</div></div>' +
        '<div class="when" title="' + esc(exactTime(x.signed_in_at)) + '">' + esc(fmtWhen(x.signed_in_at)) + '</div></div>';
    }).join('') : '<div class="empty-note">No sign-ins recorded yet.</div>') +
    (history.length > 8 ? '<button class="btn ghost small" style="margin-top:8px" onclick="A.histAll=!A.histAll;drawDetail(A.detail[\'' + p.id + '\'])">' + (A.histAll ? 'Show fewer' : 'Show all ' + history.length) + '</button>' : '') +
    (anyBackfill ? '<div class="foot-note">Sign-ins before the admin portal went live come from the sessions the system still had saved, so older history may be incomplete. Every sign-in from now on is recorded.</div>' : '') +
    '</div>';

  var staff = d.staff || [];
  var staffHtml =
    '<div class="card adm-section"><div class="card-head"><div><h2>Staff<span class="count-pill">' + staff.length + '</span></h2><div class="sub">Everyone with an account at this pharmacy</div></div></div>' +
    (staff.length ? '<div class="table-scroll"><table class="adm-table"><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Account created</th><th>Last sign-in</th><th class="num">Sign-ins · 30d</th><th>Access</th></tr></thead><tbody>' +
      staff.map(function (s) {
        var expired = s.account_expires_at && toDate(s.account_expires_at) <= new Date();
        var access = !s.active ? '<span class="badge bad"><span class="dot"></span>Disabled</span>'
          : expired ? '<span class="badge bad"><span class="dot"></span>Expired</span>'
          : s.account_expires_at ? '<span class="badge warn"><span class="dot"></span>Until ' + esc(fmtDate(s.account_expires_at)) + '</span>'
          : '<span class="badge good"><span class="dot"></span>Active</span>';
        return '<tr><td><div class="cell-id"><div class="row-avatar">' + esc(initials(s.full_name)) + '</div><div><b>' + esc(s.full_name || 'Unnamed') + '</b>' +
          (s.is_admin ? ' <span class="badge admin">You</span>' : '') + '</div></div></td>' +
          '<td>' + esc(roleLabel(s.role)) + '</td><td>' + esc(s.phone || '—') + '</td>' +
          '<td title="' + esc(exactTime(s.created_at)) + '">' + esc(fmtDate(s.created_at)) + '</td>' +
          '<td title="' + esc(exactTime(s.last_sign_in_at)) + '">' + esc(fmtWhen(s.last_sign_in_at)) + '</td>' +
          '<td class="num">' + num(s.sign_ins_30d) + '</td><td>' + access + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty-note">No staff accounts.</div>') +
    '</div>';

  $('#admin').innerHTML = shell(p.name,
    '<a class="back-link" href="#/">' + icon('back') + 'All pharmacies</a>' + hero + subscriptionCard(p) + '<div class="card" id="smsCard"><div class="empty-note">Loading SMS…</div></div>' + tiles +
    '<div class="adm-grid-2">' + chart + signins + '</div>' + staffHtml + dangerCard(p));
  wireSubscription(p);
  loadAdminSms(p);

  barChart($('#chartDetail'), d.daily, 'sales', function (x) {
    return '<b>' + esc(fmtDate(x.day)) + '</b><br><span class="sw"></span>' + num(x.sales) + (x.sales === 1 ? ' sale' : ' sales') + ' · ' + kes(x.sales_value) +
      '<br>' + num(x.sign_ins) + (x.sign_ins === 1 ? ' sign-in' : ' sign-ins');
  });
}

// ---------------------------------------------------------------------------
// Subscription: trial days, mark as paid, delete
// ---------------------------------------------------------------------------
function subscriptionCard(p) {
  var pi = planInfo(p), paid = p.subscription_status === 'active';
  var line = p.subscription_expires_at
    ? (pi.ended ? 'Ended on ' : (paid ? 'Paid until ' : 'Trial ends on ')) + '<b>' + esc(fmtDate(p.subscription_expires_at)) + '</b>'
    : 'No end date set';
  return '<div class="card" id="subCard"><div class="card-head"><div><h2>Subscription</h2>' +
    '<div class="sub">Every pharmacy starts with a 3-month free trial and becomes Active when you mark its first payment. When the end date passes, the pharmacy is locked out until you extend or activate it.</div></div>' +
    planBadge(p) + '</div>' +
    '<div class="sub-line">' + line + '</div>' +
    '<div class="sub-grid">' +
      '<div class="sub-box"><div class="sub-t">Add or remove days</div>' +
        '<div class="field"><label for="trDays">Number of days</label><input id="trDays" type="number" min="1" step="1" inputmode="numeric" placeholder="e.g. 30"></div>' +
        '<div class="sub-btns"><button class="btn primary small" id="trAdd">Add days</button>' +
        '<button class="btn ghost small" id="trCut">Take away days</button>' +
        '<button class="btn ghost small" id="trEnd">End now</button></div></div>' +
      '<div class="sub-box"><div class="sub-t">' + (paid ? 'Renew payment' : 'Mark as paid (first payment)') + '</div>' +
        '<div class="field"><label for="actDays">Paid for how many days</label><input id="actDays" type="number" min="1" step="1" inputmode="numeric" value="30"></div>' +
        '<div class="sub-btns"><button class="btn primary small" id="actBtn">' + (paid ? 'Renew' : 'Activate') + '</button></div></div>' +
    '</div></div>';
}

function dangerCard(p) {
  var pi = planInfo(p);
  return '<div class="card danger-zone"><div class="card-head"><div><h2>Delete this pharmacy</h2>' +
    '<div class="sub">Permanently removes the pharmacy, its staff logins and all its drugs, sales and records. This cannot be undone. Only available after the trial or plan has ended.</div></div></div>' +
    (pi.ended ? '' : '<div class="foot-note" style="border-top:0;margin-top:0;padding-top:0">This pharmacy still has time left. Use “End now” above first if you really want to delete it.</div>') +
    '<button class="btn danger small" id="delBtn"' + (pi.ended ? '' : ' disabled') + '>Delete pharmacy…</button></div>';
}

// Re-read the pharmacy after a change so the badge, dates and tables update.
async function reloadAfterChange(id) {
  A.overview = null; delete A.detail[id];
  await showDetail(id);
}

async function changeDays(p, sign) {
  var n = parseInt($('#trDays').value, 10);
  if (!(n > 0)) { toast('Enter the number of days first.', 'bad'); return; }
  var r = await sb.rpc('admin_extend_trial', { p_pharmacy_id: p.id, p_days: sign * n });
  if (r.error) throw r.error;
  toast(sign > 0 ? 'Added ' + n + ' days.' : 'Took away ' + n + ' days.');
  await reloadAfterChange(p.id);
}

function wireSubscription(p) {
  var add = $('#trAdd'), cut = $('#trCut'), end = $('#trEnd'), actv = $('#actBtn'), del = $('#delBtn');
  add.onclick = function () { act(add, function () { return changeDays(p, 1); }); };
  cut.onclick = function () { act(cut, function () { return changeDays(p, -1); }); };
  end.onclick = function () {
    modal('End the plan now?',
      '<p>' + esc(p.name) + ' will be locked out of the app straight away until you add days or mark it as paid.</p>' +
      '<div class="adm-modal-actions"><button class="btn ghost small" onclick="closeModal()">Cancel</button><button class="btn danger small" id="endGo">End now</button></div>',
      { onOpen: function (m) {
        var go = $('#endGo', m);
        go.onclick = function () {
          act(go, async function () {
            // Moves the end date to just before now, whatever is left.
            var left = Math.max(Number(p.trial_days_left) || 0, 0);
            var r = await sb.rpc('admin_extend_trial', { p_pharmacy_id: p.id, p_days: -(left + 1) });
            if (r.error) throw r.error;
            closeModal(); toast('Plan ended.');
            await reloadAfterChange(p.id);
          });
        };
      } });
  };
  actv.onclick = function () {
    act(actv, async function () {
      var n = parseInt($('#actDays').value, 10);
      if (!(n > 0)) { toast('Enter how many days were paid for.', 'bad'); return; }
      var r = await sb.rpc('admin_activate_pharmacy', { p_pharmacy_id: p.id, p_days: n });
      if (r.error) throw r.error;
      toast(p.name + ' is active for ' + n + ' days.');
      await reloadAfterChange(p.id);
    });
  };
  del.onclick = function () { startDelete(p); };
}

// SMS credit: balance, usage and a manual add / remove (a gift, or fixing a
// payment made outside M-Pesa). Read-only numbers come from admin_sms_wallet.
async function loadAdminSms(p) {
  var card = $('#smsCard');
  var r;
  try { r = await sb.rpc('admin_sms_wallet', { p_pharmacy_id: p.id }); } catch (e) { r = { error: e }; }
  card = $('#smsCard');
  if (!card) return;
  if (r.error) { card.innerHTML = '<div class="empty-note">' + esc(friendlyError(r.error)) + '</div>'; return; }
  var w = r.data;
  card.innerHTML =
    '<div class="card-head"><div><h2>SMS credit</h2><div class="sub">Bought by the pharmacy with M-Pesa. Each SMS costs ' + kes(w.price_per_sms) + '.</div></div></div>' +
    '<div class="sub-line"><b>' + kes(w.balance) + '</b> left · ' + pl(w.sent_30d, 'SMS') + ' sent in 30 days · ' + pl(w.sent_all, 'SMS') + ' sent in total · ' + kes(w.bought_all) + ' bought in total</div>' +
    '<div class="sub-grid"><div class="sub-box"><div class="sub-t">Add or remove credit</div>' +
      '<div class="field"><label for="smsAmt">Amount in KES (use a minus to remove)</label><input id="smsAmt" type="number" step="1" inputmode="numeric" placeholder="e.g. 200"></div>' +
      '<div class="field"><label for="smsNote">Note</label><input id="smsNote" type="text" maxlength="80" placeholder="e.g. Free credit"></div>' +
      '<div class="sub-btns"><button class="btn primary small" id="smsAdj">Save</button></div></div>' +
    '<div class="sub-box"><div class="sub-t">Latest activity</div>' +
      (w.recent.length ? w.recent.map(function (t) {
        return '<div class="mt">' + esc(fmtDate(t.created_at)) + ' · ' + esc(t.description || t.kind) + ' · <b>' + (Number(t.amount) > 0 ? '+' : '') + kes(t.amount).replace('KES -', '−KES ') + '</b></div>';
      }).join('') : '<div class="mt">Nothing yet.</div>') +
    '</div></div>';
  var btn = $('#smsAdj');
  btn.onclick = function () {
    act(btn, async function () {
      var n = Number($('#smsAmt').value);
      if (!n) { toast('Enter an amount first.', 'bad'); return; }
      var res = await sb.rpc('admin_adjust_sms_credit', { p_pharmacy_id: p.id, p_amount: n, p_note: $('#smsNote').value });
      if (res.error) throw res.error;
      toast('SMS credit is now ' + kes(res.data.balance) + '.');
      await loadAdminSms(p);
    });
  };
}

// Two steps, same as Kodi: first your password again, then the exact name.
function startDelete(p) {
  modal('Delete ' + p.name + '?',
    '<p>Step 1 of 2 — confirm it is you. Enter your admin password.</p>' +
    '<div class="field"><label for="delPw">Your password</label>' + pwField('delPw', 'current-password') + '</div>' +
    '<div id="delErr" class="err" style="display:none"></div>' +
    '<div class="adm-modal-actions"><button class="btn ghost small" onclick="closeModal()">Cancel</button><button class="btn primary small" id="delNext">Continue</button></div>',
    { onOpen: function (m) {
      wirePwEyes(m);
      var pw = $('#delPw', m), next = $('#delNext', m), err = $('#delErr', m);
      pw.focus();
      function go() {
        if (!pw.value) { err.textContent = 'Enter your password.'; err.style.display = 'block'; return; }
        act(next, async function () {
          err.style.display = 'none';
          var u = await sb.auth.getUser();
          var email = u.data && u.data.user && u.data.user.email;
          if (!email) throw new Error('Your session has ended. Please log in again.');
          var r = await sb.auth.signInWithPassword({ email: email, password: pw.value });
          if (r.error) { err.textContent = 'That password is not correct.'; err.style.display = 'block'; return; }
          confirmDelete(p);
        });
      }
      next.onclick = go;
      pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    } });
}

function confirmDelete(p) {
  modal('Delete ' + p.name + '?',
    '<p>Step 2 of 2 — type the pharmacy name exactly to delete it for good: <b>' + esc(p.name) + '</b></p>' +
    '<div class="field"><input id="delName" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Pharmacy name"></div>' +
    '<div class="adm-modal-actions"><button class="btn ghost small" onclick="closeModal()">Cancel</button><button class="btn danger small" id="delGo" disabled>Delete for good</button></div>',
    { onOpen: function (m) {
      var inp = $('#delName', m), go = $('#delGo', m);
      inp.focus();
      inp.addEventListener('input', function () { go.disabled = inp.value.trim() !== p.name; });
      go.onclick = function () {
        act(go, async function () {
          var r = await sb.rpc('admin_delete_pharmacy', { p_pharmacy_id: p.id, p_confirm_name: inp.value.trim() });
          if (r.error) throw r.error;
          closeModal();
          A.overview = null; A.detail = {};
          toast(p.name + ' was deleted.');
          location.hash = '#/';
          route();
        });
      };
    } });
}

// Password field with a show/hide eye, same markup as the main app.
function pwField(id, autocomplete) {
  return '<div class="pw-wrap"><input id="' + id + '" type="password" autocomplete="' + autocomplete + '">' +
    '<button type="button" class="pw-eye" aria-label="Show password" aria-pressed="false">' + EYE_ON + '</button></div>';
}
var EYE_ON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
var EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.5 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function wirePwEyes(root) {
  (root || document).querySelectorAll('.pw-eye').forEach(function (b) {
    b.onclick = function () {
      var inp = b.parentNode.querySelector('input');
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = show ? EYE_OFF : EYE_ON;
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      b.setAttribute('aria-pressed', show ? 'true' : 'false');
    };
  });
}

// ---------------------------------------------------------------------------
// Chart: a single-series daily bar chart (inline SVG, no library). Thin bars
// with 2px gaps and 4px rounded tops anchored on the baseline, recessive
// gridlines, integer ticks, a hover/tap tooltip per day. Single series, so
// no legend — the card title names it. Redrawn on resize.
// ---------------------------------------------------------------------------
var CHARTS = [];
function barChart(el, rows, key, tipFn) {
  if (!el) return;
  CHARTS = CHARTS.filter(function (c) { return document.body.contains(c.el); });
  CHARTS.push({ el: el, rows: rows, key: key, tipFn: tipFn });
  drawBarChart(el, rows, key, tipFn);
}
// Integer-only y-axis (these are counts): step is 1/2/5/10×10ⁿ, at most ~5
// ticks, and the top tick is always >= the largest bar.
function niceScale(max) {
  if (max <= 0) return { top: 1, step: 1 };
  var raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  var step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
  return { top: Math.ceil(max / step) * step, step: step };
}
function drawBarChart(el, rows, key, tipFn) {
  rows = rows || [];
  var W = Math.max(280, el.clientWidth || 600), H = 190;
  var padL = 30, padR = 6, padT = 10, padB = 24;
  var iw = W - padL - padR, ih = H - padT - padB;
  var max = rows.reduce(function (m, r) { return Math.max(m, Number(r[key]) || 0); }, 0);
  var sc = niceScale(max), top = sc.top, step = sc.step;
  var n = rows.length || 1, slot = iw / n, gap = 2, bw = Math.max(2, Math.min(18, slot - gap));
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="img" aria-label="Daily bar chart, last 30 days">';
  for (var t = 0; t <= top + 1e-9; t += step) {
    var y = padT + ih - (t / top) * ih;
    svg += (t === 0 ? '' : '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '"/>') +
      '<text class="axis" x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + Math.round(t).toLocaleString() + '</text>';
  }
  svg += '<line class="base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + ih) + '" y2="' + (padT + ih) + '"/>';
  rows.forEach(function (r, i) {
    var v = Number(r[key]) || 0;
    var x = padL + i * slot + (slot - bw) / 2;
    if (v > 0) {
      var h = Math.max(3, (v / top) * ih), y0 = padT + ih, y1 = y0 - h, rr = Math.min(4, bw / 2, h);
      svg += '<path class="bar" d="M' + x + ',' + y0 + 'V' + (y1 + rr) + 'Q' + x + ',' + y1 + ' ' + (x + rr) + ',' + y1 +
        'H' + (x + bw - rr) + 'Q' + (x + bw) + ',' + y1 + ' ' + (x + bw) + ',' + (y1 + rr) + 'V' + y0 + 'Z"/>';
    }
    var d = toDate(r.day), last = i === rows.length - 1;
    var label = last ? 'Today' : (i % 7 === (rows.length - 1) % 7 ? d.getDate() + ' ' + MONTHS[d.getMonth()] : '');
    if (label && !(i > rows.length - 4 && !last)) {
      svg += '<text class="axis" x="' + (padL + i * slot + slot / 2) + '" y="' + (H - 6) + '" text-anchor="' + (last ? 'end' : 'middle') + '">' + label + '</text>';
    }
    svg += '<rect class="hit" data-i="' + i + '" x="' + (padL + i * slot) + '" y="' + padT + '" width="' + slot + '" height="' + ih + '"/>';
  });
  svg += '</svg>';
  var empty = max === 0 ? '<div class="chart-empty">' + esc(el.getAttribute('data-empty') || 'Nothing recorded in the last 30 days') + '</div>' : '';
  el.innerHTML = svg + empty + '<div class="chart-tip" style="display:none"></div>';
  var tip = el.querySelector('.chart-tip');
  function show(ev) {
    var t = ev.target.closest && ev.target.closest('.hit'); if (!t) return;
    var i = +t.getAttribute('data-i');
    var box = el.getBoundingClientRect(), sv = el.querySelector('svg').getBoundingClientRect();
    var scale = sv.width / W;
    var cx = (padL + i * slot + slot / 2) * scale;
    var v = Number(rows[i][key]) || 0;
    var cy = (padT + ih - (v / top) * ih) * scale;
    tip.innerHTML = tipFn(rows[i]);
    tip.style.display = 'block';
    var tw = tip.offsetWidth;
    var left = Math.min(Math.max(cx, tw / 2 + 4), box.width - tw / 2 - 4);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(cy, tip.offsetHeight + 12) + 'px';
  }
  el.addEventListener('mousemove', show);
  el.addEventListener('click', show);
  el.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
}
var resizeT;
window.addEventListener('resize', function () {
  clearTimeout(resizeT);
  resizeT = setTimeout(function () { CHARTS.forEach(function (c) { if (document.body.contains(c.el)) drawBarChart(c.el, c.rows, c.key, c.tipFn); }); }, 150);
});

init();
