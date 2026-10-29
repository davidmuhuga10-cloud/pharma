// nativeShell.js must do nothing in a normal browser, and in the app it must
// route window.print to the Printer plugin and send the back button the right way.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'nativeShell.js'), 'utf8');
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log('FAIL ' + msg); bad++; } };

function run(win, doc) { vm.runInNewContext(src, Object.assign({ window: win, document: doc, setTimeout: () => 0 }, win)); }
function makeDoc(opts) {
  opts = opts || {};
  const vp = { c: 'width=device-width, initial-scale=1, viewport-fit=cover', getAttribute() { return this.c; }, setAttribute(k, v) { this.c = v; } };
  const classes = new Set(opts.nav ? ['nav-open'] : []);
  const mask = opts.mask ? { remove() { opts.removed = true; } } : null;
  return { vp, classes, doc: {
    readyState: 'complete', documentElement: { classList: { add() {} } },
    querySelector: s => s === 'meta[name="viewport"]' ? vp : s === '.mask' ? mask : s === '.dlg-mask' ? (opts.dlg ? {} : null) : null,
    body: { classList: { contains: c => classes.has(c), remove: c => classes.delete(c) } } } };
}

// 1. normal browser: no Capacitor, nothing changes
{ const printOrig = () => 'orig'; const win = { print: printOrig }; const d = makeDoc(); run(win, d.doc);
  check(win.print === printOrig, 'window.print must be untouched in a normal browser');
  check(d.vp.c.includes('viewport-fit=cover'), 'viewport must be untouched in a normal browser'); }

// 2. in the app
function app(state, extra, docOpts) {
  const calls = []; let backHandler;
  const d = makeDoc(docOpts);
  const win = Object.assign({ print: () => 'orig', STATE: state,
    Capacitor: { isNativePlatform: () => true, Plugins: {
      Printer: { printWebView: o => { calls.push('print:' + o.name); return Promise.resolve(); } },
      App: { addListener: (n, f) => { backHandler = f; }, minimizeApp: () => { calls.push('minimize'); return Promise.resolve(); } },
      StatusBar: { setBackgroundColor: o => { calls.push('bar:' + o.color); return Promise.resolve(); }, setStyle: () => Promise.resolve() },
      SplashScreen: { hide: () => { calls.push('splash'); return Promise.resolve(); } } } } }, extra);
  run(win, d.doc);
  return { win, calls, back: () => backHandler(), d };
}
{ const a = app({ profile: {}, tab: 'dashboard' });
  check(a.d.vp.c.includes('viewport-fit=cover'), 'app keeps viewport-fit=cover; the CSS pads for the status bar');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  check(/\.topbar \{[^}]*padding-top: calc\(12px \+ env\(safe-area-inset-top/.test(css), 'top bar must be padded by safe-area-inset-top');
  check(/\.navdrawer \{[^}]*var\(--ph-safe-top\)/.test(css), 'menu drawer must start below the status bar');
  check(/\.auth-brand \{[^}]*safe-area-inset-top/.test(css), 'sign-in screen must clear the status bar');
  a.win.print(); check(a.calls.includes('print:Pharma'), 'window.print must call the Printer plugin');
  check(a.calls.includes('bar:#0F5132'), 'status bar must be Pharma green');
  check(a.calls.includes('splash'), 'splash must be hidden once the page has loaded');
  a.back(); check(a.calls.includes('minimize'), 'back on Home must minimise the app'); }
{ let went; const a = app({ profile: {}, tab: 'inventory' }, { setTab: t => { went = t; } });
  a.back(); check(went === 'dashboard' && !a.calls.includes('minimize'), 'back on another tab must go to Home'); }
{ let closed = 0, went; const a = app({ profile: {}, tab: 'inventory' }, { closeSheet: () => { closed++; }, setTab: t => { went = t; } }, { mask: true });
  a.back(); check(closed === 1 && !went, 'back with a sheet open must close the sheet only'); }
{ let closed = 0, went; const a = app({ profile: {}, tab: 'inventory' }, { closeNavDrawer: () => { closed++; }, setTab: t => { went = t; } }, { nav: true });
  a.back(); check(closed === 1 && !went, 'back with the menu drawer open must close the drawer only'); }
{ let dclosed = 0, sclosed = 0; const a = app({ profile: {}, tab: 'sell' }, { closeDialog: () => { dclosed++; }, closeSheet: () => { sclosed++; } }, { dlg: true, mask: true });
  a.back(); check(dclosed === 1 && sclosed === 0 && !a.calls.includes('minimize'), 'back with a pop-up open must close the pop-up only'); }
{ const a = app({ profile: null, tab: 'dashboard' }); a.back(); check(a.calls.includes('minimize'), 'back on the sign-in screen must minimise the app'); }

if (bad) process.exit(1);
console.log('PASS native shell: browser untouched; print, back button, status bar and splash behave');
