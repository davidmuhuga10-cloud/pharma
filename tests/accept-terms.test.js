// Accepting the Terms on the sign-in screens (owner-approved from a sketch, 9 Nov 2026).
// Create account and Staff join show a tick box ("I agree to the Terms of Service and Privacy
// Policy"), unticked, and the form refuses to go on until it is ticked. Log in only shows a
// short "By signing in you accept..." line. The links open in a new tab so nothing typed is lost.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }
const auth = fs.readFileSync(path.join(root, 'js/auth.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
function fn(name) {
  const i = auth.indexOf('async function ' + name + '(');
  if (i < 0) return '';
  const j = auth.indexOf('\n}\n', i);
  return auth.slice(i, j + 3);
}

const helper = auth.match(/function termsAgreeHtml\(id\)\s*\{[\s\S]*?\n\}/);
check(!!helper, 'js/auth.js has termsAgreeHtml(id)');
const h = helper ? helper[0] : '';
check(/type="checkbox"/.test(h) && !/checked/.test(h), 'the box is a checkbox and starts unticked');
check(/href="terms\.html"/.test(h) && /href="privacy\.html"/.test(h), 'it links to terms.html and privacy.html');
check(/target="_blank"/.test(h) && /rel="noopener"/.test(h), 'the links open in a new tab, so a half-filled form is not lost');

const signup = auth.slice(auth.indexOf('function renderSignup()'), auth.indexOf('function renderJoin()'));
const join = auth.slice(auth.indexOf('function renderJoin()'), auth.indexOf('// A normal form field'));
const login = auth.slice(auth.indexOf('function renderLogin()'), auth.indexOf('function renderSignup()'));
check(/termsAgreeHtml\('suAgree'\)/.test(signup), 'Create account shows the tick box');
check(/termsAgreeHtml\('jnAgree'\)/.test(join), 'Staff join shows the tick box');
check(!/termsAgreeHtml/.test(login), 'Log in has no tick box');
check(/By signing in you accept our/.test(login) && /terms\.html/.test(login) && /privacy\.html/.test(login), 'Log in shows the "By signing in you accept" line with both links');

const ds = fn('doSignup'), dj = fn('doJoin');
for (const [name, body, id] of [['doSignup', ds, 'suAgree'], ['doJoin', dj, 'jnAgree']]) {
  const gate = body.indexOf("$('#" + id + "').checked");
  const go = body.indexOf('startSignupVerify(');
  check(gate > 0, name + ' reads the tick box');
  check(gate > 0 && go > gate, name + ' stops before sending a code when the box is not ticked');
  check(/Please tick the box to accept the Terms of Service and Privacy Policy\./.test(body), name + ' tells the person what to do');
}

check(/\.agree\s*\{/.test(css) && /\.agree input\s*\{/.test(css) && /\.agree-note\s*\{/.test(css), 'style.css styles the tick box and the login line');
check(/\.agree input\s*\{[^}]*min-width|\.agree input\s*\{[^}]*width:\s*2\d?px/.test(css), 'the tick box is a tap-sized target (20px or more)');
console.log(failed ? failed + ' accept-terms checks failed' : 'PASS accept-terms: tick box on Create account and Staff join, accept line on Log in');
process.exit(failed ? 1 : 0);
