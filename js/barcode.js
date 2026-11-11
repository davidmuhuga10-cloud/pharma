// js/barcode.js - scanning a drug's barcode with the camera.
//
// Uses the browser's own BarcodeDetector where the device has it (most Android
// Chrome, recent desktop Chrome) - nothing is downloaded or installed for it.
// Where a device does not support it, or declines camera access, the "Scan"
// button simply is not offered: typing the barcode by hand still works
// everywhere, and so does a USB barcode scanner (it just types the number very
// fast and presses Enter, like a fast typist using the keyboard).

function barcodeCameraSupported() {
  return (typeof window !== 'undefined') && ('BarcodeDetector' in window) &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

var bcStream = null;
var bcDetector = null;
var bcLoopActive = false;
var bcOnResult = null;

// Opens a camera sheet and calls onResult(code) once a barcode is read.
// Closing the sheet any way (Cancel, the X, tapping outside) stops the camera.
async function openBarcodeScan(onResult) {
  if (!barcodeCameraSupported()) {
    toast('Camera scanning is not available on this device or browser. Type the barcode in, or use a USB barcode scanner instead.', 'bad');
    return;
  }
  bcOnResult = onResult;
  var body = sheet('Scan barcode', '');
  body.innerHTML =
    '<div style="position:relative;background:#000;border-radius:10px;overflow:hidden">' +
    '<video id="bcVideo" playsinline autoplay muted style="width:100%;display:block"></video>' +
    '</div>' +
    '<div class="tiny" id="bcHint" style="margin:10px 0">Your phone or browser will ask to use the camera. Tap <b>Allow</b>.</div>' +
    '<button class="btn ghost block" onclick="bcStopScan();closeSheet()">Cancel</button>';
  try {
    // This is the call that makes the browser show its own "Allow camera?" prompt.
    // It only appears if the page is allowed to ask: the site's Permissions-Policy
    // header (_headers) must say camera=(self), and the Android app must declare the
    // CAMERA permission. If either is missing the browser refuses silently with no
    // prompt - which is exactly how this broke before 11 Nov 2026.
    bcStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    bcStopScan();
    closeSheet();
    toast(bcCameraErrorMessage(e), 'bad');
    return;
  }
  var video = $('#bcVideo');
  if (!video || !document.body.contains(video)) { bcStopScan(); return; } // the sheet was closed while the camera was opening
  var hint = $('#bcHint');
  if (hint) hint.textContent = 'Point the camera at the barcode.';
  video.srcObject = bcStream;
  try { bcDetector = new BarcodeDetector(); } catch (e) {
    try { bcDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] }); }
    catch (e2) { bcStopScan(); closeSheet(); toast('This browser cannot read barcodes. Type the barcode in instead.', 'bad'); return; }
  }
  bcLoopActive = true;
  bcScanLoop(video);
}

// Say what actually went wrong and what to do about it. A browser only shows its
// "Allow camera?" prompt the first time; after someone taps Block it never asks again,
// so the message has to tell them where to switch it back on.
function bcCameraErrorMessage(e) {
  var name = (e && e.name) || '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device. Type the barcode in instead.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is busy - another app may be using it. Close that app and try again, or type the barcode in.';
  }
  return 'Camera permission is off for Pharma. Tap the padlock next to the web address, set Camera to Allow, then scan again. Or type the barcode in.';
}

async function bcScanLoop(video) {
  while (bcLoopActive) {
    // The sheet may have been dismissed (X, tap outside) without going through
    // Cancel - stop here rather than keep the camera running unseen.
    if (!document.body.contains(video)) { bcStopScan(); return; }
    try {
      var codes = await bcDetector.detect(video);
      if (codes && codes.length) {
        var value = (codes[0].rawValue || '').trim();
        if (value) { bcFound(value); return; }
      }
    } catch (e) { /* a frame that could not be read yet; try the next one */ }
    await new Promise(function (r) { setTimeout(r, 200); });
  }
}

function bcFound(value) {
  var cb = bcOnResult;
  bcStopScan();
  closeSheet();
  if (cb) cb(value);
}

function bcStopScan() {
  bcLoopActive = false;
  bcDetector = null;
  if (bcStream) { bcStream.getTracks().forEach(function (t) { t.stop(); }); bcStream = null; }
  bcOnResult = null;
}
