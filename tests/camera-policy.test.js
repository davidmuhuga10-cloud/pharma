// The camera must be ALLOWED to ask, or Scan barcode can never show the "Allow camera?" prompt.
//
// WHY THIS TEST EXISTS
// Until 11 Nov 2026 the site sent `Permissions-Policy: camera=()`, which tells the browser
// "no page on this site may ever use the camera". The browser then refuses getUserMedia()
// at once and shows NO prompt, so tapping Scan barcode just flashed an error telling the
// person to "check the browser has camera permission" - when there was nothing for them to
// check or click. Every other app (Google Meet etc.) shows an Allow/Block prompt because its
// site permits the camera. The same was true of the Android app, whose manifest never
// declared the CAMERA permission.
//
// camera=(self) allows the camera for Pharma's OWN pages only. Microphone, location,
// payment and USB stay blocked, and no embedded third-party page can use the camera.
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
var fail = 0;
function check(ok, msg) { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; }

var headers = fs.readFileSync(path.join(root, '_headers'), 'utf8');
var policy = (headers.match(/^\s*Permissions-Policy:\s*(.+)$/m) || [])[1] || '';
check(policy !== '', '_headers sets a Permissions-Policy');
check(/(^|[\s,])camera=\(self\)/.test(policy), 'the camera is allowed for Pharma\'s own pages: camera=(self)');
check(!/camera=\(\)/.test(policy), 'the camera is NOT blocked outright (camera=() makes the browser skip its Allow prompt)');
check(!/camera=\*/.test(policy), 'the camera is not opened to every embedded site (camera=* would be too wide)');
['microphone', 'geolocation', 'payment', 'usb'].forEach(function (f) {
  check(new RegExp(f + '=\\(\\)').test(policy), f + ' is still blocked');
});

var manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  var manifest = fs.readFileSync(manifestPath, 'utf8');
  check(/<uses-permission android:name="android\.permission\.CAMERA"\s*\/>/.test(manifest),
    'the Android app declares the CAMERA permission, so Android can ask for it');
  check(/android\.hardware\.camera"[^>]*android:required="false"/.test(manifest),
    'a camera is not REQUIRED to install the app (typing the barcode in still works without one)');
} else {
  console.log('skip android manifest checks: android/ folder not present here');
}

process.exit(fail ? 1 : 0);
