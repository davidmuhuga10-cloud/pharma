// js/shell.js - start-up (init) and the page frame: sign-in check, navigation
// and the phone menu drawer.
//
// --- Start-up ---

// What the frame needs (who you are, the pharmacy, category and supplier lists)
// is saved on this device after each successful load. On the next start the
// frame draws from that copy at once and the real data is re-checked in the
// background (refreshProfileInBackground). The copy only decides what is
// drawn; the database still enforces every permission, and a switched-off
// account is picked up by the background check within a second or two.
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
  } catch (e) { }
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
    // A session this tab did not create (signed in on another tab, or restored
    // later) must still load the profile, or the tab stays on the login screen.
    // doLogin/doSignup/doJoin load the profile themselves, so only handle the
    // case where we have none.
    if (evt === 'SIGNED_IN' && !STATE.profile) {
      try { await loadProfileAndPharmacy(); } catch (e) { return; }
      render();
    }
  });
}

// With email confirmation on, signUp() may return no session, so the pharmacy
// cannot be created yet. We keep what the person typed and finish the job on
// their first real session, otherwise a confirmed account with no pharmacy
// would be a dead end.
var PENDING_KEY = 'hodhi_pending_signup';

// Login uses a phone number, but Supabase Auth wants an email, so we derive a
// stable, non-deliverable "auth email" from the phone (never shown in the UI).
// Numbers are normalised (07... -> 2547...) so "0712345678" and
// "+254712345678" are the same account.
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
    // No profile yet: if a signup was queued on this device (e.g. after email
    // confirmation), finish it now.
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
  // A temporary account (e.g. an accountant's code) past account_expires_at.
  // The database already refuses it everything via my_pharmacy_id()/my_role(),
  // but the profile row stays readable so this specific message can be shown.
  if (profile.account_expires_at && new Date(profile.account_expires_at) <= new Date()) {
    clearProfileCache();
    STATE.profile = null;
    STATE.disabledMessage = 'Your temporary access has expired. Ask the pharmacy owner for a new code.';
    return;
  }
  // The Pharma admin working inside a pharmacy that gave support access: act as
  // that pharmacy. The database applies the same rule (my_pharmacy_id), so this
  // only chooses which pharmacy's id the screens ask for. A failed or empty answer
  // simply means "not in support mode".
  STATE.support = null;
  try {
    var ctx = await sb.rpc('support_context');
    if (ctx.data && ctx.data.pharmacy_id) {
      STATE.support = ctx.data;
      profile = Object.assign({}, profile, { pharmacy_id: ctx.data.pharmacy_id, role: 'co_owner', full_name: 'Pharma Support' });
    }
  } catch (e) { STATE.support = null; }
  // The pharmacy, categories and suppliers are independent, so fetch all three
  // at once. The plan check rides along: if the trial or plan has ended, the
  // database already refuses this pharmacy its data (my_pharmacy_id), so show a
  // clear message instead of empty screens. A failed check (offline) is not a
  // lock-out.
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
  // Never keep a support session's borrowed identity on the device.
  if (STATE.support) clearProfileCache(); else saveProfileCache();
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
  // The menu is rebuilt on every render; on desktop it stays visible, so
  // remember its scroll position and restore it.
  var oldNav = document.querySelector('.nd-nav');
  var navScroll = oldNav ? oldNav.scrollTop : 0;
  app.innerHTML =
    '<div class="topbar">' +
    '<div class="topbar-left">' +
    // Phone only (hidden at 860px+, where the sidebar lists everything). Opens the
    // menu drawer (navDrawerHtml / wireNavDrawer).
    '<button class="burgerbtn" id="btnNavMenu" title="Menu" aria-label="Open menu">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"></line>' +
      '<line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg></button>' +
    '<div class="topbar-id">' + logoMarkHtml(30) + '<div><div class="brand">Pharma</div>' +
    '<div class="sub">' + esc(STATE.pharmacy ? STATE.pharmacy.name : '') + '</div></div></div>' +
    '</div>' +
    '<button class="profbtn" onclick="openProfile()" title="Profile" aria-label="Profile">' + icon('user', 20) + '</button></div>' +
    supportBannerHtml() +
    '<div class="content" id="content"></div>' +
    navBar() +
    navDrawerHtml();
  var newNav = document.querySelector('.nd-nav');
  if (newNav && navScroll) newNav.scrollTop = navScroll;
  wireNavDrawer();
  return renderTab();
}

