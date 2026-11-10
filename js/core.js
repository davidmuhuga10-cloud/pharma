// js/core.js - shared basics: settings, roles and permissions, text strings,
// icons, pop-up dialogs, loading screen and the lazy Excel loader.
// All js/ files share one global scope, so load order in index.html matters.
// Pharma - pharmacy stock and sales. Plain JavaScript, no build step.
// Supabase handles the database, login and row-level security (see schema.sql).

var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

var STATE = {
  session: null,
  profile: null,  // { id, pharmacy_id, full_name, role, active, language }
  pharmacy: null,  // { id, name, currency, expiry_warn_days, vat_rate }
  tab: 'dashboard',
  cart: [],  // [{ drug_id, name, unit, price, qty, stock, rx }]
  drugsCache: [],
  categoriesCache: [],
  suppliersCache: [],
  masterDrugsCache: [],  // shared drug catalogue used by "Sync common drugs"
  syncSelected: {},  // { master_drug_id: {qty, sellPrice, reorderLevel, expiry, costPrice} } while that sheet is open
  lpoSelected: {},  // { drug_id: {qty, costPrice, sellPrice, expiry, expiryUnknown, batchNo} } while the New LPO sheet is open
  authMode: 'login'    // 'login' | 'signup' | 'join'
};

// --- Roles and permissions ---
// This only decides what the screen offers. The real gate is the database
// (row-level security and the role checks inside its functions), so a hidden
// button can never be bypassed by calling the API directly.
//   owner / co_owner  everything (co_owner is equal to owner in practice)
//   pharmacist        daily stock and sales, no settings or staff
//   stock_taker       view and count stock, restock, view reports
//   attendant         sell and look things up only
//   accountant        read-only finance (reports, suppliers, expenses, claims);
//                     always a temporary account made from a staff invite code
// A person with no profile row has no access at all.
var PHARMACIST_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export',
  'edit_inventory', 'restock', 'write_off', 'correct_stock', 'return', 'void', 'discount', 'claims', 'suppliers', 'expenses',
  'customers', 'sms', 'credit_limit', 'controlled', 'view_controlled', 'stock_take', 'approve_stock_take', 'undo_stock_sheet', 'cash_close', 'cash_review'];
var ATTENDANT_ACTIONS = ['sell', 'view_dashboard', 'view_inventory', 'view_reports', 'print', 'export', 'customers', 'cash_close'];
// Readable role names for anywhere a role is shown to a person.
var ROLE_LABELS = { owner: 'Owner', co_owner: 'Co-owner', pharmacist: 'Pharmacist', stock_taker: 'Stock taker', attendant: 'Seller', accountant: 'Accountant' };
function roleLabel(r) { return ROLE_LABELS[r] || r; }

var STOCK_TAKER_ACTIONS = ['view_dashboard', 'view_inventory', 'view_reports', 'print', 'export', 'restock', 'correct_stock', 'stock_take', 'view_controlled'];
// 'view_suppliers' and 'view_expenses' are read-only. 'suppliers' and 'expenses'
// can also write. An accountant sees the figures but none of the write buttons.
var ACCOUNTANT_ACTIONS = ['view_dashboard', 'view_reports', 'print', 'export', 'claims', 'view_suppliers', 'view_expenses', 'view_customers', 'view_controlled', 'cash_review'];

// ---- Per-staff permissions ------------------------------------------------
// profiles.access holds what the owner switched off for one person (null =
// everything, as before). Owner and co-owner are never limited. This hides
// screens and figures; the dashboard functions and v_drug_stock also blank the
// same figures in the database (migrations/2026-11-09_staff_access.sql).
// The switch list, the presets and the editor are in js/staff-access.js.
function staffAccessOf(profile) {
  return profile && profile.access && typeof profile.access === 'object' ? profile.access : null;
}
function isOwnerRole(role) { return role === 'owner' || role === 'co_owner'; }
// Does this person hold the permission? (keys: ACCESS_KEYS in js/staff-access.js)
function canSee(key) {
  var p = STATE.profile;
  if (!p) return false;
  if (isOwnerRole(p.role)) return true;
  var a = staffAccessOf(p);
  if (!a || !(key in a)) return true;
  return a[key] !== false;
}
// Controlled drugs register: 'off' | 'view' | 'record'.
function controlledLevelOf(profile) {
  if (!profile) return 'off';
  if (isOwnerRole(profile.role)) return 'record';
  var a = staffAccessOf(profile);
  if (a && (a.controlled === 'off' || a.controlled === 'view' || a.controlled === 'record')) return a.controlled;
  if (profile.role === 'pharmacist') return 'record';
  if (profile.role === 'stock_taker' || profile.role === 'accountant') return 'view';
  return 'off';
}
function controlledLevel() { return controlledLevelOf(STATE.profile); }
function can(action) {
  if (!STATE.profile) return false;
  var role = STATE.profile.role;
  if (role === 'owner' || role === 'co_owner') return true;
  var acc = staffAccessOf(STATE.profile);
  if (acc) {
    if ((action === 'export' || action === 'print') && acc.export === false) return false;
    if (action === 'controlled' && acc.controlled) return acc.controlled === 'record';
    if (action === 'view_controlled' && acc.controlled) return acc.controlled !== 'off';
  }
  if (role === 'pharmacist') return PHARMACIST_ACTIONS.indexOf(action) !== -1;
  if (role === 'stock_taker') return STOCK_TAKER_ACTIONS.indexOf(action) !== -1;
  if (role === 'accountant') return ACCOUNTANT_ACTIONS.indexOf(action) !== -1;
  return ATTENDANT_ACTIONS.indexOf(action) !== -1;
}

