// js/shell.js - Start-up (init) and the page frame: sign-in check, navigation, the phone menu drawer.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// BOOTSTRAP
// ---------------------------------------------------------------------------

// What the app needs to draw its frame (who you are, which pharmacy, the
// category and supplier lists) is remembered on this device after every
// successful load. On the next start the frame appears at once from that copy
// and the real data is re-checked in the background (refreshProfileInBackground)
// — instead of the person waiting through four round trips to the database
// first. This copy only decides what is DRAWN; the database still enforces
// every permission, and a changed or switched-off account is picked up by the
// background check within a second or two.
var PROFILE_CACHE_KEY = 'hodhi_profile_cache_v1';
function saveProfileCache() {
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
      uid: STATE.session.user.id, profile: STATE.profile, pharmacy: STATE.pharmacy,
      cats: STATE.categoriesCache, sups: STATE.suppliersCache
    }));
  } catch (e) {}
}
function readProfileCache(uid) {
  try {
    var c = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || 'null');
    return (c && c.uid === uid && c.profile && c.pharmacy) ? c : null;
  } catch (e) { return null; }
}
function clearProfileCache() { try { localStorage.removeItem(PROFILE_CACHE_KEY); } catch (e) {} }
function profileSig() { return JSON.stringify([STATE.profile, STATE.pharmacy]); }

async function refreshProfileInBackground(sigBefore) {
  try {
    await loadProfileAndPharmacy();
    // Account switched off, expired or removed: show the sign-in screen with its message.
    if (!STATE.profile) { render(); return; }
    // Only redraw if something the frame shows actually changed.
    if (profileSig() !== sigBefore) render();
  } catch (e) { /* offline or a hiccup: keep working from the saved copy */ }
}

async function init() {
  try {
    var { data } = await sb.auth.getSession();
    STATE.session = data.session;
    var cached = STATE.session ? readProfileCache(STATE.session.user.id) : null;
    if (cached) {
      STATE.profile = cached.profile; STATE.pharmacy = cached.pharmacy;
      STATE.categoriesCache = cached.cats || []; STATE.suppliersCache = cached.sups || [];
      var sig = profileSig();
      render();
      warmXlsx();
      refreshProfileInBackground(sig);
      return finishInit();
    }
    if (STATE.session) await loadProfileAndPharmacy();
    render();
    if (STATE.profile) warmXlsx();
  } catch (e) {
    $('#app').innerHTML =
      '<div class="auth-wrap-simple"><div class="auth-card">' + logoMarkHtml(44) + '<div class="mark">Pharma</div>' +
      '<div class="card empty" style="display:flex;gap:8px;align-items:flex-start;text-align:left;margin-top:14px">' + icon('warn', 18) + esc(friendlyError(e)) + '<div style="margin-top:12px">' +
      '<button class="btn primary" onclick="location.reload()">Reload</button></div></div></div></div>';
    return;
  }
  finishInit();
}