// --- Menu drawer (phone only) ---
// The bottom bar fits about five thumb-sized buttons. The drawer holds the
// rest, including the Reports sub-screens (one tap instead of two). Rows are
// a tab (`tab`), a Reports sub-view (`report`) or a group label (`grp`). Each
// row uses the same can() checks as the screens, so the drawer never offers
// something the database would refuse.
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
      // Desktop only (docked sidebar): logo and pharmacy name at the top. Hidden on phones.
      '<div class="nd-brand">' + logoMarkHtml(34) +
        '<div class="nd-bname">' + esc(STATE.pharmacy ? STATE.pharmacy.name : 'Pharma') + '</div></div>' +
      '<div class="nd-head">Menu</div>' +
      '<div class="nd-navwrap">' +
      '<nav class="nd-nav">' + navMenuItems().map(function (m) {
        if (m.grp) return '<div class="nd-grp">' + esc(m.grp) + '</div>';
        var attr = m.report ? 'data-report="' + m.report + '"' : 'data-nav="' + m.tab + '"';
        // A Reports sub-view is current only while that exact view is open, so "All
        // Reports" and e.g. "Expiry Dates" never both highlight.
        var on = m.report
          ? (STATE.tab === 'reports' && reportsView === m.report)
          : (STATE.tab === m.tab && !(m.tab === 'reports' && reportsView !== 'hub'));
        return '<button class="nd-row' + (on ? ' active' : '') + '" ' + attr + '>' +
          '<span class="nd-chip">' + m.ic + '</span>' +
          '<span class="nd-lab">' + m.label + '</span></button>';
      }).join('') + '</nav>' +
      '<div class="nd-sb" id="navSb"><div class="nd-sb-th" id="navSbTh"></div></div>' +
      '</div>' +
      '<div class="nd-foot"><div class="nd-who">' + esc((STATE.profile && STATE.profile.full_name) || '') +
        (STATE.profile && STATE.profile.role ? ' &middot; ' + esc(roleLabel(STATE.profile.role)) : '') + '</div>' +
        'Pharma &copy; 2026</div>' +
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

  // Size and place the scroll thumb. Hidden when the list already fits.
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
  // The drawer's elements are rebuilt on every render(), so their listeners die
  // with them. Window and document listeners would pile up, so they are attached
  // once and look up the current drawer in the DOM.
  if (list) list.addEventListener('scroll', updateNavScrollbar, { passive: true });
  if (!wireNavDrawer._global) {
    wireNavDrawer._global = true;
    window.addEventListener('resize', function () {
      var el = document.getElementById('navSb');
      if (el) wireNavDrawer.refresh();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNavDrawer();
    });
  }
  wireNavDrawer.refresh = updateNavScrollbar;
  updateNavScrollbar();  // no-op while hidden on a phone; sizes the docked desktop menu

  // Mouse and pen only: drag the thumb or click the track. A finger scrolls the
  // list itself, so touch is ignored.
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
    // Measured once the drawer is on screen; a hidden element has no height.
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

// Open a Reports sub-screen directly. Used by the drawer; renderReports()
// reads reportsView on its way in.
function goReport(view) {
  reportsView = view;
  setTab('reports');
}

// The same markup is the phone's bottom bar and the desktop's left sidebar
// (see the .navbar rules in style.css). The brand block and account footer are
// hidden until the desktop layout has room for them.
function navBar() {
  // Dashboard, reports and settings are on every role's list; inventory, sell,
  // suppliers and expenses are permission-gated.
  // The fourth element marks a desktop-sidebar-only item. Seven items in the
  // phone bar made the buttons too small; six fit (Home, Inventory, Sell, Customers,
  // Expenses, Reports, as in Kodi), so SMS, Suppliers and Settings live in the
  // menu drawer on phones (navMenuItems) and in the sidebar at 860px+.
  // Phones show an emoji chip (same emoji as navMenuItems); the desktop sidebar
  // keeps the line icon.
  var CHIP = { dashboard: '&#127968;', inventory: '&#128138;', sell: '&#129534;', suppliers: '&#128666;',
               expenses: '&#128181;', reports: '&#128202;', settings: '&#9881;', customers: '&#128101;', sms: '&#128172;' };
  var items = [['dashboard', 'home', t('home')]];
  if (can('view_inventory')) items.push(['inventory', 'stock', 'Inventory']);
  if (can('sell')) items.push(['sell', 'sell', t('sell')]);
  var seeSuppliers = can('suppliers') || can('view_suppliers');
  var seeExpenses = can('expenses') || can('view_expenses');
  if (canSeeCustomers()) items.push(['customers', 'people', 'Customers']);
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

// Checkout bar showing item count and total, kept in sync by drawSell() via
// syncCartBar().
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

// Stock take and the controlled-drug register belong to Stock, so Inventory
// stays highlighted while they are open.
function navTabOn(tab) {
  return STATE.tab === tab || (tab === 'inventory' && (STATE.tab === 'stocktake' || STATE.tab === 'controlled'));
}
// While a screen loads, show "Please wait, loading..." and ignore taps so
// requests don't pile up. The pill waits ~120 ms so instant screens don't flicker.
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

