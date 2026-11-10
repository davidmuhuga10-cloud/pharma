// A few helpers exist twice: once for the app (js/) and once for the admin
// console (admin.js), because admin.html loads only admin.js and shares no
// code with the app. That is deliberate - but it means a fix applied to one
// copy silently misses the other, and two of these are security- or
// auth-critical:
//
//   esc()               escapes HTML. In November 2026 a companion escaping
//                       bug in the app broke seven buttons for any drug with
//                       an apostrophe in its name. If esc() ever needs
//                       fixing, BOTH copies must change.
//   normalizePhone()    turns 07.., +2547.., 7.. into 2547.. Used to find the
//                       account.
//   phoneToAuthEmail()  turns a phone number into the e-mail Supabase Auth
//                       actually stores. If the app and the admin console
//                       ever disagree about this, the admin console looks up
//                       an account that does not exist, or the wrong one.
//   act()               small shared DOM helper.
//
// This test does not stop the duplication. It stops the two copies DRIFTING
// APART without anyone noticing. If it fails, you changed one copy: copy the
// same change into the other, or - better - move the function somewhere both
// pages load and delete both copies.
//
// Run from the project folder: node tests/shared-helpers.test.js
//
// To prove it works: change a character inside esc() in admin.js and run it.
// It must print FAIL and exit 1.

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

// Pull one top-level function out of a file by matching braces.
function grab(file, name) {
  const lines = read(file).split(/\r?\n/);
  const start = new RegExp('^\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  for (let i = 0; i < lines.length; i++) {
    if (!start.test(lines[i])) continue;
    let depth = 0, seen = false, body = [];
    for (let j = i; j < lines.length && j < i + 400; j++) {
      body.push(lines[j]);
      for (const ch of lines[j]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
      if (seen && depth <= 0) return body.join('\n');
    }
    return body.join('\n');
  }
  return null;
}

// Whitespace and comments differ harmlessly between the two files; what must
// not differ is the code.
const normalise = s => s
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();

const SHARED = [
  { name: 'esc',              app: 'js/core.js'  },
  { name: 'act',              app: 'js/core.js'  },
  { name: 'normalizePhone',   app: 'js/shell.js' },
  { name: 'phoneToAuthEmail', app: 'js/shell.js' }
];

for (const { name, app } of SHARED) {
  const a = grab(app, name);
  const b = grab('admin.js', name);

  check(a !== null, name + '() still exists in ' + app);
  check(b !== null, name + '() still exists in admin.js');
  if (a === null || b === null) continue;

  const same = normalise(a) === normalise(b);
  check(same,
    name + '() differs between ' + app + ' and admin.js — the two copies have drifted.\n' +
    '       ' + app + ':\n         ' + normalise(a) + '\n' +
    '       admin.js:\n         ' + normalise(b) + '\n' +
    '       Copy the change into the other file, or move the function somewhere both pages load.');
}

if (failed) {
  console.error('\n' + failed + ' problem(s). See tests/shared-helpers.test.js for why this matters.');
  process.exit(1);
}
console.log('PASS shared helpers: esc, act, normalizePhone and phoneToAuthEmail are identical in the app and the admin console');
