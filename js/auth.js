// js/auth.js - Sign in, sign up, password reset, staff invites.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
// AUTH
// ---------------------------------------------------------------------------

// Phone sign-in pieces (hidden at >= 860px by style.css). The mark is the
// white-on-red hospital cross; the benefit row only shows on the log-in
// screen and only when the screen is tall enough (style.css).
function crossMarkHtml() {
  return '<div class="auth-hero-mark"><svg viewBox="0 0 48 48" aria-hidden="true">' +
    '<polygon points="18,6 30,6 30,18 42,18 42,30 30,30 30,42 18,42 18,30 6,30 6,18 18,18" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>' +
    '</svg></div>';
}
function authHeroHtml() {
  return '<div class="auth-hero">' + crossMarkHtml() +
    '<h1 class="auth-hero-word">Pharma</h1>' +
    '<p class="auth-hero-tag">Know your stock</p>' +
    '<div class="auth-feats">' +
    '<div class="auth-feat"><i>&#128138;</i><span>Batch<br>tracking</span></div>' +
    '<div class="auth-feat"><i>&#9200;</i><span>Expiry<br>alerts</span></div>' +
    '<div class="auth-feat"><i>&#128202;</i><span>Daily<br>reports</span></div>' +
    '<div class="auth-feat"><i>&#129534;</i><span>Printed<br>receipts</span></div>' +
    '</div></div>';
}
// Tells style.css which auth screen is showing (the benefit row is for log-in
// only). Returns '' so it can sit at the front of each body.innerHTML string.
// The footer line below sits inside each card, under the button (style.css uses
// display:contents + order on #authBody so the card and the links share one column).
function authSetMode(mode) {
  var w = $('.auth-wrap'); if (w) w.setAttribute('data-mode', mode);
  return '';
}
var AUTH_FOOT = '<div class="auth-lfoot"><span>Batches &middot; FEFO</span><span>KES</span></div>';
// list: [prefix, label, onclick-js]. Prefix shows on the phone only; the " · "
// separator on desktop only (style.css).
function authLinks(list) {
  return '<div class="auth-toggle">' + list.map(function (x) {
    return '<a href="#" onclick="' + x[2] + ';return false;">' +
      (x[0] ? '<span class="auth-pre">' + x[0] + ' </span>' : '') + '<b>' + x[1] + '</b></a>';
  }).join('<span class="auth-sep"> &middot; </span>') + '</div>';
}

// One sign-in design on every screen size (the "dispensing label" sign-in):
// hospital-cross mark, "Know your stock", four feature chips, and the form as a
// cream label card with the two links under it. A phone stacks them (curved
// green header, card below); at 860px+ it is a split screen with the same
// pieces: green hero on the left, label card on the right (style.css, the
// "AUTH, desktop" block). Both use the same #authBody and ids.
function authScreen() {
  if (STATE.recoveryMode) return recoveryScreen();
  var msg = STATE.disabledMessage;
  STATE.disabledMessage = null;
  // auth-bg-fill is a full-bleed absolutely-positioned green layer behind
  // EVERYTHING (phone only — hidden at 860px+, where auth-brand paints its
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
    authHeroHtml() +
    '</div>' +
    '</div>' +
    '<div class="auth-form-col"><div class="auth-card">' +
    (msg ? '<div class="card" style="border-color:#EFC3BE;background:#FBE9E7;margin-bottom:12px">' + esc(msg) + '</div>' : '') +
    '<div id="authBody"></div></div></div>' +
    '</div>';
}

