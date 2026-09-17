/* Hodhi — Pharmacy Stock & Sales. Vanilla JS, no build step, same spirit as
   Kodi/Shule: one file, Supabase for backend + auth + RLS, works as an
   installable PWA. See schema.sql for the tables/views/functions this calls. */

var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

var STATE = {
  session: null,
  profile: null,      // { id, pharmacy_id, full_name, role, active, language }
  pharmacy: null,      // { id, name, currency, expiry_warn_days, vat_rate }
  tab: 'dashboard',
  cart: [],            // [{ drug_id, name, unit, price, qty, stock, rx }]
  drugsCache: [],
  categoriesCache: [],
  suppliersCache: [],
  authMode: 'login'    // 'login' | 'signup' | 'join'
};

// ---------------------------------------------------------------------------
// ACCESS CONTROL — owner sees/does everything; pharmacist runs day-to-day
// stock & sales but not business settings or staff; attendant ("seller")
// only sells and looks things up, nothing that changes stock or money rules.
// ---------------------------------------------------------------------------
var PHARMACIST_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export',
  'edit_inventory', 'restock', 'write_off', 'correct_stock', 'return', 'void', 'discount', 'claims', 'suppliers'];
var ATTENDANT_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export'];

function can(action) {
  if (!STATE.profile) return false;
  var role = STATE.profile.role;
  if (role === 'owner') return true;
  if (role === 'pharmacist') return PHARMACIST_ACTIONS.indexOf(action) !== -1;
  return ATTENDANT_ACTIONS.indexOf(action) !== -1;
}

// ---------------------------------------------------------------------------
// MINIMAL i18n — English / Swahili for the primary navigation and headline
// labels. Not every string in the app is translated yet; this covers the
// screens a pharmacist looks at most.
// ---------------------------------------------------------------------------
var STRINGS = {
  en: {
    home: 'Home', stock: 'Stock', sell: 'Sell', reports: 'Reports', settings: 'Settings',
    dashboard: 'Dashboard', stockValue: 'Stock value (retail)', salesToday: 'Sales today',
    salesWeek: 'Sales this week', salesMonth: 'Sales this month', needsAttention: 'Needs attention',
    outOfStock: 'Out of stock', lowStock: 'Low stock', expiringSoon: 'Expiring soon',
    logOut: 'Log out', addDrug: '+ Add new drug', checkout: 'Checkout', total: 'Total'
  },
  sw: {
    home: 'Nyumbani', stock: 'Bidhaa', sell: 'Uza', reports: 'Ripoti', settings: 'Mipangilio',
    dashboard: 'Dashibodi', stockValue: 'Thamani ya bidhaa (rejareja)', salesToday: 'Mauzo leo',
    salesWeek: 'Mauzo wiki hii', salesMonth: 'Mauzo mwezi huu', needsAttention: 'Yanayohitaji uangalizi',
    outOfStock: 'Bidhaa zilizoisha', lowStock: 'Bidhaa chache', expiringSoon: 'Zinakaribia kuisha muda',
    logOut: 'Toka', addDrug: '+ Ongeza dawa mpya', checkout: 'Lipa', total: 'Jumla'
  }
};
function t(key) {
  var lang = (STATE.profile && STATE.profile.language) || 'en';
  return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
}

// ---------------------------------------------------------------------------
// ICON SET — hand-drawn inline SVGs, self-contained (no icon-font CDN to
// depend on, same reasoning as vendoring Supabase/xlsx above). Every icon
// uses stroke="currentColor" so it inherits whatever color CSS gives it.
// ---------------------------------------------------------------------------
var ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
  stock: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-35 12 12)"/><line x1="12" y1="6.5" x2="12" y2="17.5" transform="rotate(-35 12 12)"/>',
  sell: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2Z"/><line x1="8.5" y1="7" x2="15.5" y2="7"/><line x1="8.5" y1="11" x2="15.5" y2="11"/><line x1="8.5" y1="15" x2="13" y2="15"/>',
  reports: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="12" width="3" height="8"/><rect x="10.5" y="7" width="3" height="13"/><rect x="15" y="3" width="3" height="17"/>',
  settings: '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2"/><line x1="4" y1="13" x2="20" y2="13"/><circle cx="15" cy="13" r="2"/><line x1="4" y1="19" x2="20" y2="19"/><circle cx="9" cy="19" r="2"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M7 17v4h10v-4"/>',
  upload: '<path d="M12 16V4"/><path d="M6.5 9.5 12 4l5.5 5.5"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12"/><path d="M6.5 10.5 12 16l5.5-5.5"/><path d="M4 20h16"/>',
  clipboard: '<rect x="5.5" y="4" width="13" height="16" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><line x1="8.5" y1="11" x2="15.5" y2="11"/><line x1="8.5" y1="15" x2="15.5" y2="15"/>',
  cart: '<circle cx="9.5" cy="20" r="1.4"/><circle cx="17.5" cy="20" r="1.4"/><path d="M3 4h2.2l2.2 11.6a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L20.5 8H6"/>',
  warn: '<path d="M12 3 22 20H2Z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><circle cx="12" cy="16.5" r="1"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  box: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M8 8V6.5a4 4 0 0 1 8 0V8"/>'
};
function icon(name, size) {
  var s = size || 18;
  return '<svg class="ic-svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
}
// The brand mark used on the auth screen and topbar — a rounded badge in
// brand green with the capsule glyph, instead of plain unstyled text.
function logoMarkHtml(size) {
  var s = size || 44;
  return '<div class="brand-badge" style="width:' + s + 'px;height:' + s + 'px">' + icon('stock', Math.round(s * 0.52)) + '</div>';
}

function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
}); }
function fmt(n) { return 'KES ' + (Math.round((Number(n) || 0)) ).toLocaleString(); }
function fmtDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso + (String(iso).length <= 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function daysUntil(iso) {
  var d = new Date(iso + 'T00:00:00');
  return Math.ceil((d - new Date(new Date().toDateString())) / 86400000);
}
function toast(msg, kind) {
  var t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, 2600);
}
function closeSheet() { var m = $('.mask'); if (m) m.remove(); }
function sheet(title, bodyHtml) {
  closeSheet();
  var mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="sheet"><div class="sheet-head"><h2>' + esc(title) + '</h2>' +
    '<button onclick="closeSheet()">' + icon('close',15) + '</button></div><div id="sheetBody">' + bodyHtml + '</div></div>';
  mask.addEventListener('click', function (e) { if (e.target === mask) closeSheet(); });
  document.body.appendChild(mask);
  return $('#sheetBody');
}
function act(btn, fn) {
  var original = btn.textContent;
  btn.disabled = true;
  fn().catch(function (e) { toast(friendlyError(e), 'bad'); })
    .finally(function () { btn.disabled = false; btn.textContent = original; });
}

// Turns a raw network/Supabase error into something a pharmacist can act on,
// instead of a stack trace or "Failed to fetch".
function friendlyError(e) {
  var msg = (e && e.message) || String(e || '');
  if (/failed to fetch|network|load failed/i.test(msg)) return 'No internet connection — check your connection and try again.';
  return msg || 'Something went wrong.';
}

// Renders a retry card into a container when a data load fails, instead of
// leaving "Loading…" spinning forever on a dropped connection.
function errorCard(container, message, retryFn) {
  container.innerHTML =
    '<div class="card empty">' +
    '<div style="margin-bottom:10px;display:flex;gap:8px;align-items:flex-start">' + icon('warn',18) + '' + esc(message) + '</div>' +
    '<button class="btn secondary small" onclick="(' + retryFn + ')()">Try again</button>' +
    '</div>';
}

// ---------------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------------

async function init() {
  try {
    var { data } = await sb.auth.getSession();
    STATE.session = data.session;
    if (STATE.session) await loadProfileAndPharmacy();
    render();
  } catch (e) {
    $('#app').innerHTML =
      '<div class="auth-wrap-simple"><div class="auth-card">' + logoMarkHtml(44) + '<div class="mark">Hodhi</div>' +
      '<div class="card empty" style="display:flex;gap:8px;align-items:flex-start;text-align:left;margin-top:14px">' + icon('warn', 18) + esc(friendlyError(e)) + '<div style="margin-top:12px">' +
      '<button class="btn primary" onclick="location.reload()">Reload</button></div></div></div></div>';
    return;
  }
  sb.auth.onAuthStateChange(function (evt, session) {
    STATE.session = session;
    if (evt === 'PASSWORD_RECOVERY') { STATE.recoveryMode = true; render(); return; }
    if (!session) { STATE.profile = null; STATE.pharmacy = null; render(); }
  });
}

// Supabase's default "confirm your email" flow means signUp() often returns
// no session at all — the profile/pharmacy can't be created at that point
// because there's no authenticated user yet to own it. So we stash what the
// person typed and finish the job the first time they actually get a
// session (right after signup if confirmation is off, or on their first
// login after clicking the confirmation link if it's on). Without this, a
// confirmed account with no pharmacy is a dead end with no way back in.
var PENDING_KEY = 'hodhi_pending_signup';

function stashPendingSignup(data) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(data)); } catch (e) {}
}

