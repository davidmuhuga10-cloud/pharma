// The admin console (admin.html / admin.js): email sign-in, password reset, eye icons on every
// password box, and a side menu whose every entry opens a real page. Run from the project folder:
//   node tests/admin-shell.test.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin.css'), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const fn = name => {
  const i = js.search(new RegExp('(async )?function ' + name + '\\('));
  if (i < 0) return '';
  const m = js.slice(i).match(/\n\}/);
  return js.slice(i, i + (m ? m.index : 3000));
};

// Sign in with an email and password, not a phone number.
const login = fn('doLogin') + fn('renderLogin');
check(/signInWithPassword\(\{ email: email/.test(login), 'admin sign-in uses the email the owner typed');
check(!/phoneToAuthEmail\(|normalizePhone\(/.test(login), 'admin sign-in does not turn a phone number into an email');
check(/id="lgEmail" type="email"/.test(login), 'sign-in has an email box');

// Every password box has the eye, and does not auto-capitalise.
const pw = fn('pwField');
check(/autocapitalize="off"/.test(pw) && /autocorrect="off"/.test(pw) && /spellcheck="false"/.test(pw), 'password boxes turn auto-capitalise, auto-correct and spell-check off');
check(/pw-eye/.test(js), 'password boxes have an eye button');
['lgPw', 'npPw', 'npPw2', 'cpOld', 'cpNew', 'cpNew2'].forEach(id =>
  check(new RegExp("pwField\\('" + id + "'").test(js), 'password box ' + id + ' is built with pwField (eye icon)'));
check(/wirePwEyes\(\$\('#admin'\)\)/.test(fn('authPage')), 'sign-in, reset and new-password screens switch the eyes on');
check(/wirePwEyes\(\$\('#admin'\)\)/.test(fn('showAccount')), 'account page switches the eyes on');

// Password reset: link by email, then a new-password screen.
check(/resetPasswordForEmail\(/.test(fn('renderForgot')), 'forgot-password sends a reset email');
check(/updateUser\(\{ password: pw \}\)/.test(fn('renderNewPassword')), 'new-password screen saves the password');
check(/PASSWORD_RECOVERY/.test(fn('init')), 'init handles the reset-link sign-in');
check(js.indexOf('RECOVERY_LINK = /type=recovery/') > -1 && js.indexOf('RECOVERY_LINK = /type=recovery/') < js.indexOf('supabase.createClient'),
  'the reset link is noted before the Supabase client clears the address');
check(/A\.recovering\) return/.test(fn('route')), 'the menu does not open while choosing a new password');
check(/signInWithPassword\(\{ email: email, password: oldPw \}\)/.test(fn('showAccount')), 'changing the password checks the current one first');

// The side menu: every entry has a page, on the desktop menu and the phone bar.
const routes = (fn('route').match(/'#\/[a-z]+'/g) || []).map(s => s.slice(1, -1));
const items = (js.match(/\['(overview|pharmacies|billing|account)', '#\/([a-z]*)'/g) || []).map(s => '#/' + s.match(/'#\/([a-z]*)'/)[1]);
check(items.length === 4, 'the menu has Overview, Pharmacies, Billing and Account');
items.filter(h => h !== '#/').forEach(h => check(routes.indexOf(h) > -1, 'route() opens ' + h));
check(/class="navdrawer adm-drawer"/.test(fn('shell')) && /class="navbar adm-nav"/.test(fn('shell')), 'menu has the desktop sidebar and the phone bottom bar');
check(/@media \(max-width: 859px\) \{ \.adm-drawer \{ display: none; \} \}/.test(css), 'the docked sidebar is hidden on a phone');
check(/margin-left: var\(--sidebar-w\)/.test(css), 'the page makes room for the sidebar on a desktop');
check(!/href="#\/">' \+ icon\('back'\)/.test(js), 'pharmacy page goes back to Pharmacies, not Overview');

// Nobody\'s sign-in details belong in the source.
check(!/@gmail\.com|password\s*[:=]\s*['"][^'"]{6,}/i.test(js), 'no email address or password is written into admin.js');

if (failed) process.exit(1);
console.log('admin shell: ok');