function finishInit() {
  sb.auth.onAuthStateChange(async function (evt, session) {
    STATE.session = session;
    if (evt === 'PASSWORD_RECOVERY') { STATE.recoveryMode = true; render(); return; }
    if (!session) { STATE.profile = null; STATE.pharmacy = null; clearProfileCache(); clearDashCache(); render(); return; }
    // A session arriving that this tab didn't create — signed in on another
    // tab, or a session restored after this one was opened — used to update
    // STATE.session and nothing else, leaving the tab on the login screen with
    // a perfectly good session behind it. doLogin/doSignup/doJoin load the
    // profile themselves, so only handle the case where we don't have one.
    if (evt === 'SIGNED_IN' && !STATE.profile) {
      try { await loadProfileAndPharmacy(); } catch (e) { return; }
      render();
    }
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
  // A failed request (offline, server hiccup) is not "no profile": throwing lets
  // callers keep what they have instead of treating the account as unlinked.
  if (error) throw error;
  if (!profile) {
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
    clearProfileCache();
    return;
  }
  if (profile.active === false) {
    clearProfileCache();
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
    clearProfileCache();
    STATE.profile = null;
    STATE.disabledMessage = 'Your temporary access has expired. Ask the pharmacy owner for a new code.';
    return;
  }
  // The pharmacy, categories and suppliers don't depend on each other, so ask
  // for all three at once (one round trip instead of three in a row). The plan
  // check rides along: if the trial or paid plan has ended the database already
  // refuses this pharmacy its data (my_pharmacy_id), so show a clear message
  // instead of empty screens. A failed check (offline) is not a lock-out.
  var rest = await Promise.all([
    sb.from('pharmacies').select('*').eq('id', profile.pharmacy_id).maybeSingle(),
    sb.from('drug_categories').select('*').eq('pharmacy_id', profile.pharmacy_id).order('name'),
    sb.from('suppliers').select('*').eq('pharmacy_id', profile.pharmacy_id).order('name'),
    sb.rpc('my_subscription')
  ]);
  var sub = rest[3].data;
  if (sub && sub.locked) {
    clearProfileCache();
    STATE.profile = null;
    STATE.disabledMessage = (sub.status === 'active' ? 'Your Pharma plan has ended.' : 'Your free trial has ended.') +
      ' Contact the Pharma team to activate ' + (sub.pharmacy_name || 'your pharmacy') + ' and get back in. Your data is safe.';
    return;
  }
  if (rest[0].error) throw rest[0].error;
  STATE.profile = profile;
  STATE.pharmacy = rest[0].data;
  STATE.categoriesCache = rest[1].data || [];
  STATE.suppliersCache = rest[2].data || [];
  saveProfileCache();
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
    '<div class="topbar">' +
    '<div class="topbar-left">' +
    // Phone only (hidden at 860px+, where the sidebar already lists every
    // destination). Opens the menu drawer — see navDrawerHtml/wireNavDrawer.
    '<button class="burgerbtn" id="btnNavMenu" title="Menu" aria-label="Open menu">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"></line>' +
      '<line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg></button>' +
    '<div class="topbar-id">' + logoMarkHtml(30) + '<div><div class="brand">Pharma</div>' +
    '<div class="sub">' + esc(STATE.pharmacy ? STATE.pharmacy.name : '') + '</div></div></div>' +
    '</div>' +
    '<button onclick="logout()">Log out</button></div>' +
    '<div class="content" id="content"></div>' +
    navBar() +
    navDrawerHtml();
  wireNavDrawer();
  return renderTab();
}

// ---------------------------------------------------------------------------
// MENU DRAWER (phone only) — ported from Kodi's own drawer, see the matching
// block in style.css for the geometry and why it exists. The bottom bar can
// carry about five thumb-sized targets; this is where everything else lives,
// including the five Reports sub-screens, which previously took two taps
// (Reports, then the tile) from anywhere in the app.
//
// Rows are either a tab (`tab`), a Reports sub-view (`report`), or a grouping
// label (`grp`). Every row is permission-gated with the same can() checks the
// bottom bar and the screens themselves use, so the drawer can never offer an
// action the database would refuse.
// ---------------------------------------------------------------------------
function navMenuItems() {
  var out = [{ tab: 'dashboard', label: 'Overview', ic: '&#127968;' }];
  var seeStock = can('view_inventory');
  var seeReports = can('view_reports');
  if (seeStock || can('sell') || canSeeCustomers() || canSeeControlled()) {
    out.push({ grp: 'Stock' });
    if (seeStock) out.push({ tab: 'inventory', label: 'Inventory', ic: '&#128138;' });
    if (can('sell')) out.push({ tab: 'sell', label: 'Sell', ic: '&#129534;' });
    if (canSeeCustomers()) out.push({ tab: 'customers', label: 'Customers', ic: '&#128101;' });
    if (can('sms')) out.push({ tab: 'sms', label: 'SMS', ic: '&#128172;' });
    if (can('stock_take')) out.push({ tab: 'stocktake', label: 'Stock Take', ic: '&#128203;' });
    if (canSeeControlled()) out.push({ tab: 'controlled', label: 'Controlled <br>Drugs', ic: '&#128274;' });
    if (seeReports) {
      out.push({ report: 'lowstock', label: 'Reorder <br>List', ic: '&#128230;' });
      out.push({ report: 'expiry', label: 'Expiry <br>Dates', ic: '&#9200;' });
    }
  }
  var seeSuppliers = can('suppliers') || can('view_suppliers');
  var seeExpenses = can('expenses') || can('view_expenses');
  if (seeSuppliers || seeExpenses || seeReports) {
    out.push({ grp: 'Money' });
    if (seeSuppliers) out.push({ tab: 'suppliers', label: 'Suppliers', ic: '&#128666;' });
    if (seeExpenses) out.push({ tab: 'expenses', label: 'Expenses', ic: '&#128181;' });
    if (seeReports) out.push({ report: 'valuation', label: 'Stock <br>Valuation', ic: '&#128176;' });
    if (can('claims')) out.push({ report: 'claims', label: 'Insurance <br>Claims', ic: '&#127973;' });
  }
  out.push({ grp: 'More' });
  if (seeReports) out.push({ tab: 'reports', label: 'All Reports', ic: '&#128202;' });
  out.push({ tab: 'settings', label: 'Settings', ic: '&#9881;' });
  return out;
}

function navDrawerHtml() {
  return '<div class="navscrim" id="navScrim"></div>' +
    '<aside class="navdrawer" id="navDrawer">' +
      '<div class="nd-head">Menu</div>' +
      '<div class="nd-navwrap">' +
      '<nav class="nd-nav">' + navMenuItems().map(function (m) {
        if (m.grp) return '<div class="nd-grp">' + esc(m.grp) + '</div>';
        var attr = m.report ? 'data-report="' + m.report + '"' : 'data-nav="' + m.tab + '"';
        // A Reports sub-view counts as current only while that exact view is
        // open, so "All Reports" and e.g. "Expiry Dates" never both highlight.
        var on = m.report
          ? (STATE.tab === 'reports' && reportsView === m.report)
          : (STATE.tab === m.tab && !(m.tab === 'reports' && reportsView !== 'hub'));
        return '<button class="nd-row' + (on ? ' active' : '') + '" ' + attr + '>' +
          '<span class="nd-chip">' + m.ic + '</span>' +
          '<span class="nd-lab">' + m.label + '</span></button>';
      }).join('') + '</nav>' +
      '<div class="nd-sb" id="navSb"><div class="nd-sb-th" id="navSbTh"></div></div>' +
      '</div>' +
      '<div class="nd-foot">Pharma &copy; 2026</div>' +
    '</aside>';
}

function closeNavDrawer() { document.body.classList.remove('nav-open'); }

function wireNavDrawer() {
  var btn = document.getElementById('btnNavMenu');
  var scrim = document.getElementById('navScrim');
  var drawer = document.getElementById('navDrawer');
  var list = drawer && drawer.querySelector('.nd-nav');
  var sb = document.getElementById('navSb');
  var th = document.getElementById('navSbTh');
  if (!btn || !drawer) return;

  // Size and place the drawn thumb. Hidden outright when the list already
  // fits, so the bar only ever appears when there is genuinely more below.
  function updateNavScrollbar() {
    if (!list || !sb || !th) return;
    var hidden = list.scrollHeight - list.clientHeight;
    if (hidden <= 2) { sb.classList.remove('on'); return; }
    sb.classList.add('on');
    var trackH = sb.clientHeight;
    var thumbH = Math.max(24, Math.round(trackH * (list.clientHeight / list.scrollHeight)));
    th.style.height = thumbH + 'px';
    th.style.top = Math.round((trackH - thumbH) * (list.scrollTop / hidden)) + 'px';
  }
  // The drawer's own elements are rebuilt by every render(), so their
  // listeners go on fresh nodes each time and die with them. The window and
  // document ones would NOT — re-binding them on every render would stack up
  // a new listener per render for the life of the session — so they are
  // attached once and read the current drawer through the DOM instead.
  if (list) list.addEventListener('scroll', updateNavScrollbar, { passive: true });
  if (!wireNavDrawer._global) {
    wireNavDrawer._global = true;
    window.addEventListener('resize', function () {
      var el = document.getElementById('navSb');
      if (el && document.body.classList.contains('nav-open')) wireNavDrawer.refresh();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNavDrawer();
    });
  }
  wireNavDrawer.refresh = updateNavScrollbar;

  // Mouse and pen only: drag the thumb, or click the track to jump. A finger
  // scrolls the list itself, so touch is deliberately ignored here.
  if (sb && th && list) {
    var dragging = false, startY = 0, startTop = 0;
    th.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      dragging = true; startY = e.clientY; startTop = list.scrollTop;
      th.setPointerCapture(e.pointerId);
      th.classList.add('drag');
      e.preventDefault(); e.stopPropagation();
    });
    th.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var trackH = sb.clientHeight - th.offsetHeight;
      var hidden = list.scrollHeight - list.clientHeight;
      if (trackH > 0) list.scrollTop = startTop + ((e.clientY - startY) / trackH) * hidden;
    });
    var stopDrag = function () { dragging = false; th.classList.remove('drag'); };
    th.addEventListener('pointerup', stopDrag);
    th.addEventListener('pointercancel', stopDrag);
    sb.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.target === th) return;
      var r = sb.getBoundingClientRect();
      var trackH = r.height - th.offsetHeight;
      var hidden = list.scrollHeight - list.clientHeight;
      if (trackH > 0) {
        var ratio = (e.clientY - r.top - th.offsetHeight / 2) / trackH;
        list.scrollTop = Math.max(0, Math.min(1, ratio)) * hidden;
      }
    });
  }

  btn.onclick = function () {
    document.body.classList.toggle('nav-open');
    // Measured once the drawer is actually on screen — a hidden element has
    // no height to measure, so this cannot run at build time.
    if (document.body.classList.contains('nav-open')) updateNavScrollbar();
  };
  if (scrim) scrim.onclick = closeNavDrawer;
  drawer.onclick = function (e) {
    var b = e.target.closest('[data-nav],[data-report]');
    if (!b) return;
    closeNavDrawer();
    var rep = b.getAttribute('data-report');
    if (rep) { goReport(rep); return; }
    setTab(b.getAttribute('data-nav'));
  };
}