async function finishPendingSignupIfAny() {
  var pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (e) {}
  if (!pending) return false;
  try {
    if (pending.kind === 'owner') {
      var { error } = await sb.rpc('bootstrap_pharmacy', {
        p_name: pending.pharmacyName, p_full_name: pending.fullName, p_phone: pending.phone
      });
      if (error) return false;
    } else if (pending.kind === 'staff') {
      var { error: joinErr } = await sb.rpc('join_pharmacy_with_code', {
        p_code: pending.code, p_full_name: pending.fullName, p_phone: pending.phone
      });
      if (joinErr) return false;
    }
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

async function loadProfileAndPharmacy() {
  var uid = STATE.session.user.id;
  var { data: profile, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (error || !profile) {
    // No profile yet — if this is a returning-after-email-confirmation
    // session with a pending signup queued on this device, finish it now.
    if (await finishPendingSignupIfAny()) {
      var retry = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
      profile = retry.data;
    }
  }
  if (!profile) {
    STATE.profile = null;
    STATE.noPharmacyYet = true;
    return;
  }
  if (profile.active === false) {
    STATE.profile = null;
    STATE.disabledMessage = 'Your access to this pharmacy has been switched off by the owner. Ask them to reactivate your account.';
    return;
  }
  STATE.profile = profile;
  var { data: pharmacy } = await sb.from('pharmacies').select('*').eq('id', profile.pharmacy_id).maybeSingle();
  STATE.pharmacy = pharmacy;
  var { data: cats } = await sb.from('drug_categories').select('*').eq('pharmacy_id', profile.pharmacy_id).order('name');
  STATE.categoriesCache = cats || [];
  var { data: sups } = await sb.from('suppliers').select('*').eq('pharmacy_id', profile.pharmacy_id).order('name');
  STATE.suppliersCache = sups || [];
}

function render() {
  var app = $('#app');
  if (!STATE.session || !STATE.profile) {
    app.innerHTML = authScreen();
    if (!STATE.recoveryMode) {
      if (STATE.authMode === 'signup') renderSignup();
      else if (STATE.authMode === 'join') renderJoin();
      else renderLogin();
    }
    return;
  }
  app.innerHTML =
    '<div class="topbar"><div class="topbar-id">' + logoMarkHtml(30) + '<div><div class="brand">Hodhi</div>' +
    '<div class="sub">' + esc(STATE.pharmacy ? STATE.pharmacy.name : '') + '</div></div></div>' +
    '<button onclick="logout()">Log out</button></div>' +
    '<div class="content" id="content"></div>' +
    navBar() +
    (STATE.tab === 'sell' ? cartFab() : '');
  renderTab();
}

function navBar() {
  var items = [
    ['dashboard', 'home', t('home')],
    ['inventory', 'stock', t('stock')],
    ['sell', 'sell', t('sell')],
    ['reports', 'reports', t('reports')],
    ['settings', 'settings', t('settings')]
  ];
  return '<div class="navbar">' + items.map(function (i) {
    return '<button class="' + (STATE.tab === i[0] ? 'active' : '') + '" onclick="setTab(\'' + i[0] + '\')">' +
      '<span class="ic">' + icon(i[1], 20) + '</span>' + i[2] + '</button>';
  }).join('') + '</div>';
}

function cartFab() {
  if (!STATE.cart.length) return '';
  var n = STATE.cart.reduce(function (a, c) { return a + c.qty; }, 0);
  return '<button class="fab" onclick="openCheckout()" title="Checkout">' + icon('cart',22) + '<span style="position:absolute;top:-4px;right:-4px;background:#B3261E;color:#fff;border-radius:50%;width:20px;height:20px;font-size:11px;display:flex;align-items:center;justify-content:center;">' + n + '</span></button>';
}

function setTab(t) { STATE.tab = t; render(); }

async function logout() { await sb.auth.signOut(); STATE.tab = 'dashboard'; STATE.cart = []; render(); }

function renderTab() {
  if (STATE.tab === 'dashboard') renderDashboard();
  else if (STATE.tab === 'inventory') renderInventory();
  else if (STATE.tab === 'sell') renderSell();
  else if (STATE.tab === 'reports') renderReports();
  else if (STATE.tab === 'settings') renderSettings();
}

// ---------------------------------------------------------------------------
// PRINTING & EXCEL EXPORT — shared helpers
// ---------------------------------------------------------------------------

function letterheadHtml(title, subtitle) {
  var p = STATE.pharmacy || {};
  var metaLines = [p.address, [p.town, p.phone].filter(Boolean).join(' · '), p.email].filter(Boolean);
  return '<div class="print-letterhead">' +
    '<div class="pname">' + esc(p.name || '') + '</div>' +
    metaLines.map(function (m) { return '<div class="pmeta">' + esc(m) + '</div>'; }).join('') +
    '</div>' +
    '<div class="print-title">' + esc(title) + (subtitle ? ' — ' + esc(subtitle) : '') + '</div>';
}

function printHtml(title, subtitle, bodyHtml, footNote) {
  var area = $('#printArea');
  area.innerHTML = letterheadHtml(title, subtitle) + bodyHtml +
    '<div class="print-footer">' + (footNote ? esc(footNote) + ' · ' : '') +
    'Printed ' + new Date().toLocaleString('en-GB') + ' · Generated by Hodhi</div>';
  setTimeout(function () { window.print(); }, 30);
}

function tableHtml(headers, rows) {
  return '<table class="print-table"><thead><tr>' +
    headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + (c == null ? '' : esc(String(c))) + '</td>'; }).join('') + '</tr>'; }).join('') +
    '</tbody></table>';
}

