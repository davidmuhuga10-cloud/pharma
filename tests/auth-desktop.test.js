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
check((js.match(/<div class="auth-feat">/g) || []).length === 4 && /<i>[^<]*<\/i><span>Batch<br>tracking<\/span>/.test(js), 'four feature chips, label in a span (so it can sit beside the chip)');
check(!/auth-desk-top|auth-stat-card|auth-brand-headline|auth-brand-line/.test(js + css), 'the old desktop headline and floating stat cards are gone');
const i = css.indexOf('AUTH, desktop (860px and up)');
check(i > 0, 'style.css has the desktop sign-in block');
const blk = css.slice(i);
check(/@media \(min-width: 860px\)/.test(blk), 'it applies from 860px up');
check(/\.auth-brand \{[^}]*flex: 0 0 47%/.test(blk) && /\.auth-form-col \{[^}]*flex: 1/.test(blk), 'hero left (47%), form right');
check(/\.auth-feats \{[^}]*grid-template-columns: repeat\(2/.test(blk) && /\.auth-feat i \{[^}]*width: 56px/.test(blk), 'feature chips in a 2 x 2 grid with glass chips');
check(/#authBody > \.card \{[^}]*background: #FBF7EC/.test(blk) && /#authBody > \.card::before/.test(blk), 'cream label card with perforated edges');
check(/#authBody \.btn\.primary \{[^}]*linear-gradient/.test(blk) && /\.auth-toggle a \{[^}]*border: 1\.5px solid var\(--green\)/.test(blk), 'gold stamp button and outlined links');
check(!/color:\s*#(?:[89a-f])\1\1/i.test(blk), 'no gray text colours in the block');
// the phone design must still be there, unchanged
check(/@media \(max-width: 859px\) \{\s*\n\s*\.auth-hero \{ display: block; \}/.test(css), 'phone sign-in block still present');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS desktop sign-in: same pieces as the phone, split-screen styles present');
