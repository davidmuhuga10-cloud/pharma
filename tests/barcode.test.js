// Barcode scanning via the browser's own camera API (BarcodeDetector). Nothing here talks to a
// real camera or a real device - the browser APIs it uses are small stand-ins. Run from the
// project folder:   node tests/barcode.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const src = read('js/barcode.js'), index = read('index.html'), sw = read('sw.js');

function makeCtx(nav, Detector) {
  var ctx = {
    console: console,
    toasts: [],
    toast: function (msg) { ctx.toasts.push(msg); },
    sheetOpened: false, sheetClosed: false, videoEl: null,
    icon: function () { return ''; },
    sheet: function (title) { ctx.sheetOpened = true; ctx.videoEl = { srcObject: null }; return { innerHTML: '' }; },
    closeSheet: function () { ctx.sheetClosed = true; },
    $: function (sel) { return sel === '#bcVideo' ? ctx.videoEl : null; },
    document: { body: { contains: function (el) { return el === ctx.videoEl; } } },
    navigator: nav || {},
    setTimeout: setTimeout
  };
  // a real browser never has a "BarcodeDetector" property that is simply undefined - it is
  // either there or (like most of them today) not on window at all, so the key itself, not
  // just its value, must be missing to stand in for "unsupported".
  if (Detector) ctx.BarcodeDetector = Detector;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

(async function () {
  // --- neither browser API is there: no "Scan" button anywhere should be offered ---
  var noneCtx = makeCtx(undefined, undefined);
  check(noneCtx.barcodeCameraSupported() === false, 'with neither the camera API nor BarcodeDetector, scanning is not offered');
  var noneCalled = false;
  await noneCtx.openBarcodeScan(function () { noneCalled = true; });
  check(!noneCalled && !noneCtx.sheetOpened && noneCtx.toasts.length === 1, 'calling it anyway just explains that typing the barcode in, or a USB scanner, still works');

  // --- only one of the two APIs exists: still not supported ---
  var halfCtx1 = makeCtx({ mediaDevices: { getUserMedia: function () { return Promise.resolve(); } } }, undefined);
  check(halfCtx1.barcodeCameraSupported() === false, 'a camera with no BarcodeDetector is not enough');
  var halfCtx2 = makeCtx({}, function () {}); // a real browser always has a navigator object, just maybe no camera API on it
  check(halfCtx2.barcodeCameraSupported() === false, 'a BarcodeDetector with no camera access is not enough');

  // --- supported, but the person declines the camera permission ---
  var deniedCtx = makeCtx(
    { mediaDevices: { getUserMedia: function () { return Promise.reject(new Error('NotAllowedError')); } } },
    function () {}
  );
  check(deniedCtx.barcodeCameraSupported() === true, 'with both APIs present, scanning is offered');
  var deniedCalled = false;
  await deniedCtx.openBarcodeScan(function () { deniedCalled = true; });
  check(!deniedCalled && deniedCtx.sheetClosed && /camera permission/i.test(deniedCtx.toasts[deniedCtx.toasts.length - 1]),
    'declining the camera closes the sheet itself and suggests typing the barcode in instead');

  // --- the message says what to DO, per kind of failure (a real DOMException has .name) ---
  async function failMessage(errName) {
    var c = makeCtx(
      { mediaDevices: { getUserMedia: function () { var e = new Error('x'); e.name = errName; return Promise.reject(e); } } },
      function () {}
    );
    await c.openBarcodeScan(function () {});
    return c.toasts[c.toasts.length - 1];
  }
  check(/padlock/i.test(await failMessage('NotAllowedError')) && /Allow/.test(await failMessage('NotAllowedError')),
    'a blocked camera tells the person where to switch it back on (padlock -> Camera -> Allow)');
  check(/No camera was found/i.test(await failMessage('NotFoundError')),
    'a device with no camera says so, instead of blaming permission');
  check(/another app/i.test(await failMessage('NotReadableError')),
    'a camera in use by another app says so');

  // --- the happy path: a code is read straight away ---
  var tracksStopped = 0;
  var FakeDetector = function () { this.detect = async function () { return [{ rawValue: ' 6009999988887 ' }]; }; };
  var happyCtx = makeCtx(
    { mediaDevices: { getUserMedia: function () { return Promise.resolve({ getTracks: function () { return [{ stop: function () { tracksStopped++; } }]; } }); } } },
    FakeDetector
  );
  var found = null;
  await happyCtx.openBarcodeScan(function (code) { found = code; });
  // the scan loop keeps running after openBarcodeScan itself returns - give it a tick to finish
  await new Promise(function (r) { setTimeout(r, 20); });
  check(found === '6009999988887', 'a code read by the camera is trimmed and handed to the caller');
  check(happyCtx.sheetClosed === true, 'the scan sheet closes itself once a code is found');
  check(tracksStopped === 1, 'the camera is released once a code is found, not left running');

  // --- the sheet is dismissed (the X button, or tapping outside) before anything is read ---
  var dismissStopped = 0;
  var SlowDetector = function () { this.detect = async function () { return []; }; };
  var dismissCtx = makeCtx(
    { mediaDevices: { getUserMedia: function () { return Promise.resolve({ getTracks: function () { return [{ stop: function () { dismissStopped++; } }]; } }); } } },
    SlowDetector
  );
  var dismissCalled = false;
  await dismissCtx.openBarcodeScan(function () { dismissCalled = true; });
  dismissCtx.videoEl = null; // the mask was removed from the page without going through Cancel
  await new Promise(function (r) { setTimeout(r, 300); });
  check(!dismissCalled, 'dismissing the sheet never calls back as if a code had been found');
  check(dismissStopped === 1, 'the camera is still released even when the sheet is dismissed another way');

  // --- wiring ---
  check(/js\/barcode\.js/.test(index) && /\.\/js\/barcode\.js/.test(sw), 'the script is loaded and kept offline');
  var scriptOrder = (index.match(/<script src="js\/([\w-]+)\.js">/g) || []).map(function (s) { return s.match(/js\/([\w-]+)\.js/)[1]; });
  check(scriptOrder.indexOf('barcode') === scriptOrder.indexOf('core') + 1, 'it loads right after core.js, before any screen that might use it');
  check(scriptOrder.indexOf('barcode') < scriptOrder.indexOf('main'), 'and well before main.js, which must stay last');
  check(!/vendor|cdn\.|unpkg|jsdelivr/i.test(src), 'camera scanning uses the browser\'s own API, nothing downloaded or vendored');

  if (failed) process.exit(1);
  console.log('barcode scanning: ok');
})();
