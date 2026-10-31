/*
 * install.js - the "Install Pharma" bar and popup.
 *
 * Two pieces, both for phones and tablets only (nothing is shown on a computer):
 *
 *  1. A slim bar fixed to the top of the sign-in pages: "Install Pharma app  [Install]".
 *     It stays until Pharma is installed, even after "Not now". Tapping it installs.
 *  2. A popup card shown as soon as the browser says the site can be installed.
 *     "Not now" hides the popup for 3 days (the bar stays).
 *
 * What a tap does:
 *  - Android Chrome, Edge, Samsung Internet, Opera: the browser's own install
 *    prompt (beforeinstallprompt). After you accept, the card says "Installing"
 *    and waits for the browser to finish. If nothing has finished after 30
 *    seconds (it sometimes stalls) the card closes and the bar goes back to
 *    "Install", so one more tap tries again.
 *  - Android, browser has not offered install yet: the menu steps.
 *  - iPhone and iPad: Apple has no one-tap install, so the two steps (Share, then
 *    Add to Home Screen).
 *  - Inside WhatsApp, Facebook, Instagram, TikTok and similar in-app browsers
 *    nothing can be installed: "Open in Chrome" on Android, "open in Safari" on iPhone.
 *  - Never shown inside the installed app or the Android app.
 *
 * Self-contained: no other file is needed and it touches nothing else. It only
 * looks for the sign-in screen (an element with class auth-wrap) to decide
 * whether to show the bar.
 */