function exportExcel(filename, sheetName, rows) {
  if (!rows.length) { toast('Nothing to export.', 'bad'); return; }
  var ws = XLSX.utils.json_to_sheet(rows);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  XLSX.writeFile(wb, filename);
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

// Desktop gets a proper split layout (brand panel + form) instead of a small
// centered card floating in a sea of empty page; mobile collapses to the
// brand mark above the form, same as before. See style.css's
// .auth-wrap/.auth-brand rules for the responsive behavior.
function authScreen() {
  if (STATE.recoveryMode) return recoveryScreen();
  var msg = STATE.disabledMessage;
  STATE.disabledMessage = null;
  return '<div class="auth-wrap">' +
    '<div class="auth-brand">' +
    logoMarkHtml(56) +
    '<div class="mark">Hodhi</div><div class="tag">Know your stock. Never run dry, never run expired.</div>' +
    '<ul class="auth-brand-list">' +
    '<li>' + icon('stock', 16) + ' Batch-level stock with automatic expiry tracking</li>' +
    '<li>' + icon('sell', 16) + ' Fast, cart-based selling with split payments</li>' +
    '<li>' + icon('reports', 16) + ' Daily, weekly and monthly reports — no month-end wait</li>' +
    '</ul>' +
    '</div>' +
    '<div class="auth-form-col"><div class="auth-card">' +
    (msg ? '<div class="card" style="border-color:#EFC3BE;background:#FBE9E7;margin-bottom:12px">' + esc(msg) + '</div>' : '') +
    '<div id="authBody"></div></div></div>' +
    '</div>';
}

function renderLogin() {
  STATE.authMode = 'login';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="field"><label>Email</label><input id="loEmail" type="email" placeholder="you@pharmacy.co.ke"></div>' +
    '<div class="field"><label>Password</label><input id="loPw" type="password" placeholder="••••••••"></div>' +
    '<div id="loErr" class="error-text"></div>' +
    '<button class="btn primary" id="loBtn" onclick="doLogin()">Log in</button>' +
    '<div class="tiny" style="text-align:center;margin-top:10px"><a href="#" onclick="renderForgotPassword();return false;">Forgot password?</a></div>' +
    '</div><div class="auth-toggle">New pharmacy? <a href="#" onclick="renderSignup();return false;">Create an account</a>' +
    ' · Joining a pharmacy? <a href="#" onclick="renderJoin();return false;">Use a staff code</a></div>';
}

function renderSignup() {
  STATE.authMode = 'signup';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="field"><label>Pharmacy name</label><input id="suPharmacy" placeholder="e.g. Rubao Mukothima Pharmacy"></div>' +
    '<div class="field"><label>Your name</label><input id="suName" placeholder="e.g. Rubao Mukothima"></div>' +
    '<div class="field"><label>Phone</label><input id="suPhone" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Email</label><input id="suEmail" type="email" placeholder="you@pharmacy.co.ke"></div>' +
    '<div class="field"><label>Password</label><input id="suPw" type="password" placeholder="At least 8 characters"></div>' +
    '<div id="suErr" class="error-text"></div>' +
    '<button class="btn primary" id="suBtn" onclick="doSignup()">Create pharmacy account</button>' +
    '</div><div class="auth-toggle">Already have an account? <a href="#" onclick="renderLogin();return false;">Log in</a>' +
    ' · Joining a pharmacy? <a href="#" onclick="renderJoin();return false;">Use a staff code</a></div>';
}

function renderJoin() {
  STATE.authMode = 'join';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="tiny" style="margin-bottom:10px">Ask the pharmacy owner for a staff invite code (Settings → Staff, in their app).</div>' +
    '<div class="field"><label>Staff code</label><input id="jnCode" placeholder="e.g. 2E530A" style="text-transform:uppercase"></div>' +
    '<div class="field"><label>Your name</label><input id="jnName" placeholder="e.g. Peter Attendant"></div>' +
    '<div class="field"><label>Phone</label><input id="jnPhone" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Email</label><input id="jnEmail" type="email" placeholder="you@example.com"></div>' +
    '<div class="field"><label>Password</label><input id="jnPw" type="password" placeholder="At least 8 characters"></div>' +
    '<div id="jnErr" class="error-text"></div>' +
    '<button class="btn primary" id="jnBtn" onclick="doJoin()">Join pharmacy</button>' +
    '</div><div class="auth-toggle"><a href="#" onclick="renderLogin();return false;">Back to log in</a></div>';
}

// Was a native browser prompt() — looks broken/untrustworthy on mobile,
// can't be styled, and some in-app browsers (e.g. opening the PWA link from
// inside WhatsApp) block it outright. A normal form field, like every other
// screen in the app, fixes both problems.
function renderForgotPassword() {
  STATE.authMode = 'forgot';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="tiny" style="margin-bottom:10px">Enter the email on your Hodhi account and we\'ll send a reset link.</div>' +
    '<div class="field"><label>Email</label><input id="fpEmail" type="email" placeholder="you@pharmacy.co.ke"></div>' +
    '<div id="fpErr" class="error-text"></div>' +
    '<button class="btn primary" id="fpBtn" onclick="doForgotPassword()">Send reset link</button>' +
    '</div><div class="auth-toggle"><a href="#" onclick="renderLogin();return false;">Back to log in</a></div>';
}

async function doForgotPassword() {
  var btn = $('#fpBtn'); var err = $('#fpErr'); err.textContent = '';
  act(btn, async function () {
    var email = $('#fpEmail').value.trim();
    if (!email) { err.textContent = 'Enter your email address.'; return; }
    var { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
    if (error) { err.textContent = friendlyError(error); return; }
    renderLogin();
    toast('Check your email for a password reset link.', 'good');
  });
}

function recoveryScreen() {
  return '<div class="auth-wrap-simple"><div class="auth-card">' +
    logoMarkHtml(44) + '<div class="mark">Hodhi</div><div class="tag">Set a new password</div>' +
    '<div class="card" style="margin-top:14px">' +
    '<div class="field"><label>New password</label><input id="rcPw" type="password" placeholder="At least 8 characters"></div>' +
    '<div id="rcErr" class="error-text"></div>' +
    '<button class="btn primary" id="rcBtn" onclick="doSetNewPassword()">Save new password</button>' +
    '</div></div></div>';
}

async function doSetNewPassword() {
  var btn = $('#rcBtn'); var err = $('#rcErr'); err.textContent = '';
  act(btn, async function () {
    var pw = $('#rcPw').value;
    if (pw.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    var { error } = await sb.auth.updateUser({ password: pw });
    if (error) { err.textContent = error.message; return; }
    STATE.recoveryMode = false;
    toast('Password updated — you are now logged in.', 'good');
    STATE.session = (await sb.auth.getSession()).data.session;
    await loadProfileAndPharmacy();
    render();
  });
}

async function doJoin() {
  var btn = $('#jnBtn'); var err = $('#jnErr'); err.textContent = '';
  act(btn, async function () {
    var code = $('#jnCode').value.trim();
    var fullName = $('#jnName').value.trim();
    var phone = $('#jnPhone').value.trim();
    var email = $('#jnEmail').value.trim();
    var pw = $('#jnPw').value;
    if (!code || !email || pw.length < 8) { err.textContent = 'Fill in the staff code, email, and an 8+ character password.'; return; }
    var { data: signUpData, error: suErr } = await sb.auth.signUp({ email: email, password: pw });
    if (suErr) { err.textContent = suErr.message; return; }
    stashPendingSignup({ kind: 'staff', code: code, fullName: fullName, phone: phone });
    if (!signUpData.session) {
      toast('Check your email to confirm the account, then log in and it will pick up your staff code automatically.', 'good');
      renderLogin();
      return;
    }
    STATE.session = signUpData.session;
    await finishPendingSignupIfAny();
    await loadProfileAndPharmacy();
    if (!STATE.profile) { err.textContent = 'Account created but joining the pharmacy failed — check the code and try logging in again.'; return; }
    render();
  });
}

async function doLogin() {
  var btn = $('#loBtn'); var err = $('#loErr'); err.textContent = '';
  act(btn, async function () {
    var email = $('#loEmail').value.trim(), pw = $('#loPw').value;
    var { error } = await sb.auth.signInWithPassword({ email: email, password: pw });
    if (error) {
      if (/email not confirmed/i.test(error.message)) {
        err.textContent = 'Confirm your email first — check your inbox (and spam folder) for the link we sent.';
      } else {
        err.textContent = error.message;
      }
      return;
    }
    STATE.session = (await sb.auth.getSession()).data.session;
    await loadProfileAndPharmacy();
    if (!STATE.profile && STATE.noPharmacyYet) {
      err.textContent = "You're logged in, but this account isn't linked to a pharmacy yet. If you just signed up, try logging in again in a moment — if that doesn't work, sign up again.";
      return;
    }
    render();
  });
}

async function doSignup() {
  var btn = $('#suBtn'); var err = $('#suErr'); err.textContent = '';
  act(btn, async function () {
    var pharmacyName = $('#suPharmacy').value.trim();
    var fullName = $('#suName').value.trim();
    var phone = $('#suPhone').value.trim();
    var email = $('#suEmail').value.trim();
    var pw = $('#suPw').value;
    if (!pharmacyName || !email || pw.length < 8) { err.textContent = 'Fill in the pharmacy name, email, and an 8+ character password.'; return; }
    var { data: signUpData, error: suErr } = await sb.auth.signUp({ email: email, password: pw });
    if (suErr) { err.textContent = suErr.message; return; }
    // Stash what they typed BEFORE checking for a session — if this Supabase
    // project requires email confirmation, signUp() returns no session at
    // all, so there's no authenticated user yet to attach a pharmacy to.
    // loadProfileAndPharmacy() finishes this automatically on their first
    // real login (see finishPendingSignupIfAny above).
    stashPendingSignup({ kind: 'owner', pharmacyName: pharmacyName, fullName: fullName, phone: phone });
    if (!signUpData.session) {
      err.textContent = '';
      toast('Check your email to confirm the account, then log in and your pharmacy will be set up automatically.', 'good');
      renderLogin();
      return;
    }
    STATE.session = signUpData.session;
    await finishPendingSignupIfAny();
    await loadProfileAndPharmacy();
    if (!STATE.profile) { err.textContent = 'Account created but pharmacy setup failed — please try logging in again.'; return; }
    render();
  });
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------

async function renderDashboard() {
  var c = $('#content');
  c.innerHTML = '<div class="empty">Loading dashboard…</div>';

  var startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  var startWeek = new Date(startToday); startWeek.setDate(startWeek.getDate() - startWeek.getDay());
  var startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1);

  var stockRes, outRes, lowRes, expRes, salesToday, salesWeek, salesMonth;
  try {
    [stockRes, outRes, lowRes, expRes, salesToday, salesWeek, salesMonth] = await Promise.all([
      sb.from('v_drug_stock').select('stock_value_retail'),
      sb.from('v_out_of_stock').select('drug_id,name,unit'),
      sb.from('v_low_stock').select('drug_id,name,unit,qty_in_stock,reorder_level'),
      sb.from('v_expiring_batches').select('*').order('expiry_date'),
      sb.from('sales').select('total_amount').gte('sold_at', startToday.toISOString()),
      sb.from('sales').select('total_amount').gte('sold_at', startWeek.toISOString()),
      sb.from('sales').select('total_amount').gte('sold_at', startMonth.toISOString())
    ]);
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderDashboard');
    return;
  }

  var stockValue = (stockRes.data || []).reduce(function (a, r) { return a + Number(r.stock_value_retail || 0); }, 0);
  var sumAmt = function (rows) { return (rows || []).reduce(function (a, r) { return a + Number(r.total_amount || 0); }, 0); };
  var outOfStock = outRes.data || [];
  var lowStock = lowRes.data || [];
  var expiring = expRes.data || [];

  c.innerHTML =
    '<div class="kpi-grid">' +
    kpi('Stock value (retail)', fmt(stockValue), 'good') +
    kpi('Sales today', fmt(sumAmt(salesToday.data)), '') +
    kpi('Sales this week', fmt(sumAmt(salesWeek.data)), '') +
    kpi('Sales this month', fmt(sumAmt(salesMonth.data)), '') +
    '</div>' +

    '<div class="section-title">Needs attention</div>' +
    '<div class="kpi-grid">' +
    kpi('Out of stock', outOfStock.length, outOfStock.length ? 'bad' : 'good') +
    kpi('Low stock', lowStock.length, lowStock.length ? 'warn' : 'good') +
    '</div>' +

    (expiring.length ? (
      '<div class="section-title">Expiring soon (within ' + (STATE.pharmacy.expiry_warn_days) + ' days)</div>' +
      '<div class="card">' + expiring.slice(0, 8).map(function (b) {
        var d = daysUntil(b.expiry_date);
        var kind = d <= 30 ? 'bad' : 'warn';
        return listRow(b.drug_name, b.quantity_remaining + ' ' + b.unit + ' · batch ' + (b.batch_no || '—'),
          '<span class="badge ' + kind + '">' + d + 'd left</span>');
      }).join('') + '</div>'
    ) : '') +

    (outOfStock.length ? (
      '<div class="section-title">Out of stock</div>' +
      '<div class="card">' + outOfStock.slice(0, 8).map(function (d) {
        return listRow(d.name, 'Reorder needed', '<span class="badge bad">0 ' + esc(d.unit) + '</span>');
      }).join('') + '</div>'
    ) : '') +

    (lowStock.length ? (
      '<div class="section-title">Low stock</div>' +
      '<div class="card">' + lowStock.slice(0, 8).map(function (d) {
        return listRow(d.name, 'Reorder level: ' + d.reorder_level, '<span class="badge warn">' + d.qty_in_stock + ' ' + esc(d.unit) + '</span>');
      }).join('') + '</div>'
    ) : '') +

    (!outOfStock.length && !lowStock.length && !expiring.length ?
      '<div class="card empty">Stock looks healthy — nothing out of stock, low, or expiring soon.</div>' : '');
}

function kpi(label, value, kind) {
  return '<div class="kpi ' + (kind || '') + '"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div></div>';
}
function listRow(name, meta, right) {
  return '<div class="list-row"><div><div class="name">' + esc(name) + '</div><div class="meta">' + meta + '</div></div><div class="right">' + right + '</div></div>';
}

// ---------------------------------------------------------------------------
// INVENTORY
// ---------------------------------------------------------------------------

var invFilter = '';

async function renderInventory() {
  var c = $('#content');
  c.innerHTML = '<div class="empty">Loading inventory…</div>';
  try {
    var { data: stock } = await sb.from('v_drug_stock').select('*').order('name');
    STATE.drugsCache = stock || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderInventory');
    return;
  }
  drawInventory();
}

var invPage = 1;
var INV_PAGE_SIZE = 50;

function drawInventory() {
  var c = $('#content');
  var q = invFilter.toLowerCase();
  var allRows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
  var rows = allRows.slice(0, invPage * INV_PAGE_SIZE);
  c.innerHTML =
    '<div class="searchbox field"><input placeholder="Search drugs…" value="' + esc(invFilter) + '" oninput="invFilter=this.value;invPage=1;drawInventory()"></div>' +
    '<div class="toolbar-row">' +
    (can('edit_inventory') ? '<button class="btn secondary" onclick="openAddDrug()">' + t('addDrug') + '</button>' : '') +
    (can('edit_inventory') ? '<button class="btn ghost" onclick="openImportExcel()">' + icon('upload',15) + ' Import</button>' : '') +
    '<button class="btn ghost" onclick="exportInventoryExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn ghost" onclick="printInventory()">' + icon('printer',15) + ' Print</button>' +
    '</div>' +
    (can('restock') ? '<div class="toolbar-row"><button class="btn ghost" onclick="openReorderList()">' + icon('clipboard',15) + ' Reorder list</button></div>' : '') +
    '<div class="card">' + (rows.length ? rows.map(function (d) {
      var badge = d.qty_in_stock === 0 ? '<span class="badge bad">Out</span>'
        : d.qty_in_stock <= d.reorder_level ? '<span class="badge warn">Low</span>'
        : '<span class="badge good">OK</span>';
      var expBadge = d.soonest_expiry ? (daysUntil(d.soonest_expiry) <= (STATE.pharmacy.expiry_warn_days || 90)
        ? ' <span class="badge ' + (daysUntil(d.soonest_expiry) <= 30 ? 'bad' : 'warn') + '">exp ' + fmtDate(d.soonest_expiry) + '</span>' : '') : '';
      return '<div class="list-row" onclick="openDrugDetail(\'' + d.drug_id + '\')" style="cursor:pointer">' +
        '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + fmt(d.stock_value_retail) + ' in stock value' + expBadge + '</div></div>' +
        '<div class="right">' + badge + '<div class="meta">' + d.qty_in_stock + ' ' + esc(d.unit) + '</div></div></div>';
    }).join('') : '<div class="empty">No drugs match. Try clearing the search or add a new one.</div>') + '</div>' +
    (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="invPage++;drawInventory()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : '');
}

function exportInventoryExcel() {
  var rows = STATE.drugsCache.map(function (d) {
    return {
      'Drug': d.name,
      'Unit': d.unit,
      'Qty in stock': d.qty_in_stock,
      'Reorder level': d.reorder_level,
      'Status': d.qty_in_stock === 0 ? 'OUT OF STOCK' : d.qty_in_stock <= d.reorder_level ? 'LOW STOCK' : 'OK',
      'Soonest expiry': d.soonest_expiry ? fmtDate(d.soonest_expiry) : '',
      'Stock value (cost)': Number(d.stock_value_cost || 0),
      'Stock value (retail)': Number(d.stock_value_retail || 0)
    };
  });
  exportExcel((STATE.pharmacy.name || 'Hodhi') + ' - stock - ' + todayStr() + '.xlsx', 'Stock', rows);
}

function printInventory() {
  var rows = STATE.drugsCache.map(function (d) {
    var status = d.qty_in_stock === 0 ? 'OUT OF STOCK' : d.qty_in_stock <= d.reorder_level ? 'LOW STOCK' : 'OK';
    return [d.name, d.qty_in_stock + ' ' + d.unit, status, d.soonest_expiry ? fmtDate(d.soonest_expiry) : '—', fmt(d.stock_value_retail)];
  });
  var totalValue = STATE.drugsCache.reduce(function (a, d) { return a + Number(d.stock_value_retail || 0); }, 0);
  printHtml('Stock Take', todayStr(),
    tableHtml(['Drug', 'Qty in stock', 'Status', 'Soonest expiry', 'Stock value'], rows),
    (STATE.drugsCache.length) + ' drugs · Total stock value ' + fmt(totalValue));
}

function todayStr() { return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }

// ---------------------------------------------------------------------------
// BULK IMPORT — the whole reason this app exists is a spreadsheet just like
// this one; re-typing 300 rows by hand defeats the point. Accepts a flexible
// column layout (matches the columns pharmacists already use: Drug, Qty,
// Price, Expiry…) and understands the "12.2027" (month.year) expiry format
// seen in real stock-take sheets, not just proper dates.
// ---------------------------------------------------------------------------

function downloadImportTemplate() {
  var rows = [{
    'Drug': 'Amoxiclav 228 susp', 'Category': 'Antibiotics/Antifungals/Amoebicides', 'Form': 'syrup',
    'Unit': 'bottle', 'Qty': 20, 'Cost Price': 150, 'Sell Price': 200, 'Expiry': '12.2027',
    'Batch No': '', 'Supplier': ''
  }];
  exportExcel('Hodhi - import template.xlsx', 'Stock', rows);
}

// Parses "12.2027" (month.year, as seen in real stock-take sheets), a
// proper date string, or an Excel date object — returns 'YYYY-MM-DD' (last
// day of the month for the month.year form) or null if unreadable.
function parseFlexibleExpiry(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10);
  var s = String(val).trim();
  var m = s.match(/^(\d{1,2})\.(\d{4})$/);
  if (m) {
    var month = parseInt(m[1], 10), year = parseInt(m[2], 10);
    if (month >= 1 && month <= 12) {
      var lastDay = new Date(year, month, 0).getDate();
      return year + '-' + String(month).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
    }
  }
  var d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

function openImportExcel() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = function () {
    if (!input.files.length) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        previewImport(rows);
      } catch (err) {
        toast('Could not read that file — is it a valid Excel/CSV file?', 'bad');
      }
    };
    reader.readAsArrayBuffer(input.files[0]);
  };
  input.click();
}

function previewImport(rawRows) {
  var parsed = [];
  var skipped = 0;
  rawRows.forEach(function (r) {
    var get = function (keys) {
      for (var i = 0; i < keys.length; i++) {
        var k = Object.keys(r).find(function (rk) { return rk.trim().toLowerCase() === keys[i]; });
        if (k && String(r[k]).trim() !== '') return r[k];
      }
      return null;
    };
    var name = get(['drug', 'name', 'drug name']);
    var qty = parseInt(get(['qty', 'quantity']), 10);
    var sellPrice = parseFloat(get(['sell price', 'price', 'price per unit']));
    var expiryRaw = get(['expiry', 'exp dt', 'expiry date']);
    var expiry = parseFlexibleExpiry(expiryRaw);
    if (!name || !qty || qty <= 0 || !sellPrice || !expiry) { skipped++; return; }
    parsed.push({
      name: String(name).trim(),
      category: get(['category']) || '',
      form: (get(['form']) || 'other').toString().toLowerCase(),
      unit: get(['unit']) || 'unit',
      qty: qty,
      costPrice: parseFloat(get(['cost price'])) || null,
      sellPrice: sellPrice,
      expiry: expiry,
      batchNo: get(['batch no', 'batch']) || null,
      supplier: get(['supplier']) || null
    });
  });

  var body = sheet('Import preview', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + parsed.length + ' rows ready to import' +
    (skipped ? ', ' + skipped + ' skipped (missing drug name, quantity, sell price, or a readable expiry date)' : '') + '.</div>' +
    '<div class="card" style="max-height:260px;overflow-y:auto">' +
    (parsed.length ? parsed.slice(0, 50).map(function (p) {
      return listRow(p.name, p.qty + ' ' + p.unit + ' · exp ' + fmtDate(p.expiry), fmt(p.sellPrice));
    }).join('') : '<div class="empty">Nothing importable was found in that file.</div>') +
    (parsed.length > 50 ? '<div class="tiny" style="margin-top:8px">…and ' + (parsed.length - 50) + ' more</div>' : '') +
    '</div>' +
    (parsed.length ? '<button class="btn primary" id="impBtn" onclick="runImport(' + "'" + btoa(encodeURIComponent(JSON.stringify(parsed))) + "'" + ')">Import ' + parsed.length + ' rows</button>' : '') +
    '<button class="btn ghost" style="margin-top:8px" onclick="downloadImportTemplate()">Download a blank template instead</button>';
}

async function runImport(encoded) {
  var rows = JSON.parse(decodeURIComponent(atob(encoded)));
  var btn = $('#impBtn');
  act(btn, async function () {
    var catByName = {};
    STATE.categoriesCache.forEach(function (c) { catByName[c.name.toLowerCase()] = c.id; });
    var drugByName = {};
    STATE.drugsCache.forEach(function (d) { drugByName[d.name.toLowerCase()] = d.drug_id; });
    // also pick up drugs already in the DB that might not be in the (stock>0) cache
    var { data: allDrugs } = await sb.from('drugs').select('id, name').eq('pharmacy_id', STATE.profile.pharmacy_id);
    (allDrugs || []).forEach(function (d) { drugByName[d.name.toLowerCase()] = d.id; });

    var imported = 0, failed = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      try {
        var drugId = drugByName[r.name.toLowerCase()];
        if (!drugId) {
          var validForms = ['tablet', 'capsule', 'syrup', 'injection', 'cream_ointment', 'drops', 'suppository', 'inhaler', 'iv_fluid', 'other'];
          var { data: newDrug, error: dErr } = await sb.from('drugs').insert({
            pharmacy_id: STATE.profile.pharmacy_id,
            name: r.name,
            form: validForms.indexOf(r.form) !== -1 ? r.form : 'other',
            unit: r.unit,
            category_id: r.category ? (catByName[r.category.toLowerCase()] || null) : null
          }).select().single();
          if (dErr) throw dErr;
          drugId = newDrug.id;
          drugByName[r.name.toLowerCase()] = drugId;
        }
        var { error: rErr } = await sb.rpc('record_restock', {
          p_pharmacy_id: STATE.profile.pharmacy_id,
          p_drug_id: drugId,
          p_quantity: r.qty,
          p_cost_price: r.costPrice,
          p_sell_price: r.sellPrice,
          p_expiry_date: r.expiry,
          p_batch_no: r.batchNo,
          p_supplier: r.supplier
        });
        if (rErr) throw rErr;
        imported++;
      } catch (e) {
        failed++;
      }
    }
    toast('Imported ' + imported + ' rows' + (failed ? ', ' + failed + ' failed' : '') + '.', failed ? 'warn' : 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
// REORDER LIST — a proactive "what to buy" list from what's low/out, instead
// of waiting to notice at the counter.
// ---------------------------------------------------------------------------

var pendingReorderList = [];

function openReorderList() {
  var needed = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; })
    .map(function (d) {
      var suggested = Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5);
      return { name: d.name, unit: d.unit, current: d.qty_in_stock, reorderLevel: d.reorder_level, suggested: suggested };
    });
  pendingReorderList = needed;
  var body = sheet('Reorder list', '');
  body.innerHTML =
    '<div class="toolbar-row">' +
    '<button class="btn ghost" onclick="exportReorderExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn ghost" onclick="printReorderList()">' + icon('printer',15) + ' Print</button>' +
    '</div>' +
    '<div class="card">' + (needed.length ? needed.map(function (n) {
      return listRow(n.name, 'Have ' + n.current + ' ' + n.unit + ' · reorder level ' + n.reorderLevel, '<b>Order ' + n.suggested + '</b>');
    }).join('') : '<div class="empty">Nothing needs reordering right now.</div>') + '</div>';
}

function exportReorderExcel() {
  var rows = pendingReorderList.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Hodhi') + ' - reorder list.xlsx', 'Reorder', rows);
}

function printReorderList() {
  var needed = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; });
  var rows = needed.map(function (d) {
    var suggested = Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5);
    return [d.name, d.qty_in_stock + ' ' + d.unit, d.reorder_level, suggested];
  });
  printHtml('Reorder List', todayStr(), tableHtml(['Drug', 'Current stock', 'Reorder level', 'Suggested order'], rows), needed.length + ' items');
}

