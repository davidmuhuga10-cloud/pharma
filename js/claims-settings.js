// js/claims-settings.js - insurance claims, and Settings (business profile).
//
// --- Insurance claims ---
// Created automatically at checkout when a payment line uses "insurance", and
// tracked here until paid or rejected.

var claimsCache = [];
var claimsRange = 'all';      // 'all' | 'month' | 'custom'
var claimsFrom = '';
var claimsTo = '';
var claimsStatus = 'all';     // 'all' | 'pending' | 'submitted' | 'paid' | 'rejected'
var claimsPage = 1;
var CLAIM_STATUSES = ['pending', 'submitted', 'paid', 'rejected'];
var CLAIM_RANGES = [{ key: 'all', label: 'All time' }, { key: 'month', label: 'This month' }];
// Plain coloured text, no background: pending amber, submitted black, paid green, rejected red.
var CLAIM_TONE = { pending: 'warn', submitted: 'ink', paid: 'ok', rejected: 'bad' };

function claimLabel(st) { return st.charAt(0).toUpperCase() + st.slice(1); }

// The date range is applied in the database (so a pharmacy with thousands of
// claims is never cut off at 200); the status filter works on what came back.
function claimsBounds() {
  if (claimsRange === 'month') {
    var n = new Date();
    return { start: new Date(n.getFullYear(), n.getMonth(), 1).toISOString(), end: null };
  }
  if (claimsRange === 'custom') return rangeBounds(claimsFrom, claimsTo);
  return { start: null, end: null };
}

function claimsRangeLabel() {
  if (claimsRange === 'custom') return fmtDate(claimsFrom) + ' to ' + fmtDate(claimsTo);
  return claimsRange === 'month' ? 'This month' : 'All time';
}

async function loadClaims() {
  drawReportsShell2('Insurance Claims');
  claimsPage = 1;
  try {
    var bounds = claimsBounds();
    var r = await fetchAllRows(function () {
      var q = sb.from('insurance_claims').select('*').order('created_at', { ascending: false });
      if (bounds.start) q = q.gte('created_at', bounds.start);
      if (bounds.end) q = q.lt('created_at', bounds.end);
      return q;
    }, 'id');
    if (r.error) throw r.error;
    claimsCache = r.data || [];
  } catch (e) { claimsCache = []; }
  drawClaims();
}

function pickClaimsRange(key) { claimsRange = key; loadClaims(); }
function applyClaimsRange() {
  var r = rangeBarRead(), err = rangeError(r.from, r.to);
  if (err) { toast(err, 'bad'); return; }
  claimsFrom = r.from; claimsTo = r.to; claimsRange = 'custom';
  loadClaims();
}
function pickClaimsStatus(st) { claimsStatus = st; claimsPage = 1; drawClaims(); }
function goClaimsPage(p) { claimsPage = p; drawClaims(); }

// The claims on screen, in print and in Excel: the chosen status of the chosen dates.
function claimsView() {
  return claimsCache.filter(function (c) { return claimsStatus === 'all' || c.status === claimsStatus; });
}

function claimsAmount(list) { return list.reduce(function (a, c) { return a + Number(c.amount || 0); }, 0); }

