// js/main.js - Runs the app. Must stay the LAST script loaded.
// (One of the files app.js was split into. All of them share one global scope, so
// order in index.html matters: see the list there.)
init();

// Keep an app that stays open for days up to date. Without this, a phone that never closes
// Pharma keeps running the code it loaded last week (that is how an old browser pop-up that
// says "pharmacymngt.netlify.app says" could still appear after it had been replaced).
// When a new version has been downloaded the page reloads itself, but only at a safe moment:
// nothing in the cart, no pop-up or sheet open, and nobody typing.
(function () {
  if (!('serviceWorker' in navigator)) return;
  var hadController = !!navigator.serviceWorker.controller, updated = false, timer = null;
  function safeToReload() {
    var a = document.activeElement;
    return !(STATE.cart && STATE.cart.length) && !document.querySelector('.mask, .dlg-mask') &&
      !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function tryReload() { if (updated && safeToReload()) location.reload(); }
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }   // the very first install is not an update
    updated = true; tryReload();
    if (!timer) timer = setInterval(tryReload, 15000);
  });
  // Coming back to the app (from another app or a locked screen): look for a new version now.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
    tryReload();
  });
})();
