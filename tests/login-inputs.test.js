// Password boxes must not auto-capitalise or auto-correct. When the eye shows the password as
// plain text, a phone keyboard would capitalise the first letter and the login would wrongly say
// "incorrect". Run from the project folder:
//   node tests/login-inputs.test.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const start = src.indexOf('function pwField(');
const body = src.slice(start, src.indexOf('\n}', start));
check(start > 0, 'pwField exists in js/core.js');
check(/autocapitalize="off"/.test(body), 'password boxes turn auto-capitalise off');
check(/autocorrect="off"/.test(body), 'password boxes turn auto-correct off');
check(/spellcheck="false"/.test(body), 'password boxes turn spell-check off');
if (failed) process.exit(1);
console.log('login inputs: ok');