function openAddDrug() {
  var catOptions = STATE.categoriesCache.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
  var body = sheet('Add a drug', '');
  body.innerHTML =
    '<div class="field"><label>Drug name</label><input id="dName" placeholder="e.g. Amoxiclav 228 susp"></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Form</label><select id="dForm">' +
      ['tablet', 'capsule', 'syrup', 'injection', 'cream_ointment', 'drops', 'suppository', 'inhaler', 'iv_fluid', 'other']
        .map(function (f) { return '<option value="' + f + '">' + f.replace('_', '/') + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field"><label>Unit</label><input id="dUnit" placeholder="tablet, bottle, vial…"></div></div>' +
    '<div class="field"><label>Category</label><select id="dCat"><option value="">— none —</option>' + catOptions + '</select></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Reorder level</label><input id="dReorder" type="number" value="' + (STATE.pharmacy.low_stock_default || 5) + '"></div>' +
    '<div class="field"><label>Prescription only?</label><select id="dRx"><option value="false">No</option><option value="true">Yes</option></select></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Pack size (optional)</label><input id="dPackSize" type="number" placeholder="e.g. 100"></div>' +
    '<div class="field"><label>Pack label (optional)</label><input id="dPackLabel" placeholder="e.g. box"></div></div>' +
    '<div class="tiny" style="margin-bottom:10px">Pack size just speeds up restocking later — e.g. "100" + "box" lets you enter "3 boxes" instead of typing 300.</div>' +
    '<button class="btn primary" id="dSaveBtn" onclick="saveNewDrug()">Save drug</button>' +
    '<div class="tiny" style="margin-top:10px">Add its first batch (quantity, price, expiry) right after saving.</div>';
}

async function saveNewDrug() {
  var btn = $('#dSaveBtn');
  act(btn, async function () {
    var name = $('#dName').value.trim();
    if (!name) { toast('Give the drug a name.', 'bad'); return; }
    var payload = {
      pharmacy_id: STATE.profile.pharmacy_id,
      name: name,
      form: $('#dForm').value,
      unit: $('#dUnit').value.trim() || 'unit',
      category_id: $('#dCat').value || null,
      reorder_level: parseInt($('#dReorder').value, 10) || 5,
      is_prescription: $('#dRx').value === 'true',
      pack_size: parseInt($('#dPackSize').value, 10) || null,
      pack_label: $('#dPackLabel').value.trim() || null
    };
    var { data, error } = await sb.from('drugs').insert(payload).select().single();
    if (error) { toast(error.message, 'bad'); return; }
    toast('Drug added.', 'good');
    openRestock(encodeDrugForRestock(data));
  });
}

function encodeDrugForRestock(drug) { return btoa(encodeURIComponent(JSON.stringify(drug))); }

async function openDrugDetail(drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  if (!d) return;
  var { data: drugRow } = await sb.from('drugs').select('*').eq('id', drugId).single();
  var { data: batches } = await sb.from('batches').select('*').eq('drug_id', drugId).order('expiry_date');
  var body = sheet(d.name, '');
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('In stock', d.qty_in_stock + ' ' + esc(d.unit), '') +
    kpi('Stock value', fmt(d.stock_value_retail), '') +
    '</div>' +
    (can('restock') ? '<button class="btn primary" style="margin-bottom:14px" onclick="closeSheet();openRestock(' + "'" + encodeDrugForRestock(drugRow) + "'" + ')">+ Restock this drug</button>' : '') +
    '<div class="section-title">Batches</div>' +
    (batches && batches.length ? batches.map(function (b) {
      var d2 = daysUntil(b.expiry_date);
      var kind = b.quantity_remaining === 0 ? 'muted' : d2 < 0 ? 'bad' : d2 <= 30 ? 'bad' : d2 <= 90 ? 'warn' : 'good';
      var discountBadge = b.discount_percent > 0 ? ' <span class="badge warn">-' + b.discount_percent + '%</span>' : '';
      return '<div class="list-row"><div><div class="name">' + esc(b.batch_no || 'Batch') + ' · ' + fmtDate(b.expiry_date) + discountBadge + '</div>' +
        '<div class="meta">Received ' + fmtDate(b.received_at) + (b.supplier ? ' from ' + esc(b.supplier) : '') + '</div>' +
        (can('write_off') && b.quantity_remaining > 0 ? '<div class="toolbar-row" style="margin-top:6px">' +
          '<button class="btn ghost small" onclick="openWriteOff(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.quantity_remaining + ')">Write off</button>' +
          '<button class="btn ghost small" onclick="openCorrection(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.quantity_remaining + ')">Correct count</button>' +
          (can('discount') ? '<button class="btn ghost small" onclick="openDiscount(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.discount_percent + ')">Mark down</button>' : '') +
          '</div>' : '') +
        '</div><div class="right"><span class="badge ' + kind + '">' + b.quantity_remaining + ' left</span></div></div>';
    }).join('') : '<div class="empty">No batches yet.</div>');
}