// Opens a Reports sub-screen directly, instead of Reports-then-tile. Used by
// the drawer; renderReports() reads reportsView on its way in.
function goReport(view) {
  reportsView = view;
  setTab('reports');
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
  // The fourth element marks a destination as desktop-sidebar-only. Seven
  // items crammed into a phone's bottom bar left each target well under the
  // ~40px a thumb needs, so Suppliers and Settings now live in the menu
  // drawer on a phone (navMenuItems above) and stay on the sidebar at 860px+,
  // where there is a full column and no size pressure at all. The bar itself
  // is unchanged on desktop — see .nav-desktop-extra in style.css.
  // The glass 3D chip shown on phones (the desktop sidebar keeps the line
  // icon). Same emoji as the menu drawer's rows (navMenuItems) so the two
  // always match.
  var CHIP = { dashboard: '&#127968;', inventory: '&#128138;', sell: '&#129534;', suppliers: '&#128666;',
               expenses: '&#128181;', reports: '&#128202;', settings: '&#9881;', customers: '&#128101;', sms: '&#128172;' };
  var items = [['dashboard', 'home', t('home')]];
  if (can('view_inventory')) items.push(['inventory', 'stock', 'Inventory']);
  if (can('sell')) items.push(['sell', 'sell', t('sell')]);
  var seeSuppliers = can('suppliers') || can('view_suppliers');
  var seeExpenses = can('expenses') || can('view_expenses');
  if (canSeeCustomers()) items.push(['customers', 'people', 'Customers', true]);
  if (can('sms')) items.push(['sms', 'chat', 'SMS', true]);
  if (seeSuppliers) items.push(['suppliers', 'truck', t('suppliers'), true]);
  if (seeExpenses) items.push(['expenses', 'wallet', t('expenses')]);
  items.push(['reports', 'reports', t('reports')]);
  items.push(['settings', 'settings', t('settings'), true]);
  var p = STATE.profile || {};
  var pharmacy = STATE.pharmacy || {};
  return '<div class="navbar">' +
    '<div class="navbar-brand">' + logoMarkHtml(38) + '<div class="word">Pharma</div></div>' +
    items.map(function (i) {
      var cls = (navTabOn(i[0]) ? 'active' : '') + (i[3] ? ' nav-desktop-extra' : '');
      return '<button class="' + cls.trim() + '" onclick="setTab(\'' + i[0] + '\')">' +
        '<span class="ic">' + icon(i[1], 20) + '</span>' +
        '<span class="ic3d" aria-hidden="true">' + (CHIP[i[0]] || '') + '</span>' + i[2] + '</button>';
    }).join('') +
    '<div class="navbar-spacer"></div>' +
    '<div class="navbar-foot"><div class="who">' + esc(pharmacy.name || '') + '</div>' +
    '<div class="role">' + esc(p.full_name || '') + '</div>' + (p.role ? '<div class="role">' + esc(roleLabel(p.role)) + '</div>' : '') + '</div>' +
    '</div>';
}

