// Inside the app the page is white, the top bar, bottom bar and menus are black and the Restock-style
// buttons are red. The sign-in screens, tiles and graphs must keep their own colours. Run from the project folder:
//   node tests/app-theme.test.js
const fs = require('fs'), path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const start = css.indexOf('/* ---- APP THEME');
check(start > 0, 'the app theme block exists in style.css');
const end = css.indexOf('/* ---- PROFILE and GET SUPPORT');
const block = css.slice(start, end > start ? end : undefined);
const rule = sel => { const m = block.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };

check(/background:\s*#FAF9F7/i.test(rule('html:has(.topbar), body:has(.topbar)')), 'the page behind the cards is white');
check(/background:\s*#221F1D/i.test(rule('body:has(.topbar) .topbar')), 'the top bar is black');
check(/background:\s*#221F1D/i.test(rule('body:has(.topbar) .btn.primary')), 'main buttons (Sell) are black');
check(/background:\s*var\(--red\)/.test(rule('body:has(.topbar) .btn.secondary')), 'Restock-style buttons are red');
check(/\.topbar \{ background: #221F1D; color: #fff/i.test(block.slice(block.indexOf('@media (min-width: 860px)'))), 'the desktop top strip is black with white text');
check(/\.nd-who \{ display: none; \}/.test(block), 'the desktop menu does not show the user name');
check(/\.topbar \.topbar-id \.brand-badge \{ display: none; \}/.test(block), 'no P badge before the pharmacy name');
check(/background: #DCE8F6/i.test(block), 'phone bottom bar uses the soft blue of the Kodi app');
check(/\.navdrawer \{ background/.test(block.slice(block.indexOf('@media (min-width: 860px)'), block.indexOf('The phone menu is parked')) ) === false, 'the desktop menu is not recoloured (stays green)');
check(/font-family:\s*'Inter',\s*-apple-system/.test(block), 'the app uses the Kodi font stack (Inter first)');
check(/h1[^{]*\{[^}]*font-weight:\s*650[^}]*letter-spacing:\s*-\.015em/.test(block), 'headings use the Kodi weight and spacing');
const noteRule = (css.match(/\.support-note\s*\{([^}]*)\}/) || [])[1] || '';
check(/background:\s*#F4F2EF/i.test(noteRule) && !/amber/.test(noteRule), 'the Get support notice uses the warm light Kodi background, not the amber/reddish one');
check(/\.sheet-head \{[^}]*border-bottom: 1px solid #E8E4DE/.test(block), 'pop-ups have a header band with a divider (Kodi style)');
check(/\.sheet-head button \{[^}]*width: 34px[^}]*background: #F1EFEC/.test(block), 'pop-ups have a light square close button');
check(/\.sheet \.btn\.danger[^{]*\{[^}]*background: var\(--red\)/.test(block), 'destructive buttons in pop-ups are solid red');

// Every selector in the block is scoped to the app shell, so sign-in pages cannot be touched.
const sels = (block.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) || []).map(s => s.trim()).filter(s => s && !s.startsWith('@'));
sels.forEach(s => s.split(',').forEach(p => check(/:has\(\.topbar\)/.test(p), 'scoped to the app only: ' + p.trim())));
check(!/\.auth|#authBody|\.kpi|\.dash-graph|\.dash-stat|\.dash-list-card|\.dash-chart|\.dash-card-head|\.t-green/.test(sels.join(' ')), 'sign-in screens, tiles and graphs are not touched by the theme');

// The out-of-stock / expiry strip on the dashboard is plain red, not brown.
const alertRule = (css.match(/\n\.dash-alert\s*\{([^}]*)\}/) || [])[1] || '';
check(/[^-]color:\s*var\(--red\)/.test(alertRule) && !/#8a2a22/i.test(alertRule), 'the dashboard out-of-stock strip text is red, not brown');

if (failed) process.exit(1);
console.log('app theme: ok');
