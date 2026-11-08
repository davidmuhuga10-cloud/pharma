// nativeShell.js - runs ONLY inside the Pharma Android app (a Capacitor 8
// WebView shell loading https://pharmamanagement.site; see
// capacitor.config.json and android/). In a normal browser window.Capacitor
// does not exist and this file returns on its first line.
// Loaded in <head> of index.html, before style.css, so the layout step runs
// before anything is drawn.
//
//  1. Layout: edge-to-edge page (viewport-fit=cover); style.css pads the top
//     bar by the status-bar height so it is not hidden under the clock.
//  2. Status bar: light icons on Pharma green.
//  3. Printing: window.print() does nothing in an Android WebView, so it sends
//     the page to Android's print service (Printer plugin) with the same print
//     styles; only #printArea is printed and "Save as PDF" is a choice.
//  4. Back button: closes a pop-up, then a sheet, then the menu drawer. On any
//     screen other than Home it goes Home; otherwise the app goes to the
//     background.
//  5. Splash: hidden once the page has loaded (after 8s at most).
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  var P = C.Plugins || {};
  var BRAND = '#0F5132';
  var noop = function () {};
  var later = function (p) { if (p && typeof p.then === 'function') p.then(noop, noop); };
  document.documentElement.classList.add('native-app');

  /* ------------------------------------------------------- 1. layout --- */
  // Nothing to do here on purpose. style.css pads the top bar, menu and sign-in
  // screen by env(safe-area-inset-top). Older WebViews pad the page natively and
  // report 0 for the inset, so there is never a double gap. (Changing
  // viewport-fit at run time is ignored by newer WebViews.)

  /* --------------------------------------------------- 2. status bar --- */
  if (P.StatusBar) {
    try {
      later(P.StatusBar.setBackgroundColor({ color: BRAND }));
      later(P.StatusBar.setStyle({ style: 'DARK' })); // DARK = light icons, for a dark bar
    } catch (e) { /* best-effort */ }
  }

  /* ----------------------------------------------------- 3. printing --- */
  if (P.Printer && P.Printer.printWebView) {
    window.print = function () {
      try { later(P.Printer.printWebView({ name: 'Pharma' })); } catch (e) { /* best-effort */ }
    };
  }

  /* -------------------------------------------------- 4. back button --- */
  if (P.App && P.App.addListener) {
    try {
      P.App.addListener('backButton', function () {
        if (document.querySelector('.dlg-mask')) { if (typeof window.closeDialog === 'function') window.closeDialog(); return; }
        var mask = document.querySelector('.mask');
        if (mask) { if (typeof window.closeSheet === 'function') window.closeSheet(); else mask.remove(); return; }
        if (document.body.classList.contains('nav-open')) {
          if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); else document.body.classList.remove('nav-open');
          return;
        }
        var st = window.STATE;
        if (st && st.profile && st.tab && st.tab !== 'dashboard' && typeof window.setTab === 'function') {
          try { window.setTab('dashboard'); return; } catch (e) { /* fall through */ }
        }
        later(P.App.minimizeApp());
      });
    } catch (e) { /* best-effort */ }
  }

  /* ------------------------------------------------------ 5. splash --- */
  if (P.SplashScreen) {
    var hide = function () { try { later(P.SplashScreen.hide()); } catch (e) { /* best-effort */ } };
    if (document.readyState === 'complete') hide();
    else window.addEventListener('load', hide);
    setTimeout(hide, 8000);
  }
})();