function renderLogin() {
  STATE.authMode = 'login';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML = authSetMode('login') +
    '<div class="card">' +
    '<h2 class="auth-title">Welcome back &#128075;</h2>' +
    '<div class="field"><label>Phone number</label><input id="loPhone" type="tel" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Password</label>' + pwField('loPw', '••••••••') + '</div>' +
    '<div id="loErr" class="error-text"></div>' +
    '<button class="btn primary" id="loBtn" onclick="doLogin()">Log in</button>' +
    '<div class="tiny auth-forgot"><a href="#" onclick="renderForgotPassword();return false;">Forgot password?</a></div>' +
    AUTH_FOOT + '</div>' +
    authLinks([['New pharmacy?', 'Create an account', 'renderSignup()'], ['Have a code?', 'Staff login', 'renderJoin()']]);
}

function renderSignup() {
  STATE.authMode = 'signup';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML = authSetMode('signup') +
    '<div class="card">' +
    '<h2 class="auth-title">Create your account</h2>' +
    '<div class="field"><label>Pharmacy name</label><input id="suPharmacy" placeholder="e.g. Afya Bora Pharmacy"></div>' +
    '<div class="field"><label>Your name</label><input id="suName" placeholder="e.g. Daud Kinyua"></div>' +
    '<div class="field"><label>Phone number</label><input id="suPhone" type="tel" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Password</label>' + pwField('suPw', 'At least 8 characters') + '</div>' +
    '<div id="suErr" class="error-text"></div>' +
    '<button class="btn primary" id="suBtn" onclick="doSignup()">Create pharmacy account</button>' +
    AUTH_FOOT + '</div>' +
    authLinks([['Already registered?', 'Log in', 'renderLogin()'], ['Have a code?', 'Staff login', 'renderJoin()']]);
}

// Staff with an invite code (Settings -> Staff, in the owner's app) join here
// from the "Have a code? Staff login" link on the log-in and create-account screens.
function renderJoin() {
  STATE.authMode = 'join';
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML = authSetMode('join') +
    '<div class="card">' +
    '<h2 class="auth-title">Join pharmacy</h2>' +
    '<div class="field"><label>Staff code</label><input id="jnCode" placeholder="e.g. 2E530A" style="text-transform:uppercase"></div>' +
    '<div class="field"><label>Your name</label><input id="jnName" placeholder="e.g. Daud Kinyua"></div>' +
    '<div class="field"><label>Phone number</label><input id="jnPhone" type="tel" placeholder="07XXXXXXXX"></div>' +
    '<div class="field"><label>Password</label>' + pwField('jnPw', 'At least 8 characters') + '</div>' +
    '<div id="jnErr" class="error-text"></div>' +
    '<button class="btn primary" id="jnBtn" onclick="doJoin()">Join pharmacy</button>' +
    AUTH_FOOT + '</div>' + authLinks([['', 'Back to log in', 'renderLogin()']]);
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
    body.innerHTML = authSetMode('forgot') +
      '<div class="card">' +
      '<h2 class="auth-title">Forgot your password?</h2>' +
      '<div class="tiny" style="margin-bottom:10px">Enter the phone number on the account — we\'ll text you a 6-digit code.</div>' +
      '<div class="field"><label>Phone number</label><input id="fpPhone" type="tel" placeholder="07XXXXXXXX" value="' + esc(fpPhoneVal) + '"></div>' +
      '<div id="fpErr" class="error-text"></div>' +
      '<button class="btn primary" id="fpBtn" onclick="doSendResetCode()">Send code</button>' +
      AUTH_FOOT + '</div>' + authLinks([['', 'Back to log in', 'renderLogin()']]);
  } else if (fpStep === 'code') {
    body.innerHTML = authSetMode('forgot') +
      '<div class="card">' +
      '<h2 class="auth-title">Enter the code</h2>' +
      '<div class="tiny" style="margin-bottom:10px">Enter the 6-digit code sent to ' + esc(fpPhoneVal) + '.</div>' +
      '<div class="field"><label>Code</label><input id="fpCode" type="tel" maxlength="6" placeholder="123456"></div>' +
      '<div id="fpErr" class="error-text"></div>' +
      '<button class="btn primary" id="fpBtn" onclick="doVerifyResetCode()">Verify</button>' +
      AUTH_FOOT + '</div>' +
      authLinks([['', 'Use a different number', 'renderForgotPassword()'], ['', 'Resend code', 'doSendResetCode()']]);
  } else {
    body.innerHTML = authSetMode('forgot') +
      '<div class="card">' +
      '<h2 class="auth-title">Choose a new password</h2>' +
      '<div class="tiny" style="margin-bottom:10px">Phone number verified. Choose a new password.</div>' +
      '<div class="field"><label>New password</label>' + pwField('fpPw', 'At least 8 characters') + '</div>' +
      '<div id="fpErr" class="error-text"></div>' +
      '<button class="btn primary" id="fpBtn" onclick="doSetResetPassword()">Set new password</button>' +
      AUTH_FOOT + '</div>' + authLinks([['', 'Back to log in', 'renderLogin()']]);
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
      err.textContent = friendlyError({ message: data.message }) === 'Something went wrong.' ? 'Could not send a code right now. Try again shortly.' : friendlyError({ message: data.message });
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
    '<div class="field"><label>New password</label>' + pwField('rcPw', 'At least 8 characters') + '</div>' +
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
    if (error) { err.textContent = friendlyError(error); return; }
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
    await startSignupVerify({ kind: 'staff', code: code, fullName: fullName, phone: phone, pw: pw }, err);
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
        err.textContent = friendlyError(error);
      }
      return;
    }
    STATE.session = (await sb.auth.getSession()).data.session;
    // Signed in: show the branded loading screen straight away rather than
    // leaving the button on "Please wait…" while the pharmacy loads.
    $('#app').innerHTML = loadScreenHtml();
    try { await loadProfileAndPharmacy(); }
    catch (loadErr) { render(); toast(friendlyError(loadErr), 'bad'); return; }
    if (!STATE.profile && STATE.noPharmacyYet) {
      render(); err = $('#loErr') || err;
      err.textContent = "You're logged in, but this account isn't linked to a pharmacy yet. If you just signed up, try logging in again in a moment — if that doesn't work, sign up again.";
      return;
    }
    render();
    warmXlsx();
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
    await startSignupVerify({ kind: 'owner', pharmacyName: pharmacyName, fullName: fullName, phone: phone, pw: pw }, err);
  });
}