// --- Text strings (English / Swahili) ---
// Only the main navigation and headlines are translated so far.
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
// English only for now, whatever the profile says: a half-translated screen
// is more confusing than a fully English one. Read STATE.profile.language
// again once Swahili is complete.
function t(key) {
  return STRINGS.en[key] || key;
}

// --- Icons ---
// Inline SVGs, so there is no icon font to download. They use
// stroke="currentColor" and take their colour from CSS.
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
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2c2.6.2 4.5 2.4 4.5 5.3"/>',
  // date-range calendar button
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.5 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  barcode: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><line x1="6" y1="7.5" x2="6" y2="16.5"/><line x1="9" y1="7.5" x2="9" y2="16.5"/><line x1="11.5" y1="7.5" x2="11.5" y2="16.5"/><line x1="14.5" y1="7.5" x2="14.5" y2="16.5"/><line x1="17" y1="7.5" x2="17" y2="16.5"/>'
};
function icon(name, size) {
  var s = size || 18;
  return '<svg class="ic-svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
}
// Password box with a show/hide eye. One document-level click handler covers
// every box, including ones drawn later.
// Capital-off and no auto-correct: when the eye turns the field into plain text, a phone keyboard
// would otherwise capitalise the first letter and the login would say "incorrect".
function pwField(id, placeholder) {
  return '<div class="pw-wrap"><input id="' + id + '" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="' + placeholder + '">' +
    '<button type="button" class="pw-eye" aria-label="Show password" aria-pressed="false">' + icon('eye', 20) + '</button></div>';
}
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('.pw-eye');
  if (!b) return;
  var inp = b.parentNode.querySelector('input');
  var show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  b.innerHTML = icon(show ? 'eyeOff' : 'eye', 20);
  b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  b.setAttribute('aria-pressed', show ? 'true' : 'false');
});
// Brand mark (green badge with the "P") for the sign-in screen, top bar and
// loading screen.
function logoMarkHtml(size) {
  var s = size || 44;
  return '<div class="brand-badge" style="width:' + s + 'px;height:' + s + 'px;font-size:' + Math.round(s * 0.5) + 'px">P</div>';
}

function $(sel, ctx) { return (ctx || document).querySelector(sel); }

