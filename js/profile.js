// Profile (the round button in the top bar): who is signed in, change password,
// Get support, sign out. "Get support" lets the Pharma admin into this pharmacy
// for a few hours to look at a problem and fix it; the database ends it by
// itself when the time is up (see migrations/2026-11-07_support_access.sql).
// When the admin is the one working inside a pharmacy for support, STATE.support
// is set (shell.js) and this screen offers "Leave support" instead.

var SUPPORT_HOURS = [1, 2, 4, 8, 24];
var supportPick = 2;

// "3:40 pm"
function supportTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
}
// "1 h 52 min left"
function supportLeft(iso) {
  var mins = Math.max(0, Math.round((new Date(iso) - new Date()) / 60000));
  return (mins >= 60 ? Math.floor(mins / 60) + ' h ' : '') + (mins % 60) + ' min left';
}

function openProfile() {
  var p = STATE.profile || {};
  var pharmacyName = STATE.pharmacy ? STATE.pharmacy.name : '';
  var canGrant = !STATE.support && (p.role === 'owner' || p.role === 'co_owner');
  var html =
    '<div class="prof-head"><div class="brand-badge" style="width:52px;height:52px;font-size:22px">' + esc((p.full_name || '?').charAt(0).toUpperCase()) + '</div>' +
    '<div><div class="prof-name">' + esc(p.full_name || '') + '</div>' +
    '<div class="prof-meta">' + esc(roleLabel(p.role)) + (pharmacyName ? ' &middot; ' + esc(pharmacyName) : '') + '</div>' +
    (p.phone && !STATE.support ? '<div class="prof-meta">' + esc(showPhone(p.phone)) + '</div>' : '') + '</div></div>' +
    (STATE.support
      ? '<div class="support-note"><b>Support mode.</b> You are working inside ' + esc(STATE.support.pharmacy_name) +
        ' until ' + esc(supportTime(STATE.support.expires_at)) + '.</div>' +
        '<button class="btn primary" onclick="leaveSupport(this)">Leave support</button>'
      : '<button class="prof-card" onclick="openChangePassword()"><div class="prof-ic">&#128273;</div><div><div class="t1">Change password</div><div class="t2">Needs your current password</div></div></button>' +
        (canGrant ? '<button class="prof-card" onclick="openSupport()"><div class="prof-ic">&#128735;</div><div><div class="t1">Get support</div><div class="t2">Let the Pharma admin look at your pharmacy for a few hours</div></div></button>' : '') +
        (p.role === 'owner' ? '<button class="prof-card" onclick="closeSheet();setTab(\'settings\')"><div class="prof-ic">&#9881;</div><div><div class="t1">Pharmacy settings</div><div class="t2">Name, contacts, staff, plan</div></div></button>' : '')) +
    '<button class="btn ghost" style="margin-top:6px" onclick="closeSheet();logout()">Sign out</button>';
  sheet('Profile', html);
}

// --- Change password: current password first, then the new one twice ---
function openChangePassword() {
  sheet('Change password',
    '<div class="field"><label>Current password</label>' + pwField('cpOld', '') + '</div>' +
    '<div class="field"><label>New password</label>' + pwField('cpNew', 'At least 8 characters') + '</div>' +
    '<div class="field"><label>New password again</label>' + pwField('cpNew2', '') + '</div>' +
    '<div id="cpErr" class="error-text"></div>' +
    '<button class="btn primary" id="cpBtn" onclick="doChangePassword()">Save new password</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="openProfile()">Back</button>');
}

