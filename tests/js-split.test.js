// The app's code used to be one file (app.js). It is now split by screen into
// js/*.js, loaded as plain scripts that share one global scope (there is no
// build step). That only works if three things stay true, and this checks them:
//   1. every file in js/ is loaded by index.html, in the same order,
//      and main.js (the one that starts the app) is last;
//   2. sw.js pre-caches every one of them (or the app would not open offline);
//   3. init() is called exactly once, only in main.js, and every file parses.
// Run from the project folder: node tests/js-split.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const onDisk = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f).sort();
const html = read('index.html');
const loaded = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);
const sw = read('sw.js');

check(onDisk.length > 0, 'js/ has script files');
check(JSON.stringify([...loaded].sort()) === JSON.stringify(onDisk), 'index.html loads every file in js/ and nothing else (loaded: ' + loaded.join(', ') + ')');
check(loaded[loaded.length - 1] === 'js/main.js', 'js/main.js is the LAST script in index.html');
check(loaded[0] === 'js/core.js', 'js/core.js is the FIRST script in index.html');
check(!/src="app\.js"/.test(html), 'index.html no longer loads the old app.js');
for (const f of loaded) check(sw.includes("'./" + f + "'"), 'sw.js pre-caches ' + f);
check(!/'\.\/app\.js'/.test(sw), 'sw.js no longer pre-caches the old app.js');

let initCalls = 0;
for (const f of onDisk) {
  const src = read(f);
  try { new vm.Script(src, { filename: f }); } catch (e) { check(false, f + ' does not parse: ' + e.message); }
  const n = (src.match(/^init\(\);/gm) || []).length;
  initCalls += n;
  if (f !== 'js/main.js') check(n === 0, f + ' must not call init() (only main.js starts the app)');
}
check(initCalls === 1, 'init() is called exactly once (found ' + initCalls + ')');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS js split: ' + onDisk.length + ' files, loaded in order, pre-cached, init() once');
