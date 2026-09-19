/* Pharma — Pharmacy Stock & Sales. Vanilla JS, no build step, same spirit as
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
  masterDrugsCache: [],   // shared reference catalog for the "Sync common drugs" onboarding flow
  syncSelected: {},        // { master_drug_id: {qty, sellPrice, reorderLevel, expiry, costPrice} } while that sheet is open
  lpoSelected: {},         // { drug_id: {qty, costPrice, sellPrice, expiry, expiryUnknown, batchNo} } while the New LPO sheet is open
  authMode: 'login'    // 'login' | 'signup' | 'join'
};

// ---------------------------------------------------------------------------
// ACCESS CONTROL (item 3 — see schema.sql section 7 for the matching
// database-level enforcement, which is the real gate: everything here is
// just what the UI offers, so an action a role can't reach still can't be
// forced through the RPC/RLS layer either) — fixed roles, preset
// permissions (not a customizable per-role toggle screen):
//   owner / co_owner — see/do everything; co_owner is full equal access
//     to owner in every practical sense (only the literal 'owner' value
//     itself, set once at pharmacy creation, is special — see schema.sql).
//   pharmacist — day-to-day stock & sales, not business settings or staff.
//   stock_taker — view & count inventory, restock, and view reports; no
//     selling, no write-offs, no suppliers/expenses/financial access.
//   attendant ("seller") — only sells and looks things up, nothing that
//     changes stock or money rules.
//   accountant — financial oversight only (reports/suppliers/expenses/
//     claims), no write access anywhere; always a time-limited temporary
//     account redeemed via the same staff-invite code flow as any other
//     role, never a regular permanent account (see openInviteStaff).
// Anyone not explicitly added (no profiles row at all) has no access —
// enforced by loadProfileAndPharmacy() finding no row and by every RLS
// policy requiring a matching profiles row via my_pharmacy_id()/my_role().
// ---------------------------------------------------------------------------
var PHARMACIST_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export',
  'edit_inventory', 'restock', 'write_off', 'correct_stock', 'return', 'void', 'discount', 'claims', 'suppliers', 'expenses'];
var ATTENDANT_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export'];
// Friendly labels for the 6 fixed roles — used anywhere a role is shown to
// a person (staff list, invite picker, "signed in as", account-expired
// messaging), so the raw enum value (e.g. 'stock_taker') is never printed.
var ROLE_LABELS = { owner: 'Owner', co_owner: 'Co-owner', pharmacist: 'Pharmacist', stock_taker: 'Stock taker', attendant: 'Seller', accountant: 'Accountant' };
function roleLabel(r) { return ROLE_LABELS[r] || r; }

var STOCK_TAKER_ACTIONS = ['view_dashboard', 'view_inventory', 'view_reports', 'print', 'export', 'restock', 'correct_stock'];
// 'view_suppliers'/'view_expenses' (read-only) are deliberately distinct
// from 'suppliers'/'expenses' (full read+write, see PHARMACIST_ACTIONS) —
// an accountant should see the Suppliers/Expenses tabs and every figure on
// them, but never the write actions (new supplier, new LPO, record
// payment, new expense, reverse expense) that live on those same screens.
var ACCOUNTANT_ACTIONS = ['view_dashboard', 'view_reports', 'print', 'export', 'claims', 'view_suppliers', 'view_expenses'];

function can(action) {
  if (!STATE.profile) return false;
  var role = STATE.profile.role;
  if (role === 'owner' || role === 'co_owner') return true;
  if (role === 'pharmacist') return PHARMACIST_ACTIONS.indexOf(action) !== -1;
  if (role === 'stock_taker') return STOCK_TAKER_ACTIONS.indexOf(action) !== -1;
  if (role === 'accountant') return ACCOUNTANT_ACTIONS.indexOf(action) !== -1;
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
    logOut: 'Log out', addDrug: '+ Add new drug', checkout: 'Checkout', total: 'Total',
    suppliers: 'Suppliers', expenses: 'Expenses'
  },
  sw: {
    home: 'Nyumbani', stock: 'Bidhaa', sell: 'Uza', reports: 'Ripoti', settings: 'Mipangilio',
    dashboard: 'Dashibodi', stockValue: 'Thamani ya bidhaa (rejareja)', salesToday: 'Mauzo leo',
    salesWeek: 'Mauzo wiki hii', salesMonth: 'Mauzo mwezi huu', needsAttention: 'Yanayohitaji uangalizi',
    outOfStock: 'Bidhaa zilizoisha', lowStock: 'Bidhaa chache', expiringSoon: 'Zinakaribia kuisha muda',
    logOut: 'Toka', addDrug: '+ Ongeza dawa mpya', checkout: 'Lipa', total: 'Jumla',
    suppliers: 'Wasambazaji', expenses: 'Matumizi'
  }
};
// English only for now, enforced regardless of what's stored on the
// profile — the Swahili strings above only cover a handful of nav/headline
// labels (see the comment on STRINGS), so switching a pharmacist into it
// mid-app would show a confusing mix of translated and untranslated text.
// Once Swahili is fully translated, this can go back to reading
// STATE.profile.language.
function t(key) {
  return STRINGS.en[key] || key;
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
  box: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M8 8V6.5a4 4 0 0 1 8 0V8"/>',
  truck: '<rect x="2.5" y="7" width="11" height="9" rx="1"/><path d="M13.5 10h4l3 3v3h-7z"/><circle cx="7" cy="18.5" r="1.6"/><circle cx="16.5" cy="18.5" r="1.6"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1H5a2 2 0 0 0-2 2Z"/><path d="M3 8v10a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z"/><circle cx="16" cy="14.5" r="1.4"/>',
  // Item 33 (mobile dashboard redesign): the date-range calendar-picker button.
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>'
};
function icon(name, size) {
  var s = size || 18;
  return '<svg class="ic-svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
}
// The brand mark used on the auth screen, topbar and loading screen — a
// rounded badge in brand green with the "P" letterform, matching the app's
// icon set (icons/icon-*.png) instead of plain unstyled text.
function logoMarkHtml(size) {
  var s = size || 44;
  return '<div class="brand-badge" style="width:' + s + 'px;height:' + s + 'px;font-size:' + Math.round(s * 0.5) + 'px">P</div>';
}

function $(sel, ctx) { return (ctx || document).querySelector(sel); }

// PHARMA_PROJECT_STATUS.md item 28: this app's render model rebuilds a
// whole container's innerHTML on every state change — simple and fine for
// most screens, but a live "search as you type" box redraws its own
// container on every keystroke, which recreates the <input> DOM node from
// scratch and drops focus/cursor position. That's what made typing feel
// like it "blocks" after one character until you click back in — the box
// wasn't actually broken, it was just losing focus on every redraw. This
// restores focus (and cursor position, for text inputs) to the same
// element by id across a redraw. Used by the handful of search boxes that
// redraw their own container (Inventory, Sync common drugs, Sell, new LPO).
function redrawKeepingFocus(container, html) {
  var active = document.activeElement;
  var activeId = (active && container.contains(active) && active.id) ? active.id : null;
  var selStart = null, selEnd = null;
  if (activeId && typeof active.selectionStart === 'number') { selStart = active.selectionStart; selEnd = active.selectionEnd; }
  container.innerHTML = html;
  if (activeId) {
    var el = document.getElementById(activeId);
    if (el) {
      el.focus();
      if (selStart !== null && el.setSelectionRange) {
        try { el.setSelectionRange(selStart, selEnd); } catch (e) {}
      }
    }
  }
}
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
// Bug fix (system-wide): this already disabled the button on click, but
// never changed what it SHOWED — a busy button looked identical to a live
// one (same label, same near-full opacity), so an impatient tap while a
// request was in flight looked like it hadn't registered, and people
// tapped again. Now it visibly swaps to "Please wait…" the instant it's
// clicked and only restores the original label (icon included — this uses
// innerHTML, not textContent) once the request settles, so a duplicate tap
// literally can't do anything: the element is disabled AND clearly busy the
// whole time. Every "Save"/"Confirm"/"Record" button already goes through
// this helper; using it is what makes a new action button safe by default.
function act(btn, fn) {
  if (!btn) { fn().catch(function (e) { toast(friendlyError(e), 'bad'); }); return; }
  var original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Please wait…';
  fn().catch(function (e) { toast(friendlyError(e), 'bad'); })
    .finally(function () { btn.disabled = false; btn.innerHTML = original; });
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
      '<div class="auth-wrap-simple"><div class="auth-card">' + logoMarkHtml(44) + '<div class="mark">Pharma</div>' +
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

// Pharma logs in with a phone number, not an email — pharmacy staff in
// Kenya reliably have a phone number, not necessarily an email address they
// check. Supabase Auth's password flow is still email-shaped under the
// hood, so we derive a stable, non-deliverable "auth email" from the
// phone number and use that everywhere sb.auth.* wants an email. The real
// phone number is what the person types and sees; this derived address
// never appears in the UI. Normalizing to a consistent digit form (07... ->
// 2547...) means "0712345678" and "+254712345678" log into the same
// account.
function normalizePhone(raw) {
  var digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.charAt(0) === '0') digits = '254' + digits.slice(1);
  else if (digits.length === 9) digits = '254' + digits;
  return digits;
}
function phoneToAuthEmail(phone) {
  return 'p' + normalizePhone(phone) + '@hodhi.local';
}

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
  // Item 3: a temporary account (e.g. an accountant's time-limited code)
  // past its account_expires_at — my_pharmacy_id()/my_role() already
  // refuse it everything at the database level, but the profile row
  // itself is still readable (see schema.sql's "read colleagues in same
  // pharmacy" policy) precisely so this specific message can be shown
  // instead of a generic/blank one.
  if (profile.account_expires_at && new Date(profile.account_expires_at) <= new Date()) {
    STATE.profile = null;
    STATE.disabledMessage = 'Your temporary access has expired. Ask the pharmacy owner for a new code.';
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
    '<div class="topbar"><div class="topbar-id">' + logoMarkHtml(30) + '<div><div class="brand">Pharma</div>' +
    '<div class="sub">' + esc(STATE.pharmacy ? STATE.pharmacy.name : '') + '</div></div></div>' +
    '<button onclick="logout()">Log out</button></div>' +
    '<div class="content" id="content"></div>' +
    navBar() +
    (STATE.tab === 'sell' ? cartFab() : '');
  renderTab();
}

// Same markup renders as the phone's bottom tab bar and the desktop's full
// left sidebar (see style.css's .navbar rules) — the brand block and the
// account footer are written here too, but stay hidden (display:none)
// until the desktop layout has room for them.
function navBar() {
  // Item 3: dashboard/reports/settings are on every role's list, so they
  // stay unconditional — but inventory and sell aren't (e.g. accountant
  // has neither, stock_taker has no 'sell'), so they're now gated the same
  // way suppliers/expenses already were.
  var items = [['dashboard', 'home', t('home')]];
  if (can('view_inventory')) items.push(['inventory', 'stock', t('stock')]);
  if (can('sell')) items.push(['sell', 'sell', t('sell')]);
  var seeSuppliers = can('suppliers') || can('view_suppliers');
  var seeExpenses = can('expenses') || can('view_expenses');
  if (seeSuppliers) items.push(['suppliers', 'truck', t('suppliers')]);
  if (seeExpenses) items.push(['expenses', 'wallet', t('expenses')]);
  items.push(['reports', 'reports', t('reports')]);
  items.push(['settings', 'settings', t('settings')]);
  var p = STATE.profile || {};
  var pharmacy = STATE.pharmacy || {};
  return '<div class="navbar">' +
    '<div class="navbar-brand">' + logoMarkHtml(38) + '<div class="word">Pharma</div></div>' +
    items.map(function (i) {
      return '<button class="' + (STATE.tab === i[0] ? 'active' : '') + '" onclick="setTab(\'' + i[0] + '\')">' +
        '<span class="ic">' + icon(i[1], 20) + '</span>' + i[2] + '</button>';
    }).join('') +
    '<div class="navbar-spacer"></div>' +
    '<div class="navbar-foot"><div class="who">' + esc(pharmacy.name || '') + '</div>' +
    '<div class="role">' + esc(p.full_name || '') + (p.role ? ' · ' + esc(roleLabel(p.role)) : '') + '</div></div>' +
    '</div>';
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
  else if (STATE.tab === 'suppliers') renderSuppliers();
  else if (STATE.tab === 'expenses') renderExpenses();
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
    'Printed ' + new Date().toLocaleString('en-GB') + ' · Generated by Pharma</div>';
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

// Desktop gets a proper split layout (green brand panel with floating stat
// cards + form) instead of a small centered card floating in a sea of empty
// page; mobile gets the same green panel collapsed into a curved-gradient
// hero above the form, with a "Trusted by pharmacists worldwide" trust line.
// Sketched against Kodi's own login/signup screens and approved (headline
// wording, trust line, stat-card colors) before being wired up here — see
// style.css's .auth-wrap/.auth-brand rules for the responsive behavior.
// The headline and the tag below it share the same fixed max-width + centered
// auto-wrap technique (see .auth-brand-headline/.auth-brand-tag in
// style.css) specifically so the headline visually centers on the same axis
// as the tag beneath it, instead of each line just centering inside the
// full-width panel independently.
function authScreen() {
  if (STATE.recoveryMode) return recoveryScreen();
  var msg = STATE.disabledMessage;
  STATE.disabledMessage = null;
  // auth-bg-fill is a full-bleed absolutely-positioned green layer behind
  // EVERYTHING (mobile only — disabled at 900px, where auth-brand paints its
  // own green instead) so the hero text, the card and the trust line all sit
  // on ONE continuous green screen, exactly like the approved sketch —
  // instead of auth-brand's green box ending right after its own text and
  // the card floating in a separate, differently-colored section below it.
  // auth-brand-trust lives at the auth-wrap level (a sibling of auth-brand/
  // auth-form-col, not nested inside auth-brand) so it can be pinned via
  // position:absolute to the bottom of the FULL screen, not just to the
  // bottom of the short text block.
  return '<div class="auth-wrap">' +
    '<div class="auth-bg-fill"></div>' +
    '<div class="auth-brand">' +
    '<div class="auth-brand-top">' +
    logoMarkHtml(56) +
    '<h1 class="auth-brand-headline">Know Your Stock<br>Never Run Dry</h1>' +
    '<div class="auth-brand-tag">Batches, sales, expiry tracking and reports &mdash; everything a pharmacy needs, in one place.</div>' +
    '</div>' +
    '<div class="auth-brand-line line-top"></div>' +
    '<div class="auth-stat-stack">' +
    '<div class="auth-stat-card s1"><div class="auth-stat-lab">Sales this month</div><div class="auth-stat-val">KES 480,500</div></div>' +
    '<div class="auth-stat-card s2"><div class="auth-stat-lab">Drugs tracked</div><div class="auth-stat-val">312 Drugs</div></div>' +
    '<div class="auth-stat-card s3"><div class="auth-stat-lab">Batches monitored</div><div class="auth-stat-val">1,140 Batches</div><div class="auth-stat-sub">Expiry-tracked</div></div>' +
    '</div>' +
    '<div class="auth-brand-line line-bottom"></div>' +
    '</div>' +
    '<div class="auth-form-col"><div class="auth-card">' +
    (msg ? '<div class="card" style="border-color:#EFC3BE;background:#FBE9E7;margin-bottom:12px">' + esc(msg) + '</div>' : '') +
    '<div id="authBody"></div></div></div>' +
    '<div class="auth-brand-trust">Trusted by pharmacists worldwide &#127757;</div>' +
    '</div>';
}

function renderLogin() {
  STATE.authMode = 'login';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="field"><label>Phone number</label><input id="loPhone" type="tel" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Password</label><input id="loPw" type="password" placeholder="••••••••"></div>' +
    '<div id="loErr" class="error-text"></div>' +
    '<button class="btn primary" id="loBtn" onclick="doLogin()">Log in</button>' +
    '<div class="tiny" style="text-align:center;margin-top:10px"><a href="#" onclick="renderForgotPassword();return false;">Forgot password?</a></div>' +
    '</div><div class="auth-toggle"><a href="#" onclick="renderSignup();return false;">Create an account</a>' +
    ' · <a href="#" onclick="renderJoin();return false;">Staff Login</a></div>';
}

function renderSignup() {
  STATE.authMode = 'signup';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="field"><label>Pharmacy name</label><input id="suPharmacy" placeholder="e.g. Rubao Mukothima Pharmacy"></div>' +
    '<div class="field"><label>Your name</label><input id="suName" placeholder="e.g. Rubao Mukothima"></div>' +
    '<div class="field"><label>Phone number</label><input id="suPhone" type="tel" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Password</label><input id="suPw" type="password" placeholder="At least 8 characters"></div>' +
    '<div id="suErr" class="error-text"></div>' +
    '<button class="btn primary" id="suBtn" onclick="doSignup()">Create pharmacy account</button>' +
    '</div><div class="auth-toggle"><a href="#" onclick="renderLogin();return false;">Log in</a>' +
    ' · <a href="#" onclick="renderJoin();return false;">Staff Login</a></div>';
}

function renderJoin() {
  STATE.authMode = 'join';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML =
    '<div class="card">' +
    '<div class="tiny" style="margin-bottom:10px">Ask the pharmacy owner for a staff invite code (Settings → Staff, in their app).</div>' +
    '<div class="field"><label>Staff code</label><input id="jnCode" placeholder="e.g. 2E530A" style="text-transform:uppercase"></div>' +
    '<div class="field"><label>Your name</label><input id="jnName" placeholder="e.g. Peter Attendant"></div>' +
    '<div class="field"><label>Phone number</label><input id="jnPhone" type="tel" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Password</label><input id="jnPw" type="password" placeholder="At least 8 characters"></div>' +
    '<div id="jnErr" class="error-text"></div>' +
    '<button class="btn primary" id="jnBtn" onclick="doJoin()">Join pharmacy</button>' +
    '</div><div class="auth-toggle"><a href="#" onclick="renderLogin();return false;">Back to log in</a></div>';
}

// Was a native browser prompt() — looks broken/untrustworthy on mobile,
// can't be styled, and some in-app browsers (e.g. opening the PWA link from
// inside WhatsApp) block it outright. A normal form field, like every other
// screen in the app, fixes both problems.
// Phone-based accounts have no email on file to send a reset link to.
// UPDATED (PHARMA_PROJECT_STATUS.md item 18, closing roadmap A.1(b)): this
// used to let anyone who knew the phone number set a brand-new password
// immediately, no code. Now a real 3-step flow — phone -> SMS code ->
// new password — proves phone ownership first. send-otp/verify-otp are
// public Edge Functions; the short-lived verified_token verify-otp returns
// is what reset-password-by-phone now requires before it will touch the
// account. The actual account lookup + password change still happens
// server-side in that Edge Function, the only place allowed to hold the
// service-role key this needs.
var fpStep = 'phone';
var fpPhoneVal = '';
var fpToken = '';

function renderForgotPassword() {
  STATE.authMode = 'forgot';
  fpStep = 'phone'; fpPhoneVal = ''; fpToken = '';
  drawForgotPassword();
}

function drawForgotPassword() {
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  if (fpStep === 'phone') {
    body.innerHTML =
      '<div class="card">' +
      '<div class="tiny" style="margin-bottom:10px">Enter the phone number on the account — we\'ll text you a 6-digit code.</div>' +
      '<div class="field"><label>Phone number</label><input id="fpPhone" type="tel" placeholder="07XXXXXXXX" value="' + esc(fpPhoneVal) + '"></div>' +
      '<div id="fpErr" class="error-text"></div>' +
      '<button class="btn primary" id="fpBtn" onclick="doSendResetCode()">Send code</button>' +
      '</div><div class="auth-toggle"><a href="#" onclick="renderLogin();return false;">Back to log in</a></div>';
  } else if (fpStep === 'code') {
    body.innerHTML =
      '<div class="card">' +
      '<div class="tiny" style="margin-bottom:10px">Enter the 6-digit code sent to ' + esc(fpPhoneVal) + '.</div>' +
      '<div class="field"><label>Code</label><input id="fpCode" type="tel" maxlength="6" placeholder="123456"></div>' +
      '<div id="fpErr" class="error-text"></div>' +
      '<button class="btn primary" id="fpBtn" onclick="doVerifyResetCode()">Verify</button>' +
      '</div><div class="auth-toggle"><a href="#" onclick="renderForgotPassword();return false;">Use a different number</a>' +
      ' · <a href="#" onclick="doSendResetCode();return false;">Resend code</a></div>';
  } else {
    body.innerHTML =
      '<div class="card">' +
      '<div class="tiny" style="margin-bottom:10px">Phone number verified. Choose a new password.</div>' +
      '<div class="field"><label>New password</label><input id="fpPw" type="password" placeholder="At least 8 characters"></div>' +
      '<div id="fpErr" class="error-text"></div>' +
      '<button class="btn primary" id="fpBtn" onclick="doSetResetPassword()">Set new password</button>' +
      '</div><div class="auth-toggle"><a href="#" onclick="renderLogin();return false;">Back to log in</a></div>';
  }
}

async function doSendResetCode() {
  var btn = $('#fpBtn'); var err = $('#fpErr'); if (err) err.textContent = '';
  act(btn, async function () {
    var phone = fpStep === 'phone' ? $('#fpPhone').value.trim() : fpPhoneVal;
    if (!phone) { err.textContent = 'Enter the phone number on the account.'; return; }
    var { data, error } = await sb.functions.invoke('send-otp', {
      body: { phone: phone, purpose: 'password_reset' }
    });
    if (error || !data || data.ok === false) {
      err.textContent = (data && data.message) || friendlyError(error);
      return;
    }
    if (data.sent === false) {
      err.textContent = data.message || 'Could not send a code right now. Try again shortly.';
      return;
    }
    fpPhoneVal = phone;
    fpStep = 'code';
    drawForgotPassword();
    toast('Code sent — check your phone.', 'good');
  });
}

async function doVerifyResetCode() {
  var btn = $('#fpBtn'); var err = $('#fpErr'); err.textContent = '';
  act(btn, async function () {
    var code = $('#fpCode').value.trim();
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
    var { data, error } = await sb.functions.invoke('verify-otp', {
      body: { phone: fpPhoneVal, purpose: 'password_reset', code: code }
    });
    if (error || !data || data.ok === false) {
      err.textContent = (data && data.message) || friendlyError(error);
      return;
    }
    fpToken = data.verified_token;
    fpStep = 'password';
    drawForgotPassword();
  });
}

async function doSetResetPassword() {
  var btn = $('#fpBtn'); var err = $('#fpErr'); err.textContent = '';
  act(btn, async function () {
    var pw = $('#fpPw').value;
    if (pw.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    var { data, error } = await sb.functions.invoke('reset-password-by-phone', {
      body: { phone: fpPhoneVal, newPassword: pw, otp_verified_token: fpToken }
    });
    if (error || (data && data.error)) {
      err.textContent = (data && data.error) || friendlyError(error);
      return;
    }
    fpStep = 'phone'; fpPhoneVal = ''; fpToken = '';
    renderLogin();
    toast('Password updated — log in with your new password.', 'good');
  });
}

function recoveryScreen() {
  return '<div class="auth-wrap-simple"><div class="auth-card">' +
    logoMarkHtml(44) + '<div class="mark">Pharma</div><div class="tag">Set a new password</div>' +
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
    var pw = $('#jnPw').value;
    if (!code || !phone || pw.length < 8) { err.textContent = 'Fill in the staff code, phone number, and an 8+ character password.'; return; }
    var { data: signUpData, error: suErr } = await sb.auth.signUp({ email: phoneToAuthEmail(phone), password: pw });
    if (suErr) { err.textContent = suErr.message; return; }
    stashPendingSignup({ kind: 'staff', code: code, fullName: fullName, phone: phone });
    if (!signUpData.session) {
      toast('Account created — log in with your phone number and password and it will pick up your staff code automatically.', 'good');
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
    var phone = $('#loPhone').value.trim(), pw = $('#loPw').value;
    if (!phone || !pw) { err.textContent = 'Enter your phone number and password.'; return; }
    var { error } = await sb.auth.signInWithPassword({ email: phoneToAuthEmail(phone), password: pw });
    if (error) {
      if (/invalid login credentials/i.test(error.message)) {
        err.textContent = 'Incorrect phone number or password.';
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
    var pw = $('#suPw').value;
    if (!pharmacyName || !phone || pw.length < 8) { err.textContent = 'Fill in the pharmacy name, phone number, and an 8+ character password.'; return; }
    var { data: signUpData, error: suErr } = await sb.auth.signUp({ email: phoneToAuthEmail(phone), password: pw });
    if (suErr) { err.textContent = suErr.message; return; }
    // Stash what they typed BEFORE checking for a session — if this Supabase
    // project requires email confirmation, signUp() returns no session at
    // all, so there's no authenticated user yet to attach a pharmacy to.
    // loadProfileAndPharmacy() finishes this automatically on their first
    // real login (see finishPendingSignupIfAny above). Confirmation should be
    // turned OFF for this project since the derived address can't receive it
    // — see PHARMA_PROJECT_STATUS.md.
    stashPendingSignup({ kind: 'owner', pharmacyName: pharmacyName, fullName: fullName, phone: phone });
    if (!signUpData.session) {
      err.textContent = '';
      toast('Account created — log in with your phone number and password to finish setting up your pharmacy.', 'good');
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
// DASHBOARD — redesigned: a real Today/Week/Month/Year filter (dashRange)
// that drives a sales trend chart and a rush-hours chart (both with a real
// axis), four tiles (Sales / Stock value / Profit / Supplier debt owed),
// the stock-health bar, a Sales→Cost→Profit widget, and capped Top
// sellers / Expiring soon lists that open a full list in a sheet when
// clicked. Backed by the dashboard_data(p_pharmacy_id, p_range) RPC
// (schema.sql §13) for everything range-dependent; stock/expiring/supplier
// balance are point-in-time snapshots fetched once per visit, same as the
// old dashboard. Every chart/list renders a fixed-size placeholder when
// there's no data yet, so a brand-new pharmacy never sees a broken or
// jumping layout — see PHARMA_PROJECT_STATUS.md item 22.
// ---------------------------------------------------------------------------

var dashRange = 'week';
var dashLoading = false;
var dashData = null;   // last dashboard_data() RPC result for the current dashRange
var dashSnap = null;   // point-in-time snapshot: stock value/health, expiring, supplier debt

var DCOLOR = {
  sales: '#008300', salesLight: '#E3F3E3',
  blue: '#4D7AB3', blueLight: '#E7EEF6',
  violet: '#6F5FA0', violetLight: '#ECE8F7',
  orange: '#eb6834', orangeLight: '#FDEBE3',
  magenta: '#e87ba4', magentaLight: '#FCEAF1',
  critical: '#d03b3b', serious: '#ec835a', warning: '#fab219', good: '#0ca30c',
  ctxWarm: '#BE8F87',
  // No-gray-text rule (app-wide, see style.css --ink-soft): chart axis
  // ticks/labels and "No sales recorded yet" captions used to render in a
  // lighter gray-brown, hard to read in daylight glare. Now the same deep
  // near-black as regular body text (matches --ink) — only the hairline
  // gridlines themselves stay light, since those are lines, not text.
  gridline: '#E7E2DC', inkSoft: '#201E1B'
};
var DASH_RANGE_LABELS = { today: 'Today', week: 'Week', month: 'Month', year: 'Year', custom: 'Custom' };
var DASH_PERIOD_LABEL = { today: 'Today', week: 'This week', month: 'This month', year: 'This year', custom: 'Custom range' };
var DASH_VS_LABEL = { today: 'yesterday', week: 'last week', month: 'last month', year: 'last year', custom: 'the previous period' };
var DASH_TOPSELLERS_TITLE = { today: 'Top sellers today', week: 'Top sellers this week', month: 'Top sellers this month', year: 'Top sellers this year', custom: 'Top sellers' };
var RUSH_LABELS = ['12-3am', '3-6am', '6-9am', '9am-12pm', '12-3pm', '3-6pm', '6-9pm', '9pm-12am'];
// Item 33: a custom date range picked via the dashboard's calendar button.
// Set together with dashRange = 'custom'; cleared whenever a preset range
// tab is tapped instead. See openDashDateRangePicker()/applyDashCustomRange().
var dashCustomStart = null;
var dashCustomEnd = null;

// Item 33: branches between the original preset-range RPC and the new
// custom-date-range one (dashboard_data_custom, schema.sql) added for the
// dashboard's calendar picker — kept as a completely separate SQL function
// rather than an overload, so the existing today/week/month/year path is
// untouched. Shared by the initial load and every range switch.
function fetchDashboardData() {
  if (dashRange === 'custom' && dashCustomStart && dashCustomEnd) {
    return sb.rpc('dashboard_data_custom', { p_pharmacy_id: STATE.profile.pharmacy_id, p_start: dashCustomStart, p_end: dashCustomEnd });
  }
  return sb.rpc('dashboard_data', { p_pharmacy_id: STATE.profile.pharmacy_id, p_range: dashRange === 'custom' ? 'today' : dashRange });
}

async function renderDashboard() {
  var c = $('#content');
  c.innerHTML = '<div class="empty">Loading dashboard…</div>';
  try {
    var results = await Promise.all([
      sb.from('v_drug_stock').select('drug_id,name,unit,qty_in_stock,reorder_level,stock_value_retail'),
      sb.from('v_out_of_stock').select('drug_id,name,unit'),
      sb.from('v_low_stock').select('drug_id,name,unit,qty_in_stock,reorder_level'),
      sb.from('v_expiring_batches').select('*').order('expiry_date'),
      sb.from('suppliers').select('id,opening_balance').eq('pharmacy_id', STATE.profile.pharmacy_id),
      sb.from('supplier_lpos').select('supplier_id,total_amount').eq('pharmacy_id', STATE.profile.pharmacy_id),
      sb.from('supplier_payments').select('supplier_id,amount').eq('pharmacy_id', STATE.profile.pharmacy_id),
      fetchDashboardData()
    ]);
    var stockRes = results[0], outRes = results[1], lowRes = results[2], expRes = results[3],
        supsRes = results[4], lposRes = results[5], paysRes = results[6], dashRes = results[7];
    if (dashRes.error) throw dashRes.error;

    var stockValue = (stockRes.data || []).reduce(function (a, r) { return a + Number(r.stock_value_retail || 0); }, 0);
    var sups = supsRes.data || [], lpos = lposRes.data || [], pays = paysRes.data || [];
    var supplierOwed = 0, suppliersOwedCount = 0;
    sups.forEach(function (s) {
      var delivered = lpos.filter(function (l) { return l.supplier_id === s.id; }).reduce(function (a, l) { return a + Number(l.total_amount || 0); }, 0);
      var paid = pays.filter(function (p) { return p.supplier_id === s.id; }).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
      var bal = Number(s.opening_balance || 0) + delivered - paid;
      if (bal > 0.5) { supplierOwed += bal; suppliersOwedCount++; }
    });

    dashSnap = {
      stockValue: stockValue,
      drugCount: (stockRes.data || []).length,
      outOfStock: outRes.data || [],
      lowStock: lowRes.data || [],
      expiring: expRes.data || [],
      supplierOwed: supplierOwed,
      suppliersOwedCount: suppliersOwedCount,
      // Item 27 (Dashboard quick access): a lightweight name/qty list kept
      // around purely for the "is this drug in stock?" quick-search box —
      // avoids a second round trip on every keystroke.
      drugList: stockRes.data || []
    };
    dashData = dashRes.data;
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderDashboard');
    return;
  }
  drawDashboard();
}

async function setDashRange(r) {
  if (r === dashRange || dashLoading) return;
  dashRange = r;
  dashCustomStart = null; dashCustomEnd = null; // a preset tab always clears any picked custom range
  dashLoading = true;
  drawDashboard(); // instant tab feedback; range-dependent cards stay on the previous range's data, dimmed, until the refetch lands — no skeleton flash
  try {
    var res = await fetchDashboardData();
    if (res.error) throw res.error;
    dashData = res.data;
  } catch (e) {
    toast(friendlyError(e), 'bad');
  }
  dashLoading = false;
  drawDashboard();
}

// Item 33: the calendar button on the dashboard's range control opens this
// small from/to picker instead of being limited to the four preset tabs.
function openDashDateRangePicker() {
  var start = dashCustomStart || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  var end = dashCustomEnd || new Date().toISOString().slice(0, 10);
  var body = sheet('Custom date range', '');
  body.innerHTML =
    '<div class="field"><label>From</label><input id="dashRangeFrom" type="date" value="' + esc(start) + '"></div>' +
    '<div class="field"><label>To</label><input id="dashRangeTo" type="date" value="' + esc(end) + '"></div>' +
    '<button class="btn primary" id="dashRangeApplyBtn" onclick="applyDashCustomRange()">Apply</button>';
}

async function applyDashCustomRange() {
  var from = $('#dashRangeFrom').value, to = $('#dashRangeTo').value;
  if (!from || !to) { toast('Pick both a from and a to date.', 'bad'); return; }
  if (to < from) { toast('The "to" date is before the "from" date.', 'bad'); return; }
  var btn = $('#dashRangeApplyBtn');
  act(btn, async function () {
    dashCustomStart = from; dashCustomEnd = to;
    dashRange = 'custom';
    dashLoading = true;
    closeSheet();
    drawDashboard();
    try {
      var res = await fetchDashboardData();
      if (res.error) throw res.error;
      dashData = res.data;
    } catch (e) {
      toast(friendlyError(e), 'bad');
    }
    dashLoading = false;
    drawDashboard();
  });
}

// Item 33: the "Restock" quick-access button — reuses the exact same
// reorder-list sheet/logic Inventory already has (openReorderList), just
// fed from the dashboard's own already-loaded stock snapshot instead of
// re-querying, so it opens instantly.
function dashQuickRestock() {
  if (dashSnap && dashSnap.drugList && dashSnap.drugList.length) {
    STATE.drugsCache = dashSnap.drugList;
    openReorderList();
  } else {
    setTab('inventory');
  }
}

// Item 33 (mobile dashboard redesign, approved via sketch — see
// PHARMA_PROJECT_STATUS.md): combines pieces from three sketched concepts —
// the urgent-alert strip and stock-check search box, a Sell+Restock action
// pair and the 4-tile stat grid + stock health, and the sales trend graph
// (now a compact single-line header instead of a big centered headline)
// placed above the stat grid with plain white cards throughout — only the
// stat grid keeps the item-30/31 tinted-tile treatment now. Rush hours and
// the Sales→Cost→Profit breakdown were dropped from this layout (not asked
// for in the approved sketch); their draw functions are left in place
// below, unused, rather than deleted, in case they're wanted back.
function drawDashboard() {
  var c = $('#content');
  var refetching = dashLoading ? ' dash-refetching' : '';
  c.innerHTML =
    dashAlertHtml(dashSnap) +
    dashQuickAccessHtml() +
    dashFilterRowHtml() +
    '<div class="card dash-graph-card' + refetching + '">' + dashSalesGraphHtml(dashData) + '</div>' +
    '<div class="dash-stat-grid' + refetching + '">' + dashStatGridHtml(dashData, dashSnap) + '</div>' +
    '<div class="card dash-list-card">' + dashStockHealthHtml(dashSnap) + '</div>' +
    '<div class="dash-row">' +
      '<div class="dash-col' + refetching + '">' + dashTopSellersCard(dashData) + '</div>' +
      '<div class="dash-col">' + dashExpiringCard(dashSnap) + '</div>' +
    '</div>';
}

// The urgent-alerts strip from the first sketch — out-of-stock count and
// the single soonest-expiring batch (if within 30 days), tap-through to
// Inventory. Renders nothing when there's nothing urgent to flag.
function dashAlertHtml(snap) {
  snap = snap || {};
  var outCount = (snap.outOfStock || []).length;
  var expiring = snap.expiring || [];
  var soonest = expiring.length ? expiring[0] : null; // v_expiring_batches is already ordered by expiry_date
  var soonestDays = soonest ? daysUntil(soonest.expiry_date) : null;
  var parts = [];
  if (outCount) parts.push('<b>' + outCount + ' out of stock</b>');
  if (soonest && soonestDays !== null && soonestDays <= 30) {
    parts.push('<b>1 batch expires ' + (soonestDays < 0 ? 'already' : soonestDays === 0 ? 'today' : 'in ' + soonestDays + ' day' + (soonestDays === 1 ? '' : 's')) + '</b>');
  }
  if (!parts.length) return '';
  return '<div class="dash-alert" onclick="setTab(\'inventory\')">' + icon('warn', 16) +
    '<div>' + parts.join(' &middot; ') + ' — tap Stock to review</div></div>';
}

// Item 27 (Dashboard quick access), redone for item 33: a Sell shortcut
// alongside a new Restock shortcut (straight into the same reorder list
// Inventory already has), plus the live "is this drug in stock?" search.
function dashQuickAccessHtml() {
  return '<div class="dash-actions">' +
    '<button class="btn primary" onclick="setTab(\'sell\')">' + icon('sell', 15) + ' Sell</button>' +
    '<button class="btn secondary" onclick="dashQuickRestock()">' + icon('box', 15) + ' Restock</button>' +
    '</div>' +
    '<div class="dash-quick-search">' +
    '<input id="dashStockCheckInput" placeholder="Check if a drug is in stock…" autocomplete="off" oninput="dashStockCheckSearch(this.value)" onblur="setTimeout(function(){var b=document.getElementById(\'dashStockCheckResults\');if(b)b.classList.remove(\'open\');},150)">' +
    '<div id="dashStockCheckResults" class="dash-quick-results"></div>' +
    '</div>';
}

function dashStockCheckSearch(val) {
  var box = $('#dashStockCheckResults');
  if (!box) return;
  var q = (val || '').trim().toLowerCase();
  if (!q) { box.classList.remove('open'); box.innerHTML = ''; return; }
  var matches = (dashSnap.drugList || []).filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
  box.classList.add('open');
  box.innerHTML = matches.length ? matches.map(function (d) {
    var kind = d.qty_in_stock === 0 ? 'bad' : d.qty_in_stock <= (d.reorder_level || 0) ? 'warn' : 'good';
    var badge = kind === 'bad' ? '<span class="badge bad">Out of stock</span>' : kind === 'warn' ? '<span class="badge warn">Low stock</span>' : '<span class="badge good">In stock</span>';
    return '<div class="dash-quick-result-row" onclick="dashStockCheckGoInventory(\'' + d.drug_id + '\')">' +
      '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + d.qty_in_stock + ' ' + esc(d.unit) + ' available</div></div>' +
      '<div class="right">' + badge + '<button class="btn small secondary" style="margin-left:8px" onclick="event.stopPropagation();dashStockCheckSell(\'' + d.drug_id + '\')">Sell</button></div>' +
      '</div>';
  }).join('') : '<div class="dash-quick-result-row empty">No drug matches that search.</div>';
}

function dashStockCheckGoInventory(drugId) {
  var d = (dashSnap.drugList || []).filter(function (x) { return x.drug_id === drugId; })[0];
  invFilter = d ? d.name : '';
  invPage = 1;
  setTab('inventory');
}

function dashStockCheckSell(drugId) {
  var d = (dashSnap.drugList || []).filter(function (x) { return x.drug_id === drugId; })[0];
  sellFilter = d ? d.name : '';
  setTab('sell');
}

// Item 33: restyled as a rounded segmented pill control (was plain
// underlined text tabs) plus a calendar button that opens a real
// custom-date-range picker (openDashDateRangePicker/applyDashCustomRange,
// backed by the new dashboard_data_custom() RPC in schema.sql) instead of
// being limited to the four presets.
function dashFilterRowHtml() {
  var isCustom = dashRange === 'custom';
  return '<div class="dash-filter-row"><div class="dash-tabs">' +
    ['today', 'week', 'month', 'year'].map(function (r) {
      return '<button class="dash-tab' + (!isCustom && dashRange === r ? ' active' : '') + '" onclick="setDashRange(\'' + r + '\')">' + DASH_RANGE_LABELS[r] + '</button>';
    }).join('') +
    '</div>' +
    '<button class="dash-cal-btn' + (isCustom ? ' active' : '') + '" onclick="openDashDateRangePicker()" title="Custom date range">' + icon('calendar', 15) + '</button>' +
    '</div>' +
    (isCustom && dashCustomStart && dashCustomEnd ? '<div class="dash-custom-label">' + esc(fmtDate(dashCustomStart)) + ' – ' + esc(fmtDate(dashCustomEnd)) + '</div>' : '');
}

// ---- charts: real axis (hairline gridlines + comma-formatted ticks), a
// fixed viewBox so they scale to any container width without ever
// clipping the axis band, and an honest "No sales recorded yet" caption
// (inside the SAME fixed-size chart, not a layout swap) when a range has
// no data — exactly what a brand-new pharmacy sees before its first sale.

// Bug fix: the old thresholds (1.5 / 3 / 7) could pick a step where the top
// tick (4 * step) fell BELOW the real max value — e.g. a max of 250 rounded
// to a 0/50/100/150/200 axis, so a data point of 250 was plotted above the
// chart's y=0 and rendered completely off-canvas (the "graph isn't showing"
// bug: a real point that's simply invisible, clipped outside the SVG
// viewBox, not missing data). Correct "nice number" boundaries are 1/2/5/10
// — i.e. the smallest of those >= norm — which guarantees 4 * step is
// always >= maxVal, so the highest data point always lands inside the axis.
function niceTicks(maxVal) {
  if (!maxVal || maxVal <= 0) return [0, 250, 500, 750, 1000];
  var rough = maxVal / 4;
  var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
  var norm = rough / mag;
  var step = norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag;
  var ticks = [];
  for (var i = 0; i <= 4; i++) ticks.push(Math.round(i * step));
  return ticks;
}
function fmtCompact(n) { return Math.round(n).toLocaleString(); }

function axisLineChart(values, labels, w, h, color, isEmpty) {
  var ticks = niceTicks(values.length ? Math.max.apply(null, values) : 0);
  var gutter = 50, plotW = w - gutter, labelBand = 18, totalH = h + labelBand;
  var hi = ticks[ticks.length - 1] || 1;
  var n = Math.max(values.length, 1);
  function px(i) { return gutter + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2); }
  function py(v) { return h - (v / hi) * (h - 8) - 4; }
  var grid = '', ticksHtml = '', axisLabels = '';
  ticks.forEach(function (t) {
    var y = py(t);
    grid += '<line x1="' + gutter + '" y1="' + y.toFixed(1) + '" x2="' + w + '" y2="' + y.toFixed(1) + '" stroke="' + DCOLOR.gridline + '" stroke-width="1"/>';
    ticksHtml += '<text x="' + (gutter - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + DCOLOR.inkSoft + '">' + fmtCompact(t) + '</text>';
  });
  labels.forEach(function (l, i) {
    axisLabels += '<text x="' + px(i).toFixed(1) + '" y="' + (h + 13) + '" text-anchor="middle" font-size="10.5" font-weight="600" fill="' + DCOLOR.inkSoft + '">' + esc(l) + '</text>';
  });
  var body;
  if (!isEmpty && values.length) {
    var pts = values.map(function (v, i) { return [px(i), py(v)]; });
    var poly = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = 'M' + pts[0][0].toFixed(1) + ',' + h + ' L' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L') + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + h + ' Z';
    var gid = 'dg' + Math.random().toString(36).slice(2, 9);
    var last = pts[pts.length - 1];
    body = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<polyline points="' + poly + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4" fill="' + color + '" stroke="#fff" stroke-width="2"/>';
  } else {
    body = '<text x="' + (gutter + plotW / 2).toFixed(1) + '" y="' + (h / 2).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="600" fill="' + DCOLOR.inkSoft + '">No sales recorded yet</text>';
  }
  return '<svg viewBox="0 0 ' + w + ' ' + totalH + '" style="width:100%;height:auto;display:block">' + grid + ticksHtml + body + axisLabels + '</svg>';
}

function axisBarChart(values, labels, w, h, color, isEmpty, peakLabel) {
  var ticks = niceTicks(values.length ? Math.max.apply(null, values) : 0);
  var gutter = 50, plotW = w - gutter, labelBand = 18, totalH = h + labelBand;
  var n = labels.length || 8, gap = 9;
  var barW = (plotW - gap * (n - 1)) / n;
  var hi = ticks[ticks.length - 1] || 1;
  function py(v) { return h - (v / hi) * (h - 8) - 4; }
  var grid = '', ticksHtml = '', axisLabels = '';
  ticks.forEach(function (t) {
    var y = py(t);
    grid += '<line x1="' + gutter + '" y1="' + y.toFixed(1) + '" x2="' + w + '" y2="' + y.toFixed(1) + '" stroke="' + DCOLOR.gridline + '" stroke-width="1"/>';
    ticksHtml += '<text x="' + (gutter - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + DCOLOR.inkSoft + '">' + fmtCompact(t) + '</text>';
  });
  labels.forEach(function (l, i) {
    var cx = gutter + i * (barW + gap) + barW / 2;
    axisLabels += '<text x="' + cx.toFixed(1) + '" y="' + (h + 13) + '" text-anchor="middle" font-size="9.5" font-weight="600" fill="' + DCOLOR.inkSoft + '">' + esc(l) + '</text>';
  });
  var bars = '', peakHtml = '', capHtml = '';
  if (!isEmpty) {
    var maxI = 0;
    values.forEach(function (v, i) { if (v > values[maxI]) maxI = i; });
    values.forEach(function (v, i) {
      var x = gutter + i * (barW + gap), y = py(v), bh = Math.max(h - y, 0), r = Math.min(4, barW / 2);
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="' + r.toFixed(1) + '" ry="' + r.toFixed(1) + '" fill="' + color + '"/>';
    });
    if (peakLabel) {
      var pxp = gutter + maxI * (barW + gap) + barW / 2, pyp = py(values[maxI]);
      peakHtml = '<text x="' + pxp.toFixed(1) + '" y="' + Math.max(pyp - 8, 12).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + color + '">' + esc(peakLabel) + '</text>';
    }
  } else {
    capHtml = '<text x="' + (gutter + plotW / 2).toFixed(1) + '" y="' + (h / 2).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="600" fill="' + DCOLOR.inkSoft + '">No sales recorded yet</text>';
  }
  return '<svg viewBox="0 0 ' + w + ' ' + totalH + '" style="width:100%;height:auto;display:block">' + grid + ticksHtml + bars + peakHtml + capHtml + axisLabels + '</svg>';
}

var DASH_BUCKET_FMT = {
  hour: function (iso) { return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', hour12: true }).replace(/\s/g, '').toLowerCase(); },
  day: function (iso) { return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' }); },
  week: function (iso, i) { return 'W' + (i + 1); },
  month: function (iso) { return new Date(iso).toLocaleDateString('en-GB', { month: 'short' }); }
};
function dashBucketLabels(trend, bucket) {
  var fn = DASH_BUCKET_FMT[bucket] || function () { return ''; };
  return trend.map(function (t, i) { return fn(t.bucket_start, i); });
}

function deltaChipHtml(total, prev, vsLabel) {
  if (!prev || prev <= 0) return ''; // no real previous-period baseline — omit rather than fabricate a %
  var pct = Math.round(((total - prev) / prev) * 100);
  var up = pct >= 0;
  return '<span class="dash-chip ' + (up ? 'up' : 'down') + '">' + (up ? '↑' : '↓') + ' ' + Math.abs(pct) + '% vs ' + vsLabel + '</span>';
}
function dashDeltaText(total, prev, vsLabel) {
  if (!prev || prev <= 0) return '';
  var pct = Math.round(((total - prev) / prev) * 100);
  return (pct >= 0 ? '+' : '') + pct + '% vs ' + vsLabel;
}

// Item 33: the header used to be a centered section-title + a big 28px
// headline + a separate centered chip row, stacked tall above the chart —
// collapsed here into one compact label/value row (matching the rest of
// the redesigned dashboard's card headers) so the chart starts almost
// immediately below it instead of after three stacked lines of text.
function dashSalesGraphHtml(d) {
  var total = d ? Number(d.sales_total || 0) : 0;
  var prev = d ? Number(d.sales_prev_total || 0) : 0;
  var trend = (d && d.trend) || [];
  var values = trend.map(function (t) { return Number(t.total || 0); });
  var labels = dashBucketLabels(trend, d ? d.bucket : 'day');
  var isEmpty = total <= 0;
  var chip = isEmpty ? '' : deltaChipHtml(total, prev, DASH_VS_LABEL[dashRange]);
  var periodLabel = (DASH_PERIOD_LABEL[dashRange] || 'Today').toLowerCase();
  return '<div class="dash-card-head"><div class="t">Sales &mdash; ' + esc(periodLabel) + '</div><div class="v">' + fmt(total) + '</div></div>' +
    (chip ? '<div class="dash-graph-chip-row">' + chip + '</div>' : '') +
    '<div class="dash-chart-wrap">' + axisLineChart(values, labels, 600, 140, DCOLOR.sales, isEmpty) + '</div>';
}

function dashRushGraphHtml(d) {
  var rushRows = (d && d.rush) || [];
  var values = [0, 0, 0, 0, 0, 0, 0, 0];
  rushRows.forEach(function (r) { if (r.idx >= 0 && r.idx < 8) values[r.idx] = Number(r.total || 0); });
  var totalRush = values.reduce(function (a, v) { return a + v; }, 0);
  var isEmpty = totalRush <= 0;
  var maxI = 0;
  values.forEach(function (v, i) { if (v > values[maxI]) maxI = i; });
  var headline = isEmpty ? '—' : RUSH_LABELS[maxI];
  var share = isEmpty ? 0 : Math.round((values[maxI] / totalRush) * 100);
  var chip = isEmpty ? '' : '<span class="dash-chip" style="color:' + DCOLOR.violet + '">' + share + '% of sales in this window</span>';
  return '<div class="dash-graph-head"><div class="section-title" style="text-align:center">Rush hours</div>' +
    '<div class="dash-graph-headline">' + esc(headline) + '</div>' +
    '<div class="dash-graph-chip-row">' + chip + '</div>' +
    '<div class="dash-chart-wrap">' + axisBarChart(values, RUSH_LABELS, 600, 140, DCOLOR.violet, isEmpty, isEmpty ? null : 'Peak: ' + RUSH_LABELS[maxI]) + '</div>' +
  '</div>';
}

// Item 33: replaces the old single-file dash-pill-row — now a 2-up grid
// (4-up on desktop) with Sales and Profit paired first, Stock value and
// Supplier debt owed second, per the approved sketch. Still the item-30/31
// tinted-tile treatment (background + accent border in the stat's own
// hue); just no more colored dot, to match the sketch's plainer tile face.
function dashStatGridHtml(d, snap) {
  snap = snap || {};
  var salesTotal = d ? Number(d.sales_total || 0) : 0;
  var profitTotal = d ? Number(d.profit_total || 0) : 0;
  var profitPrev = d ? Number(d.profit_prev_total || 0) : 0;
  var marginPct = salesTotal > 0 ? Math.round((profitTotal / salesTotal) * 100) : null;

  var stats = [
    { label: 'Sales', value: fmt(salesTotal), color: DCOLOR.sales, bg: DCOLOR.salesLight,
      sub: dashDeltaText(salesTotal, d ? d.sales_prev_total : 0, DASH_VS_LABEL[dashRange]) || DASH_PERIOD_LABEL[dashRange] },
    { label: 'Profit', value: fmt(profitTotal), color: DCOLOR.sales, bg: DCOLOR.salesLight,
      sub: marginPct === null ? 'No sales yet' : (dashDeltaText(profitTotal, profitPrev, DASH_VS_LABEL[dashRange]) || (marginPct + '% margin')) },
    { label: 'Stock value', value: fmt(snap.stockValue || 0), color: DCOLOR.orange, bg: DCOLOR.orangeLight,
      sub: (snap.drugCount || 0) + ' drugs tracked' },
    { label: 'Debt owed', value: fmt(snap.supplierOwed || 0), color: DCOLOR.magenta, bg: DCOLOR.magentaLight,
      sub: (snap.suppliersOwedCount || 0) + ((snap.suppliersOwedCount || 0) === 1 ? ' supplier' : ' suppliers') }
  ];
  return stats.map(function (p) {
    return '<div class="dash-stat" style="background:' + p.bg + ';border-color:' + p.color + '">' +
      '<div class="lab" style="color:' + p.color + '">' + esc(p.label) + '</div>' +
      '<div class="val">' + p.value + '</div>' +
      '<div class="sub">' + esc(p.sub) + '</div>' +
    '</div>';
  }).join('');
}

function segmentedBarHtml(segments, h) {
  var total = segments.reduce(function (a, s) { return a + s[0]; }, 0) || 1;
  var parts = segments.map(function (s) {
    var pct = s[0] / total * 100;
    return '<div style="width:' + pct.toFixed(2) + '%;background:' + s[1] + '"></div>';
  }).join('');
  return '<div style="display:flex;width:100%;height:' + h + 'px;border-radius:' + (h / 2) + 'px;overflow:hidden;background:var(--line)">' + parts + '</div>';
}

// Item 33: compact header (was a full-width section-title) and the
// out-of-stock/low-stock/healthy legend is now a fixed 3-column grid
// instead of a wrapping flex row, so all three always sit on one line
// (short labels — "Out 18" not "Out of stock (18)" — are what makes that
// fit at phone width) instead of the third item dropping to its own line.
function dashStockHealthHtml(snap) {
  snap = snap || {};
  var out = (snap.outOfStock || []).length, low = (snap.lowStock || []).length;
  var total = snap.drugCount || 0;
  var healthy = Math.max(total - out - low, 0);
  var hasData = total > 0;
  var bar = hasData
    ? segmentedBarHtml([[out, DCOLOR.critical], [low, DCOLOR.warning], [healthy, DCOLOR.good]], 10)
    : '<div style="height:10px;border-radius:5px;background:var(--line)"></div>';
  var legend = '<div class="dash-health-legend">' +
    '<span class="sw"><span class="dot" style="background:' + DCOLOR.critical + '"></span>Out ' + out + '</span>' +
    '<span class="sw"><span class="dot" style="background:' + DCOLOR.warning + '"></span>Low ' + low + '</span>' +
    '<span class="sw"><span class="dot" style="background:' + DCOLOR.good + '"></span>Healthy ' + healthy + '</span>' +
  '</div>';
  var caption = hasData ? '' : '<div class="tiny" style="margin-top:8px">No drugs added yet — add your first drug in Inventory to start tracking stock health.</div>';
  return '<div class="dash-card-head"><div class="t">Stock health</div><div class="v" style="font-size:12.5px;color:var(--ink-soft);font-weight:700">' + total + ' drugs</div></div>' +
    '<div style="height:8px"></div>' + bar + legend + caption;
}

function dashProfitHtml(d) {
  var sales = d ? Number(d.sales_total || 0) : 0;
  var cost = d ? Number(d.cost_total || 0) : 0;
  var profit = d ? Number(d.profit_total || 0) : 0;
  var hasData = sales > 0;
  var marginPct = hasData ? Math.round((profit / sales) * 100) : 0;
  var bar = hasData
    ? segmentedBarHtml([[Math.max(cost, 0), DCOLOR.ctxWarm], [Math.max(profit, 0), DCOLOR.sales]], 14)
    : '<div style="height:14px;border-radius:7px;background:var(--line)"></div>';
  var legend = hasData
    ? '<div class="dash-profit-legend">' +
      '<span class="sw"><span class="dot" style="background:' + DCOLOR.ctxWarm + '"></span>Cost of goods <b>' + fmt(cost) + '</b></span>' +
      '<span class="sw"><span class="dot" style="background:' + DCOLOR.sales + '"></span>Profit <b>' + fmt(profit) + '</b></span>' +
      '<span class="dash-profit-margin">' + marginPct + '% margin</span>' +
    '</div>'
    : '<div class="tiny" style="margin-top:8px">No sales recorded yet for this period.</div>';
  var header = '<div style="display:flex;align-items:baseline;justify-content:space-between">' +
    '<div class="section-title">Sales &rarr; cost &rarr; profit</div>' +
    '<div class="tiny">Sales ' + fmt(sales) + '</div></div>';
  return header + '<div style="height:10px"></div>' + bar + legend;
}

function dashBarRowHtml(label, valueTxt, pct, color) {
  pct = Math.max(4, Math.min(100, pct));
  return '<div class="dash-bar-row">' +
    '<div class="dash-bar-label">' + esc(label) + '</div>' +
    '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '<div class="dash-bar-value">' + esc(valueTxt) + '</div>' +
  '</div>';
}
function dashPlaceholderRowHtml() {
  return '<div class="dash-bar-row placeholder">' +
    '<div class="dash-bar-label">—</div>' +
    '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:4%;background:var(--line)"></div></div>' +
    '<div class="dash-bar-value">—</div>' +
  '</div>';
}
function dashUrgencyRowHtml(name, meta, daysTxt, pct, kind) {
  var color = { critical: DCOLOR.critical, serious: DCOLOR.serious, warning: DCOLOR.warning }[kind];
  var word = { critical: 'Critical', serious: 'Soon', warning: 'Watch' }[kind];
  pct = Math.max(6, Math.min(100, pct));
  return '<div class="dash-bar-row">' +
    '<div style="width:150px;min-width:0">' +
      '<div class="dash-bar-label" style="width:auto">' + esc(name) + '</div>' +
      '<div class="dash-bar-meta">' + esc(meta) + '</div>' +
    '</div>' +
    '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '<div class="dash-bar-value" style="width:34px">' + esc(daysTxt) + '</div>' +
    '<div class="dash-bar-status" style="color:' + color + '">' + word + '</div>' +
  '</div>';
}

function dashTopSellersCard(d) {
  var all = (d && d.top_sellers) || [];
  var top4 = all.slice(0, 4);
  var maxUnits = top4.length ? Math.max.apply(null, top4.map(function (s) { return Number(s.units || 0); })) : 1;
  var rows = top4.map(function (s) {
    var pct = maxUnits ? (Number(s.units || 0) / maxUnits * 100) : 0;
    return dashBarRowHtml(s.name, Number(s.units || 0) + ' units', pct, DCOLOR.blue);
  }).join('');
  for (var i = top4.length; i < 4; i++) rows += dashPlaceholderRowHtml();
  var empty = all.length === 0 ? '<div class="tiny" style="text-align:center;margin-top:14px">No sales recorded yet this period.</div>' : '';
  var footer = all.length > 4 ? '<button class="dash-view-all" onclick="openTopSellersFull()">View all ' + all.length + ' &rarr;</button>' : '';
  // Item 33: plain white card (no more blue tint) and a compact left-aligned
  // header, matching the approved sketch — only the stat grid keeps tinting.
  return '<div class="card dash-list-card"><div class="dash-card-head"><div class="t">' + esc(DASH_TOPSELLERS_TITLE[dashRange] || 'Top sellers') + '</div></div>' + rows + empty + footer + '</div>';
}

function dashExpiringCard(snap) {
  var all = (snap && snap.expiring) || [];
  var top4 = all.slice(0, 4);
  var rows = top4.map(function (b) {
    var days = daysUntil(b.expiry_date);
    var kind = days <= 14 ? 'critical' : days <= 30 ? 'serious' : 'warning';
    var pct = Math.max(6, Math.min(100, 100 - Math.min(days, 90) / 90 * 100));
    return dashUrgencyRowHtml(b.drug_name, 'batch ' + (b.batch_no || '—') + ' · ' + b.quantity_remaining + ' ' + b.unit, days + 'd', pct, kind);
  }).join('');
  for (var i = top4.length; i < 4; i++) rows += dashPlaceholderRowHtml();
  var empty = all.length === 0 ? '<div class="tiny" style="text-align:center;margin-top:14px">Nothing expiring soon.</div>' : '';
  var footer = all.length > 4 ? '<button class="dash-view-all" onclick="openExpiringFull()">View all ' + all.length + ' &rarr;</button>' : '';
  return '<div class="card dash-list-card"><div class="dash-card-head"><div class="t">Expiring soon</div></div>' + rows + empty + footer + '</div>';
}

function openTopSellersFull() {
  var all = (dashData && dashData.top_sellers) || [];
  var maxUnits = all.length ? Math.max.apply(null, all.map(function (s) { return Number(s.units || 0); })) : 1;
  var body = '<div class="card">' + (all.length ? all.map(function (s) {
    var pct = maxUnits ? Number(s.units || 0) / maxUnits * 100 : 0;
    return dashBarRowHtml(s.name, Number(s.units || 0) + ' units · ' + fmt(s.revenue), pct, DCOLOR.blue);
  }).join('') : '<div class="empty">No sales recorded yet this period.</div>') + '</div>';
  sheet((DASH_TOPSELLERS_TITLE[dashRange] || 'Top sellers') + ' — full list', body);
}

function openExpiringFull() {
  var all = (dashSnap && dashSnap.expiring) || [];
  var body = '<div class="card">' + (all.length ? all.map(function (b) {
    var days = daysUntil(b.expiry_date);
    var kind = days <= 14 ? 'critical' : days <= 30 ? 'serious' : 'warning';
    var pct = Math.max(6, Math.min(100, 100 - Math.min(days, 90) / 90 * 100));
    return dashUrgencyRowHtml(b.drug_name, 'batch ' + (b.batch_no || '—') + ' · ' + b.quantity_remaining + ' ' + b.unit, days + 'd', pct, kind);
  }).join('') : '<div class="empty">Nothing expiring soon.</div>') + '</div>';
  sheet('Expiring soon — full list', body);
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
  if (!can('view_inventory')) { c.innerHTML = '<div class="card empty">You do not have access to Inventory.</div>'; return; }
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
  var reorderCount = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; }).length;
  var unknownExpiryCount = STATE.drugsCache.filter(function (d) { return d.has_unknown_expiry; }).length;
  redrawKeepingFocus(c,
    '<div class="searchbox field"><input id="invSearchInput" placeholder="Search drugs…" value="' + esc(invFilter) + '" oninput="invFilter=this.value;invPage=1;drawInventory()"></div>' +
    '<div class="toolbar-row">' +
    (can('edit_inventory') ? '<div class="toolbar-segment">' +
      '<button class="btn" onclick="openSyncMasterDrugs()">' + icon('box',15) + ' Sync common drugs</button>' +
      '<button class="btn" onclick="openImportExcel()">' + icon('upload',15) + ' Import</button>' +
      '</div>' : '') +
    '<div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportInventoryExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn" onclick="printInventory()">' + icon('printer',15) + ' Print</button>' +
    '</div>' +
    (can('edit_inventory') ? '<button class="btn primary toolbar-primary" onclick="openAddDrug()">' + t('addDrug') + '</button>' : '') +
    '</div>' +
    (can('restock') && reorderCount ? '<div class="inline-notice">' + icon('clipboard',15) +
      '<a href="#" onclick="openReorderList();return false;">' + reorderCount + (reorderCount === 1 ? ' drug needs' : ' drugs need') + ' reordering — view list</a></div>' : '') +
    (unknownExpiryCount ? '<div class="inline-notice">' + icon('warn',15) +
      '<a href="#" onclick="openUnknownExpiryList();return false;">' + unknownExpiryCount + (unknownExpiryCount === 1 ? ' drug has' : ' drugs have') + ' a batch with no expiry date set — view list</a></div>' : '') +
    '<div class="card">' + (rows.length ? rows.map(function (d) {
      var kind = d.qty_in_stock === 0 ? 'bad' : d.qty_in_stock <= d.reorder_level ? 'warn' : 'good';
      var badge = kind === 'bad' ? '<span class="badge bad">Out</span>' : kind === 'warn' ? '<span class="badge warn">Low</span>' : '<span class="badge good">OK</span>';
      var expBadge = d.soonest_expiry ? (daysUntil(d.soonest_expiry) <= (STATE.pharmacy.expiry_warn_days || 90)
        ? ' <span class="badge ' + (daysUntil(d.soonest_expiry) <= 30 ? 'bad' : 'warn') + '">exp ' + fmtDate(d.soonest_expiry) + '</span>' : '') : '';
      return '<div class="list-row" onclick="openDrugDetail(\'' + d.drug_id + '\')" style="cursor:pointer">' +
        '<div style="display:flex;align-items:center;gap:12px"><div class="row-avatar ' + (kind === 'good' ? '' : kind) + '">' + esc((d.name || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + fmt(d.stock_value_retail) + ' in stock value' + expBadge + '</div></div></div>' +
        '<div class="right">' + badge + '<div class="meta">' + d.qty_in_stock + ' ' + esc(d.unit) + '</div></div></div>';
    }).join('') : '<div class="empty">No drugs match. Try clearing the search or add a new one.</div>') + '</div>' +
    (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="invPage++;drawInventory()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : ''));
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
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - stock - ' + todayStr() + '.xlsx', 'Stock', rows);
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
  exportExcel('Pharma - import template.xlsx', 'Stock', rows);
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

// Column-name aliases the importer recognizes, matched case-insensitively.
// 'drugs' (plural) is here because that's the header real pharmacy
// stock-take sheets actually use (see IMPORT_COLUMN_ALIASES.name).
var IMPORT_COLUMN_ALIASES = {
  name: ['drug', 'drugs', 'name', 'drug name'],
  category: ['category'],
  form: ['form'],
  unit: ['unit'],
  qty: ['qty', 'quantity'],
  costPrice: ['cost price'],
  sellPrice: ['sell price', 'price', 'price per unit'],
  expiry: ['expiry', 'exp dt', 'expiry date'],
  batchNo: ['batch no', 'batch'],
  supplier: ['supplier']
};

// Real stock-take sheets (like the one this app was built from) often have
// a title row above the real column headers ("RUBAO MUKOTHIMA STOCK TAKE",
// then "DRUGS / QTY / PRICE PER UNIT / …" on the next row). Reading the
// file as plain rows (not assuming row 1 is the header) and searching the
// first several rows for one that actually contains a recognized column
// name handles that without asking the pharmacist to edit their sheet first.
function findImportHeaderRow(rows) {
  for (var i = 0; i < Math.min(rows.length, 10); i++) {
    for (var c = 0; c < rows[i].length; c++) {
      var cell = String(rows[i][c] || '').trim().toLowerCase();
      if (IMPORT_COLUMN_ALIASES.name.indexOf(cell) !== -1) return i;
    }
  }
  return 0;
}

function buildImportColumnMap(headerRow) {
  var map = {};
  headerRow.forEach(function (cell, idx) {
    var v = String(cell || '').trim().toLowerCase();
    Object.keys(IMPORT_COLUMN_ALIASES).forEach(function (field) {
      if (map[field] === undefined && IMPORT_COLUMN_ALIASES[field].indexOf(v) !== -1) map[field] = idx;
    });
  });
  return map;
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
        var allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        var headerIdx = findImportHeaderRow(allRows);
        var colMap = buildImportColumnMap(allRows[headerIdx] || []);
        var dataRows = allRows.slice(headerIdx + 1);
        previewImport(dataRows, colMap);
      } catch (err) {
        toast('Could not read that file — is it a valid Excel/CSV file?', 'bad');
      }
    };
    reader.readAsArrayBuffer(input.files[0]);
  };
  input.click();
}

function previewImport(dataRows, colMap) {
  var parsed = [];
  var skipped = 0;
  var currentCategory = '';
  dataRows.forEach(function (row) {
    var cell = function (field) {
      var idx = colMap[field];
      if (idx === undefined) return null;
      var v = row[idx];
      return (v === undefined || v === null || String(v).trim() === '') ? null : v;
    };
    var name = cell('name');
    var qty = parseInt(cell('qty'), 10);
    var sellPrice = parseFloat(cell('sellPrice'));

    // A row that's just a drug name with no quantity and no price at all
    // (written in ALL CAPS, e.g. "ANALGESICS/ANTIPYRETICS", "COUGH SYRUPS")
    // is a section header in the pharmacist's sheet, not a stock line —
    // remember it as the category for the rows underneath, same way a
    // person reading the sheet by eye would.
    if (name && qty !== qty /* NaN */ && !sellPrice) {
      var trimmedName = String(name).trim();
      if (trimmedName === trimmedName.toUpperCase() && /[A-Za-z]/.test(trimmedName)) {
        currentCategory = trimmedName;
        return;
      }
    }

    // Only drug name and current stock quantity are actually required —
    // everything else (price, expiry, category, batch no., supplier) is
    // optional at import time, so a messy real-world stock-take sheet
    // doesn't lose rows over incidental missing columns. A missing sell
    // price defaults to cost price (or 0, visibly flaggable in Inventory —
    // nobody misses a drug priced at KES 0). A missing expiry imports as
    // "expiry unknown" (same placeholder-date pattern record_restock
    // already supports for Sync common drugs / supplier LPOs) rather than
    // being skipped — see openUnknownExpiryList() for how the pharmacy
    // finds and fixes these afterward.
    var expiryRaw = cell('expiry');
    var expiry = parseFlexibleExpiry(expiryRaw);
    if (!name || !qty || qty <= 0) { skipped++; return; }
    var costPrice = parseFloat(cell('costPrice')) || null;
    parsed.push({
      name: String(name).trim(),
      category: cell('category') || currentCategory || '',
      form: (cell('form') || 'other').toString().toLowerCase(),
      unit: cell('unit') || 'unit',
      qty: qty,
      costPrice: costPrice,
      sellPrice: sellPrice || costPrice || 0,
      expiry: expiry,
      expiryUnknown: !expiry,
      batchNo: cell('batchNo') || null,
      supplier: cell('supplier') || null
    });
  });

  var noPriceCount = parsed.filter(function (p) { return !p.sellPrice; }).length;
  var noExpiryCount = parsed.filter(function (p) { return p.expiryUnknown; }).length;
  var body = sheet('Import preview', '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">' + parsed.length + ' rows ready to import' +
    (skipped ? ', ' + skipped + ' skipped (missing drug name or quantity)' : '') + '.' +
    (noExpiryCount ? ' ' + noExpiryCount + ' with no expiry date — they\'ll import as "expiry unknown," flagged in Inventory to fix later.' : '') +
    (noPriceCount ? ' ' + noPriceCount + ' with no price — they\'ll import at KES 0 until you set a price.' : '') +
    '</div>' +
    '<div class="card" style="max-height:260px;overflow-y:auto">' +
    (parsed.length ? parsed.slice(0, 50).map(function (p) {
      return listRow(p.name, p.qty + ' ' + p.unit + ' · exp ' + (p.expiryUnknown ? 'unknown' : fmtDate(p.expiry)), fmt(p.sellPrice));
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
    // Normalized (letters/digits only, lowercased) so "Anti-H-Pylori" from
    // the seeded categories matches "ANTI H PYLORI" as written by hand in a
    // real stock-take sheet — punctuation/spacing varies, the category
    // doesn't.
    var normCat = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
    var catByName = {};
    STATE.categoriesCache.forEach(function (c) { catByName[normCat(c.name)] = c.id; });
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
            category_id: r.category ? (catByName[normCat(r.category)] || null) : null
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
          p_supplier: r.supplier,
          p_expiry_unknown: !r.expiry
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
// SYNC COMMON DRUGS — fast onboarding for a fresh pharmacy: instead of
// typing every drug by hand (or preparing an Excel sheet), browse/search a
// shared catalog of the drugs a Kenyan chemist commonly stocks and tick the
// ones this pharmacy actually sells, entering just the current quantity,
// price, reorder threshold and (optionally) expiry per item. An additional
// option alongside "+ Add new drug" and Excel import, not a replacement —
// whichever suits the pharmacy best. See sync_master_drugs() in schema.sql.
// ---------------------------------------------------------------------------

var syncFilter = '';

// Matches the order bootstrap_pharmacy() seeds these 16 categories in, so
// the list reads in the same familiar order as a real stock-take sheet.
var SYNC_CATEGORY_ORDER = [
  'Analgesics/Antipyretics', 'Antibiotics/Antifungals/Amoebicides',
  'Bronchodilators/Anti-Allergy', 'Antacids/Anti-H-Pylori', 'Antimalarials',
  'Anti-DM', 'Hypertensives/Convulsants', 'Antiemetics/Laxatives',
  'Contraceptives', 'Supplements', 'Eye/Ear Drops', 'ORS',
  'Injectables', 'Powders/Creams', 'Non-Pharmaceuticals', 'Others'
];

async function openSyncMasterDrugs() {
  syncFilter = '';
  STATE.syncSelected = {};
  var body = sheet('Sync common drugs', '<div class="empty">Loading catalog…</div>');
  if (!STATE.masterDrugsCache || !STATE.masterDrugsCache.length) {
    try {
      var { data, error } = await sb.from('master_drugs').select('*').order('category_name').order('sort_order');
      if (error) throw error;
      STATE.masterDrugsCache = data || [];
    } catch (e) {
      body.innerHTML = '<div class="card empty">Could not load the catalog. ' + esc(friendlyError(e)) + '</div>';
      return;
    }
  }
  drawSyncMasterDrugs();
}

function drawSyncMasterDrugs() {
  var body = $('#sheetBody');
  if (!body) return;
  var q = syncFilter.trim().toLowerCase();
  var all = STATE.masterDrugsCache || [];
  var matches = q ? all.filter(function (m) { return m.name.toLowerCase().indexOf(q) !== -1; }) : all;

  var byCat = {};
  matches.forEach(function (m) { (byCat[m.category_name] = byCat[m.category_name] || []).push(m); });
  var catNames = SYNC_CATEGORY_ORDER.filter(function (c) { return byCat[c]; });
  Object.keys(byCat).forEach(function (c) { if (catNames.indexOf(c) === -1) catNames.push(c); });

  var selectedCount = Object.keys(STATE.syncSelected).length;

  redrawKeepingFocus(body,
    '<div class="tiny" style="margin-bottom:10px">Tick the drugs this pharmacy sells and enter the current quantity, price and reorder threshold for each. Expiry date is optional.</div>' +
    '<div class="searchbox field"><input id="syncSearchInput" placeholder="Search drugs…" value="' + esc(syncFilter) + '" oninput="syncFilter=this.value;drawSyncMasterDrugs()"></div>' +
    (catNames.length ? catNames.map(function (cat) {
      var items = byCat[cat];
      var hasSelected = items.some(function (m) { return STATE.syncSelected[m.id]; });
      var isOpen = !!q || hasSelected;
      return '<details' + (isOpen ? ' open' : '') + ' style="margin-bottom:8px">' +
        '<summary style="cursor:pointer;padding:8px 4px;font-weight:600">' + esc(cat) + ' (' + items.length + ')</summary>' +
        '<div class="card">' + items.map(drawSyncDrugRow).join('') + '</div>' +
        '</details>';
    }).join('') : '<div class="empty">No drugs match your search.</div>') +
    '<div class="tiny" style="margin:12px 0">' + selectedCount + ' drug' + (selectedCount === 1 ? '' : 's') + ' selected</div>' +
    '<button class="btn primary" id="syncSubmitBtn" onclick="submitMasterDrugsSync()"' + (selectedCount ? '' : ' disabled') + '>Add to inventory</button>');
}

function drawSyncDrugRow(m) {
  var sel = STATE.syncSelected[m.id];
  var row = '<div class="list-row">' +
    '<label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">' +
    '<input type="checkbox"' + (sel ? ' checked' : '') + ' onchange="toggleSyncDrug(\'' + m.id + '\')">' +
    '<div><div class="name">' + esc(m.name) + '</div><div class="meta">' + esc(String(m.form).replace('_', '/')) + ' · ' + esc(m.unit) + (m.is_prescription ? ' · Rx' : '') + '</div></div>' +
    '</label></div>';
  if (!sel) return row;
  row +=
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Quantity (' + esc(m.unit) + ')</label><input type="number" min="1" value="' + esc(sel.qty) + '" oninput="updateSyncField(\'' + m.id + '\',\'qty\',this.value)"></div>' +
    '<div class="field"><label>Sell price</label><input type="number" step="0.01" value="' + esc(sel.sellPrice) + '" oninput="updateSyncField(\'' + m.id + '\',\'sellPrice\',this.value)"></div>' +
    '</div>' +
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Reorder level</label><input type="number" min="0" value="' + esc(sel.reorderLevel) + '" oninput="updateSyncField(\'' + m.id + '\',\'reorderLevel\',this.value)"></div>' +
    '<div class="field"><label>Expiry date (optional)</label><input type="date" value="' + esc(sel.expiry) + '" oninput="updateSyncField(\'' + m.id + '\',\'expiry\',this.value)"></div>' +
    '</div>' +
    '<div class="field" style="padding:0 4px 14px 34px;max-width:200px"><label>Cost price (optional)</label><input type="number" step="0.01" value="' + esc(sel.costPrice) + '" oninput="updateSyncField(\'' + m.id + '\',\'costPrice\',this.value)"></div>';
  return row;
}

function toggleSyncDrug(masterDrugId) {
  if (STATE.syncSelected[masterDrugId]) {
    delete STATE.syncSelected[masterDrugId];
  } else {
    STATE.syncSelected[masterDrugId] = {
      qty: '', sellPrice: '', reorderLevel: STATE.pharmacy.low_stock_default || 5, expiry: '', costPrice: ''
    };
  }
  drawSyncMasterDrugs();
}

// Field edits write straight into STATE, with no re-render — re-rendering
// the whole sheet on every keystroke would reset focus and lose whatever
// the pharmacist is mid-typing in every other expanded row.
function updateSyncField(masterDrugId, field, value) {
  if (STATE.syncSelected[masterDrugId]) STATE.syncSelected[masterDrugId][field] = value;
}

async function submitMasterDrugsSync() {
  var btn = $('#syncSubmitBtn');
  if (!btn) return;
  act(btn, async function () {
    var ids = Object.keys(STATE.syncSelected);
    if (!ids.length) { toast('Select at least one drug.', 'bad'); return; }
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var sel = STATE.syncSelected[id];
      var master = STATE.masterDrugsCache.find(function (m) { return m.id === id; });
      var label = master ? master.name : 'a selected drug';
      var qty = parseInt(sel.qty, 10);
      if (!qty || qty <= 0) { toast('Enter a valid quantity for ' + label + '.', 'bad'); return; }
      var price = parseFloat(sel.sellPrice);
      if (!price || price <= 0) { toast('Enter a sell price for ' + label + '.', 'bad'); return; }
      items.push({
        master_drug_id: id,
        quantity: qty,
        sell_price: price,
        reorder_level: (sel.reorderLevel !== '' && sel.reorderLevel != null) ? parseInt(sel.reorderLevel, 10) : null,
        cost_price: (sel.costPrice !== '' && sel.costPrice != null) ? parseFloat(sel.costPrice) : null,
        expiry_date: sel.expiry || null
      });
    }
    var { error } = await sb.rpc('sync_master_drugs', { p_pharmacy_id: STATE.profile.pharmacy_id, p_items: items });
    if (error) { toast(error.message, 'bad'); return; }
    toast('Added ' + items.length + ' drug' + (items.length === 1 ? '' : 's') + ' to inventory.', 'good');
    STATE.syncSelected = {};
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
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportReorderExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn" onclick="printReorderList()">' + icon('printer',15) + ' Print</button>' +
    '</div></div>' +
    '<div class="card">' + (needed.length ? needed.map(function (n) {
      return listRow(n.name, 'Have ' + n.current + ' ' + n.unit + ' · reorder level ' + n.reorderLevel, '<b>Order ' + n.suggested + '</b>');
    }).join('') : '<div class="empty">Nothing needs reordering right now.</div>') + '</div>';
}

function exportReorderExcel() {
  var rows = pendingReorderList.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - reorder list.xlsx', 'Reorder', rows);
}

function printReorderList() {
  var needed = STATE.drugsCache.filter(function (d) { return d.qty_in_stock <= d.reorder_level; });
  var rows = needed.map(function (d) {
    var suggested = Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5);
    return [d.name, d.qty_in_stock + ' ' + d.unit, d.reorder_level, suggested];
  });
  printHtml('Reorder List', todayStr(), tableHtml(['Drug', 'Current stock', 'Reorder level', 'Suggested order'], rows), needed.length + ' items');
}

// Drugs brought into stock without a known expiry date (e.g. via a relaxed
// Excel import, item 26) are flagged in v_drug_stock via has_unknown_expiry.
// This lets the pharmacy come back later, look up the exact batch, and fill
// in the real expiry date once they have it.
function openUnknownExpiryList() {
  sheet('Batches with no expiry date', '<div class="empty">Loading…</div>');
  loadUnknownExpiryList();
}

async function loadUnknownExpiryList() {
  var body = $('#sheetBody');
  if (!body) return;
  try {
    var { data: batches, error } = await sb.from('batches')
      .select('id, batch_no, quantity_remaining, drug_id, drugs(name, unit)')
      .eq('pharmacy_id', STATE.profile.pharmacy_id)
      .eq('expiry_unknown', true)
      .gt('quantity_remaining', 0)
      .order('created_at', { ascending: true });
    if (error) throw error;
    STATE.unknownExpiryBatches = batches || [];
    renderUnknownExpiryList();
  } catch (e) {
    body.innerHTML = '<div class="empty">' + esc(friendlyError(e)) + '</div>';
  }
}

function renderUnknownExpiryList() {
  var body = $('#sheetBody');
  if (!body) return;
  var batches = STATE.unknownExpiryBatches || [];
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">These batches were brought into stock without an expiry date. Set the real date once you have it — this only needs doing once per batch.</div>' +
    (batches.length ? '<div class="card">' + batches.map(function (b) {
      var drugName = (b.drugs && b.drugs.name) || 'Unknown drug';
      var unit = (b.drugs && b.drugs.unit) || 'unit';
      return '<div class="list-row"><div><div class="name">' + esc(drugName) + '</div>' +
        '<div class="meta">' + b.quantity_remaining + ' ' + esc(unit) + (b.batch_no ? ' · batch ' + esc(b.batch_no) : '') + '</div></div>' +
        '<div class="right" style="display:flex;gap:8px;align-items:center">' +
        '<input type="date" id="expInput_' + b.id + '">' +
        '<button class="btn small" id="expSaveBtn_' + b.id + '" onclick="saveBatchExpiry(\'' + b.id + '\')">Save</button>' +
        '</div></div>';
    }).join('') + '</div>' : '<div class="empty">Nothing left to flag — every batch has an expiry date.</div>');
}

async function saveBatchExpiry(batchId) {
  var btn = $('#expSaveBtn_' + batchId);
  act(btn, async function () {
    var input = $('#expInput_' + batchId);
    var val = input ? input.value : '';
    if (!val) { toast('Pick a date first.', 'bad'); return; }
    var { error } = await sb.rpc('set_batch_expiry', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_batch_id: batchId,
      p_expiry_date: val
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expiry date saved.', 'good');
    STATE.unknownExpiryBatches = (STATE.unknownExpiryBatches || []).filter(function (b) { return b.id !== batchId; });
    renderUnknownExpiryList();
    renderInventory();
  });
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
    kpi('In stock', d.qty_in_stock + ' ' + esc(d.unit), 't-sales') +
    kpi('Stock value', fmt(d.stock_value_retail), 't-orange') +
    '</div>' +
    (can('restock') ? '<button class="btn primary" style="margin-bottom:14px" onclick="closeSheet();openRestock(' + "'" + encodeDrugForRestock(drugRow) + "'" + ')">+ Restock this drug</button>' : '') +
    '<div class="section-title">Batches</div>' +
    (batches && batches.length ? batches.map(function (b) {
      var d2 = daysUntil(b.expiry_date);
      // expiry_unknown batches (from "Sync common drugs", or a restock marked
      // "I don't know the expiry") carry a placeholder date 3 years out —
      // never show that fake date, and never flag it as expiring.
      var kind = b.quantity_remaining === 0 ? 'muted' : b.expiry_unknown ? 'good' : d2 < 0 ? 'bad' : d2 <= 30 ? 'bad' : d2 <= 90 ? 'warn' : 'good';
      var expiryLabel = b.expiry_unknown ? 'Expiry unknown' : fmtDate(b.expiry_date);
      var discountBadge = b.discount_percent > 0 ? ' <span class="badge warn">-' + b.discount_percent + '%</span>' : '';
      return '<div class="list-row"><div><div class="name">' + esc(b.batch_no || 'Batch') + ' · ' + expiryLabel + discountBadge + '</div>' +
        '<div class="meta">Received ' + fmtDate(b.received_at) + (b.supplier ? ' from ' + esc(b.supplier) : '') + '</div>' +
        ((can('write_off') || can('correct_stock') || can('edit_expiry')) && b.quantity_remaining > 0 ? '<div class="toolbar-row" style="margin-top:6px">' +
          (can('write_off') ? '<button class="btn ghost small" onclick="openWriteOff(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.quantity_remaining + ')">Write off</button>' : '') +
          // Was gated on can('write_off') — a real pre-existing bug: this
          // button is "Correct count" (record_correction), a different
          // action from write-off with its own backend permission tier,
          // so it needs its own can('correct_stock') check. Fixed as part
          // of item 3 since stock_taker can correct stock but not write
          // off, and the old gate would have hidden this button from them.
          (can('correct_stock') ? '<button class="btn ghost small" onclick="openCorrection(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.quantity_remaining + ')">Correct count</button>' : '') +
          (can('discount') ? '<button class="btn ghost small" onclick="openDiscount(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',' + b.discount_percent + ')">Mark down</button>' : '') +
          // Item 34: owner-only — fixes a batch that already has a real (just
          // wrong) expiry date, e.g. entered as already-past by mistake, which
          // silently drops it out of "in stock" with no other way to correct it.
          (can('edit_expiry') ? '<button class="btn ghost small" onclick="openEditExpiry(\'' + b.id + '\',\'' + esc(d.name).replace(/'/g, "\\'") + '\',\'' + (b.expiry_unknown ? '' : b.expiry_date) + '\')">Edit expiry</button>' : '') +
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
    // A correction directly overwrites the batch's counted quantity — cheap
    // to close the same confirmation gap write-off and void already have,
    // so a fat-fingered tap doesn't silently overwrite a real count.
    if (!confirm('Set this batch\'s quantity to ' + qty + '? This overwrites the current count.')) return;
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

// Item 34 — owner-only fix for a real bug report: a batch restocked with an
// already-past expiry date (e.g. picked yesterday by mistake) silently drops
// out of "in stock" everywhere (dashboard, Inventory, Sell) with no way to
// correct it in the app — set_batch_expiry only covers batches marked
// "expiry unknown", not one that already has a real-but-wrong date. Reopens
// the same drug's detail sheet afterward so the fix is visible immediately.
function openEditExpiry(batchId, drugName, currentExpiry) {
  var body = sheet('Edit expiry: ' + drugName, '');
  body.innerHTML =
    '<div class="tiny" style="margin-bottom:10px">Only use this to correct a wrongly-entered date — for a batch that was never given a real expiry date, use "Batches with no expiry date" in Inventory instead.</div>' +
    '<div class="field"><label>Correct expiry date</label><input id="eeDate" type="date" value="' + esc(currentExpiry) + '"></div>' +
    '<button class="btn primary" id="eeSaveBtn" onclick="saveEditExpiry(\'' + batchId + '\')">Save</button>';
}

async function saveEditExpiry(batchId) {
  var btn = $('#eeSaveBtn');
  act(btn, async function () {
    var val = $('#eeDate').value;
    if (!val) { toast('Pick a date first.', 'bad'); return; }
    var { error } = await sb.rpc('correct_batch_expiry', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_new_expiry_date: val
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expiry date corrected.', 'good');
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

function drawSell() {
  var c = $('#content');
  var q = sellFilter.toLowerCase();
  var rows = STATE.drugsCache.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
  redrawKeepingFocus(c,
    (heldSalesCache.length ? heldSalesCard() : '') +
    '<div class="searchbox field"><input id="sellSearchInput" placeholder="Search a drug to sell…" value="' + esc(sellFilter) + '" oninput="sellFilter=this.value;drawSell()"></div>' +
    (STATE.cart.length ? cartSummaryCard() : '') +
    '<div class="card">' + (rows.length ? rows.map(function (d) {
      return '<div class="list-row" onclick="addToCart(\'' + d.drug_id + '\')" style="cursor:pointer">' +
        '<div><div class="name">' + esc(d.name) + (d.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + d.qty_in_stock + ' ' + esc(d.unit) + ' available' + (d.default_price ? ' · ' + fmt(d.default_price) : '') + '</div></div>' +
        '<div class="right btn small secondary">Add</div></div>';
    }).join('') : '<div class="empty">Nothing in stock matches that search.</div>') + '</div>');
}

function heldSalesCard() {
  return '<div class="card"><div class="section-title" style="margin-top:0">Held sales (' + heldSalesCache.length + ')</div>' +
    heldSalesCache.map(function (h) {
      var cart = h.cart || [];
      var total = cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
      return '<div class="list-row"><div><div class="name">' + esc(h.label || 'Held sale') + '</div><div class="meta">' + cart.length + ' item(s) · ' + fmt(total) + ' · ' + new Date(h.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</div></div>' +
        '<div class="right" style="display:flex;gap:6px"><button class="btn small secondary" onclick="resumeHeldSale(this,\'' + h.id + '\')">Resume</button><button class="btn small danger" onclick="deleteHeldSale(this,\'' + h.id + '\')">' + icon('close',14) + '</button></div></div>';
    }).join('') + '</div>';
}

async function holdSale(btn) {
  act(btn, async function () {
    if (!STATE.cart.length) { toast('Cart is empty.', 'bad'); return; }
    var label = prompt('Label for this held sale (optional) — e.g. customer name or counter number:') || null;
    var { error } = await sb.from('held_sales').insert({
      pharmacy_id: STATE.profile.pharmacy_id, label: label, cart: STATE.cart, created_by: STATE.session.user.id
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    STATE.cart = [];
    toast('Sale held. Resume it any time from the Sell tab.', 'good');
    renderSell();
  });
}

function resumeHeldSale(btn, id) {
  var h = heldSalesCache.find(function (x) { return x.id === id; });
  if (!h) return;
  if (STATE.cart.length && !confirm('This will replace your current cart with the held sale. Continue?')) return;
  act(btn, async function () {
    STATE.cart = h.cart || [];
    await sb.from('held_sales').delete().eq('id', id);
    heldSalesCache = heldSalesCache.filter(function (x) { return x.id !== id; });
    drawSell();
  });
}

async function deleteHeldSale(btn, id) {
  if (!confirm('Discard this held sale? Its items are not deducted from stock, so nothing to undo.')) return;
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
      return '<div class="cart-line"><div><div class="name">' + esc(item.name) + (item.is_prescription ? ' <span class="badge warn">Rx</span>' : '') + '</div><div class="meta">' + fmt(item.price) + ' each' + (item.patient_name ? ' · Patient: ' + esc(item.patient_name) : '') + '</div></div>' +
        '<div class="qty-ctrl"><button onclick="changeQty(' + i + ',-1)">−</button><span>' + item.qty + '</span><button onclick="changeQty(' + i + ',1)">+</button></div></div>';
    }).join('') +
    '<div class="list-row"><div class="name">Total</div><div class="name">' + fmt(total) + '</div></div>' +
    '<div class="toolbar-row" style="margin-top:10px"><button class="btn ghost" onclick="holdSale(this)">⏸ Hold</button><button class="btn primary" onclick="openCheckout()">Checkout</button></div></div>';
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

// Item 32: Reports restructured from one flat screen into a proper hub of
// sub-modules (brief item 3) — Sales, Expiry Dates, Stock Valuation, Low
// Stock, and Insurance Claims, each its own printable report with the
// pharmacy's letterhead and the shared "Generated by Pharma" print footer
// (already built into printHtml()/letterheadHtml() — reused as-is, not
// rebuilt per report). reportsView tracks which sub-screen is showing, the
// same in-content navigation pattern already used by Suppliers' list/detail
// screens (see supplierDetailId/openSupplierDetail/closeSupplierDetail).
var reportsView = 'hub'; // 'hub' | 'sales' | 'expiry' | 'valuation' | 'lowstock' | 'claims'
var reportRange = 'today';
var reportData = null; // last-loaded sales report, kept for export/print
var expiryReportData = null;
var valuationReportData = null;
var lowStockReportData = null;

async function renderReports() {
  if (reportsView === 'sales') { await loadReport(); return; }
  if (reportsView === 'expiry') { await loadExpiryReport(); return; }
  if (reportsView === 'valuation') { await loadValuationReport(); return; }
  if (reportsView === 'lowstock') { await loadLowStockReport(); return; }
  if (reportsView === 'claims') { await loadClaims(); return; }
  drawReportsHub();
}

function openReportsHub() { reportsView = 'hub'; renderReports(); }

var REPORT_TILES = [
  { view: 'sales', kind: 't-sales', ico: 'sell', title: 'Sales Report', desc: 'Revenue, payment methods, top sellers and every transaction, by date range.' },
  { view: 'expiry', kind: 't-amber', ico: 'warn', title: 'Expiry Dates Report', desc: 'Every batch by expiry urgency — expired, critical, soon, and unknown-expiry batches still needing a real date.' },
  { view: 'valuation', kind: 't-orange', ico: 'wallet', title: 'Stock Valuation Report', desc: 'What your current stock is worth, at cost and at retail, drug by drug.' },
  { view: 'lowstock', kind: 't-red', ico: 'clipboard', title: 'Low Stock Report', desc: 'Every drug at or below its reorder level, with a suggested order quantity.' },
  { view: 'claims', kind: 't-violet', ico: 'reports', title: 'Insurance Claims', desc: 'Every claim raised at checkout, tracked through to paid or rejected.' }
];

function drawReportsHub() {
  var c = $('#content');
  c.innerHTML =
    '<div class="reports-grid">' +
    REPORT_TILES.filter(function (r) { return r.view !== 'claims' || can('claims'); }).map(function (r) {
      return '<button class="report-tile ' + r.kind + '" onclick="reportsView=\'' + r.view + '\';renderReports()">' +
        '<div class="r-ico">' + icon(r.ico, 20) + '</div>' +
        '<div><div class="r-title">' + esc(r.title) + '</div><div class="r-desc">' + esc(r.desc) + '</div></div>' +
      '</button>';
    }).join('') +
    '</div>';
}

function reportsBackBtn() {
  return '<button class="btn ghost small" style="margin-bottom:10px" onclick="openReportsHub()">&larr; All reports</button>';
}

function drawReportsShell() {
  var c = $('#content');
  c.innerHTML =
    reportsBackBtn() +
    '<div class="row-3" style="margin-bottom:14px">' +
    ['today', 'week', 'month'].map(function (r) {
      return '<button class="btn ' + (reportRange === r ? 'primary' : 'ghost') + ' small" onclick="reportRange=\'' + r + '\';loadReport()">' + r[0].toUpperCase() + r.slice(1) + '</button>';
    }).join('') + '</div>' +
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportReportExcel()">' + icon('download',15) + ' Excel</button>' +
    '<button class="btn" onclick="printReport()">' + icon('printer',15) + ' Print</button>' +
    '</div></div>' +
    '<div id="reportBody"><div class="empty">Loading…</div></div>';
}

// Shared shell for the four newer report screens (Expiry, Valuation, Low
// Stock, Claims) — no date-range toggle (each is a live snapshot), just the
// back button plus an Excel/Print toolbar wired to that view's own
// export/print functions.
var REPORT_SHELL_HANDLERS = {
  expiry: { excel: 'exportExpiryReportExcel', print: 'printExpiryReport' },
  valuation: { excel: 'exportValuationReportExcel', print: 'printValuationReport' },
  lowstock: { excel: 'exportLowStockReportExcel', print: 'printLowStockReport' },
  claims: { excel: 'exportClaimsExcel', print: 'printClaimsReport' }
};

function drawReportsShell2(title) {
  var c = $('#content');
  var h = REPORT_SHELL_HANDLERS[reportsView] || {};
  c.innerHTML =
    reportsBackBtn() +
    '<div class="section-title" style="margin-top:0">' + esc(title) + '</div>' +
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    (h.excel ? '<button class="btn" onclick="' + h.excel + '()">' + icon('download',15) + ' Excel</button>' : '') +
    (h.print ? '<button class="btn" onclick="' + h.print + '()">' + icon('printer',15) + ' Print</button>' : '') +
    '</div></div>' +
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
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - sales - ' + reportRange + ' - ' + todayStr() + '.xlsx', 'Sales', rows);
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
}

function drawReportBody() {
  var body = $('#reportBody');
  var sales = reportData.sales, byMethod = reportData.byMethod, topDrugs = reportData.topDrugs;
  var visible = sales.slice(0, reportTxPage * TX_PAGE_SIZE);
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Total sales', fmt(reportData.total), 't-sales') +
    kpi('Transactions', sales.length, 't-violet') +
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
    (sales.length > visible.length ? '<button class="btn ghost" onclick="reportTxPage++;drawReportBody()">Load more</button>' : '');
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
// EXPIRY DATES REPORT — every batch still in stock, bucketed by urgency.
// Reuses the same thresholds/logic as the drug-detail batch list and the
// Inventory "unknown expiry" notice (expiry_unknown, item 26).
// ---------------------------------------------------------------------------

// Item — user punch list: full per-category drill-down lists (not just a
// count), each independently printable/exportable, paginated 10-at-a-time,
// and (for Unknown Expiry) editable right there instead of only from
// Inventory's separate "fix later" list. expiryReportData now holds one
// FLAT array (`all`) rather than pre-split buckets — every category's
// membership (including the summary tiles' own counts) is computed on
// demand by expiryCategoryRows() from that one array, so the tile count,
// the drill-down list and the print/export can never drift out of sync
// with each other. That single source of truth is also the actual fix for
// the "90-day report shows dates out to 2028" bug: the bucketing math
// (days <= 90) was always correct, but the old layout printed every bucket
// — including "later than 90 days", genuinely containing far-future dates
// — one after another on the same unbroken page with no drill-down, so a
// reader scrolling past "Expiring soon" straight into "Later than 90 days"
// could easily read those as still being part of the 90-day report. Now
// clicking "Expiring in 90 Days" opens ONLY that category's own rows.
var expiryCategory = null; // null = summary tiles | 'expired' | 'within30' | 'within90' | 'unknown' | 'custom'
var expiryPage = 1;
var EXPIRY_PAGE_SIZE = 10;
var expiryCustomFrom = '';
var expiryCustomTo = '';

async function loadExpiryReport() {
  expiryCategory = null;
  expiryPage = 1;
  drawReportsShell2('Expiry Dates Report');
  try {
    var { data: batches, error } = await sb.from('batches')
      .select('id, batch_no, quantity_remaining, expiry_date, expiry_unknown, drug_id, drugs(name, unit)')
      .eq('pharmacy_id', STATE.profile.pharmacy_id)
      .gt('quantity_remaining', 0)
      .order('expiry_date');
    if (error) throw error;
    var all = (batches || []).map(function (b) {
      return {
        id: b.id, name: (b.drugs && b.drugs.name) || 'Unknown drug', unit: (b.drugs && b.drugs.unit) || 'unit',
        batch_no: b.batch_no, qty: b.quantity_remaining, expiry_date: b.expiry_date,
        expiry_unknown: !!b.expiry_unknown, days: b.expiry_unknown ? null : daysUntil(b.expiry_date)
      };
    });
    expiryReportData = { all: all, total: all.length };
    drawExpiryReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadExpiryReport');
  }
}

// Cumulative thresholds (0–30, 0–90), not mutually-exclusive bands — a drug
// expiring in 12 days is meant to show up under BOTH "Expiring in 30 Days"
// and "Expiring in 90 Days", since anyone pulling the 90-day list wants
// everything expiring that soon, urgent items included, not just the 31–90
// slice. Expired items are their own bucket and never double up into these.
function expiryCategoryRows(cat) {
  var all = (expiryReportData && expiryReportData.all) || [];
  if (cat === 'expired') return all.filter(function (r) { return !r.expiry_unknown && r.days < 0; });
  if (cat === 'within30') return all.filter(function (r) { return !r.expiry_unknown && r.days >= 0 && r.days <= 30; });
  if (cat === 'within90') return all.filter(function (r) { return !r.expiry_unknown && r.days >= 0 && r.days <= 90; });
  if (cat === 'unknown') return all.filter(function (r) { return r.expiry_unknown; });
  if (cat === 'custom') {
    if (!expiryCustomFrom || !expiryCustomTo) return [];
    return all.filter(function (r) { return !r.expiry_unknown && r.expiry_date >= expiryCustomFrom && r.expiry_date <= expiryCustomTo; });
  }
  return [];
}

var EXPIRY_CATEGORIES = [
  { key: 'expired', label: 'Expired', kind: 't-red' },
  { key: 'within30', label: 'Expiring in 30 Days', kind: 't-red' },
  { key: 'within90', label: 'Expiring in 90 Days', kind: 't-amber' },
  { key: 'unknown', label: 'Unknown Expiry', kind: 't-neutral' }
];

var EXPIRY_CATEGORY_META = {
  expired: { title: 'Expired', badge: 'bad', showDays: true },
  within30: { title: 'Expiring in 30 Days', badge: 'bad', showDays: true },
  within90: { title: 'Expiring in 90 Days', badge: 'warn', showDays: true },
  unknown: { title: 'Unknown Expiry', badge: 'muted', showDays: false },
  custom: { title: 'Custom range', badge: 'warn', showDays: true }
};

function drawExpiryReportBody() {
  var body = $('#reportBody');
  if (!body) return;
  if (!expiryCategory) { drawExpirySummary(body); return; }
  drawExpiryCategory(body);
}

function drawExpirySummary(body) {
  body.innerHTML =
    (expiryReportData.total ? (
      '<div class="kpi-grid" style="margin-bottom:14px">' +
      EXPIRY_CATEGORIES.map(function (c) {
        return '<button class="kpi kpi-clickable ' + c.kind + '" onclick="openExpiryCategory(\'' + c.key + '\')">' +
          '<div class="label">' + esc(c.label) + '</div><div class="value">' + expiryCategoryRows(c.key).length + '</div></button>';
      }).join('') +
      '</div>' +
      '<div class="card" style="margin-bottom:12px">' +
      '<div class="tiny" style="margin-bottom:8px;font-weight:700">Custom date range</div>' +
      '<div class="row-2">' +
      '<div class="field"><label>From</label><input id="expFrom" type="date" value="' + esc(expiryCustomFrom) + '"></div>' +
      '<div class="field"><label>To</label><input id="expTo" type="date" value="' + esc(expiryCustomTo) + '"></div>' +
      '</div>' +
      '<button class="btn primary small" onclick="applyExpiryCustomRange()">View list</button>' +
      '</div>'
    ) : '<div class="empty">No batches in stock yet.</div>');
}

function applyExpiryCustomRange() {
  var from = $('#expFrom') ? $('#expFrom').value : '';
  var to = $('#expTo') ? $('#expTo').value : '';
  if (!from || !to) { toast('Pick both a from and to date.', 'bad'); return; }
  if (from > to) { toast('The "from" date must be before the "to" date.', 'bad'); return; }
  expiryCustomFrom = from; expiryCustomTo = to;
  openExpiryCategory('custom');
}

function openExpiryCategory(cat) {
  expiryCategory = cat;
  expiryPage = 1;
  drawExpiryReportBody();
}

function closeExpiryCategory() {
  expiryCategory = null;
  drawExpiryReportBody();
}

function drawExpiryCategory(body) {
  var cat = expiryCategory;
  var meta = EXPIRY_CATEGORY_META[cat];
  var allRows = expiryCategoryRows(cat);
  // Soonest/most-overdue first, same urgency ordering the old fixed buckets
  // used; Unknown Expiry keeps insertion order (oldest batch first — same
  // as Inventory's own "fix later" list, so the two never disagree on
  // which one to fix first).
  if (cat !== 'unknown') allRows = allRows.slice().sort(function (a, b) { return a.days - b.days; });
  var rows = allRows.slice(0, expiryPage * EXPIRY_PAGE_SIZE);
  var title = cat === 'custom' ? ('Custom range: ' + fmtDate(expiryCustomFrom) + ' – ' + fmtDate(expiryCustomTo)) : meta.title;
  body.innerHTML =
    '<button class="btn ghost small" style="margin-bottom:10px" onclick="closeExpiryCategory()">&larr; Back to Expiry Dates Report</button>' +
    '<div class="section-title" style="margin-top:0">' + esc(title) + ' (' + allRows.length + ')</div>' +
    '<div class="toolbar-row"><div class="toolbar-segment toolbar-end">' +
    '<button class="btn" onclick="exportExpiryCategoryExcel()">' + icon('download', 15) + ' Excel</button>' +
    '<button class="btn" onclick="printExpiryCategory()">' + icon('printer', 15) + ' Print</button>' +
    '</div></div>' +
    (cat === 'unknown' && allRows.length ? '<div class="tiny" style="margin-bottom:10px">Set the real expiry date once you have it — this only needs doing once per batch.</div>' : '') +
    (allRows.length ? (
      // Every category but "custom" has one status for all its rows, so
      // meta.badge (fixed red/amber/gray) is right for all of them. Custom
      // range can mix already-expired rows with still-future ones in the
      // same list, so its badge color is worked out per row instead —
      // otherwise an expired item in a custom range would wrongly show the
      // same amber "still has time" color as a not-yet-expired one.
      '<div class="card">' + rows.map(function (r) {
        var kind = meta.badge;
        if (cat === 'custom') kind = r.days < 0 ? 'bad' : (r.days <= 30 ? 'bad' : 'warn');
        return expiryRowHtml(r, kind, meta.showDays, cat === 'unknown');
      }).join('') + '</div>' +
      (allRows.length > rows.length ? '<button class="btn ghost" style="margin-top:10px" onclick="expiryPage++;drawExpiryReportBody()">Load more (' + (allRows.length - rows.length) + ' more)</button>' : '')
    ) : '<div class="empty">Nothing in this list.</div>');
}

function expiryRowHtml(r, kind, showDays, editable) {
  return '<div class="list-row"><div><div class="name">' + esc(r.name) + (r.batch_no ? ' · batch ' + esc(r.batch_no) : '') + '</div>' +
    '<div class="meta">' + r.qty + ' ' + esc(r.unit) + '</div></div>' +
    (editable ?
      '<div class="right" style="display:flex;gap:8px;align-items:center">' +
      '<input type="date" id="expInput_' + r.id + '">' +
      '<button class="btn small" id="expSaveBtn_' + r.id + '" onclick="saveExpiryReportRowDate(\'' + r.id + '\')">Save</button>' +
      '</div>'
      :
      '<div class="right"><span class="badge ' + kind + '">' + (r.expiry_date ? fmtDate(r.expiry_date) : 'No date set') + (showDays && typeof r.days === 'number' ? (r.days < 0 ? ' · ' + Math.abs(r.days) + 'd ago' : ' · ' + r.days + 'd left') : '') + '</span></div>'
    ) + '</div>';
}

// Lets a batch's expiry date be set right from the Unknown Expiry
// drill-down, not only from Inventory's separate list — same RPC
// (set_batch_expiry), so both places enforce the exact same rules.
async function saveExpiryReportRowDate(batchId) {
  var btn = $('#expSaveBtn_' + batchId);
  act(btn, async function () {
    var input = $('#expInput_' + batchId);
    var val = input ? input.value : '';
    if (!val) { toast('Pick a date first.', 'bad'); return; }
    var { error } = await sb.rpc('set_batch_expiry', {
      p_pharmacy_id: STATE.profile.pharmacy_id, p_batch_id: batchId, p_expiry_date: val
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Expiry date saved.', 'good');
    if (expiryReportData) expiryReportData.all = expiryReportData.all.filter(function (r) { return r.id !== batchId; });
    STATE.unknownExpiryBatches = (STATE.unknownExpiryBatches || []).filter(function (b) { return b.id !== batchId; });
    drawExpiryReportBody();
  });
}

function expiryCategoryExportRows(cat) {
  var rows = expiryCategoryRows(cat);
  if (cat !== 'unknown') rows = rows.slice().sort(function (a, b) { return a.days - b.days; });
  return rows.map(function (r) { return [r.name, r.batch_no || '', r.qty + ' ' + r.unit, r.expiry_date && !r.expiry_unknown ? fmtDate(r.expiry_date) : '—']; });
}

function printExpiryCategory() {
  if (!expiryCategory) return;
  var meta = EXPIRY_CATEGORY_META[expiryCategory];
  var title = expiryCategory === 'custom' ? ('Expiry — custom range: ' + fmtDate(expiryCustomFrom) + ' to ' + fmtDate(expiryCustomTo)) : ('Expiry — ' + meta.title);
  var rows = expiryCategoryExportRows(expiryCategory);
  printHtml(title, todayStr(), tableHtml(['Drug', 'Batch', 'Qty', 'Expiry date'], rows), rows.length + ' batches');
}

function exportExpiryCategoryExcel() {
  if (!expiryCategory) return;
  var meta = EXPIRY_CATEGORY_META[expiryCategory];
  var rows = expiryCategoryExportRows(expiryCategory).map(function (r) {
    return { 'Drug': r[0], 'Batch': r[1], 'Qty': r[2], 'Expiry date': r[3] };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - expiry - ' + (meta ? meta.title.toLowerCase().replace(/\s+/g, '-') : expiryCategory) + ' - ' + todayStr() + '.xlsx', 'Expiry', rows);
}

// Whole-report (every category combined) print/export — still reachable
// from the persistent shell toolbar at the top of both the summary and any
// drill-down, for a single combined list when that's what's wanted instead
// of one category at a time.
function expiryReportRows() {
  var all = (expiryReportData && expiryReportData.all) || [];
  function statusLabel(r) {
    if (r.expiry_unknown) return 'Unknown expiry';
    if (r.days < 0) return 'Expired';
    if (r.days <= 30) return 'Critical (≤30d)';
    if (r.days <= 90) return 'Soon (≤90d)';
    return 'Later';
  }
  return all.slice().sort(function (a, b) {
    var da = a.expiry_unknown ? Infinity : a.days, db = b.expiry_unknown ? Infinity : b.days;
    return da - db;
  }).map(function (r) {
    return [r.name, r.batch_no || '', r.qty + ' ' + r.unit, statusLabel(r), r.expiry_date && !r.expiry_unknown ? fmtDate(r.expiry_date) : '—'];
  });
}

function printExpiryReport() {
  if (!expiryReportData) { toast('Report still loading.', 'bad'); return; }
  printHtml('Expiry Dates Report', todayStr(),
    tableHtml(['Drug', 'Batch', 'Qty', 'Status', 'Expiry date'], expiryReportRows()),
    expiryReportData.total + ' batches in stock');
}

function exportExpiryReportExcel() {
  if (!expiryReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = expiryReportRows().map(function (r) {
    return { 'Drug': r[0], 'Batch': r[1], 'Qty': r[2], 'Status': r[3], 'Expiry date': r[4] };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - expiry - ' + todayStr() + '.xlsx', 'Expiry', rows);
}

// ---------------------------------------------------------------------------
// STOCK VALUATION REPORT — what current stock is worth, at cost and retail,
// drug by drug. Reuses v_drug_stock's stock_value_cost/stock_value_retail
// (already computed for Inventory's own export, item 26/27).
// ---------------------------------------------------------------------------

async function loadValuationReport() {
  drawReportsShell2('Stock Valuation Report');
  try {
    var { data, error } = await sb.from('v_drug_stock').select('drug_id, name, unit, qty_in_stock, stock_value_cost, stock_value_retail').order('stock_value_retail', { ascending: false });
    if (error) throw error;
    var rows = (data || []).filter(function (d) { return d.qty_in_stock > 0; });
    var totalCost = rows.reduce(function (a, d) { return a + Number(d.stock_value_cost || 0); }, 0);
    var totalRetail = rows.reduce(function (a, d) { return a + Number(d.stock_value_retail || 0); }, 0);
    valuationReportData = { rows: rows, totalCost: totalCost, totalRetail: totalRetail };
    drawValuationReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadValuationReport');
  }
}

function drawValuationReportBody() {
  var body = $('#reportBody');
  var d = valuationReportData;
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Value at cost', fmt(d.totalCost), 't-orange') +
    kpi('Value at retail', fmt(d.totalRetail), 't-sales') +
    kpi('Est. margin', fmt(d.totalRetail - d.totalCost), 't-green') +
    kpi('Drugs tracked', d.rows.length, 't-neutral') +
    '</div>' +
    '<div class="section-title">By drug</div>' +
    '<div class="card">' + (d.rows.length ? d.rows.map(function (r) {
      return listRow(r.name, r.qty_in_stock + ' ' + esc(r.unit) + ' · cost ' + fmt(r.stock_value_cost), fmt(r.stock_value_retail));
    }).join('') : '<div class="empty">No stock recorded yet.</div>') + '</div>';
}

function printValuationReport() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(function (r) { return [r.name, r.qty_in_stock + ' ' + r.unit, fmt(r.stock_value_cost), fmt(r.stock_value_retail)]; });
  printHtml('Stock Valuation Report', todayStr(),
    tableHtml(['Drug', 'Qty in stock', 'Value (cost)', 'Value (retail)'], rows),
    'Total cost ' + fmt(valuationReportData.totalCost) + ' · Total retail ' + fmt(valuationReportData.totalRetail));
}

function exportValuationReportExcel() {
  if (!valuationReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = valuationReportData.rows.map(function (r) {
    return { 'Drug': r.name, 'Unit': r.unit, 'Qty in stock': r.qty_in_stock, 'Value (cost)': Number(r.stock_value_cost || 0), 'Value (retail)': Number(r.stock_value_retail || 0) };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - stock valuation - ' + todayStr() + '.xlsx', 'Valuation', rows);
}

// ---------------------------------------------------------------------------
// LOW STOCK REPORT — every drug at or below its reorder level, with a
// suggested order quantity. Same formula as the Inventory reorder list
// (openReorderList), but as its own formal, printable/exportable report.
// ---------------------------------------------------------------------------

async function loadLowStockReport() {
  drawReportsShell2('Low Stock Report');
  try {
    var { data, error } = await sb.from('v_drug_stock').select('drug_id, name, unit, qty_in_stock, reorder_level').order('name');
    if (error) throw error;
    var rows = (data || []).filter(function (d) { return d.qty_in_stock <= d.reorder_level; }).map(function (d) {
      return { name: d.name, unit: d.unit, current: d.qty_in_stock, reorderLevel: d.reorder_level, suggested: Math.max(d.reorder_level * 3 - d.qty_in_stock, d.reorder_level || 5) };
    });
    lowStockReportData = { rows: rows };
    drawLowStockReportBody();
  } catch (e) {
    errorCard($('#reportBody'), friendlyError(e), 'loadLowStockReport');
  }
}

function drawLowStockReportBody() {
  var body = $('#reportBody');
  var rows = lowStockReportData.rows;
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Need reordering', rows.length, rows.length ? 't-red' : 't-neutral') +
    '</div>' +
    '<div class="card">' + (rows.length ? rows.map(function (n) {
      return listRow(n.name, 'Have ' + n.current + ' ' + n.unit + ' · reorder level ' + n.reorderLevel, '<b>Order ' + n.suggested + '</b>');
    }).join('') : '<div class="empty">Nothing needs reordering right now.</div>') + '</div>';
}

function printLowStockReport() {
  if (!lowStockReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = lowStockReportData.rows.map(function (n) { return [n.name, n.current + ' ' + n.unit, n.reorderLevel, n.suggested]; });
  printHtml('Low Stock Report', todayStr(), tableHtml(['Drug', 'Current stock', 'Reorder level', 'Suggested order'], rows), rows.length + ' drugs need reordering');
}

function exportLowStockReportExcel() {
  if (!lowStockReportData) { toast('Report still loading.', 'bad'); return; }
  var rows = lowStockReportData.rows.map(function (n) {
    return { 'Drug': n.name, 'Current stock': n.current, 'Reorder level': n.reorderLevel, 'Suggested order qty': n.suggested };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - low stock - ' + todayStr() + '.xlsx', 'Low stock', rows);
}

// ---------------------------------------------------------------------------
// INSURANCE CLAIMS — created automatically at checkout when a payment line
// uses "insurance"; tracked here through to paid/rejected. Promoted from an
// inline strip at the bottom of the Sales report (its original spot) to its
// own full report screen as part of item 32.
// ---------------------------------------------------------------------------

var claimsCache = [];

async function loadClaims() {
  drawReportsShell2('Insurance Claims');
  try {
    var { data } = await sb.from('insurance_claims').select('*').order('created_at', { ascending: false }).limit(200);
    claimsCache = data || [];
  } catch (e) { claimsCache = []; }
  drawClaims();
}

function drawClaims() {
  var body = $('#reportBody');
  if (!body) return;
  var pendingTotal = claimsCache.filter(function (c) { return c.status === 'pending'; }).reduce(function (a, c) { return a + Number(c.amount || 0); }, 0);
  body.innerHTML =
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Pending', fmt(pendingTotal), 't-amber') +
    kpi('Total claims', claimsCache.length, 't-violet') +
    '</div>' +
    '<div class="card">' + (claimsCache.length ? claimsCache.map(function (c) {
      return '<div class="list-row"><div><div class="name">' + esc(c.scheme) + '</div><div class="meta">' + new Date(c.created_at).toLocaleDateString('en-GB') + (c.claim_number ? ' · ' + esc(c.claim_number) : '') + '</div></div>' +
        '<div class="right"><div>' + fmt(c.amount) + '</div><select style="margin-top:4px" onchange="updateClaimStatus(this,\'' + c.id + '\',this.value)">' +
        ['pending', 'submitted', 'paid', 'rejected'].map(function (s) { return '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>'; }).join('') +
        '</select></div></div>';
    }).join('') : '<div class="empty">No insurance claims yet.</div>') + '</div>';
}

async function updateClaimStatus(sel, id, status) {
  // Not a "Save" button, but the same double-fire risk applies to a select
  // someone re-picks quickly — disable it for the round trip too.
  sel.disabled = true;
  var { error } = await sb.from('insurance_claims').update({ status: status, updated_at: new Date().toISOString() }).eq('id', id);
  sel.disabled = false;
  if (error) { toast(friendlyError(error), 'bad'); return; }
  var c = claimsCache.find(function (x) { return x.id === id; });
  if (c) c.status = status;
  toast('Claim updated.', 'good');
}

function exportClaimsExcel() {
  var rows = claimsCache.map(function (c) {
    return { 'Date': new Date(c.created_at).toLocaleDateString('en-GB'), 'Scheme': c.scheme, 'Claim number': c.claim_number || '', 'Amount': Number(c.amount || 0), 'Status': c.status };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - insurance claims - ' + todayStr() + '.xlsx', 'Claims', rows);
}

function printClaimsReport() {
  var rows = claimsCache.map(function (c) {
    return [new Date(c.created_at).toLocaleDateString('en-GB'), c.scheme, c.claim_number || '—', fmt(c.amount), c.status.charAt(0).toUpperCase() + c.status.slice(1)];
  });
  var pendingTotal = claimsCache.filter(function (c) { return c.status === 'pending'; }).reduce(function (a, c) { return a + Number(c.amount || 0); }, 0);
  printHtml('Insurance Claims Report', todayStr(),
    tableHtml(['Date', 'Scheme', 'Claim number', 'Amount', 'Status'], rows),
    claimsCache.length + ' claims · ' + fmt(pendingTotal) + ' pending');
}

// ---------------------------------------------------------------------------
// SETTINGS — business profile (name, address, phone…) printed on every
// report/receipt, plus the low-stock and expiry-warning thresholds.
// ---------------------------------------------------------------------------

async function renderSettings() {
  var c = $('#content');
  var p = STATE.pharmacy || {};
  // Item 3: co_owner is full equal access to owner — same settings/staff
  // capability everywhere this "isOwner" flag gates the UI.
  var isOwner = STATE.profile.role === 'owner' || STATE.profile.role === 'co_owner';
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
    '<div class="field"><label>Physical address</label><textarea id="stAddress" rows="2" placeholder="e.g. Medicare Pharmacy" ' + (isOwner ? '' : 'disabled') + '>' + esc(p.address || '') + '</textarea></div>' +
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

    (isOwner ? (
      '<div class="section-title">Staff</div>' +
      '<div class="card">' +
      (staff.length ? staff.map(function (s) {
        var isMe = s.id === STATE.profile.id;
        var expired = s.account_expires_at && new Date(s.account_expires_at) <= new Date();
        var badge = s.active === false ? '<span class="badge bad">Disabled</span>' :
          expired ? '<span class="badge bad">Expired</span>' : '<span class="badge good">Active</span>';
        var expiryNote = (s.account_expires_at && !expired) ? ' · expires ' + fmtDate(s.account_expires_at) : '';
        return '<div class="list-row"><div><div class="name">' + esc(s.full_name || '(no name)') + (isMe ? ' (you)' : '') + '</div>' +
          '<div class="meta">' + esc(roleLabel(s.role)) + (s.phone ? ' · ' + esc(s.phone) : '') + esc(expiryNote) + '</div></div>' +
          '<div class="right">' + badge +
          (isMe ? '' : '<div style="margin-top:6px"><button class="btn ghost small" onclick="toggleStaffActive(this,\'' + s.id + '\',' + (s.active === false) + ')">' +
            (s.active === false ? 'Reactivate' : 'Disable') + '</button></div>') +
          '</div></div>';
      }).join('') : '<div class="tiny">Just you so far.</div>') +
      (invites.length ? '<div class="tiny" style="margin-top:10px">Unused invite codes: ' +
        invites.map(function (i) { return '<b>' + esc(i.code) + '</b> (' + esc(roleLabel(i.role)) + (i.account_expires_hours ? ', ' + inviteExpiryLabel(i.account_expires_hours) : '') + ')'; }).join(', ') + '</div>' : '') +
      '<div class="toolbar-row" style="margin-top:10px">' +
      '<button class="btn secondary small" onclick="openInviteStaff(this)">+ Invite staff</button>' +
      '</div></div>'
    ) : '') +

    '<div class="section-title">Account</div>' +
    '<div class="card">' +
    '<div class="tiny" style="margin-bottom:10px">Signed in as ' + esc(STATE.profile.full_name || '') + ' (' + esc(roleLabel(STATE.profile.role)) + ')' +
    (STATE.profile.account_expires_at ? ' · temporary access, expires ' + fmtDate(STATE.profile.account_expires_at) : '') + '</div>' +
    '<div class="field"><label>Language</label><div class="tiny">English (Kiswahili is coming soon — turned off for now so the app doesn\'t mix half-translated screens)</div></div></div>';
}

// ---------------------------------------------------------------------------
// SUPPLIERS — opening balances, LPOs (Local Purchase Orders) that record a
// delivery AND restock inventory in one step (integrated by design, so a
// pharmacist enters a delivery once rather than in both Suppliers and
// Stock), payments against a supplier's running balance, and a full
// running-ledger statement per supplier: first delivery to most recent,
// running debt owed, what's been paid and when. See schema.sql's
// supplier_lpos/supplier_lpo_items/supplier_payments tables and the
// record_supplier_lpo/record_supplier_payment functions.
// ---------------------------------------------------------------------------

var supplierDetailId = null;   // set while viewing one supplier's ledger instead of the list
var lpoFilter = '';
var lpoDeliveredAt = '';
var lpoNotes = '';

async function renderSuppliers() {
  var c = $('#content');
  if (!can('suppliers') && !can('view_suppliers')) { c.innerHTML = '<div class="card empty">You do not have access to Suppliers.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading suppliers…</div>';
  try {
    var { data: sups, error } = await sb.from('suppliers').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id).order('name');
    if (error) throw error;
    STATE.suppliersCache = sups || [];
    var { data: lpos } = await sb.from('supplier_lpos').select('supplier_id, total_amount').eq('pharmacy_id', STATE.profile.pharmacy_id);
    var { data: pays } = await sb.from('supplier_payments').select('supplier_id, amount').eq('pharmacy_id', STATE.profile.pharmacy_id);
    STATE.supplierLposAgg = lpos || [];
    STATE.supplierPaymentsAgg = pays || [];
  } catch (e) {
    errorCard(c, friendlyError(e), 'renderSuppliers');
    return;
  }
  if (supplierDetailId) { openSupplierDetail(supplierDetailId); return; }
  drawSuppliersList();
}

function drawSuppliersList() {
  var c = $('#content');
  var sups = STATE.suppliersCache || [];
  var lpos = STATE.supplierLposAgg || [];
  var pays = STATE.supplierPaymentsAgg || [];
  function balanceFor(s) {
    var delivered = lpos.filter(function (l) { return l.supplier_id === s.id; }).reduce(function (a, l) { return a + Number(l.total_amount || 0); }, 0);
    var paid = pays.filter(function (p) { return p.supplier_id === s.id; }).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
    return Number(s.opening_balance || 0) + delivered - paid;
  }
  c.innerHTML =
    (can('suppliers') ? '<div class="toolbar-row"><button class="btn primary" onclick="openAddSupplier()">+ New supplier</button></div>' : '') +
    '<div class="card">' +
    (sups.length ? sups.map(function (s) {
      var bal = balanceFor(s);
      var badgeKind = bal > 0.5 ? 'bad' : (bal < -0.5 ? 'good' : 'muted');
      var badgeText = bal > 0.5 ? fmt(bal) + ' owed' : (bal < -0.5 ? fmt(-bal) + ' credit' : 'Settled');
      return '<div class="list-row" style="cursor:pointer" onclick="openSupplierDetail(\'' + s.id + '\')">' +
        '<div><div class="name">' + esc(s.name) + '</div><div class="meta">' + esc([s.phone, s.address].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="right"><span class="badge ' + badgeKind + '">' + badgeText + '</span></div></div>';
    }).join('') : '<div class="empty">No suppliers yet. Add one to start tracking deliveries and payments.</div>') +
    '</div>';
}

function retrySupplierDetail() { if (supplierDetailId) openSupplierDetail(supplierDetailId); }

async function openSupplierDetail(supplierId) {
  supplierDetailId = supplierId;
  var c = $('#content');
  if (!c) return;
  c.innerHTML = '<div class="empty">Loading supplier…</div>';
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  try {
    if (!supplier) {
      var { data: supRow, error: sErr } = await sb.from('suppliers').select('*').eq('id', supplierId).maybeSingle();
      if (sErr) throw sErr;
      supplier = supRow;
    }
    if (!supplier) { c.innerHTML = '<div class="card empty">Supplier not found.</div>'; return; }
    var { data: lpos, error: lErr } = await sb.from('supplier_lpos').select('*, supplier_lpo_items(*, drugs(name, unit))').eq('supplier_id', supplierId).order('delivered_at');
    if (lErr) throw lErr;
    var { data: pays, error: pErr } = await sb.from('supplier_payments').select('*').eq('supplier_id', supplierId).order('paid_at');
    if (pErr) throw pErr;
    STATE.currentSupplierDetail = { supplier: supplier, lpos: lpos || [], payments: pays || [] };
  } catch (e) {
    errorCard(c, friendlyError(e), 'retrySupplierDetail');
    return;
  }
  drawSupplierDetail();
}

function closeSupplierDetail() {
  supplierDetailId = null;
  STATE.currentSupplierDetail = null;
  STATE.currentSupplierLedger = null;
  drawSuppliersList();
}

function supplierPaymentMethodLabel(m) {
  var map = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', cheque: 'Cheque', other: 'Other' };
  return map[m] || 'Other';
}

// Merges a supplier's LPOs and payments into one chronological ledger with
// a running balance, starting from the supplier's opening balance (if any).
function buildSupplierLedger(detail) {
  var supplier = detail.supplier;
  var entries = [];
  (detail.lpos || []).forEach(function (l) {
    var items = (l.supplier_lpo_items || []).map(function (it) {
      var name = (it.drugs && it.drugs.name) || 'item';
      return name + ' ×' + it.quantity;
    });
    entries.push({
      date: l.delivered_at, sortKey: l.delivered_at + 'T00:00:01',
      label: l.lpo_number + ' · Delivery',
      detailText: items.join(', '),
      delivered: Number(l.total_amount || 0), paid: 0
    });
  });
  (detail.payments || []).forEach(function (p) {
    entries.push({
      date: p.paid_at, sortKey: p.paid_at + 'T00:00:02',
      label: 'Payment · ' + supplierPaymentMethodLabel(p.method),
      detailText: [p.reference, p.notes].filter(Boolean).join(' — '),
      delivered: 0, paid: Number(p.amount || 0)
    });
  });
  entries.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });

  var opening = Number(supplier.opening_balance || 0);
  if (opening) {
    entries.unshift({
      date: supplier.opening_balance_date || null,
      label: 'Opening balance', detailText: '', delivered: null, paid: null, openingValue: opening
    });
  }
  var running = 0;
  entries.forEach(function (e) {
    if (e.openingValue != null) running = e.openingValue;
    else running += e.delivered - e.paid;
    e.runningBalance = running;
  });
  var totalDelivered = (detail.lpos || []).reduce(function (a, l) { return a + Number(l.total_amount || 0); }, 0);
  var totalPaid = (detail.payments || []).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
  return { entries: entries, totalDelivered: totalDelivered, totalPaid: totalPaid, opening: opening, balance: running };
}

function drawSupplierDetail() {
  var c = $('#content');
  var detail = STATE.currentSupplierDetail;
  if (!detail) { drawSuppliersList(); return; }
  var supplier = detail.supplier;
  var ledger = buildSupplierLedger(detail);
  STATE.currentSupplierLedger = ledger;
  var balanceKind = ledger.balance > 0.5 ? 't-red' : (ledger.balance < -0.5 ? 't-sales' : 't-neutral');
  var contactLine = [supplier.phone, supplier.email, supplier.address].filter(Boolean).join(' · ');

  c.innerHTML =
    '<button class="btn ghost small" style="margin-bottom:10px" onclick="closeSupplierDetail()">&larr; All suppliers</button>' +
    '<div class="section-title" style="margin-top:0">' + esc(supplier.name) + '</div>' +
    (contactLine ? '<div class="tiny" style="margin-bottom:10px">' + esc(contactLine) + '</div>' : '') +
    '<div class="kpi-grid" style="margin-bottom:14px">' +
    kpi('Opening balance', fmt(ledger.opening), 't-violet') +
    kpi('Total delivered', fmt(ledger.totalDelivered), 't-orange') +
    kpi('Total paid', fmt(ledger.totalPaid), 't-sales') +
    kpi('Balance owed', fmt(ledger.balance), balanceKind) +
    '</div>' +
    '<div class="toolbar-row"><div class="toolbar-segment">' +
    (can('suppliers') ? '<button class="btn primary small" onclick="openNewLpo(\'' + supplier.id + '\')">+ New LPO</button>' +
    '<button class="btn secondary small" onclick="openRecordSupplierPayment(\'' + supplier.id + '\')">Record payment</button>' : '') +
    '</div><div class="toolbar-segment toolbar-end">' +
    '<button class="btn small" onclick="exportSupplierStatement()">' + icon('download', 15) + ' Excel</button>' +
    '<button class="btn small" onclick="printSupplierStatement()">' + icon('printer', 15) + ' Print</button>' +
    '</div></div>' +
    '<div class="section-title">Statement</div>' +
    '<div class="card">' +
    (ledger.entries.length ? ledger.entries.map(function (e) {
      var metaBits = [];
      if (e.date) metaBits.push(fmtDate(e.date));
      if (e.detailText) metaBits.push(e.detailText);
      var right = '';
      if (e.delivered) right += '<div>+' + fmt(e.delivered) + '</div>';
      if (e.paid) right += '<div style="color:var(--green)">−' + fmt(e.paid) + '</div>';
      right += '<div class="tiny">Bal ' + fmt(e.runningBalance) + '</div>';
      return '<div class="list-row"><div><div class="name">' + esc(e.label) + '</div><div class="meta">' + esc(metaBits.join(' · ')) + '</div></div>' +
        '<div class="right">' + right + '</div></div>';
    }).join('') : '<div class="empty">No deliveries or payments recorded yet.</div>') +
    '</div>';
}

function exportSupplierStatement() {
  var detail = STATE.currentSupplierDetail;
  var ledger = STATE.currentSupplierLedger;
  if (!detail || !ledger) return;
  var rows = ledger.entries.map(function (e) {
    return {
      'Date': e.date ? fmtDate(e.date) : '',
      'Entry': e.label,
      'Detail': e.detailText || '',
      'Delivered': e.delivered || '',
      'Paid': e.paid || '',
      'Balance': e.runningBalance
    };
  });
  exportExcel(detail.supplier.name + ' - statement.xlsx', 'Statement', rows);
}

function printSupplierStatement() {
  var detail = STATE.currentSupplierDetail;
  var ledger = STATE.currentSupplierLedger;
  if (!detail || !ledger) return;
  var rows = ledger.entries.map(function (e) {
    return [e.date ? fmtDate(e.date) : '—', e.label, e.detailText || '—', e.delivered ? fmt(e.delivered) : '—', e.paid ? fmt(e.paid) : '—', fmt(e.runningBalance)];
  });
  printHtml('Supplier Statement', detail.supplier.name, tableHtml(['Date', 'Entry', 'Detail', 'Delivered', 'Paid', 'Balance'], rows), 'Balance owed: ' + fmt(ledger.balance));
}

// ---------------------------------------------------------------------------
// NEW LPO — multi-drug delivery entry. Same STATE-keyed-by-id pattern as
// openSyncMasterDrugs: ticking a drug reveals its own fields, and every
// keystroke writes straight into STATE.lpoSelected with no re-render, so
// focus/typing in one row is never disturbed by editing another. Submits as
// one jsonb array to record_supplier_lpo, which creates the LPO AND the
// matching batches in a single transaction (integrated, per the owner's
// choice — one entry records both the debt and the stock received).
// ---------------------------------------------------------------------------

async function openNewLpo(supplierId) {
  lpoFilter = '';
  STATE.lpoSelected = {};
  lpoDeliveredAt = new Date().toISOString().slice(0, 10);
  lpoNotes = '';
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  var body = sheet('New LPO' + (supplier ? ': ' + supplier.name : ''), '<div class="empty">Loading drugs…</div>');
  if (!STATE.drugsCache || !STATE.drugsCache.length) {
    try {
      var { data, error } = await sb.from('v_drug_stock').select('*').order('name');
      if (error) throw error;
      STATE.drugsCache = data || [];
    } catch (e) {
      body.innerHTML = '<div class="card empty">Could not load drugs. ' + esc(friendlyError(e)) + '</div>';
      return;
    }
  }
  drawNewLpo(supplierId);
}

function drawNewLpo(supplierId) {
  var body = $('#sheetBody');
  if (!body) return;
  var q = lpoFilter.trim().toLowerCase();
  var all = STATE.drugsCache || [];
  var selectedIds = Object.keys(STATE.lpoSelected);
  var selectedDrugs = selectedIds.map(function (id) { return all.find(function (d) { return d.id === id; }); }).filter(Boolean);
  var searchMatches = q ? all.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1 && !STATE.lpoSelected[d.id]; }) : [];
  var runningTotal = selectedIds.reduce(function (sum, id) {
    var sel = STATE.lpoSelected[id];
    return sum + (parseFloat(sel.qty) || 0) * (parseFloat(sel.costPrice) || 0);
  }, 0);

  redrawKeepingFocus(body,
    '<div class="row-2">' +
    '<div class="field"><label>Delivery date</label><input type="date" value="' + esc(lpoDeliveredAt) + '" onchange="lpoDeliveredAt=this.value"></div>' +
    '<div class="field"><label>Notes (optional)</label><input value="' + esc(lpoNotes) + '" oninput="lpoNotes=this.value"></div>' +
    '</div>' +
    (selectedDrugs.length ? '<div class="tiny" style="margin-bottom:6px">On this delivery</div><div class="card" style="margin-bottom:12px">' +
      selectedDrugs.map(function (d) { return drawLpoDrugRow(d, supplierId, true); }).join('') + '</div>' : '') +
    '<div class="searchbox field"><input id="lpoSearchInput" placeholder="Search drugs to add…" value="' + esc(lpoFilter) + '" oninput="lpoFilter=this.value;drawNewLpo(\'' + supplierId + '\')"></div>' +
    (q ? (searchMatches.length ? '<div class="card">' + searchMatches.map(function (d) { return drawLpoDrugRow(d, supplierId, false); }).join('') + '</div>' : '<div class="empty">No drugs match your search.</div>') : '') +
    '<div class="tiny" style="margin:12px 0">' + selectedIds.length + ' item' + (selectedIds.length === 1 ? '' : 's') + ' selected' + (selectedIds.length ? ' · running total ' + fmt(runningTotal) : '') + '</div>' +
    '<button class="btn primary" id="lpoSaveBtn" onclick="saveLpo(\'' + supplierId + '\')"' + (selectedIds.length ? '' : ' disabled') + '>Save delivery</button>');
}

function drawLpoDrugRow(d, supplierId, selected) {
  var sel = STATE.lpoSelected[d.id];
  var row = '<div class="list-row">' +
    '<label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">' +
    '<input type="checkbox"' + (selected ? ' checked' : '') + ' onchange="toggleLpoDrug(\'' + d.id + '\',\'' + supplierId + '\')">' +
    '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + esc(d.unit) + ' · in stock: ' + d.qty_in_stock + '</div></div>' +
    '</label></div>';
  if (!selected || !sel) return row;
  row +=
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Quantity (' + esc(d.unit) + ')</label><input type="number" min="1" value="' + esc(sel.qty) + '" oninput="updateLpoField(\'' + d.id + '\',\'qty\',this.value)"></div>' +
    '<div class="field"><label>Cost price / unit</label><input type="number" step="0.01" value="' + esc(sel.costPrice) + '" oninput="updateLpoField(\'' + d.id + '\',\'costPrice\',this.value)"></div>' +
    '</div>' +
    '<div class="row-2" style="padding:0 4px 4px 34px">' +
    '<div class="field"><label>Sell price / unit</label><input type="number" step="0.01" value="' + esc(sel.sellPrice) + '" oninput="updateLpoField(\'' + d.id + '\',\'sellPrice\',this.value)"></div>' +
    '<div class="field"><label>Batch no. (optional)</label><input value="' + esc(sel.batchNo) + '" oninput="updateLpoField(\'' + d.id + '\',\'batchNo\',this.value)"></div>' +
    '</div>' +
    '<div class="row-2" style="padding:0 4px 14px 34px">' +
    '<div class="field"><label>Expiry date</label><input type="date" value="' + esc(sel.expiry) + '"' + (sel.expiryUnknown ? ' disabled' : '') + ' oninput="updateLpoField(\'' + d.id + '\',\'expiry\',this.value)"></div>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-top:22px"><input type="checkbox"' + (sel.expiryUnknown ? ' checked' : '') + ' onchange="toggleLpoExpiryUnknown(\'' + d.id + '\',\'' + supplierId + '\',this.checked)"> Expiry unknown</label>' +
    '</div>';
  return row;
}

// BUG FIX: the search-results list (searchMatches, in drawNewLpo) always
// excludes anything already in STATE.lpoSelected, since a selected drug is
// meant to show only in the "On this delivery" card above instead. Ticking
// a drug that was the search's only match used to leave lpoFilter
// unchanged, so the very next render recomputed searchMatches against that
// same query, found it now excluded, and landed on "No drugs match your
// search" — even though the tick had just worked and the drug was sitting
// right there in "On this delivery". Clearing the search box on a genuine
// selection (not on de-selecting) sidesteps that: the search section
// collapses back to nothing instead of showing a contradictory empty state,
// and the user can see their pick in "On this delivery" right away.
function toggleLpoDrug(drugId, supplierId) {
  if (STATE.lpoSelected[drugId]) {
    delete STATE.lpoSelected[drugId];
  } else {
    var d = (STATE.drugsCache || []).find(function (x) { return x.id === drugId; });
    STATE.lpoSelected[drugId] = { qty: '', costPrice: '', sellPrice: d && d.default_price ? String(d.default_price) : '', expiry: '', expiryUnknown: false, batchNo: '' };
    lpoFilter = '';
  }
  drawNewLpo(supplierId);
}

// Field edits write straight into STATE, with no re-render — see the note
// on updateSyncField above for why (re-rendering would reset focus/typing
// in every other expanded row).
function updateLpoField(drugId, field, value) {
  if (STATE.lpoSelected[drugId]) STATE.lpoSelected[drugId][field] = value;
}

function toggleLpoExpiryUnknown(drugId, supplierId, checked) {
  if (STATE.lpoSelected[drugId]) { STATE.lpoSelected[drugId].expiryUnknown = checked; drawNewLpo(supplierId); }
}

async function saveLpo(supplierId) {
  var btn = $('#lpoSaveBtn');
  if (!btn) return;
  act(btn, async function () {
    var ids = Object.keys(STATE.lpoSelected);
    if (!ids.length) { toast('Select at least one drug.', 'bad'); return; }
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var sel = STATE.lpoSelected[id];
      var drug = (STATE.drugsCache || []).find(function (d) { return d.id === id; });
      var label = drug ? drug.name : 'a selected drug';
      var qty = parseInt(sel.qty, 10);
      if (!qty || qty <= 0) { toast('Enter a valid quantity for ' + label + '.', 'bad'); return; }
      var cost = parseFloat(sel.costPrice);
      if (!cost || cost <= 0) { toast('Enter a cost price for ' + label + '.', 'bad'); return; }
      var sell = parseFloat(sel.sellPrice) || cost;
      if (!sel.expiryUnknown && !sel.expiry) { toast('Enter the expiry date for ' + label + ', or mark it unknown.', 'bad'); return; }
      items.push({
        drug_id: id, quantity: qty, cost_price: cost, sell_price: sell,
        expiry_date: sel.expiryUnknown ? null : sel.expiry,
        expiry_unknown: !!sel.expiryUnknown,
        batch_no: sel.batchNo ? sel.batchNo.trim() : null
      });
    }
    var { error } = await sb.rpc('record_supplier_lpo', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_supplier_id: supplierId,
      p_items: items,
      p_delivered_at: lpoDeliveredAt || null,
      p_notes: lpoNotes.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Delivery recorded.', 'good');
    STATE.lpoSelected = {};
    closeSheet();
    openSupplierDetail(supplierId);
  });
}

function openRecordSupplierPayment(supplierId) {
  var supplier = (STATE.suppliersCache || []).find(function (s) { return s.id === supplierId; });
  var body = sheet('Record payment' + (supplier ? ': ' + supplier.name : ''), '');
  body.innerHTML =
    '<div class="row-2">' +
    '<div class="field"><label>Amount</label><input id="spmAmount" type="number" step="0.01" min="0"></div>' +
    '<div class="field"><label>Method</label><select id="spmMethod">' +
    '<option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="cheque">Cheque</option><option value="other">Other</option>' +
    '</select></div></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Date</label><input id="spmDate" type="date" value="' + esc(new Date().toISOString().slice(0, 10)) + '"></div>' +
    '<div class="field"><label>Reference (optional)</label><input id="spmReference" placeholder="e.g. M-Pesa code"></div></div>' +
    '<div class="field"><label>Notes (optional)</label><input id="spmNotes"></div>' +
    '<button class="btn primary" id="spmSaveBtn" onclick="saveSupplierPayment(\'' + supplierId + '\')">Save payment</button>';
}

async function saveSupplierPayment(supplierId) {
  var btn = $('#spmSaveBtn');
  act(btn, async function () {
    var amount = parseFloat($('#spmAmount').value);
    if (!amount || amount <= 0) { toast('Enter a valid amount.', 'bad'); return; }
    var { error } = await sb.rpc('record_supplier_payment', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_supplier_id: supplierId,
      p_amount: amount,
      p_method: $('#spmMethod').value,
      p_reference: $('#spmReference').value.trim() || null,
      p_paid_at: $('#spmDate').value || null,
      p_notes: $('#spmNotes').value.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    toast('Payment recorded.', 'good');
    closeSheet();
    openSupplierDetail(supplierId);
  });
}

function openAddSupplier() {
  var body = sheet('New supplier', '');
  body.innerHTML =
    '<div class="field"><label>Name</label><input id="spName"></div>' +
    '<div class="row-2"><div class="field"><label>Phone</label><input id="spPhone"></div>' +
    '<div class="field"><label>Email</label><input id="spEmail"></div></div>' +
    '<div class="field"><label>Address</label><input id="spAddress"></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>Opening balance owed (optional)</label><input id="spOpening" type="number" step="0.01" min="0" placeholder="0"></div>' +
    '<div class="field"><label>As of date</label><input id="spOpeningDate" type="date"></div></div>' +
    '<div class="tiny" style="margin-bottom:10px">Leave the opening balance at 0 if there was no outstanding debt with this supplier before you started tracking it here.</div>' +
    '<button class="btn primary" id="spSaveBtn" onclick="saveSupplier()">Save supplier</button>';
}

async function saveSupplier() {
  var btn = $('#spSaveBtn');
  act(btn, async function () {
    var name = $('#spName').value.trim();
    if (!name) { toast('Give the supplier a name.', 'bad'); return; }
    var opening = parseFloat($('#spOpening').value) || 0;
    var { error } = await sb.from('suppliers').insert({
      pharmacy_id: STATE.profile.pharmacy_id, name: name,
      phone: $('#spPhone').value.trim() || null, email: $('#spEmail').value.trim() || null,
      address: $('#spAddress').value.trim() || null,
      opening_balance: opening,
      opening_balance_date: opening ? ($('#spOpeningDate').value || new Date().toISOString().slice(0, 10)) : null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
    var { data: sups } = await sb.from('suppliers').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id).order('name');
    STATE.suppliersCache = sups || [];
    toast('Supplier added.', 'good');
    closeSheet();
    renderSuppliers();
  });
}

// ---------------------------------------------------------------------------
// EXPENSES — a general pharmacy-expenses ledger (rent, utilities, salaries,
// transport, licenses, marketing, maintenance, supplies, other), separate
// from Suppliers (which is specifically about drug-stock deliveries and
// supplier debt). Same Today/Week/Month/Year range filter as the dashboard
// (filtered client-side against one fetch — expense volume for a single
// pharmacy is small, so a second RPC isn't worth the complexity). Voiding
// follows the same soft-delete pattern as void_sale — see schema.sql §14.
// ---------------------------------------------------------------------------

var expRange = 'month';
var expensesAllCache = [];  // every expense (incl. voided) for this pharmacy, newest first; filtered client-side by expRange
var EXP_CATEGORY_LABELS = {
  rent: 'Rent', utilities: 'Utilities', salaries: 'Salaries', transport: 'Transport',
  licenses: 'Licenses & permits', marketing: 'Marketing', maintenance: 'Maintenance & repairs',
  supplies: 'Supplies', other: 'Other'
};

async function renderExpenses() {
  var c = $('#content');
  if (!can('expenses') && !can('view_expenses')) { c.innerHTML = '<div class="card empty">You do not have access to Expenses.</div>'; return; }
  c.innerHTML = '<div class="empty">Loading expenses…</div>';
  try {
    var { data, error } = await sb.from('expenses').select('*').eq('pharmacy_id', STATE.profile.pharmacy_id)
      .order('expense_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    expensesAllCache = data || [];
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
  return new Date(now.getFullYear(), now.getMonth(), 1); // month (default)
}

function setExpRange(r) {
  if (r === expRange) return;
  expRange = r;
  drawExpensesList();
}

function drawExpensesList() {
  var c = $('#content');
  var startStr = expRangeStart(expRange).toISOString().slice(0, 10);
  var inRange = expensesAllCache.filter(function (e) { return e.expense_date >= startStr; });
  var active = inRange.filter(function (e) { return !e.voided; });
  var total = active.reduce(function (a, e) { return a + Number(e.amount || 0); }, 0);

  var byCategory = {};
  active.forEach(function (e) { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0); });
  var catRows = Object.keys(byCategory).map(function (k) { return { cat: k, total: byCategory[k] }; })
    .sort(function (a, b) { return b.total - a.total; });
  var breakdownHtml = catRows.length
    ? catRows.map(function (r) { return listRow(expenseCategoryLabel(r.cat), '', fmt(r.total)); }).join('')
    : '<div class="empty">No expenses recorded yet for this period.</div>';

  var listHtml = inRange.length ? inRange.map(expenseRowHtml).join('') : '<div class="empty">No expenses recorded yet for this period.</div>';

  c.innerHTML =
    (can('expenses') ? '<div class="toolbar-row"><button class="btn primary" onclick="openAddExpense()">+ New expense</button></div>' : '') +
    '<div class="dash-filter-row"><div class="dash-tabs">' +
      ['today', 'week', 'month', 'year'].map(function (r) {
        return '<button class="dash-tab' + (expRange === r ? ' active' : '') + '" onclick="setExpRange(\'' + r + '\')">' + DASH_RANGE_LABELS[r] + '</button>';
      }).join('') +
    '</div><div class="dash-period-label">' + DASH_PERIOD_LABEL[expRange] + '</div></div>' +
    '<div class="kpi-grid" style="margin-bottom:14px">' +
      kpi('Total spent', fmt(total), 't-red') +
      kpi('Entries', active.length, 't-violet') +
    '</div>' +
    '<div class="section-title">By category</div>' +
    '<div class="card" style="margin-bottom:14px">' + breakdownHtml + '</div>' +
    '<div class="section-title">All expenses — ' + esc(DASH_PERIOD_LABEL[expRange].toLowerCase()) + '</div>' +
    '<div class="card">' + listHtml + '</div>';
}

function expenseCategoryLabel(cat) {
  if (EXP_CATEGORY_LABELS[cat]) return EXP_CATEGORY_LABELS[cat];
  var s = String(cat || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Other';
}

// Every distinct category this pharmacy has actually used, beyond the
// fixed preset — feeds the "New expense" category datalist so a custom
// category someone typed once shows up as a quick pick next time, without
// needing a separate categories table.
function expCustomCategories() {
  var seen = {};
  (expensesAllCache || []).forEach(function (e) { if (e.category) seen[e.category] = true; });
  return Object.keys(seen).filter(function (c) { return !EXP_CATEGORY_LABELS[c]; }).sort();
}

function expenseRowHtml(e) {
  var meta = [fmtDate(e.expense_date), expenseCategoryLabel(e.category), supplierPaymentMethodLabel(e.method)].join(' · ');
  var right = fmt(e.amount) + (!e.voided && can('expenses') ? ' <button class="btn danger small" style="margin-left:14px" onclick="openReverseExpense(\'' + e.id + '\')">Reverse</button>' : '');
  return '<div class="list-row">' +
    '<div><div class="name">' + esc(e.description) + (e.voided ? ' <span class="badge bad">Reversed</span>' : '') + '</div><div class="meta">' + esc(meta) + '</div></div>' +
    '<div class="right">' + right + '</div></div>';
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

async function saveExpense() {
  var btn = $('#exSaveBtn');
  act(btn, async function () {
    var description = $('#exDescription').value.trim();
    if (!description) { toast('Give the expense a short description.', 'bad'); return; }
    var amount = parseFloat($('#exAmount').value);
    if (!amount || amount <= 0) { toast('Enter a valid amount.', 'bad'); return; }
    // Free-text category (fixed presets and custom ones alike) — normalized
    // to lowercase/trimmed for storage so "Rent" and "rent" group together;
    // displayed back through expenseCategoryLabel(), which title-cases
    // anything not in the fixed EXP_CATEGORY_LABELS preset.
    var categoryRaw = $('#exCategory').value.trim();
    var category = categoryRaw.toLowerCase().replace(/\s+/g, ' ') || 'other';
    var { error } = await sb.rpc('record_expense', {
      p_pharmacy_id: STATE.profile.pharmacy_id,
      p_category: category,
      p_description: description,
      p_amount: amount,
      p_method: $('#exMethod').value,
      p_expense_date: $('#exDate').value || null,
      p_notes: $('#exNotes').value.trim() || null
    });
    if (error) { toast(friendlyError(error), 'bad'); return; }
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

// Item 3: was two hardcoded one-tap buttons (pharmacist/seller only) that
// generated a permanent-account code immediately. Now a role picker
// covering all 5 invitable roles, plus an account time-limit picker —
// mandatory (and forced non-permanent) for accountant, optional for
// everyone else — since the resulting account's lifespan is now a real
// thing to choose, not just the 7-day code-redemption window.
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