function doChangePassword() {
  var err = $('#cpErr'); err.textContent = '';
  var oldPw = $('#cpOld').value, pw = $('#cpNew').value, pw2 = $('#cpNew2').value;
  if (!oldPw) { err.textContent = 'Type your current password.'; return; }
  if (pw.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
  if (pw !== pw2) { err.textContent = 'The two new passwords do not match.'; return; }
  act($('#cpBtn'), async function () {
    var email = STATE.session && STATE.session.user && STATE.session.user.email;
    var chk = await sb.auth.signInWithPassword({ email: email, password: oldPw });
    if (chk.error) { err.textContent = 'The current password is wrong.'; return; }
    var r = await sb.auth.updateUser({ password: pw });
    if (r.error) { err.textContent = friendlyError(r.error); return; }
    closeSheet();
    toast('Password updated.', 'good');
  });
}

// --- Get support ---
async function openSupport() {
  var body = sheet('Get support', '<div class="skel"></div>');
  var r = await sb.rpc('my_support_access');
  if (r.error) { body.innerHTML = '<div class="error-text">' + esc(friendlyError(r.error)) + '</div>'; return; }
  var a = r.data || {};
  var hist = (a.history || []).map(function (h) {
    var how = h.revoked_at ? 'stopped ' + fmtDateTime(h.revoked_at) : (new Date(h.expires_at) > new Date() ? 'on until ' + supportTime(h.expires_at) : 'ended ' + fmtDateTime(h.expires_at));
    var opened = Number(h.opened_count) ? ' &middot; opened ' + Number(h.opened_count) + (Number(h.opened_count) === 1 ? ' time' : ' times') : '';
    return '<div class="tiny" style="margin-top:4px">' + esc(fmtDateTime(h.granted_at)) + ' &middot; ' + esc(how) + opened + '</div>';
  }).join('');
  var histBlock = hist ? '<div style="margin-top:14px"><b>History</b>' + hist + '</div>' : '';
  if (a.active) {
    body.innerHTML =
      '<div class="support-on"><b>Support access is ON</b><br>The Pharma admin can open your pharmacy until <b>' + esc(supportTime(a.active.expires_at)) +
      '</b> (' + esc(supportLeft(a.active.expires_at)) + ').</div>' +
      '<button class="btn danger" id="spStop" onclick="stopSupport(this)">Stop access now</button>' + histBlock;
    return;
  }
  body.innerHTML =
    '<div class="support-note"><b>Pharma admin will get access to your pharmacy.</b> They can see your sales, stock and customers to find and fix the problem. ' +
    'Access ends by itself when the time is up, and you can stop it any time.</div>' +
    '<div style="font-weight:700;margin-bottom:2px">For how long?</div>' +
    '<div class="support-hours" id="spHours">' + SUPPORT_HOURS.map(function (h) {
      return '<button type="button" data-h="' + h + '" class="' + (h === supportPick ? 'on' : '') + '" onclick="pickSupportHours(' + h + ')">' + h + ' h</button>';
    }).join('') + '</div>' +
    '<button class="btn primary" id="spGo" onclick="grantSupport(this)">Grant access for ' + supportPick + (supportPick === 1 ? ' hour' : ' hours') + '</button>' + histBlock;
}

function pickSupportHours(h) {
  supportPick = h;
  document.querySelectorAll('#spHours button').forEach(function (b) { b.classList.toggle('on', Number(b.getAttribute('data-h')) === h); });
  $('#spGo').textContent = 'Grant access for ' + h + (h === 1 ? ' hour' : ' hours');
}

function grantSupport(btn) {
  var h = supportPick;
  act(btn, async function () {
    var r = await sb.rpc('grant_support_access', { p_hours: h });
    if (r.error) throw r.error;
    toast('Support access is on for ' + h + (h === 1 ? ' hour.' : ' hours.'), 'good');
    openSupport();
  });
}

function stopSupport(btn) {
  act(btn, async function () {
    var r = await sb.rpc('revoke_support_access');
    if (r.error) throw r.error;
    toast('Support access stopped.', 'good');
    openSupport();
  });
}

// The admin leaves the pharmacy they opened for support and goes back to the admin console.
function leaveSupport(btn) {
  act(btn, async function () {
    var r = await sb.rpc('admin_close_support');
    if (r.error) throw r.error;
    clearProfileCache(); clearDashCache();
    STATE.support = null;
    location.href = 'admin.html#/pharmacies';
  });
}

// The strip under the top bar while the admin is working inside a pharmacy.
function supportBannerHtml() {
  if (!STATE.support) return '';
  return '<div class="support-banner"><span><b>Support mode</b> &middot; ' + esc(STATE.support.pharmacy_name) +
    ' &middot; until ' + esc(supportTime(STATE.support.expires_at)) + '</span>' +
    '<button onclick="leaveSupport(this)">Leave</button></div>';
}