// UI fix: was a round floating button that only refreshed on a full
// re-render (so its item count went stale as drugs were added) and, on
// desktop, sat on top of the drug list. Now a checkout bar showing items +
// total, kept in sync by drawSell() via syncCartBar().
function cartFab() {
  if (!STATE.cart.length) return '';
  var n = STATE.cart.reduce(function (a, c) { return a + c.qty; }, 0);
  var total = STATE.cart.reduce(function (a, c) { return a + c.qty * c.price; }, 0);
  return '<button class="cart-bar" onclick="openCheckout()" title="Checkout">' +
    '<span class="cb-ic">' + icon('cart', 20) + '<span class="cb-n">' + n + '</span></span>' +
    '<span class="cb-txt">' + n + (n === 1 ? ' item' : ' items') + ' · ' + fmt(total) + '</span>' +
    '<span class="cb-go">Checkout &rarr;</span></button>';
}
function syncCartBar() {
  var old = document.querySelector('.cart-bar');
  if (old) old.remove();
  var html = STATE.tab === 'sell' ? cartFab() : '';
  var c = document.getElementById('content');
  if (c) c.classList.toggle('has-cart-bar', !!html);
  if (html) document.getElementById('app').insertAdjacentHTML('beforeend', html);
}

// Stock take and the controlled-drug register are part of the Stock area, so
// the Inventory item stays lit while they are open.
function navTabOn(tab) {
  return STATE.tab === tab || (tab === 'inventory' && (STATE.tab === 'stocktake' || STATE.tab === 'controlled'));
}
// While a screen is loading, a clear "Please wait, loading…" shows and every
// tap is ignored, so nobody can press tab after tab and pile up requests. The
// pill itself waits ~120 ms so a screen that opens instantly does not flicker.
var veilBusy = false;
function runWithVeil(fn) {
  if (veilBusy) return Promise.resolve();
  veilBusy = true;
  var v = document.createElement('div');
  v.className = 'loadveil'; v.id = 'loadVeil';
  v.innerHTML = '<div class="loadveil-pill" role="status"><span class="loadveil-spin"></span>Please wait, loading…</div>';
  document.body.appendChild(v);
  var showT = setTimeout(function () { v.classList.add('show'); }, 120);
  var failSafe = setTimeout(function () { end(); }, 20000);
  var ended = false;
  function end() { if (ended) return; ended = true; clearTimeout(showT); clearTimeout(failSafe); v.remove(); veilBusy = false; }
  var p;
  try { p = Promise.resolve(fn()); } catch (e) { end(); throw e; }
  return p.catch(function (e) { toast(friendlyError(e), 'bad'); }).then(end);
}
function setTab(t) {
  if (veilBusy) return;
  if (t !== STATE.tab) { custDetailId = null; controlledDetailId = null; stViewing = null; }
  STATE.tab = t;
  runWithVeil(function () { return render(); });
}

async function logout() { clearProfileCache(); clearDashCache(); await sb.auth.signOut(); STATE.tab = 'dashboard'; STATE.cart = []; render(); }

function renderTab() {
  if (STATE.tab === 'dashboard') return renderDashboard();
  else if (STATE.tab === 'inventory') return renderInventory();
  else if (STATE.tab === 'sell') return renderSell();
  else if (STATE.tab === 'reports') return renderReports();
  else if (STATE.tab === 'settings') return renderSettings();
  else if (STATE.tab === 'suppliers') return renderSuppliers();
  else if (STATE.tab === 'expenses') return renderExpenses();
  else if (STATE.tab === 'customers') return renderCustomers();
  else if (STATE.tab === 'sms') return renderSmsModule();
  else if (STATE.tab === 'stocktake') return renderStockTake();
  else if (STATE.tab === 'controlled') return renderControlled();
}

// ---------------------------------------------------------------------------
