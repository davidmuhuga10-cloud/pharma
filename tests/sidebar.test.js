// Desktop menu (860px and up): the phone's slide-out menu, docked open down the left edge.
// The old scrolling icon sidebar (.navbar) is hidden there; the phone's five-tab bottom bar is unchanged.
// Static checks of js/shell.js and style.css. Run from the project folder: node tests/sidebar.test.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const shell = read('js/shell.js'), css = read('style.css');

// 1. the markup: logo + pharmacy name on top, who is signed in at the bottom (both hidden on a phone)
check(/class="nd-brand"/.test(shell) && /class="nd-bname"/.test(shell), 'shell.js writes the logo / pharmacy name block (.nd-brand)');
check(/class="nd-who"/.test(shell), 'shell.js writes who is signed in (.nd-who)');
check(/\.nd-brand, \.nd-who \{ display: none; \}/.test(css), 'phone: .nd-brand / .nd-who are hidden');

// 2. phone bottom bar unchanged: customers, SMS, suppliers and settings stay off it (nav-desktop-extra)
check(/\['customers', 'people', 'Customers', true\]/.test(shell) && /\['suppliers', 'truck', t\('suppliers'\), true\]/.test(shell)
  && /\['settings', 'settings', t\('settings'\), true\]/.test(shell), 'phone bar: extra rows are still marked desktop-only');
check(/\.navbar button\.nav-desktop-extra/.test(css) || /nav-desktop-extra/.test(css), 'phone bar: .nav-desktop-extra is styled');

// 3. the desktop styles
const at = css.indexOf('DESKTOP MENU (860px+)');
check(at > 0, 'style.css has the DESKTOP MENU block');
const block = css.slice(at, at + 4500);
check(/\.navscrim, \.navbar, \.topbar \.burgerbtn \{ display: none; \}/.test(block), 'desktop: the old bar, scrim and burger button are hidden');
check(/\.navdrawer \{[^}]*transform: none;[^}]*visibility: visible/.test(block), 'desktop: the drawer is docked open (no slide, always visible)');
check(/\.nd-row\.active \{[^}]*border-left-color/.test(block), 'desktop: the current row has the gold edge');
check(/--sidebar-w:\s*200px/.test(css), 'desktop: content is pushed right by the 200px menu');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS desktop menu: docked drawer styles, brand and account blocks, phone bar unchanged');