function drawClaims() {
  var body = $('#reportBody');
  if (!body) return;
  var tiles = [{ key: 'all', label: 'All claims', kind: 't-neutral' },
    { key: 'pending', label: 'Pending', kind: 't-amber' }, { key: 'submitted', label: 'Submitted', kind: 't-violet' },
    { key: 'paid', label: 'Paid', kind: 't-green' }, { key: 'rejected', label: 'Rejected', kind: 't-red' }];
  var rows = claimsView();
  var pg = pageSlice(rows, claimsPage);
  claimsPage = pg.page;
  // the range bar is drawn once per load (it holds the date inputs), so keep it outside the part that redraws
  var bar = rangeBarHtml({ presets: CLAIM_RANGES, active: claimsRange, from: claimsFrom, to: claimsTo, pickFn: 'pickClaimsRange', applyFn: 'applyClaimsRange' });
  body.innerHTML =
    bar +
    '<div class="kpi-grid five" style="margin-bottom:14px">' + tiles.map(function (t) {
      var list = t.key === 'all' ? claimsCache : claimsCache.filter(function (c) { return c.status === t.key; });
      return '<button class="kpi kpi-clickable ' + t.kind + (claimsStatus === t.key ? ' active' : '') + '" onclick="pickClaimsStatus(\'' + t.key + '\')">' +
        '<div class="label">' + t.label + '</div><div class="value">' + list.length + '</div><div class="tiny">' + fmt(claimsAmount(list)) + '</div></button>';
    }).join('') + '</div>' +
    '<div class="section-title" style="margin-top:6px">' + (claimsStatus === 'all' ? 'All claims' : claimLabel(claimsStatus)) + ' · ' + esc(claimsRangeLabel()) + '</div>' +
    showingHtml(pg) +
    rtTable(['Date', 'Scheme', 'Claim number', 'Amount', 'Status', 'Change status'], pg.rows.map(function (c) {
      return [fmtDate(c.created_at), c.scheme, c.claim_number || '—', fmt(c.amount), stCell(claimLabel(c.status), CLAIM_TONE[c.status] || 'ink'),
        { html: '<select onchange="updateClaimStatus(this,\'' + esc(c.id) + '\',this.value)">' +
          CLAIM_STATUSES.map(function (s) { return '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + claimLabel(s) + '</option>'; }).join('') + '</select>' }];
    }), { empty: claimsCache.length ? 'No claims with that status.' : 'No insurance claims in this period. A claim is created when you sell to a customer on an insurance scheme.' }) +
    pagerHtml(pg, 'goClaimsPage');
}

async function updateClaimStatus(sel, id, status) {
  // Not a Save button, but a select re-picked quickly has the same double-fire
  // risk, so disable it for the round trip too.
  sel.disabled = true;
  var { error } = await sb.from('insurance_claims').update({ status: status, updated_at: new Date().toISOString() }).eq('id', id);
  sel.disabled = false;
  if (error) { toast(friendlyError(error), 'bad'); return; }
  var c = claimsCache.find(function (x) { return x.id === id; });
  if (c) c.status = status;
  toast('Claim updated.', 'good');
  drawClaims();
}

function claimCells(c) {
  return [fmtDate(c.created_at), c.scheme, c.claim_number || '—', fmt(c.amount), stCell(claimLabel(c.status), CLAIM_TONE[c.status] || 'ink')];
}

function exportClaimsExcel() {
  var rows = claimsView().map(function (c) {
    return { 'Date': new Date(c.created_at).toLocaleDateString('en-GB'), 'Scheme': c.scheme, 'Claim number': c.claim_number || '', 'Amount': Number(c.amount || 0), 'Status': c.status };
  });
  exportExcel((STATE.pharmacy.name || 'Pharma') + ' - insurance claims - ' + todayStr() + '.xlsx', 'Claims', rows);
}

function printClaimsReport() {
  var list = claimsView();
  printHtml('Insurance Claims Report', (claimsStatus === 'all' ? 'All claims' : claimLabel(claimsStatus)) + ' · ' + claimsRangeLabel(),
    tableHtml(['Date', 'Scheme', 'Claim number', 'Amount', 'Status'], list.map(claimCells), 'Total: ' + list.length + ' claims · ' + fmt(claimsAmount(list))),
    list.length + ' claims · ' + fmt(claimsAmount(list.filter(function (c) { return c.status === 'pending'; }))) + ' pending');
}

// --- Settings ---
// Business profile (name, address, phone...) printed on every report and
// receipt, plus the low-stock and expiry-warning thresholds.

// ---- Staff permissions (Settings -> Staff -> Permissions) ----
// Every staff member has their own. The owner (or co-owner) sets what that
// person sees; the switches and presets are in js/staff-access.js. Saving goes
// through set_staff_access(), which also writes the change log.
var staffById = {};

function openStaffPermissions(id) {
  var s = staffById[id];
  if (!s) return;
  sheet('Permissions · ' + (s.full_name || 'Staff member'),
    '<div class="tiny acc-intro">' + esc(roleLabel(s.role)) + '. Switch off what this person should not see. Their menu, dashboard, reports and downloads follow it.</div>' +
    accessEditorHtml(s.access, 'sp') +
    '<button class="btn primary" id="spSaveBtn" onclick="saveStaffPermissions(\'' + id + '\')">Save permissions</button>' +
    '<div id="spLog" class="acc-log"></div>');
  loadStaffAccessLog(id);
}

async function loadStaffAccessLog(id) {
  try {
    var r = await sb.from('staff_access_log').select('changed_at,changed_by_name,new_access,via').eq('profile_id', id).order('changed_at', { ascending: false }).limit(5);
    var box = $('#spLog');
    if (!box || r.error || !r.data || !r.data.length) return;
    box.innerHTML = '<div class="acc-title">Recent changes</div>' + r.data.map(function (l) {
      return '<div class="acc-log-row"><span>' + esc(accessLogLine(l)) + '</span><span>' + esc(l.changed_by_name || 'Unknown') + ' · ' + esc(fmtDateTime(l.changed_at)) + '</span></div>';
    }).join('');
  } catch (e) { /* the log is a nicety; the permissions still save */ }
}

async function saveStaffPermissions(id) {
  var btn = $('#spSaveBtn');
  act(btn, async function () {
    var access = accessFromEditor('sp');
    var r = await sb.rpc('set_staff_access', { p_profile_id: id, p_access: access });
    if (r.error) { toast(friendlyError(r.error), 'bad'); return; }
    toast('Permissions saved.', 'good');
    closeSheet();
    renderSettings();
  });
}

async function renderSettings() {
  var c = $('#content');
  var p = STATE.pharmacy || {};
  // co_owner has the same settings and staff access as owner.
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
    } catch (e) {  /* the staff panel just shows empty; not worth blocking the settings page */ }
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
    '<div class="field"><label>Warn me when a drug will last fewer than (days)</label><input id="stLowDays" type="number" min="1" max="90" placeholder="Off" value="' + (p.low_stock_days || '') + '" ' + (isOwner ? '' : 'disabled') + '>' +
    '<div class="tiny" style="margin-top:4px">Worked out from each drug\'s sales over the last 30 days. A drug with its own number (Edit details) uses that number instead. Leave empty to use only the numbers set on each drug.</div></div>' +
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
        staffById[s.id] = s;
        var limitable = !isOwnerRole(s.role);
        return '<div class="list-row"><div><div class="name">' + esc(s.full_name || '(no name)') + (isMe ? ' (you)' : '') + '</div>' +
          '<div class="meta">' + esc(roleLabel(s.role)) + (s.phone ? ' · ' + esc(s.phone) : '') + esc(expiryNote) + '</div>' +
          (limitable ? '<div class="meta"><b>Sees: ' + esc(accessSummary(s.access)) + '</b></div>' : '') + '</div>' +
          '<div class="right">' + badge +
          (limitable ? '<div style="margin-top:6px"><button class="btn secondary small" onclick="openStaffPermissions(\'' + s.id + '\')">Permissions</button></div>' : '') +
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
    (STATE.profile.account_expires_at ? ' · temporary access, expires ' + fmtDate(STATE.profile.account_expires_at) : '') + '</div></div>';
}

