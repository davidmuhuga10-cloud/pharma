/*
 * install.js - the "Install Pharma" popup.
 *
 * Shows a small card as soon as someone opens the site in a browser that can
 * install it, so they add Pharma to their phone or computer as a real app. This
 * is a web-app install (no APK, so no "unknown sources" warning).
 *
 *  - Phones and tablets only: nothing is shown on a computer.
 *  - Android (Chrome, Edge, Samsung Internet, Opera): the browser
 *    says "this site can be installed" (beforeinstallprompt); the button installs
 *    in one tap.
 *  - iPhone and iPad: Apple has no one-tap install, so the card shows the two
 *    steps (Share, then Add to Home Screen).
 *  - Inside WhatsApp, Facebook, Instagram, TikTok and similar in-app browsers
 *    nothing can be installed, so on Android the card offers "Open in Chrome" and
 *    on iPhone it says to open the link in Safari.
 *  - Other Android browsers that never announce install (Firefox): after a few
 *    seconds the card shows the menu steps.
 *  - Never shown inside the installed app, the Android app, or after "Not now"
 *    (hidden for 3 days).
 *
 * Self-contained: no other file is needed and it touches nothing else.
 */
(function () {
  'use strict';

  var KEY = 'pharma_install_dismissed';
  var HIDE_DAYS = 3;
  var ua = navigator.userAgent || '';
  var deferred = null;   // the browser's install prompt, once it announces one
  var card = null;
  var finished = false;  // installed or dismissed: never show again this visit

  // ---- Already installed, or inside the Android app: nothing to offer. ----
  function isInstalledApp() {
    try {
      if (window.matchMedia && (matchMedia('(display-mode: standalone)').matches ||
          matchMedia('(display-mode: fullscreen)').matches ||
          matchMedia('(display-mode: minimal-ui)').matches)) return true;
    } catch (e) {}
    if (navigator.standalone === true) return true;
    if (document.referrer && document.referrer.indexOf('android-app://') === 0) return true;
    var C = window.Capacitor;
    if (C && C.isNativePlatform && C.isNativePlatform()) return true;
    return false;
  }
  if (isInstalledApp()) return;

  // ---- "Not now" is remembered (storage can be blocked, so always guarded). ----
  function recentlyDismissed() {
    try {
      var t = parseInt(localStorage.getItem(KEY) || '0', 10);
      return t && (Date.now() - t) < HIDE_DAYS * 86400000;
    } catch (e) { return false; }
  }
  function rememberDismissed() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
  }
  if (recentlyDismissed()) return;

  // ---- What kind of visitor is this? ----
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isAndroid = /android/i.test(ua);
  var inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|Twitter|MicroMessenger|TikTok|musical_ly|Pinterest|LinkedInApp|WhatsApp|GSA\//i.test(ua) ||
              (isAndroid && /; wv\)/.test(ua));
  // iOS: only Safari-engine browsers can "Add to Home Screen"; in-app ones cannot.
  var iosSafariLike = isIOS && !inApp;
  // Phones and tablets only. On a computer people just use the website, so no popup.
  if (!isIOS && !isAndroid) return;

  // ---- The card ----
  function addStyle() {
    var s = document.createElement('style');
    s.textContent =
      '#pxScrim{position:fixed;inset:0;z-index:100000;background:rgba(14,22,19,.5);display:flex;align-items:flex-end;justify-content:center;' +
      'padding:0 12px calc(14px + env(safe-area-inset-bottom));box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'animation:pxIn .22s ease-out}' +
      '@keyframes pxIn{from{opacity:0}to{opacity:1}}' +
      '#pxCard{width:100%;max-width:360px;background:#fff;border:2px solid #D32F2F;border-radius:14px;padding:14px;box-sizing:border-box;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.35);color:#1B1B1B}' +
      '#pxHead{display:flex;align-items:center;gap:11px;margin-bottom:12px}' +
      '#pxHead img{width:40px;height:40px;border-radius:10px;flex:none}' +
      '#pxTitle{font-size:16px;font-weight:700;line-height:1.25;color:#1B1B1B}' +
      '#pxNote{font-size:13px;line-height:1.5;color:#1B1B1B;margin:0 0 12px}' +
      '.pxBtn{display:block;width:100%;border:0;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;box-sizing:border-box}' +
      '#pxYes{background:#0F5132;color:#fff}' +
      '#pxNo{background:#E8F3EC;color:#0F5132;margin-top:8px}' +
      '.pxBtn:active{opacity:.85}';
    document.head.appendChild(s);
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // mode: 'install' (one tap) | 'ios' | 'chrome' (open in Chrome) | 'safari' | 'menu'
  function show(mode) {
    if (card || finished) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { show(mode); }); return; }
    addStyle();
    var note = '', yes = '', yesAttrs = '';
    if (mode === 'ios') { note = 'Tap the Share button, then "Add to Home Screen".'; yes = 'Got it'; }
    else if (mode === 'safari') { note = 'Open this page in Safari, then tap Share and "Add to Home Screen".'; yes = 'Got it'; }
    else if (mode === 'menu') { note = 'Tap the menu (three dots), then "Install app" or "Add to Home screen".'; yes = 'Got it'; }
    else if (mode === 'chrome') {
      note = 'Open this page in Chrome to install the app.'; yes = 'Open in Chrome';
      var u = location.href.replace(/^https?:\/\//, '');
      yesAttrs = ' href="intent://' + esc(u) + '#Intent;scheme=' + (location.protocol === 'http:' ? 'http' : 'https') +
                 ';package=com.android.chrome;end"';
    } else { yes = 'Install app'; }
    var yesTag = yesAttrs ? 'a' : 'button';
    var scrim = document.createElement('div');
    scrim.id = 'pxScrim';
    scrim.innerHTML =
      '<div id="pxCard" role="dialog" aria-modal="true" aria-labelledby="pxTitle">' +
        '<div id="pxHead"><img src="icons/icon-192.png" alt=""><div id="pxTitle">Install Pharma</div></div>' +
        (note ? '<p id="pxNote">' + note + '</p>' : '') +
        '<' + yesTag + ' class="pxBtn" id="pxYes"' + yesAttrs + '>' + yes + '</' + yesTag + '>' +
        (mode === 'install' || mode === 'chrome' || mode === 'safari' || mode === 'menu' || mode === 'ios'
          ? '<button class="pxBtn" id="pxNo" type="button">Not now</button>' : '') +
      '</div>';
    document.body.appendChild(scrim);
    card = scrim;

    document.getElementById('pxNo').onclick = function () { rememberDismissed(); close(); };
    scrim.addEventListener('click', function (e) { if (e.target === scrim) { rememberDismissed(); close(); } });
    document.addEventListener('keydown', function esc2(e) {
      if (e.key === 'Escape' && card) { rememberDismissed(); close(); document.removeEventListener('keydown', esc2); }
    });
    document.getElementById('pxYes').onclick = function () {
      if (mode === 'install') { runInstall(); return; }
      if (mode === 'chrome') { rememberDismissed(); return; } // the link itself opens Chrome
      rememberDismissed(); close();                           // "Got it": the steps were read
    };
  }

  function close() {
    finished = true;
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  // One-tap install through the browser's own prompt.
  function runInstall() {
    if (!deferred) { close(); return; }
    var p = deferred; deferred = null;
    try {
      p.prompt();
      p.userChoice.then(function (r) {
        if (r && r.outcome === 'accepted') close();
        else { rememberDismissed(); close(); }
      }, close);
    } catch (e) { close(); }
  }

  // ---- Wire it up. The browser announces "installable" once the page has loaded. ----
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();       // we show our own card instead of the browser's mini-bar
    deferred = e;
    show('install');
  });
  window.addEventListener('appinstalled', function () { rememberDismissed(); close(); });

  function startFallbacks() {
    if (finished || card) return;
    if (isIOS) { show(iosSafariLike ? 'ios' : 'safari'); return; }
    if (isAndroid && inApp) { show('chrome'); return; }
    // Android browser that is not Chromium-based never announces install (e.g. Firefox).
    if (isAndroid && /Firefox/i.test(ua)) {
      setTimeout(function () { if (!card && !deferred && !finished) show('menu'); }, 3500);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startFallbacks);
  else startFallbacks();
})();