function openRestock(encodedDrug) {
  var drug = JSON.parse(decodeURIComponent(atob(encodedDrug)));
  var body = sheet('Restock: ' + drug.name, '');
  var supplierOptions = STATE.suppliersCache.map(function (s) { return '<option value="' + esc(s.name) + '">'; }).join('');
  body.innerHTML =
    (drug.pack_size ? '<div class="field"><label>Number of ' + esc(drug.pack_label || 'packs') + ' (× ' + drug.pack_size + ' ' + esc(drug.unit) + ' each)</label>' +
      '<input id="rPacks" type="number" min="1" oninput="document.getElementById(\'rQty\').value = (parseInt(this.value,10)||0) * ' + drug.pack_size + '"></div>' : '') +
    '<div class="row-2">' +
    '<div class="field"><label>Quantity (' + esc(drug.unit) + ')</label><input id="rQty" type="number" min="1"></div>' +
    '<div class="field"><label>Expiry date</label><input id="rExp" type="date"></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Cost price / unit</label><input id="rCost" type="number" step="0.01"></div>' +
    '<div class="field"><label>Sell price / unit</label><input id="rSell" type="number" step="0.01" value="' + (drug.default_price || '') + '"></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Batch no. (optional)</label><input id="rBatch"></div>' +
    '<div class="field"><label>Supplier (optional)</label><input id="rSupplier" list="rSupplierList"><datalist id="rSupplierList">' + supplierOptions + '</datalist></div></div>' +
    '<button class="btn primary" id="rSaveBtn" onclick="saveRestock(\'' + drug.id + '\')">Save restock</button>';
}

async function saveRestock(drugId) {
  var btn = $('#rSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#rQty').value, 10);
    var exp = $('#rExp').value;
    var sell = parseFloat($('#rSell').value);
    if (!qty || qty <= 0) { toast('Enter a valid quantity.', 'bad'); return; }
    if (!exp) { toast('Enter the expiry date.', 'bad'); return; }
    if (!sell) { toast('Enter the sell price.', 'bad'); return; }
    var supplierName = $('#rSupplier').value.trim() || null;
    var matchedSupplier = supplierName ? STATE.suppliersCache.find(function (s) { return s.name.toLowerCase() === supplierName.toLowerCase(); }) : null;
    var { error } = await sb.rpc('record_restock', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_drug_id: drugId,
      p_quantity: qty,
      p_cost_price: parseFloat($('#rCost').value) || null,
      p_sell_price: sell,
      p_expiry_date: exp,
      p_batch_no: $('#rBatch').value.trim() || null,
      p_supplier: supplierName,
      p_supplier_id: matchedSupplier ? matchedSupplier.id : null
    });
    if (error) { toast(error.message, 'bad'); return; }
    toast('Restocked.', 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
// WRITE-OFF, CORRECTION, DISCOUNT — the stock-movement actions the spec was
// missing: disposing of expired/damaged stock, reconciling a physical
// count, and marking down a near-expiry batch instead of a total write-off.
// ---------------------------------------------------------------------------

function openWriteOff(batchId, drugName, maxQty) {
  var body = sheet('Write off: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + maxQty + ' left in this batch.</div>' +
    '<div class="field"><label>Type</label><select id="woType">' +
    '<option value="expired_disposal">Expired — disposed of</option>' +
    '<option value="write_off">Damaged / other write-off</option></select></div>' +
    '<div class="field"><label>Quantity</label><input id="woQty" type="number" min="1" max="' + maxQty + '"></div>' +
    '<div class="field"><label>Reason / notes</label><textarea id="woReason" rows="2"></textarea></div>' +
    '<button class="btn danger" id="woSaveBtn" onclick="saveWriteOff(\'' + batchId + '\')">Write off stock</button>';
}

async function saveWriteOff(batchId) {
  var btn = $('#woSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#woQty').value, 10);
    if (!qty || qty <= 0) { toast('Enter a valid quantity.', 'bad'); return; }
    // Write-offs permanently remove stock with no undo — a fat-fingered tap
    // at a busy counter shouldn't be able to do that with zero friction.
    if (!confirm('Write off ' + qty + ' unit(s)? This cannot be undone.')) return;
    var { error } = await sb.rpc('record_write_off', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_quantity: qty,
      p_reason: $('#woReason').value.trim() || null, p_type: $('#woType').value
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Recorded.', 'good');
    closeSheet();
    renderInventory();
  });
}

function openCorrection(batchId, drugName, currentQty) {
  var body = sheet('Correct count: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">System currently shows ' + currentQty + '. Enter what you actually counted.</div>' +
    '<div class="field"><label>Actual quantity</label><input id="coQty" type="number" min="0" value="' + currentQty + '"></div>' +
    '<div class="field"><label>Reason / notes</label><textarea id="coReason" rows="2" placeholder="e.g. physical stock take, 30 Sep"></textarea></div>' +
    '<button class="btn primary" id="coSaveBtn" onclick="saveCorrection(\'' + batchId + '\')">Save correction</button>';
}

async function saveCorrection(batchId) {
  var btn = $('#coSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#coQty').value, 10);
    if (qty === '' || isNaN(qty) || qty < 0) { toast('Enter a valid quantity.', 'bad'); return; }
    var { error } = await sb.rpc('record_correction', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_new_quantity: qty,
      p_reason: $('#coReason').value.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Corrected.', 'good');
    closeSheet();
    renderInventory();
  });
}

