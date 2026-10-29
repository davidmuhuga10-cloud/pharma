/**
 * nativeShell.js — runs ONLY inside the Pharma Android app (a Capacitor 8
 * WebView shell whose server.url is https://pharmacymngt.netlify.app — see
 * capacitor.config.json and android/). In a normal browser window.Capacitor
 * doesn't exist and this file returns on its first line, so the website is
 * untouched by everything below.
 *
 * Loaded in <head> of index.html (before style.css and app.js) so the layout
 * fix in step 1 happens before anything is drawn.
 *
 * What it does:
 *  1. Layout: the page runs edge-to-edge (viewport-fit=cover) and style.css
 *     pads the top bar by the status-bar height (safe-area-inset-top), so the
 *     green bar is never hidden under the clock and battery.
 *  2. Status bar: light icons on Pharma green.
 *  3. Printing: receipts and reports call window.print(), which does nothing
 *     in an Android WebView. Here it sends the page to Android's print
 *     service (Printer plugin), which applies the same print styles as a
 *     browser — only the document (#printArea) is printed, and "Save as PDF"
 *     is one of the printer choices.
 *  4. Back button: closes an open pop-up first, then an open sheet, then the menu drawer; on any
 *     screen other than Home it goes to Home; otherwise the app goes to the
 *     background like any Android app.
 *  5. Splash: hidden as soon as the page has loaded (and after 8s at most).
 */
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  var P = C.Plugins || {};
  var BRAND = '#0F5132';
  var noop = function () {};
  var later = function (p) { if (p && typeof p.then === 'function') p.then(noop, noop); };
  document.documentElement.classList.add('native-app');

  /* ------------------------------------------------------- 1. layout --- */
  // Nothing to do here on purpose. The app runs edge-to-edge (viewport-fit=cover
  // stays as the page asks) and style.css pads the green top bar, the menu and
  // the sign-in screen by env(safe-area-inset-top), so nothing sits under the
  // clock and battery. Older WebViews pad the page natively and report 0 for
  // the inset, so there is never a double gap. (Switching the viewport to
  // viewport-fit=auto at run time is not honoured by newer WebViews.)

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
