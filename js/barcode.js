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
    '<div class="tiny" style="margin:10px 0">Point the camera at the barcode.</div>' +
    '<button class="btn ghost block" onclick="bcStopScan();closeSheet()">Cancel</button>';
  try {
    bcStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    bcStopScan();
    closeSheet();
    toast('Could not open the camera. Check the browser has camera permission, or type the barcode in instead.', 'bad');
    return;
  }
  var video = $('#bcVideo');
  if (!video || !document.body.contains(video)) { bcStopScan(); return; } // the sheet was closed while the camera was opening
  video.srcObject = bcStream;
  try { bcDetector = new BarcodeDetector(); } catch (e) {
    try { bcDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] }); }
    catch (e2) { bcStopScan(); closeSheet(); toast('This browser cannot read barcodes. Type the barcode in instead.', 'bad'); return; }
  }
  bcLoopActive = true;
  bcScanLoop(video);
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