// ---------------------------------------------------------------------------
// Phone check at sign-up. The account is NOT created until the number has been
// proven with a text code: send-otp -> verify-otp (purpose 'signup') -> the
// signup-by-phone Edge Function, which needs the verified token and creates the
// account server-side. suFlow holds what the person typed while they wait for
// the code; it lives only in memory and is wiped once the account exists.
// ---------------------------------------------------------------------------
var suFlow = null;

async function startSignupVerify(flow, err) {
  var ok = await sendSignupCode(flow.phone, err);
  if (!ok) return;
  suFlow = flow;
  drawSignupCode();
  toast('Code sent — check your phone.', 'good');
}

// Sends (or re-sends) the code. Returns true when a text really went out.
async function sendSignupCode(phone, err) {
  var { data, error } = await sb.functions.invoke('send-otp', { body: { phone: phone, purpose: 'signup' } });
  if (error || !data || data.ok === false) {
    err.textContent = (data && data.message) || friendlyError(error);
    return false;
  }
  if (data.sent === false) {
    err.textContent = 'Could not send a code right now. Check the phone number and try again shortly.';
    return false;
  }
  return true;
}

function drawSignupCode() {
  var body = $('#authBody') || (function () { render(); return $('#authBody'); })();
  body.innerHTML = authSetMode(suFlow.kind === 'staff' ? 'join' : 'signup') +
    '<div class="card">' +
    '<h2 class="auth-title">Confirm your phone</h2>' +
    '<div class="tiny" style="margin-bottom:10px">We sent a 6-digit code to ' + esc(suFlow.phone) + '. Enter it to create your account.</div>' +
    '<div class="field"><label>Code</label><input id="suCode" type="tel" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></div>' +
    '<div id="suCodeErr" class="error-text"></div>' +
    '<button class="btn primary" id="suCodeBtn" onclick="doVerifySignupCode()">Verify and create account</button>' +
    AUTH_FOOT + '</div>' +
    authLinks([['', 'Wrong number? Go back', 'backFromSignupCode()'], ['', 'Resend code', 'doResendSignupCode()']]);
}

