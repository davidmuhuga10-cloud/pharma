// js/core.js - Shared basics: settings, who may do what (roles), English/Swahili text, icons, pop-up dialogs, the loading screen and the lazy Excel loader.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
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
  'edit_inventory', 'restock', 'write_off', 'correct_stock', 'return', 'void', 'discount', 'claims', 'suppliers', 'expenses',
  'customers', 'sms', 'credit_limit', 'controlled', 'view_controlled', 'stock_take', 'approve_stock_take'];
var ATTENDANT_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export', 'customers'];
// Friendly labels for the 6 fixed roles — used anywhere a role is shown to
// a person (staff list, invite picker, "signed in as", account-expired
// messaging), so the raw enum value (e.g. 'stock_taker') is never printed.
var ROLE_LABELS = { owner: 'Owner', co_owner: 'Co-owner', pharmacist: 'Pharmacist', stock_taker: 'Stock taker', attendant: 'Seller', accountant: 'Accountant' };
function roleLabel(r) { return ROLE_LABELS[r] || r; }

var STOCK_TAKER_ACTIONS = ['view_dashboard', 'view_inventory', 'view_reports', 'print', 'export', 'restock', 'correct_stock', 'stock_take', 'view_controlled'];
// 'view_suppliers'/'view_expenses' (read-only) are deliberately distinct
// from 'suppliers'/'expenses' (full read+write, see PHARMACIST_ACTIONS) —
// an accountant should see the Suppliers/Expenses tabs and every figure on
// them, but never the write actions (new supplier, new LPO, record
// payment, new expense, reverse expense) that live on those same screens.
var ACCOUNTANT_ACTIONS = ['view_dashboard', 'view_reports', 'print', 'export', 'claims', 'view_suppliers', 'view_expenses', 'view_customers', 'view_controlled'];

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
    salesWeek: 'Sales, last 7 days', salesMonth: 'Sales this month', needsAttention: 'Needs attention',
    outOfStock: 'Out of stock', lowStock: 'Low stock', expiringSoon: 'Expiring soon',
    logOut: 'Log out', addDrug: '+ Add new drug', checkout: 'Checkout', total: 'Total',
    suppliers: 'Suppliers', expenses: 'Expenses'
  },
  sw: {
    home: 'Nyumbani', stock: 'Bidhaa', sell: 'Uza', reports: 'Ripoti', settings: 'Mipangilio',
    dashboard: 'Dashibodi', stockValue: 'Thamani ya bidhaa (rejareja)', salesToday: 'Mauzo leo',
    salesWeek: 'Mauzo siku 7 zilizopita', salesMonth: 'Mauzo mwezi huu', needsAttention: 'Yanayohitaji uangalizi',
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
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2c2.6.2 4.5 2.4 4.5 5.3"/>',
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
  // A text box that is being typed in is KEPT as the very same element while
  // everything around it is replaced. Rebuilding it on every key press makes
  // phone keyboards (Gboard and others) lose the word being typed, and
  // sometimes the keyboard itself; keeping the element avoids all of that.
  if (activeId && active.tagName === 'INPUT' && /^(text|search|tel|email|url)$/i.test(active.type || 'text')) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var twin = null, all = tmp.getElementsByTagName('input');
    for (var k = 0; k < all.length; k++) { if (all[k].id === activeId) { twin = all[k]; break; } }
    if (twin) {
      var oldNode = active, newNode = twin;
      while (oldNode !== container && newNode !== tmp) {
        var oldParent = oldNode.parentNode, newParent = newNode.parentNode;
        while (oldNode.previousSibling) oldParent.removeChild(oldNode.previousSibling);
        while (oldNode.nextSibling) oldParent.removeChild(oldNode.nextSibling);
        var seenSelf = false, before = [], after = [];
        for (var c = newParent.firstChild; c; c = c.nextSibling) {
          if (c === newNode) { seenSelf = true; continue; }
          (seenSelf ? after : before).push(c);
        }
        before.forEach(function (n) { oldParent.insertBefore(n, oldNode); });
        after.forEach(function (n) { oldParent.appendChild(n); });
        if (oldParent !== container) syncAttributes(oldParent, newParent);
        oldNode = oldParent; newNode = newParent;
      }
      return;
    }
  }
  var selStart = null, selEnd = null;
  if (activeId && typeof active.selectionStart === 'number') { selStart = active.selectionStart; selEnd = active.selectionEnd; }
  container.innerHTML = html;
  if (activeId) {
    var el = document.getElementById(activeId);
    if (el) {
      el.focus();
      if (selStart !== null && el.setSelectionRange) {
        try { el.setSelectionRange(selStart, selEnd); } catch (e) {}
      } else if (el.type === 'number' && el.value !== '') {
        // Number boxes do not report a cursor position, and a freshly built
        // one starts with the cursor at the front, so typing 100 came out as
        // "001". Put the cursor at the end (the way amounts are typed) by
        // briefly treating the box as text.
        try { el.type = 'text'; el.setSelectionRange(el.value.length, el.value.length); el.type = 'number'; } catch (e) {}
      }
    }
  }
}
function syncAttributes(to, from) {
  Array.prototype.slice.call(to.attributes).forEach(function (a) { if (!from.hasAttribute(a.name)) to.removeAttribute(a.name); });
  Array.prototype.slice.call(from.attributes).forEach(function (a) { if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value); });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
}); }
// Whole shillings for the ordinary case (that is how a Kenyan pharmacy prices,
// and how a till reads), but never round a fractional amount away: this used
// to hard-round everything, so a checkout 40 cents short displayed "Balance
// KES 0" in red while Confirm stayed disabled with no visible reason. Prices
// and markdowns are stored to 2dp, so cents really do occur.
function fmt(n) {
  var v = Number(n) || 0;
  var whole = Math.abs(v - Math.round(v)) < 0.005;
  return 'KES ' + (whole
    ? Math.round(v).toLocaleString()
    : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
// "1 tablet" / "232 tablets" / "0 units" — the unit is stored singular
// (tablet, bottle, sachet…). Short/abbreviated units (ml, mg, pcs) are left
// as typed, since "mls" or "pcses" would read worse than no plural at all.
function qtyUnit(n, unit) {
  var u = String(unit || 'unit');
  var q = Number(n) || 0;
  if (q === 1 || u.length < 3 || !/^[a-z]+$/i.test(u) || /^(mcg|pcs|iu)$/i.test(u)) return q.toLocaleString() + ' ' + u;
  if (/(s|x|ch|sh)$/i.test(u)) return q.toLocaleString() + ' ' + u + 'es';
  if (/[^aeiou]y$/i.test(u)) return q.toLocaleString() + ' ' + u.slice(0, -1) + 'ies';
  return q.toLocaleString() + ' ' + u + 's';
}
var PAY_LABEL = { credit: 'Credit (kopa)', cash: 'Cash', mpesa: 'M-Pesa', insurance: 'Insurance', bank: 'Bank', cheque: 'Cheque', other: 'Other', split: 'Split' };
function payLabel(m) { return PAY_LABEL[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : ''); }
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
// ---------------------------------------------------------------------------
// In-app pop-ups. These replace the browser's own confirm()/prompt() boxes,
// which print the website's address ("<site> says…") and cannot be styled.
// askConfirm resolves true/false, askText resolves the text (or null when
// cancelled). The phone's Back button cancels them (nativeShell.js).
// ---------------------------------------------------------------------------
function closeDialog() { var d = document.querySelector('.dlg-mask'); if (d && d._cancel) d._cancel(); else if (d) d.remove(); }
function askDialog(o) {
  return new Promise(function (resolve) {
    var old = document.querySelector('.dlg-mask'); if (old) old.remove();
    var m = document.createElement('div');
    m.className = 'dlg-mask';
    m.innerHTML =
      '<div class="dlg" role="dialog" aria-modal="true">' +
      '<h3 class="dlg-title">' + esc(o.title || 'Please confirm') + '</h3>' +
      (o.message ? '<p class="dlg-msg">' + esc(o.message) + '</p>' : '') +
      (o.input ? '<input class="dlg-input" id="dlgInput" maxlength="' + (o.maxlength || 60) + '" placeholder="' + esc(o.placeholder || '') + '" autocomplete="off">' : '') +
      '<div class="dlg-actions">' +
      '<button class="btn secondary" id="dlgNo">' + esc(o.cancelLabel || 'Cancel') + '</button>' +
      '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" id="dlgYes">' + esc(o.okLabel || 'OK') + '</button>' +
      '</div></div>';
    var done = false;
    function finish(v) { if (done) return; done = true; m.remove(); resolve(v); }
    m._cancel = function () { finish(o.input ? null : false); };
    m.addEventListener('click', function (e) { if (e.target === m) m._cancel(); });
    document.body.appendChild(m);
    var inp = m.querySelector('#dlgInput');
    m.querySelector('#dlgNo').onclick = m._cancel;
    m.querySelector('#dlgYes').onclick = function () { finish(o.input ? inp.value.trim() : true); };
    if (inp) { inp.onkeydown = function (e) { if (e.key === 'Enter') m.querySelector('#dlgYes').click(); }; setTimeout(function () { inp.focus(); }, 30); }
    else setTimeout(function () { var y = m.querySelector('#dlgYes'); if (y) y.focus(); }, 30);
  });
}
function askConfirm(title, message, okLabel, danger) { return askDialog({ title: title, message: message, okLabel: okLabel, danger: danger }); }
function askText(title, message, placeholder, okLabel) { return askDialog({ title: title, message: message, input: true, placeholder: placeholder, okLabel: okLabel }); }

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
// Anything a person sees goes through here. Our own messages (written in plain
// words inside the database functions) pass through unchanged; anything that
// looks technical, or names the services behind the app, becomes a plain
// sentence. Nobody should ever see a provider's name or a code.
function friendlyError(e) {
  var msg = (e && e.message) || String(e || '');
  if (/failed to fetch|network|load failed|networkerror|err_internet|offline/i.test(msg)) return 'No internet connection — check your connection and try again.';
  if (/jwt|refresh token|session (has )?expired|not authenticated|auth session missing|invalid token/i.test(msg)) return 'Your session has ended. Please log in again.';
  if (/user already registered|already been registered|already exists.*user/i.test(msg)) return 'That phone number already has an account. Please log in instead.';
  if (/password should be|weak password|at least \d+ characters/i.test(msg)) return 'Use a stronger password (at least 8 characters).';
  if (/rate limit|too many requests|over_.*_rate/i.test(msg)) return 'Too many tries. Please wait a minute and try again.';
  if (/row-level security|permission denied|not allowed|violates row/i.test(msg)) return 'You do not have permission to do that.';
  if (/duplicate key|unique constraint|already exists/i.test(msg)) return 'That already exists. Check the name or number and try again.';
  if (/foreign key|violates|is still referenced/i.test(msg)) return 'This is linked to other records, so it cannot be changed this way.';
  if (/timeout|timed out|statement timeout|aborted/i.test(msg)) return 'That took too long. Please try again.';
  if (/supabase|netlify|postgres|postgrest|pgrst|sqlstate|schema cache|edge function|functionshttp|functionsrelay|non-2xx|relation .* does not exist|column .* does not exist|function .* does not exist|syntax error|typeerror|referenceerror|is not a function|is not defined|cannot read|undefined|unexpected token|<html|\bhttp \d{3}|\b50\d\b/i.test(msg)) return 'Something went wrong on our side. Please try again in a moment.';
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
// LOADING SCREEN & LAZY EXCEL LIBRARY
// ---------------------------------------------------------------------------

// The branded loading screen. index.html carries this exact markup, drawn
// before any script has downloaded; this copy is for the moments after
// (e.g. straight after pressing Log in). Keep the two identical — their
// styles are the "critical" block at the end of style.css.
function loadScreenHtml() {
  return '<div class="loadscreen" role="status" aria-label="Opening Pharma"><div class="loadscreen-mark"><svg viewBox="0 0 48 48" aria-hidden="true"><polygon points="18,6 30,6 30,18 42,18 42,30 30,30 30,42 18,42 18,30 6,30 6,18 18,18" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg></div><p class="loadscreen-word">Pharma</p><svg class="loadscreen-ecg" viewBox="0 0 200 34" fill="none" stroke="#E7C76A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M0 18h54l8-14 10 28 10-20 6 6h112"/></svg><p class="loadscreen-tag">Know your stock</p></div>';
}

// vendor-xlsx.js is 880 KB and only Excel export/import need it, so it is
// not loaded with the page. warmXlsx() fetches it quietly a few seconds after
// the first screen is up (so it is normally ready before anyone taps Export),
// unless the device is on Data Saver or a slow connection;
// withXlsx() runs a callback once it is there, loading it first if needed.
var xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxLoading) {
    xlsxLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'vendor-xlsx.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { xlsxLoading = null; reject(new Error('Could not load the Excel tools — check your internet connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return xlsxLoading;
}
function warmXlsx() {
  // Not on Data Saver or a slow (2G/3G) connection: 880 KB is a real cost
  // there, so on those it loads only when someone actually taps Excel.
  var c = navigator.connection;
  if (c && (c.saveData || /(^|-)(slow-)?2g$|3g/.test(c.effectiveType || ''))) return;
  var go = function () { loadXlsx().catch(function () {}); };
  if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 8000 });
  else setTimeout(go, 4000);
}

// ---------------------------------------------------------------------------
