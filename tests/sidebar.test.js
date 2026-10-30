// The left bar is one list of buttons that is the phone's five-tab bottom bar AND the desktop's
// full sidebar. Its rows come from navMenuItems() (the same permission-gated list as the phone's
// menu drawer), so every module the menu has must be on the sidebar, a phone must still show only
// its five tabs, and exactly one sidebar row is lit. This runs the real navMenuItems()/navBar()
// from js/shell.js without a browser. Run from the project folder: node tests/sidebar.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const shell = read('js/shell.js');
const grab = name => {
  const start = shell.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in js/shell.js');
  let depth = 0, i = shell.indexOf('{', start);
  for (; i < shell.length; i++) { if (shell[i] === '{') depth++; else if (shell[i] === '}' && --depth === 0) break; }
  return shell.slice(start, i + 1);
};
const make = (perms, tab, view) => {
  const ctx = vm.createContext({
    STATE: { tab, profile: { full_name: 'T', role: 'owner' }, pharmacy: { name: 'P' } }, reportsView: view || 'hub',
    can: a => perms.includes(a), canSeeCustomers: () => perms.includes('customers'), canSeeControlled: () => perms.includes('view_controlled'),
    t: k => ({ home: 'Home', sell: 'Sell', suppliers: 'Suppliers', expenses: 'Expenses', reports: 'Reports', settings: 'Settings' }[k] || k),
    esc: s => String(s), logoMarkHtml: () => '', roleLabel: r => r
  });
  vm.runInContext(['navMenuItems', 'navTabOn', 'navBar'].map(grab).join('\n'), ctx);
  return ctx;
};
// Pulls the buttons out of the markup: { label, cls, go }
const buttons = html => [...html.matchAll(/<button class="([^"]*)" onclick="([^"]*)"><span class="ic3d"[^>]*>[^<]*<\/span>([^<]*)<\/button>/g)].map(m => ({ cls: m[1], go: m[2], label: m[3] }));
const ALL = ['sell', 'view_inventory', 'view_reports', 'customers', 'sms', 'stock_take', 'view_controlled', 'suppliers', 'expenses', 'claims'];