// Screens redraw a whole container's HTML on every change. That recreates a
// search box and drops the cursor after each key press. This puts focus and
// cursor position back on the same element id after a redraw.
function redrawKeepingFocus(container, html) {
  var active = document.activeElement;
  var activeId = (active && container.contains(active) && active.id) ? active.id : null;
  // A box being typed in is kept as the same element while its surroundings are
  // replaced. Rebuilding it makes phone keyboards lose the word being typed.
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
        // Number boxes report no cursor position, so a rebuilt one starts with the
        // cursor at the front and "100" comes out as "001". Treat the box as text
        // briefly to put the cursor at the end.
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
// esc() is for HTML. It is NOT enough inside a JavaScript string in an
// onclick="..." attribute, because the browser HTML-decodes the attribute
// before the JavaScript is parsed: esc()'s &#39; turns back into a real quote
// and ends the string early. That is why `esc(x).replace(/'/g, "\\'")` never
// worked - esc() has already turned every quote into &#39;, so the replace
// matches nothing and does nothing. The symptom was a drug named "Jack's
// Cough Syrup" making those buttons do nothing at all.
// jsArg() escapes a value for that position: anything that could end the
// string, end the attribute, or come back as one of those characters when the
// browser decodes the attribute becomes a \uXXXX escape, which survives HTML
// decoding unchanged. Use jsArg() for a value going into onclick="fn('...')",
// and esc() for a value going into HTML text or a normal attribute.
function jsArg(s) {
  return String(s == null ? '' : s).replace(/[\\'"&<>\u000d\u000a\u2028\u2029]/g, function (c) {
    var h = c.charCodeAt(0).toString(16);
    return '\\u' + '0000'.slice(h.length) + h;
  });
}
// Whole shillings normally, but never round away a real fractional amount
// (prices and discounts can have cents). Rounding everything once showed
// "Balance KES 0" while Confirm stayed disabled.
function fmt(n) {
  var v = Number(n) || 0;
  var whole = Math.abs(v - Math.round(v)) < 0.005;
  return 'KES ' + (whole
    ? Math.round(v).toLocaleString()
    : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
// "1 tablet" / "232 tablets" / "0 units". Units are stored singular. Short
// units (ml, mg, pcs) are left as typed.
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
// --- Pop-ups ---
// Replace the browser's confirm()/prompt(), which show the site address and
// cannot be styled. askConfirm resolves true/false; askText resolves the text
// or null on cancel. The phone's Back button cancels them (nativeShell.js).
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

// Runs an action button's request. The button is disabled and shows
// "Please wait..." until the request ends, so it cannot be tapped twice. Every
// button that sends a request should go through this.
// Placeholder rows shown while a list loads, in the shape the real rows will
// take, so the screen never looks frozen and nothing jumps when data lands.
function listSkeletonHtml(rows) {
  var one = '<div class="skel-row">' +
    '<span class="skel skel-avatar"></span>' +
    '<span style="flex:1"><span class="skel" style="height:12px;width:58%"></span>' +
    '<span class="skel" style="height:10px;width:34%;margin-top:8px"></span></span>' +
    '<span class="skel" style="height:18px;width:44px;border-radius:0"></span></div>';
  return '<div class="card" aria-hidden="true">' + new Array((rows || 6) + 1).join(one) + '</div>';
}

function act(btn, fn) {
  if (!btn) { fn().catch(function (e) { toast(friendlyError(e), 'bad'); }); return; }
  var original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Please wait…';
  fn().catch(function (e) { toast(friendlyError(e), 'bad'); })
    .finally(function () { btn.disabled = false; btn.innerHTML = original; });
}

// Turns an error into a plain sentence a pharmacist can act on. Our own
// messages from the database functions pass through unchanged. Anything
// technical, or naming a service behind the app, becomes a generic message.
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

// The database returns at most 1000 rows per request, so a plain list query
// silently drops the rest. This reads 1000 at a time until the list ends.
// build() must return a fresh query each call. tieBreak is a unique column so
// rows with equal sort values are not repeated or skipped between pages.
// Returns { data, error } like a normal query.
async function fetchAllRows(build, tieBreak) {
  var PAGE = 1000, all = [], from = 0;
  while (true) {
    var q = build();
    if (tieBreak) q = q.order(tieBreak);
    var r = await q.range(from, from + PAGE - 1);
    if (r.error) return { data: null, error: r.error };
    all = all.concat(r.data || []);
    if (!r.data || r.data.length < PAGE) break;
    from += PAGE;
  }
  return { data: all, error: null };
}

// Shows a retry card when a load fails, instead of "Loading..." forever.
function errorCard(container, message, retryFn) {
  container.innerHTML =
    '<div class="card empty">' +
    '<div style="margin-bottom:10px;display:flex;gap:8px;align-items:flex-start">' + icon('warn',18) + '' + esc(message) + '</div>' +
    '<button class="btn secondary small" onclick="(' + retryFn + ')()">Try again</button>' +
    '</div>';
}

// --- Loading screen and lazy Excel library ---

// The branded loading screen. index.html has the same markup, drawn before
// any script loads; this copy is for later moments (e.g. after Log in). Keep
// the two identical (styles: the "critical" block at the end of style.css).
function loadScreenHtml() {
  return '<div class="loadscreen" role="status" aria-label="Opening Pharma"><div class="loadscreen-mark"><svg viewBox="0 0 48 48" aria-hidden="true"><polygon points="18,6 30,6 30,18 42,18 42,30 30,30 30,42 18,42 18,30 6,30 6,18 18,18" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg></div><p class="loadscreen-word">Pharma</p><svg class="loadscreen-ecg" viewBox="0 0 200 34" fill="none" stroke="#E7C76A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M0 18h54l8-14 10 28 10-20 6 6h112"/></svg><p class="loadscreen-tag">Know your stock</p></div>';
}

// vendor-xlsx.js is 880 KB and only Excel import/export needs it, so it is not
// loaded with the page. warmXlsx() fetches it quietly after the first screen
// (skipped on Data Saver or slow connections). loadXlsx() loads it on demand.
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
  // On Data Saver or 2G/3G, 880 KB is costly, so load only when Excel is tapped.
  var c = navigator.connection;
  if (c && (c.saveData || /(^|-)(slow-)?2g$|3g/.test(c.effectiveType || ''))) return;
  var go = function () { loadXlsx().catch(function () {}); };
  if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 8000 });
  else setTimeout(go, 4000);
}

// WHEEL-GUARD-START
// Turning the mouse wheel over a number box that has the cursor in it nudges its value
// (a 49.95 appeared in an Amount box this way). Let go of the box when the wheel turns over it:
// the value stays as typed and the page scrolls as normal. Typing and the arrow keys still work.
document.addEventListener('wheel', function (e) {
  var t = e.target;
  if (t && t.tagName === 'INPUT' && t.type === 'number' && document.activeElement === t) t.blur();
}, { passive: true });
// WHEEL-GUARD-END
