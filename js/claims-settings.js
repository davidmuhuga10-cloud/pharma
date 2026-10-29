// js/claims-settings.js - Insurance claims, and Settings (business profile).
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
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
      return '<div class="list-row"><div><div class="name">' + esc(c.scheme) + '</div><div class="meta">' + fmtDate(c.created_at) + (c.claim_number ? ' · ' + esc(c.claim_number) : '') + '</div></div>' +
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