// 1. every module in the menu is on the sidebar, in the same order, each with its glass chip
{
  const ctx = make(ALL, 'dashboard');
  const html = vm.runInContext('navBar()', ctx);
  const b = buttons(html);
  const menu = vm.runInContext('navMenuItems().filter(function (m) { return !m.grp; }).length', ctx);
  check(menu === 15 && b.length === menu, 'sidebar has one button per menu row (menu ' + menu + ', sidebar ' + b.length + ')');
  check(b.map(x => x.label).join() === 'Home,Inventory,Sell,Customers,SMS,Stock Take,Controlled Drugs,Reorder List,Expiry Dates,Suppliers,Expenses,Stock Valuation,Insurance Claims,Reports,Settings', 'sidebar order and names: ' + b.map(x => x.label).join());
  check((html.match(/class="ic3d"/g) || []).length === b.length, 'every row has a glass chip');
  check(!/nb-grp/.test(html) && !/>(Stock|Money|More)</.test(html), 'no Stock / Money / More headings on the bar');
  // 2. a phone shows only the five tabs
  const phone = b.filter(x => !/nav-desktop-extra/.test(x.cls)).map(x => x.label);
  check(phone.join() === 'Home,Inventory,Sell,Expenses,Reports', 'phone bottom bar is still Home, Inventory, Sell, Expenses, Reports: ' + phone.join());
  check(b.find(x => x.label === 'Reports').go === "goReport('hub')", 'Reports opens its hub');
  check(b.find(x => x.label === 'Expiry Dates').go === "goReport('expiry')" && b.find(x => x.label === 'Stock Take').go === "setTab('stocktake')", 'rows open the right screens');
}
// 3. exactly one row lit on the sidebar; the phone keeps the parent tab lit
const lit = (tab, view) => buttons(vm.runInContext('navBar()', make(ALL, tab, view))).filter(x => /\bactive\b/.test(x.cls));
const deskLit = (tab, view) => lit(tab, view).filter(x => !/parent-open/.test(x.cls)).map(x => x.label);
check(deskLit('dashboard').join() === 'Home', 'Home lit on the dashboard');
check(deskLit('stocktake').join() === 'Stock Take' && lit('stocktake').some(x => x.label === 'Inventory' && /parent-open/.test(x.cls)), 'Stock Take lit; Inventory only lit for the phone (parent-open)');
check(deskLit('controlled').join() === 'Controlled Drugs', 'Controlled Drugs lit');
check(deskLit('reports', 'expiry').join() === 'Expiry Dates' && lit('reports', 'expiry').some(x => x.label === 'Reports' && /parent-open/.test(x.cls)), 'inside Expiry Dates only that row is lit; Reports is parent-open');
check(deskLit('reports', 'valuation').join() === 'Stock Valuation', 'Stock Valuation lit');
check(deskLit('reports', 'hub').join() === 'Reports', 'Reports lit at its hub');
check(deskLit('settings').join() === 'Settings' && deskLit('suppliers').join() === 'Suppliers', 'Settings / Suppliers lit');
// 4. permissions: a role that cannot do something never sees its row
{
  const b = buttons(vm.runInContext('navBar()', make(['view_dashboard', 'view_reports', 'view_suppliers', 'view_expenses', 'claims', 'customers', 'view_controlled'], 'dashboard'))).map(x => x.label);
  check(!b.includes('Sell') && !b.includes('Inventory') && !b.includes('Stock Take') && !b.includes('SMS'), 'an accountant-style role does not get Sell, Inventory, Stock Take or SMS: ' + b.join());
  check(b.includes('Insurance Claims') && b.includes('Suppliers') && b.includes('Expenses') && b.includes('Reports'), 'but does get the money rows');
}
// 4b. the topbar Profile card carries the account details and the Log out button
{
  const ctx = make(ALL, 'dashboard');
  ctx.STATE.profile = { full_name: 'Asalia W', role: 'owner' }; ctx.STATE.pharmacy = { name: 'Rubao Pharmacy' };
  vm.runInContext(['profileMenuHtml'].map(grab).join('\n'), ctx);
  const h = vm.runInContext('profileMenuHtml()', ctx);
  check(/Profile/.test(h.replace(/<[^>]+>/g, ' ')) && /Asalia W/.test(h) && /Rubao Pharmacy/.test(h) && /owner/.test(h) && /onclick="logout\(\)"/.test(h), 'profile card: name, role, pharmacy and Log out');
  check(!/class="navbar-foot"/.test(vm.runInContext('navBar()', ctx)), 'navBar() no longer writes the account card');
}
// 5. the styles that make it work
const css = read('style.css');
const desk = css.slice(css.indexOf('@media (min-width: 860px)'), css.indexOf('/* FIX (PHARMA_PROJECT_STATUS.md item 29'));
check(/\.nb-list\s*\{[^}]*overflow-y:\s*auto/.test(desk) && /\.nb-list\s*\{[^}]*min-height:\s*0/.test(desk), 'desktop: the list scrolls inside the bar (overflow-y auto, min-height 0)');
check(/\.nb-list::-webkit-scrollbar\s*\{\s*width:\s*20px/.test(desk) && /\.nb-list::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#FFFFFF/.test(desk), 'desktop: the scrollbar is a thick (20px) white bar');
check(/\.nb-list \{ display: contents; \}/.test(css), 'phone: the list adds no box of its own');
check(!/nb-grp/.test(css), 'no group-heading styles left');
check(/\.navbar button\.parent-open\s*\{[^}]*background:\s*none/.test(desk), 'desktop: a parent-open tab is not lit');
check(!/\.navbar button \.ic\b/.test(css), 'the old line-icon rules are gone');
check(/\.tb-logout \{ display: none; \}/.test(desk) && /\.tb-profile \{ display: block/.test(desk) && /\.tb-profile \{ display: none; \}/.test(css), 'topbar: Log out is replaced by Profile on a desktop only');
check(!/navbar-foot/.test(css) && !/navbar-foot/.test(shell), 'the account card in the sidebar is gone');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS sidebar: every module present, phone bar unchanged, one lit row, scrolling styles');
