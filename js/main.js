// js/main.js - starts the app. Must stay the LAST script loaded.
init();

// Keep an app that stays open for days up to date. Otherwise a phone that never
// closes Pharma keeps running last week's code. When a new version has
// downloaded, the page reloads itself, but only at a safe moment: empty cart,
// no pop-up or sheet open, nobody typing.
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
    if (!hadController) { hadController = true; return; }  // the very first install is not an update
    updated = true; tryReload();
    if (!timer) timer = setInterval(tryReload, 15000);
  });
  // Coming back to the app: check for a new version now.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
    tryReload();
  });
})();