function backFromSignupCode() {
  var f = suFlow; suFlow = null;
  if (f && f.kind === 'staff') {
    renderJoin();
    $('#jnCode').value = f.code; $('#jnName').value = f.fullName; $('#jnPhone').value = f.phone;
  } else {
    renderSignup();
    if (f) { $('#suPharmacy').value = f.pharmacyName; $('#suName').value = f.fullName; $('#suPhone').value = f.phone; }
  }
}

async function doResendSignupCode() {
  var err = $('#suCodeErr'); err.textContent = '';
  if (!suFlow) { renderSignup(); return; }
  if (await sendSignupCode(suFlow.phone, err)) toast('New code sent.', 'good');
}

async function doVerifySignupCode() {
  var btn = $('#suCodeBtn'); var err = $('#suCodeErr'); err.textContent = '';
  act(btn, async function () {
    if (!suFlow) { renderSignup(); return; }
    var code = $('#suCode').value.trim();
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
    var v = await sb.functions.invoke('verify-otp', { body: { phone: suFlow.phone, purpose: 'signup', code: code } });
    if (v.error || !v.data || v.data.ok === false) {
      err.textContent = (v.data && v.data.message) || friendlyError(v.error);
      return;
    }
    // Phone proven. Create the account (server-side, needs the token), then sign in.
    var c = await sb.functions.invoke('signup-by-phone', {
      body: { phone: suFlow.phone, password: suFlow.pw, otp_verified_token: v.data.verified_token }
    });
    if (c.error || !c.data || c.data.error) {
      if (c.data && c.data.exists) { suFlow = null; renderLogin(); toast(c.data.error, 'bad'); return; }
      err.textContent = (c.data && c.data.error) || friendlyError(c.error);
      return;
    }
    var f = suFlow;
    var { error: siErr } = await sb.auth.signInWithPassword({ email: phoneToAuthEmail(f.phone), password: f.pw });
    suFlow = null;
    if (siErr) {
      // Account exists; only the automatic sign-in failed — send them to log in.
      stashPendingSignup(f.kind === 'staff'
        ? { kind: 'staff', code: f.code, fullName: f.fullName, phone: f.phone }
        : { kind: 'owner', pharmacyName: f.pharmacyName, fullName: f.fullName, phone: f.phone });
      renderLogin();
      toast('Account created — log in with your phone number and password.', 'good');
      return;
    }
    // Keep what they typed until the pharmacy is set up (finishPendingSignupIfAny clears it).
    stashPendingSignup(f.kind === 'staff'
      ? { kind: 'staff', code: f.code, fullName: f.fullName, phone: f.phone }
      : { kind: 'owner', pharmacyName: f.pharmacyName, fullName: f.fullName, phone: f.phone });
    STATE.session = (await sb.auth.getSession()).data.session;
    $('#app').innerHTML = loadScreenHtml();
    await finishPendingSignupIfAny();
    try { await loadProfileAndPharmacy(); }
    catch (loadErr) { render(); toast(friendlyError(loadErr), 'bad'); return; }
    if (!STATE.profile) {
      render();
      toast(f.kind === 'staff'
        ? 'Account created, but joining the pharmacy failed — check the staff code and log in again.'
        : 'Account created, but pharmacy setup did not finish — log in again to complete it.', 'bad');
      return;
    }
    render();
  });
}

// ---------------------------------------------------------------------------