(function () {
  'use strict';

  var KEY = 'pharma_install_dismissed';   // "Not now" for the popup (time stamp)
  var KEY_DONE = 'pharma_installed';      // set when the browser reports the install finished
  var HIDE_DAYS = 3;
  var SLOW_MS = 30000;                    // how long to wait for "installing" before letting the person try again
  var ua = navigator.userAgent || '';

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

  // ---- What kind of visitor is this? ----
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isAndroid = /android/i.test(ua);
  var inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|Twitter|MicroMessenger|TikTok|musical_ly|Pinterest|LinkedInApp|WhatsApp|GSA\//i.test(ua) ||
              (isAndroid && /; wv\)/.test(ua));
  // iOS: only Safari-engine browsers can "Add to Home Screen"; in-app ones cannot.
  var iosSafariLike = isIOS && !inApp;
  // Phones and tablets only. On a computer people just use the website, so nothing is shown.
  if (!isIOS && !isAndroid) return;

  // ---- Remembered choices (storage can be blocked, so always guarded). ----
  function recentlyDismissed() {
    try {
      var t = parseInt(localStorage.getItem(KEY) || '0', 10);
      return !!t && (Date.now() - t) < HIDE_DAYS * 86400000;
    } catch (e) { return false; }
  }
  function rememberDismissed() {
    popupAllowed = false;
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
  }
  function readInstalledFlag() {
    try { return !!localStorage.getItem(KEY_DONE); } catch (e) { return false; }
  }
  function setInstalledFlag(on) {
    try { if (on) localStorage.setItem(KEY_DONE, '1'); else localStorage.removeItem(KEY_DONE); } catch (e) {}
  }

  var deferred = null;                    // the browser's install prompt, once it announces one
  var card = null, bar = null;
  var installing = false;                 // accepted, waiting for the browser to finish
  var installed = readInstalledFlag();    // finished earlier on this phone
  var popupAllowed = !recentlyDismissed();
  var slowTimer = null, doneTimer = null, styled = false;

  // ---- Look ----
  function addStyle() {
    if (styled) return; styled = true;
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
      '.pxBtn:active{opacity:.85}' +
      '.pxSpin{display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;vertical-align:-2px;margin-right:7px;animation:pxSpin .8s linear infinite}' +
      '@keyframes pxSpin{to{transform:rotate(360deg)}}' +
      '#pxBar{position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;gap:9px;box-sizing:border-box;' +
      'height:calc(44px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 10px 0;background:#fff;border-bottom:2px solid #D32F2F;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1B1B1B}' +
      '#pxBar img{width:26px;height:26px;border-radius:7px;flex:none}' +
      '#pxBarTxt{flex:1;font-size:14px;font-weight:700;line-height:1.2;min-width:0}' +
      '#pxBarBtn{flex:none;border:0;border-radius:8px;background:#0F5132;color:#fff;font:inherit;font-size:13px;font-weight:700;padding:7px 16px;cursor:pointer}' +
      '#pxBarBtn:active{opacity:.85}';
    document.head.appendChild(s);
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---- The card. mode: install | installing | done | ios | safari | chrome | menu ----
  function openCard(mode) {
    if (installed && mode !== 'done') return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { openCard(mode); }); return; }
    closeCard();
    addStyle();
    var title = 'Install Pharma', note = '', yes = '', yesAttrs = '', no = '';
    if (mode === 'ios') { note = 'Tap the Share button, then "Add to Home Screen".'; yes = 'Got it'; no = 'Not now'; }
    else if (mode === 'safari') { note = 'Open this page in Safari, then tap Share and "Add to Home Screen".'; yes = 'Got it'; no = 'Not now'; }
    else if (mode === 'menu') { note = 'Tap the menu (three dots), then "Install app" or "Add to Home screen".'; yes = 'Got it'; no = 'Not now'; }
    else if (mode === 'chrome') {
      note = 'Open this page in Chrome to install the app.'; yes = 'Open in Chrome'; no = 'Not now';
      var u = location.href.replace(/^https?:\/\//, '');
      yesAttrs = ' href="intent://' + esc(u) + '#Intent;scheme=' + (location.protocol === 'http:' ? 'http' : 'https') +
                 ';package=com.android.chrome;end"';
    }
    else if (mode === 'installing') {
      title = 'Installing Pharma'; note = 'This can take up to a minute. Keep this page open.';
      yes = '<span class="pxSpin"></span>Installing…';
    }
    else if (mode === 'done') {
      title = 'Pharma is installed'; note = 'Open Pharma from your home screen.'; yes = 'Done';
    }
    else { yes = 'Install app'; no = 'Not now'; }

    var yesTag = yesAttrs ? 'a' : 'button';
    var scrim = document.createElement('div');
    scrim.id = 'pxScrim';
    scrim.setAttribute('data-mode', mode);
    scrim.innerHTML =
      '<div id="pxCard" role="dialog" aria-modal="true" aria-labelledby="pxTitle">' +
        '<div id="pxHead"><img src="icons/icon-192.png" alt=""><div id="pxTitle">' + title + '</div></div>' +
        (note ? '<p id="pxNote">' + note + '</p>' : '') +
        '<' + yesTag + ' class="pxBtn" id="pxYes"' + yesAttrs + (mode === 'installing' ? ' disabled' : '') + '>' + yes + '</' + yesTag + '>' +
        (no ? '<button class="pxBtn" id="pxNo" type="button">' + no + '</button>' : '') +
      '</div>';
    document.body.appendChild(scrim);
    card = scrim;

    var quiet = (mode === 'installing' || mode === 'done');   // closing these is not a "Not now"
    var noBtn = document.getElementById('pxNo');
    if (noBtn) noBtn.onclick = function () { rememberDismissed(); closeCard(); };
    scrim.addEventListener('click', function (e) {
      if (e.target !== scrim) return;
      if (!quiet) rememberDismissed();
      closeCard();
    });
    document.getElementById('pxYes').onclick = function () {
      if (mode === 'install') { onInstallTap(); return; }
      if (mode === 'installing') return;
      if (mode === 'chrome') { rememberDismissed(); return; }   // the link itself opens Chrome
      if (mode === 'done') { closeCard(); return; }
      rememberDismissed(); closeCard();                         // "Got it": the steps were read
    };
  }

  function closeCard() {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !card) return;
    var m = card.getAttribute('data-mode');
    if (m !== 'installing' && m !== 'done') rememberDismissed();
    closeCard();
  });

  // ---- The bar on the sign-in pages ----
  function onAuthScreen() { return !!document.querySelector('.auth-wrap'); }

  function updateBar() {
    var want = !installed && document.body && onAuthScreen();
    if (!want) {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      bar = null; return;
    }
    if (!bar) {
      addStyle();
      bar = document.createElement('div');
      bar.id = 'pxBar';
      bar.innerHTML = '<img src="icons/icon-192.png" alt=""><div id="pxBarTxt"></div><button id="pxBarBtn" type="button"></button>';
      document.body.appendChild(bar);
      bar.onclick = function () { onInstallTap(); };
    }
    document.getElementById('pxBarTxt').textContent = installing ? 'Installing…' : 'Install Pharma app';
    var b = document.getElementById('pxBarBtn');
    b.textContent = installing ? 'Wait' : 'Install';
    b.style.opacity = installing ? '.6' : '';
  }

  // ---- What a tap on Install does ----
  function onInstallTap() {
    if (installing) { openCard('installing'); return; }
    if (deferred) { startNativeInstall(); return; }
    if (isIOS) { openCard(iosSafariLike ? 'ios' : 'safari'); return; }
    if (inApp) { openCard('chrome'); return; }
    openCard('menu');                       // Android browser that has not offered install (yet)
  }

  // One tap install through the browser's own prompt, then wait for it to finish.
  function startNativeInstall() {
    var p = deferred; deferred = null;
    closeCard();
    try {
      p.prompt();
      p.userChoice.then(function (r) {
        if (r && r.outcome === 'accepted') {
          installing = true; updateBar(); openCard('installing');
          clearTimeout(slowTimer);
          slowTimer = setTimeout(function () {
            if (installed || !installing) return;
            installing = false; closeCard(); updateBar();   // stalled: let the person tap Install again
          }, SLOW_MS);
        } else {
          rememberDismissed(); closeCard(); updateBar();
        }
      }, function () { closeCard(); openCard('menu'); });
    } catch (e) { openCard('menu'); }
  }

  // ---- Wire it up. The browser announces "installable" once the page has loaded. ----
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();                     // we show our own card instead of the browser's mini-bar
    deferred = e;
    if (installed) { installed = false; setInstalledFlag(false); } // it can be installed again, so it was removed
    updateBar();
    if (popupAllowed && !installing && !card) openCard('install');
  });

  window.addEventListener('appinstalled', function () {
    installed = true; installing = false; deferred = null;
    clearTimeout(slowTimer);
    setInstalledFlag(true);
    rememberDismissed();
    updateBar();
    if (card) {
      openCard('done');
      clearTimeout(doneTimer);
      doneTimer = setTimeout(closeCard, 4000);
    }
  });

  function start() {
    updateBar();
    setInterval(updateBar, 800);            // the sign-in screens are drawn by the app; follow them
    if (installed || !popupAllowed) return;
    if (isIOS) { openCard(iosSafariLike ? 'ios' : 'safari'); return; }
    if (isAndroid && inApp) { openCard('chrome'); return; }
    // Android browser that is not Chromium-based never announces install (e.g. Firefox).
    if (isAndroid && /Firefox/i.test(ua)) {
      setTimeout(function () { if (!card && !deferred && !installed && popupAllowed) openCard('menu'); }, 3500);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