function openDiscount(batchId, drugName, currentDiscount) {
  var body = sheet('Mark down: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Sell this batch below list price instead of writing it off when it expires — the discount applies automatically at checkout.</div>' +
    '<div class="field"><label>Discount %</label><input id="dcPct" type="number" min="0" max="100" value="' + (currentDiscount || 0) + '"></div>' +
    '<button class="btn primary" id="dcSaveBtn" onclick="saveDiscount(\'' + batchId + '\')">Save</button>';
}

async function saveDiscount(batchId) {
  var btn = $('#dcSaveBtn');
  act(btn, async function () {
    var pct = parseFloat($('#dcPct').value);
    if (isNaN(pct) || pct < 0 || pct > 100) { toast('Enter a percent between 0 and 100.', 'bad'); return; }
    var { error } = await sb.from('batches').update({ discount_percent: pct }).eq('id', batchId);
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast(pct > 0 ? 'Markdown set — applies automatically when this batch sells.' : 'Markdown removed.', 'good');
    closeSheet();
    renderInventory();
  });
}

// ---------------------------------------------------------------------------
// SELL
// ---------------------------------------------------------------------------

var sellFilter = '';
var heldSalesCache = [];

async function renderSell() {
  var c = $('#content');
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

function drawSell() {
  var c = $('#content');
  var q = sellFilter.toLowerCase();
  var rows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
  c.innerHTML =
    (heldSalesCache.length ? heldSalesCard() : '') +
    '<div class="searchbox field"><input placeholder="Search a drug to sell…" value="' + esc(sellFilter) + '" oninput="sellFilter=this.value;drawSell()"></div>' +
    (STATE.cart.length ? cartSummaryCard() : '') +
    '<div class="card">' + (rows.length ? rows.map(function (d) {
      return '<div class="list-row" onclick="addToCart(\'' + d.drug_id + '\')" style="cursor:pointer">' +
        '<div><div class="name">' + esc(d.name) + (d.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + d.qty_in_stock + ' ' + esc(d.unit) + ' available' + (d.default_price ? ' · ' + fmt(d.default_price) : '') + '</div></div>' +
        '<div class="right btn small secondary">Add</div></div>';
    }).join('') : '<div class="empty">Nothing in stock matches that search.</div>') + '</div>';
}

function heldSalesCard() {
  return '<div class="card"><div class="section-title" style="margin-top:0">Held sales (' + heldSalesCache.length + ')</div>' +
    heldSalesCache.map(function (h) {
      var cart = h.cart || [];
      var total = cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
      return '<div class="list-row"><div><div class="name">' + esc(h.label || 'Held sale') + '</div><div class="meta">' + cart.length + ' item(s) · ' + fmt(total) + ' · ' + new Date(h.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</div></div>' +
        '<div class="right" style="display:flex;gap:6px"><button class="btn small secondary" onclick="resumeHeldSale(\'' + h.id + '\')">Resume</button><button class="btn small danger" onclick="deleteHeldSale(\'' + h.id + '\')">' + icon('close',14) + '</button></div></div>';
    }).join('') + '</div>';
}

async function holdSale() {
  if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
  var label = prompt('Label for this held sale (optional) — e.g. customer name or counter number:') || null;
  var { error } = await sb.from('held_sales').insert({
    pharmacy_id: STATE.profile.pharmacy_id, label: label, cart: STATE.cart, created_by: STATE.session.user.id
  });
  if (error) { toast(friendlyError(error), 'bad'); return; }
  STATE.cart = [];
  toast('Sale held. Resume it any time from the Sell tab.', 'good');
  renderSell();
}

function resumeHeldSale(id) {
  var h = heldSalesCache.find(function (x) { return x.id === id; });
  if (!h) return;
  if (STATE.cart.length && !confirm('This will replace your current cart with the held sale. Continue?')) return;
  STATE.cart = h.cart || [];
  sb.from('held_sales').delete().eq('id', id).then(function () {
    heldSalesCache = heldSalesCache.filter(function (x) { return x.id !== id; });
    drawSell();
  });
}

async function deleteHeldSale(id) {
  if (!confirm('Discard this held sale? Its items are not deducted from stock, so nothing to undo.')) return;
  await sb.from('held_sales').delete().eq('id', id);
  heldSalesCache = heldSalesCache.filter(function (x) { return x.id !== id; });
  drawSell();
}

function cartSummaryCard() {
  var total = STATE.cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  return '<div class="card"><div class="section-title" style="margin-top:0">Cart</div>' +
    STATE.cart.map(function (item, i) {
      return '<div class="cart-line"><div><div class="name">' + esc(item.name) + (item.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + fmt(item.price) + ' each' + (item.patient_name ? ' · Patient: ' + esc(item.patient_name) : '') + '</div></div>' +
        '<div class="qty-ctrl"><button onclick="changeQty(' + i + ',-1)">−</button><span>' + item.qty + '</span><button onclick="changeQty(' + i + ',1)">+</button></div></div>';
    }).join('') +
    '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(total) + '</div></div>' +
    '<div class="toolbar-row" style="margin-top:10px"><button class="btn ghost" onclick="holdSale()">⏸ Hold</button><button class="btn primary" onclick="openCheckout()">Checkout</button></div></div>';
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

function openRxCapture(d) {
  var body = sheet('Prescription details — ' + d.name, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">This is a prescription-only drug. Record who it is for.</div>' +
    '<div class="field"><label>Patient name</label><input id="rxPatient" placeholder="Required"></div>' +
    '<div class="field"><label>Prescriber name (optional)</label><input id="rxPrescriber"></div>' +
    '<button class="btn primary" id="rxSaveBtn" onclick="confirmRxCapture(\'' + d.drug_id + '\')">Add to cart</button>';
}

function confirmRxCapture(drugId) {
  var d = STATE.drugsCache.find(function (x) { return x.drug_id === drugId; });
  if (!d) return;
  var patient = $('#rxPatient').value.trim();
  if (!patient) { toast('Patient name is required for a prescription drug.', 'bad'); return; }
  var prescriber = $('#rxPrescriber').value.trim() || null;
  STATE.cart.push({
    drug_id: drugId, name: d.name, unit: d.unit, price: d.default_price || 0, qty: 1, stock: d.qty_in_stock,
    is_prescription: true, patient_name: patient, prescriber_name: prescriber
  });
  closeSheet();
  drawSell();
}

function changeQty(i, delta) {
  var item = STATE.cart[i];
  item.qty += delta;
  if (item.qty <= 0) STATE.cart.splice(i, 1);
  drawSell();
}

var checkoutPayments = [];

function openCheckout() {
  if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
  var total = STATE.cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  checkoutPayments = [{ method: 'cash', amount: total, reference: '' }];
  var body = sheet('Checkout — ' + fmt(total), '');
  body.id = 'checkoutBody';
  body.dataset.total = total;
  drawCheckoutPayments();
}

function drawCheckoutPayments() {
  var body = $('#checkoutBody');
  var total = parseFloat(body.dataset.total);
  var paid = checkoutPayments.reduce(function (a, p) { return a + (parseFloat(p.amount) || 0); }, 0);
  var balance = Math.round((total - paid) * 100) / 100;
  body.innerHTML =
    '<div class="section-title" style="margin-top:0">Payment</div>' +
    checkoutPayments.map(function (p, i) {
      var needsRef = p.method === 'mpesa' || p.method === 'insurance' || p.method === 'bank';
      return '<div class="card" style="margin-bottom:8px">' +
        '<div class="row-2">' +
        '<div class="field" style="margin-bottom:6px"><label>Method</label><select onchange="setPaymentField(' + i + ',\'method\',this.value)">' +
        ['cash', 'mpesa', 'insurance', 'bank', 'other'].map(function (m) {
          return '<option value="' + m + '"' + (p.method === m ? ' selected' : '') + '>' + m.charAt(0).toUpperCase() + m.slice(1) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field" style="margin-bottom:6px"><label>Amount</label><input type="number" step="0.01" value="' + p.amount + '" oninput="setPaymentField(' + i + ',\'amount\',this.value)"></div>' +
        '</div>' +
        (needsRef ? '<div class="field" style="margin-bottom:0"><label>' + (p.method === 'insurance' ? 'Scheme / member no.' : 'Reference') + '</label><input value="' + esc(p.reference || '') + '" oninput="setPaymentField(' + i + ',\'reference\',this.value)"></div>' : '') +
        (checkoutPayments.length > 1 ? '<button class="btn small danger" style="margin-top:8px" onclick="removePaymentLine(' + i + ')">Remove</button>' : '') +
        '</div>';
    }).join('') +
    '<button class="btn ghost small" onclick="addPaymentLine()">+ Split into another payment method</button>' +
    '<div class="list-row"><div class="name">Balance</div><div class="name" style="color:' + (balance === 0 ? 'var(--green)' : 'var(--red)') + '">' + fmt(balance) + '</div></div>' +
    '<div class="field"><label>Customer name (optional)</label><input id="pCustomer" value="' + esc($('#pCustomer') ? $('#pCustomer').value : '') + '"></div>' +
    '<button class="btn primary" id="pSaveBtn" ' + (balance !== 0 ? 'disabled' : '') + ' onclick="completeSale()">Confirm sale — ' + fmt(total) + '</button>';
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
    var soldItems = STATE.cart.slice();
    var items = soldItems.map(function (c) {
      return { drug_id: c.drug_id, quantity: c.qty, patient_name: c.patient_name || null, prescriber_name: c.prescriber_name || null };
    });
    var payments = checkoutPayments.map(function (p) {
      return { method: p.method, amount: parseFloat(p.amount) || 0, reference: p.reference || null };
    });
    var customer = $('#pCustomer').value.trim() || null;
    var insuranceLine = payments.find(function (p) { return p.method === 'insurance'; });
    var { data: saleId, error } = await sb.rpc('record_sale', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_items: items,
      p_payments: payments,
      p_customer_name: customer,
      p_insurance_scheme: insuranceLine ? insuranceLine.reference : null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    if (insuranceLine) {
      await sb.from('insurance_claims').insert({
        pharmacy_id: STATE.profile.pharmacy_id, sale_id: saleId,
        scheme: insuranceLine.reference || 'Unspecified', amount: insuranceLine.amount, status: 'pending'
      });
    }
    toast('Sale recorded.', 'good');
    STATE.cart = [];
    var invoiceNo = null;
    try { var { data: s } = await sb.from('sales').select('invoice_number').eq('id', saleId).single(); invoiceNo = s ? s.invoice_number : null; } catch (e) {}
    showReceipt(soldItems, payments, customer, invoiceNo);
    renderSell();
  });
}

var pendingReceipt = null; // holds the last completed sale for the print button below

function showReceipt(items, payments, customer, invoiceNo) {
  var total = items.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  pendingReceipt = { items: items, payments: payments, customer: customer, invoiceNo: invoiceNo, total: total };
  var body = sheet('Sale complete' + (invoiceNo ? ' — ' + invoiceNo : ''), '');
  body.innerHTML =
    '<div class="card">' + items.map(function (it) {
      return listRow(it.name + (it.patient_name ? ' (' + esc(it.patient_name) + ')' : ''), it.qty + ' × ' + fmt(it.price), fmt(it.qty * it.price));
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
  extra.push('Payment: ' + d.payments.map(function (p) { return p.method + (p.reference ? ' (' + p.reference + ')' : '') + ' ' + fmt(p.amount); }).join(', '));
  printHtml('Receipt', new Date().toLocaleString('en-GB'),
    '<p style="margin:4px 0">' + extra.join(' · ') + '</p>' +
    tableHtml(['Item', 'Qty', 'Unit price', 'Line total'], rows) +
    '<p style="text-align:right;font-weight:700;margin-top:10px">Total: ' + fmt(d.total) + '</p>');
}

// ---------------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------------

var reportRange = 'today';
var reportData = null; // last-loaded report, kept for export/print

async function renderReports() {
  drawReportsShell();
  await loadReport();
}

function drawReportsShell() {
  var c = $('#content');
  c.innerHTML =
    '<div class="row-3" style="margin-bottom:14px">' +
    ['today', 'week', 'month'].map(function (r) {
      return '<button class="btn ' + (reportRange === r ? 'primary' : 'ghost') + ' small" onclick="reportRange=\'' + r + '\';loadReport()">' + r[0].toUpperCase() + r.slice(1) + '</button>';
    }).join('') + '</div>' +
    '<div class="toolbar-row">' +
    '<button class="btn ghost" onclick="exportReportExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn ghost" onclick="printReport()">' + icon('printer',15) + ' Print</button>' +
    '</div>' +
    '<div id="reportBody"><div class="empty">Loading…</div></div>';
}

function exportReportExcel() {
  if (!reportData) { toast('Report still loading.', 'bad'); return; }
  var rows = reportData.sales.map(function (s) {
    var pays = reportData.paymentsBySale[s.id] || [];
    return {
      'Invoice': s.invoice_number || '',
      'Date/time': new Date(s.sold_at).toLocaleString('en-GB'),
      'Amount': Number(s.total_amount || 0),
      'Payment method(s)': pays.map(function (p) { return p.method; }).join('+') || s.payment_method,
      'Reference(s)': pays.map(function (p) { return p.reference || ''; }).filter(Boolean).join('; '),
      'Customer': s.customer_name || '',
      'Insurance scheme': s.insurance_scheme || '',
      'Voided': s.voided ? 'Yes' : ''
    };
  });
  exportExcel((STATE.pharmacy.name || 'Hodhi') + ' - sales - ' + reportRange + ' - ' + todayStr() + '.xlsx', 'Sales', rows);
}

function printReport() {
  if (!reportData) { toast('Report still loading.', 'bad'); return; }
  var rows = reportData.sales.map(function (s) {
    var pays = reportData.paymentsBySale[s.id] || [];
    return [s.invoice_number || '', new Date(s.sold_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      fmt(s.total_amount), pays.map(function (p) { return p.method; }).join('+') || s.payment_method, s.customer_name || '—'];
  });
  var rangeLabel = reportRange.charAt(0).toUpperCase() + reportRange.slice(1);
  var summary = '<p style="margin:6px 0 14px"><b>Total sales:</b> ' + fmt(reportData.total) + ' · <b>Transactions:</b> ' + reportData.sales.length + '</p>';
  printHtml('Sales Report', rangeLabel,
    summary + tableHtml(['Invoice', 'Date/time', 'Amount', 'Payment', 'Customer'], rows),
    reportData.sales.length + ' transactions');
}

var reportTxPage = 1;
var TX_PAGE_SIZE = 20;

async function loadReport() {
  drawReportsShell();
  reportTxPage = 1;
  var start = new Date();
  if (reportRange === 'today') start.setHours(0, 0, 0, 0);
  else if (reportRange === 'week') { start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay()); }
  else { start = new Date(start.getFullYear(), start.getMonth(), 1); }

  var saleIds = [];
  var sales, items = [], payments = [];
  try {
    var salesRes = await sb.from('sales').select('*').gte('sold_at', start.toISOString()).order('sold_at', { ascending: false });
    sales = salesRes.data;
    (sales || []).forEach(function (s) { saleIds.push(s.id); });
    if (saleIds.length) {
      var itemsRes = await sb.from('sale_items').select('id, sale_id, drug_id, quantity, unit_price, line_total, patient_name, prescriber_name, drugs(name)').in('sale_id', saleIds);
      items = itemsRes.data || [];
      var paysRes = await sb.from('sales_payments').select('*').in('sale_id', saleIds);
      payments = paysRes.data || [];
    }
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadReport');
    return;
  }

  var total = (sales || []).filter(function (s) { return !s.voided; }).reduce(function (a, s) { return a + Number(s.total_amount || 0); }, 0);
  var byMethod = {};
  payments.forEach(function (p) {
    var sale = (sales || []).find(function (s) { return s.id === p.sale_id; });
    if (sale && sale.voided) return;
    byMethod[p.method] = (byMethod[p.method] || 0) + Number(p.amount || 0);
  });

  var itemsBySale = {}, paymentsBySale = {};
  items.forEach(function (it) { (itemsBySale[it.sale_id] = itemsBySale[it.sale_id] || []).push(it); });
  payments.forEach(function (p) { (paymentsBySale[p.sale_id] = paymentsBySale[p.sale_id] || []).push(p); });

  var byDrug = {};
  items.forEach(function (it) {
    var sale = (sales || []).find(function (s) { return s.id === it.sale_id; });
    if (sale && sale.voided) return;
    var name = it.drugs ? it.drugs.name : 'Unknown';
    if (!byDrug[name]) byDrug[name] = { qty: 0, value: 0 };
    byDrug[name].qty += it.quantity;
    byDrug[name].value += Number(it.line_total || 0);
  });
  var topDrugs = Object.keys(byDrug).map(function (name) { return { name: name, qty: byDrug[name].qty, value: byDrug[name].value }; })
    .sort(function (a, b) { return b.qty - a.qty; }).slice(0, 8);

  reportData = { sales: sales || [], total: total, byMethod: byMethod, topDrugs: topDrugs, itemsBySale: itemsBySale, paymentsBySale: paymentsBySale };

  drawReportBody();
  if (can('claims')) loadClaims();
}

function drawReportBody() {
  var body = $('#reportBody');
  var sales = reportData.sales, byMethod = reportData.byMethod, topDrugs = reportData.topDrugs;
  var visible = sales.slice(0, reportTxPage * TX_PAGE_SIZE);
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Total sales', fmt(reportData.total), 'good') +
    kpi('Transactions', sales.length, '') +
    '</div>' +
    '<div class="section-title">By payment method</div>' +
    '<div class="card">' + (Object.keys(byMethod).length ? Object.keys(byMethod).map(function (m) {
      return listRow(m.charAt(0).toUpperCase() + m.slice(1), '', fmt(byMethod[m]));
    }).join('') : '<div class="empty">No sales in this period yet.</div>') + '</div>' +
    '<div class="section-title">Top-selling drugs</div>' +
    '<div class="card">' + (topDrugs.length ? topDrugs.map(function (t) {
      return listRow(t.name, t.qty + ' units sold', fmt(t.value));
    }).join('') : '<div class="empty">No sales in this period yet.</div>') + '</div>' +
    '<div class="section-title">Transactions</div>' +
    '<div class="card">' + (sales.length ? visible.map(function (s) {
      var pays = reportData.paymentsBySale[s.id] || [];
      var methodLabel = pays.length > 1 ? 'split' : (pays[0] ? pays[0].method : s.payment_method);
      return '<div class="list-row" style="cursor:pointer" onclick="openSaleDetail(\'' + s.id + '\')">' +
        '<div><div class="name">' + (s.invoice_number ? esc(s.invoice_number) + ' · ' : '') + fmt(s.total_amount) + (s.voided ? ' <span class="badge bad">Voided</span>' : '') + '</div>' +
        '<div class="meta">' + new Date(s.sold_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' · ' + methodLabel + '</div></div>' +
        '<div class="right">' + (s.customer_name ? '<span class="tiny">' + esc(s.customer_name) + '</span>' : '') + '</div></div>';
    }).join('') : '<div class="empty">Nothing recorded yet.</div>') + '</div>' +
    (sales.length > visible.length ? '<button class="btn ghost" onclick="reportTxPage++;drawReportBody()">Load more</button>' : '') +
    '<div id="claimsSection"></div>';
}

function openSaleDetail(saleId) {
  var s = reportData.sales.find(function (x) { return x.id === saleId; });
  if (!s) return;
  var items = reportData.itemsBySale[saleId] || [];
  var pays = reportData.paymentsBySale[saleId] || [];
  var body = sheet((s.invoice_number || 'Sale detail') + (s.voided ? ' — VOIDED' : ''), '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:8px">' + new Date(s.sold_at).toLocaleString('en-GB') + (s.customer_name ? ' · ' + esc(s.customer_name) : '') + '</div>' +
    (s.voided ? '<div class="badge bad" style="margin-bottom:10px">Voided' + (s.void_reason ? ': ' + esc(s.void_reason) : '') + '</div>' : '') +
    '<div class="section-title" style="margin-top:0">Items</div>' +
    '<div class="card">' + items.map(function (it) {
      var name = it.drugs ? it.drugs.name : 'Unknown';
      return '<div class="list-row"><div><div class="name">' + esc(name) + (it.patient_name ? ' (' + esc(it.patient_name) + ')' : '') + '</div>' +
        '<div class="meta">' + it.quantity + ' × ' + fmt(it.unit_price) + '</div></div>' +
        '<div class="right">' + fmt(it.line_total) +
        (!s.voided && can('return') ? '<div><button class="btn small ghost" style="margin-top:4px" onclick="openReturnItem(\'' + it.id + '\',' + it.quantity + ',\'' + esc(name).replace(/'/g, "\\'") + '\')">Return</button></div>' : '') +
        '</div></div>';
    }).join('') + '</div>' +
    '<div class="section-title">Payments</div>' +
    '<div class="card">' + pays.map(function (p) {
      return listRow(p.method.charAt(0).toUpperCase() + p.method.slice(1), p.reference || '', fmt(p.amount));
    }).join('') + '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(s.total_amount) + '</div></div></div>' +
    (!s.voided && can('void') ? '<button class="btn danger" onclick="openVoidSale(\'' + saleId + '\')">Void entire sale</button>' : '');
}

function openReturnItem(saleItemId, maxQty, drugName) {
  var body = sheet('Return — ' + drugName, '');
  body.innerHTML =
    '<div class="field"><label>Quantity to return (max ' + maxQty + ')</label><input id="retQty" type="number" min="1" max="' + maxQty + '" value="1"></div>' +
    '<div class="field"><label>Reason (optional)</label><input id="retReason"></div>' +
    '<button class="btn danger" id="retSaveBtn" onclick="doReturnItem(\'' + saleItemId + '\')">Confirm return</button>';
}

async function doReturnItem(saleItemId) {
  var btn = $('#retSaveBtn');
  act(btn, async function () {
    var qty = parseInt($('#retQty').value, 10);
    if (!qty || qty < 1) { toast('Enter a valid quantity.', 'bad'); return; }
    var { error } = await sb.rpc('record_return', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_sale_item_id: saleItemId, p_quantity: qty,
      p_reason: $('#retReason').value.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Return recorded — stock restored.', 'good');
    closeSheet();
    loadReport();
  });
}

function openVoidSale(saleId) {
  var body = sheet('Void this sale?', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">This restores all sold stock and marks the sale voided. Cannot be undone.</div>' +
    '<div class="field"><label>Reason</label><input id="voidReason" placeholder="Required"></div>' +
    '<button class="btn danger" id="voidSaveBtn" onclick="doVoidSale(\'' + saleId + '\')">Void sale</button>';
}

async function doVoidSale(saleId) {
  var btn = $('#voidSaveBtn');
  act(btn, async function () {
    var reason = $('#voidReason').value.trim();
    if (!reason) { toast('A reason is required.', 'bad'); return; }
    var { error } = await sb.rpc('void_sale', { p_pharmacy_id: STATE.profile.pharmacy_id, p_sale_id: saleId, p_reason: reason });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Sale voided.', 'good');
    closeSheet();
    loadReport();
  });
}

// ---------------------------------------------------------------------------
// INSURANCE CLAIMS — created automatically at checkout when a payment line
// uses "insurance"; tracked here through to paid/rejected.
// ---------------------------------------------------------------------------

var claimsCache = [];

async function loadClaims() {
  try {
    var { data } = await sb.from('insurance_claims').select('*').order('created_at', { ascending: false }).limit(100);
    claimsCache = data || [];
  } catch (e) { claimsCache = []; }
  drawClaims();
}

function drawClaims() {
  var el = $('#claimsSection');
  if (!el) return;
  if (!claimsCache.length) { el.innerHTML = ''; return; }
  var pendingTotal = claimsCache.filter(function (c) { return c.status === 'pending'; }).reduce(function (a, c) { return a + Number(c.amount || 0); }, 0);
  el.innerHTML =
    '<div class="section-title">Insurance claims' + (pendingTotal ? ' — ' + fmt(pendingTotal) + ' pending' : '') + '</div>' +
    '<div class="toolbar-row"><button class="btn ghost" onclick="exportClaimsExcel()">' + icon('download',15) + ' Excel</button></div>' +
    '<div class="card">' + claimsCache.map(function (c) {
      return '<div class="list-row"><div><div class="name">' + esc(c.scheme) + '</div><div class="meta">' + new Date(c.created_at).toLocaleDateString('en-GB') + (c.claim_number ? ' · ' + esc(c.claim_number) : '') + '</div></div>' +
        '<div class="right"><div>' + fmt(c.amount) + '</div><select style="margin-top:4px" onchange="updateClaimStatus(\'' + c.id + '\',this.value)">' +
        ['pending', 'submitted', 'paid', 'rejected'].map(function (s) { return '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>'; }).join('') +
        '</select></div></div>';
    }).join('') + '</div>';
}

async function updateClaimStatus(id, status) {
  var { error } = await sb.from('insurance_claims').update({ status: status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { toast(friendlyError(error), 'bad'); return; }
  var c = claimsCache.find(function (x) { return x.id === id; });
  if (c) c.status = status;
  toast('Claim updated.', 'good');
}

function exportClaimsExcel() {
  var rows = claimsCache.map(function (c) {
    return { 'Date': new Date(c.created_at).toLocaleDateString('en-GB'), 'Scheme': c.scheme, 'Claim number': c.claim_number || '', 'Amount': Number(c.amount || 0), 'Status': c.status };
  });
  exportExcel((STATE.pharmacy.name || 'Hodhi') + ' - insurance claims - ' + todayStr() + '.xlsx', 'Claims', rows);
}

// ---------------------------------------------------------------------------
// SETTINGS — business profile (name, address, phone…) printed on every
// report/receipt, plus the low-stock and expiry-warning thresholds.
// ---------------------------------------------------------------------------

async function renderSettings() {
  var c = $('#content');
  var p = STATE.pharmacy || {};
  var isOwner = STATE.profile.role === 'owner';
  c.innerHTML = '<div class="empty">Loading settings…</div>';

  var staff = [];
  var invites = [];
  if (isOwner) {
    try {
      var staffRes = await sb.from('profiles').select('*').order('role');
      staff = staffRes.data || [];
      var invRes = await sb.from('staff_invites').select('*').is('used_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false });
      invites = invRes.data || [];
    } catch (e) { /* staff panel just shows empty — not worth blocking the whole settings page over */ }
  }

  c.innerHTML =
    '<div class="section-title" style="margin-top:0">Business details</div>' +
    '<div class="tiny" style="margin-bottom:10px">These appear as the letterhead on every printed report and receipt.</div>' +
    '<div class="card">' +
    '<div class="field"><label>Pharmacy name</label><input id="stName" value="' + esc(p.name || '') + '" ' + (isOwner ? '' : 'disabled') + '></div>' +
    '<div class="field"><label>Physical address</label><textarea id="stAddress" rows="2" placeholder="e.g. Rubao Market, Tharaka-Nithi County" ' + (isOwner ? '' : 'disabled') + '>' + esc(p.address || '') + '</textarea></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Town</label><input id="stTown" value="' + esc(p.town || '') + '" ' + (isOwner ? '' : 'disabled') + '></div>' +
    '<div class="field"><label>Phone</label><input id="stPhone" value="' + esc(p.phone || '') + '" ' + (isOwner ? '' : 'disabled') + '></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Email (optional)</label><input id="stEmail" value="' + esc(p.email || '') + '" ' + (isOwner ? '' : 'disabled') + '></div>' +
    '<div class="field"><label>KRA PIN (optional)</label><input id="stKra" value="' + esc(p.kra_pin || '') + '" ' + (isOwner ? '' : 'disabled') + '></div></div>' +
    (isOwner ? '<button class="btn primary" id="stSaveBtn" onclick="saveSettings()">Save business details</button>' :
      '<div class="tiny">Only the pharmacy owner can edit these.</div>') +
    '</div>' +

    '<div class="section-title">Alert thresholds</div>' +
    '<div class="card">' +
    '<div class="row-2">' +
    '<div class="field"><label>Default reorder level (new drugs)</label><input id="stLowDefault" type="number" value="' + (p.low_stock_default || 5) + '" ' + (isOwner ? '' : 'disabled') + '></div>' +
    '<div class="field"><label>"Expiring soon" window (days)</label><input id="stExpiryDays" type="number" value="' + (p.expiry_warn_days || 90) + '" ' + (isOwner ? '' : 'disabled') + '></div></div>' +
    '<div class="field"><label>VAT rate (%)</label><input id="stVat" type="number" step="0.01" value="' + (p.vat_rate || 16) + '" ' + (isOwner ? '' : 'disabled') + '></div>' +
    (isOwner ? '<button class="btn secondary" id="stSaveThresholdsBtn" onclick="saveSettings()">Save thresholds</button>' : '') +
    '</div>' +

    (can('suppliers') ? (
      '<div class="section-title">Suppliers</div>' +
      '<div class="card">' +
      (STATE.suppliersCache.length ? STATE.suppliersCache.map(function (s) {
        return listRow(s.name, [s.phone, s.town].filter(Boolean).join(' · '), '');
      }).join('') : '<div class="tiny" style="margin-bottom:10px">No suppliers saved yet.</div>') +
      '<button class="btn secondary small" style="margin-top:10px" onclick="openAddSupplier()">+ Add supplier</button>' +
      '</div>'
    ) : '') +

    (isOwner ? (
      '<div class="section-title">Staff</div>' +
      '<div class="card">' +
      (staff.length ? staff.map(function (s) {
        var isMe = s.id === STATE.profile.id;
        var badge = s.active === false ? '<span class="badge bad">Disabled</span>' : '<span class="badge good">Active</span>';
        return '<div class="list-row"><div><div class="name">' + esc(s.full_name || '(no name)') + (isMe ? ' (you)' : '') + '</div>' +
          '<div class="meta">' + esc(s.role) + (s.phone ? ' · ' + esc(s.phone) : '') + '</div></div>' +
          '<div class="right">' + badge +
          (isMe ? '' : '<div style="margin-top:6px"><button class="btn ghost small" onclick="toggleStaffActive(\'' + s.id + '\',' + (s.active === false) + ')">' +
            (s.active === false ? 'Reactivate' : 'Disable') + '</button></div>') +
          '</div></div>';
      }).join('') : '<div class="tiny">Just you so far.</div>') +
      (invites.length ? '<div class="tiny" style="margin-top:10px">Unused invite codes: ' +
        invites.map(function (i) { return '<b>' + esc(i.code) + '</b> (' + esc(i.role) + ')'; }).join(', ') + '</div>' : '') +
      '<div class="toolbar-row" style="margin-top:10px">' +
      '<button class="btn secondary small" onclick="openInviteStaff(\'pharmacist\')">+ Invite pharmacist</button>' +
      '<button class="btn secondary small" onclick="openInviteStaff(\'attendant\')">+ Invite seller</button>' +
      '</div></div>'
    ) : '') +

    '<div class="section-title">Account</div>' +
    '<div class="card">' +
    '<div class="tiny" style="margin-bottom:10px">Signed in as ' + esc(STATE.profile.full_name || '') + ' (' + esc(STATE.profile.role) + ')</div>' +
    '<div class="field"><label>Language / Lugha</label><select id="stLang" onchange="saveLanguage(this.value)">' +
    '<option value="en"' + (STATE.profile.language === 'en' || !STATE.profile.language ? ' selected' : '') + '>English</option>' +
    '<option value="sw"' + (STATE.profile.language === 'sw' ? ' selected' : '') + '>Kiswahili</option>' +
    '</select></div></div>';
}

async function saveLanguage(lang) {
  await sb.from('profiles').update({ language: lang }).eq('id', STATE.profile.id);
  STATE.profile.language = lang;
  render();
}

function openAddSupplier() {
  var body = sheet('Add supplier', '');
  body.innerHTML =
    '<div class="field"><label>Name</label><input id="spName"></div>' +
    '<div class="row-2"><div class="field"><label>Phone</label><input id="spPhone"></div>' +
    '<div class="field"><label>Email</label><input id="spEmail"></div></div>' +
    '<div class="field"><label>Address</label><input id="spAddress"></div>' +
    '<button class="btn primary" id="spSaveBtn" onclick="saveSupplier()">Save supplier</button>';
}

async function saveSupplier() {
  var btn = $('#spSaveBtn');
  act(btn, async function () {
    var name = $('#spName').value.trim();
    if (!name) { toast('Give the supplier a name.', 'bad'); return; }
    var { error } = await sb.from('suppliers').insert({
      pharmacy_id: STATE.profile.pharmacy_id, name: name,
      phone: $('#spPhone').value.trim() || null, email: $('#spEmail').value.trim() || null,
      address: $('#spAddress').value.trim() || null
    });
    if (error) { toast(error.message, 'bad'); return; }
    var { data: sups } = await sb.from('suppliers').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id).order('name');
    STATE.suppliersCache = sups || [];
    toast('Supplier added.', 'good');
    closeSheet();
    renderSettings();
  });
}

function openInviteStaff(role) {
  var body = sheet('Invite a ' + (role === 'pharmacist' ? 'pharmacist' : 'seller'), '');
  body.innerHTML = '<div class="tiny">Generating a one-time code…</div>';
  sb.rpc('create_staff_invite', { p_pharmacy_id: STATE.profile.pharmacy_id, p_role: role }).then(function (res) {
    if (res.error) { body.innerHTML = '<div class="error-text">' + esc(res.error.message) + '</div>'; return; }
    body.innerHTML =
      '<div class="tiny" style="margin-bottom:10px">Share this code with them — they enter it under "Joining a pharmacy?" when they sign up. It expires in 7 days.</div>' +
      '<div style="font-size:32px;font-weight:800;letter-spacing:4px;text-align:center;padding:20px;background:var(--green-light);border-radius:12px;color:var(--green)">' + esc(res.data) + '</div>' +
      '<button class="btn ghost" style="margin-top:14px" onclick="closeSheet()">Done</button>';
  });
}

async function toggleStaffActive(profileId, makeActive) {
  var { error } = await sb.from('profiles').update({ active: makeActive }).eq('id', profileId);
  if (error) { toast(friendlyError(error), 'bad'); return; }
  toast(makeActive ? 'Reactivated.' : 'Access disabled.', 'good');
  renderSettings();
}

async function saveSettings() {
  var btn = $('#stSaveBtn') || $('#stSaveThresholdsBtn');
  act(btn, async function () {
    var payload = {
      name: $('#stName').value.trim(),
      address: $('#stAddress').value.trim() || null,
      town: $('#stTown').value.trim() || null,
      phone: $('#stPhone').value.trim() || null,
      email: $('#stEmail').value.trim() || null,
      kra_pin: $('#stKra').value.trim() || null,
      low_stock_default: parseInt($('#stLowDefault').value, 10) || 5,
      expiry_warn_days: parseInt($('#stExpiryDays').value, 10) || 90,
      vat_rate: parseFloat($('#stVat').value) || 16
    };
    var { error } = await sb.from('pharmacies').update(payload).eq('id', STATE.profile.pharmacy_id);
    if (error) { toast(error.message, 'bad'); return; }
    STATE.pharmacy = Object.assign({}, STATE.pharmacy, payload);
    toast('Saved.', 'good');
    render();
  });
}

// ---------------------------------------------------------------------------
init();
