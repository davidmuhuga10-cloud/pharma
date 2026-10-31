// No browser pop-ups: alert(), confirm() and prompt() print the website's address
// ("pharmacymngt.netlify.app says") and cannot be styled. Customers must never see that, so
// every question goes through the in-app pop-ups in js/core.js (askConfirm / askText).
// Run from the project folder: node tests/no-native-dialogs.test.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)
  .concat(['admin.js', 'install.js', 'nativeShell.js', 'index.html', 'admin.html']);
let failed = 0;
for (const f of files) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');          // whole-line comments are fine
    if (/(^|[^\w.$])(alert|confirm|prompt)\s*\(/.test(code) || /\bwindow\.(alert|confirm|prompt)\s*\(/.test(code)) {
      failed++; console.error('FAIL ' + f + ':' + (i + 1) + ' uses a browser pop-up: ' + line.trim().slice(0, 100));
    }
  });
}
// the app keeps itself up to date, so an old phone cannot keep showing replaced screens
const main = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');
if (!/controllerchange/.test(main) || !/location\.reload\(\)/.test(main) || !/safeToReload/.test(main)) {
  failed++; console.error('FAIL js/main.js no longer reloads an open app after an update');
}
if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS no browser pop-ups anywhere in the app; open app refreshes itself after an update');
