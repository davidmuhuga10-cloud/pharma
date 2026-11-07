// The desktop sign-in is the phone's "dispensing label" sign-in as a split screen: the same hero
// (cross mark, Pharma, Know your stock, four feature chips) on the left and the same cream label
// card with the two links on the right. This checks the markup the two sizes share and that the
// desktop styles exist, without a browser. Run from the project folder: node tests/auth-desktop.test.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const js = read('js/auth.js'), css = read('style.css');
check(/Welcome back/.test(js) && /auth-lfoot/.test(js) && /Create an account/.test(js) && /Staff login/.test(js), 'log-in card has the title, the FEFO strip and both links');
check(/class="auth-sheet"/.test(js) && ['Batch tracking', 'Expiry alerts', 'Daily reports', 'Printed receipts'].every(t => js.includes('<li><span>' + t + '</span><u></u>')), 'the four features are lines on a cream card with dotted leaders (like the eatery menu card)');
const heroFn = js.slice(js.indexOf('function authHeroHtml'), js.indexOf('function authSetMode') > 0 ? js.indexOf('function authSetMode') : undefined);
const hero = heroFn.replace(/^[^\n]*\n/, '');
check((hero.match(/<div/g) || []).length === (hero.match(/<\/div>/g) || []).length, 'the sign-in hero markup has balanced <div> tags (an extra one pushes the form out of the page)');
check((js.match(/<div class="auth-feat">/g) || []).length === 4, 'the phone keeps its four icon tiles');
check(!/auth-desk-top|auth-stat-card|auth-brand-headline|auth-brand-line/.test(js + css), 'the old desktop headline and floating stat cards are gone');
const i = css.indexOf('AUTH, desktop (860px and up)');
check(i > 0, 'style.css has the desktop sign-in block');
const blk = css.slice(i);
check(/@media \(min-width: 860px\)/.test(blk), 'it applies from 860px up');
check(/\.auth-brand \{[^}]*flex: 0 0 47%/.test(blk) && /\.auth-form-col \{[^}]*flex: 1/.test(blk), 'hero left (47%), form right');
check(/\.auth-sheet \{[^}]*background: #FBF7EC/.test(css) && /\.auth-sheet li u \{[^}]*dotted/.test(css) && /\.auth-brand:has\(\.auth-sheet\) \{ border-right: 4px solid #A6D63C/.test(css), 'cream feature card with dotted lines and a lime divider on desktop');
const sheetCss = css.slice(css.indexOf('AUTH: the feature card on the app sign-in'));
check(/^\.auth-sheet \{ display: none; \}/m.test(sheetCss) && sheetCss.indexOf('@media (min-width: 860px)') > sheetCss.indexOf('.auth-sheet { display: none; }') && !/@media \(max-width/.test(sheetCss), 'the card is hidden by default and only appears from 860px up, so phones are untouched');
check(/\.auth-wrap:not\(\[data-mode="login"\]\) \.auth-sheet \{ display: none/.test(sheetCss), 'the card shows on the log-in screen only');
check(/#authBody > \.card \{[^}]*background: #FBF7EC/.test(blk) && /#authBody > \.card::before/.test(blk), 'cream label card with perforated edges');
check(/#authBody \.btn\.primary \{[^}]*linear-gradient/.test(blk) && /\.auth-toggle a \{[^}]*border: 1\.5px solid var\(--green\)/.test(blk), 'gold stamp button and outlined links');
check(!/color:\s*#(?:[89a-f])\1\1/i.test(blk), 'no gray text colours in the block');
check(/\.auth-wrap\[data-mode="login"\] \.auth-brand \{ padding-top: calc\(clamp\(24px, 7vh, 80px\) \+ 16px/.test(css), 'phone sign-in keeps 16px of air between the heartbeat line and the logo');
// the phone design must still be there, unchanged
check(/@media \(max-width: 859px\) \{\s*\n\s*\.auth-hero \{ display: block; \}/.test(css), 'phone sign-in block still present');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS desktop sign-in: same pieces as the phone, split-screen styles present');
