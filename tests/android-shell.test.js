// The Android shell's settings must agree with each other. The package name
// lives in five places; if one drifts the app builds but won't install or
// update. Also guards: one permission only (INTERNET), backups off, the root
// capacitor.config.json identical to the copy inside android/, and no leftover
// Kodi names from the project it was copied from.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = 'android/app/src/main/';
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log('FAIL ' + msg); bad++; } };

const cfg = JSON.parse(read('capacitor.config.json'));
const appId = cfg.appId;
check(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(appId), 'appId "' + appId + '" is not a valid package name');
check(read('capacitor.config.json') === read(main + 'assets/capacitor.config.json'), 'capacitor.config.json differs from android/app/src/main/assets/capacitor.config.json (run: npx cap sync android)');
check(cfg.appName === 'Pharma', 'appName should be "Pharma"');
check(cfg.server && cfg.server.url === 'https://pharmacymngt.netlify.app', 'server.url should be the live site');
check(cfg.server && cfg.server.cleartext === false, 'server.cleartext must be false');

const gradle = read('android/app/build.gradle');
check(gradle.includes('namespace = "' + appId + '"'), 'build.gradle namespace does not match appId');
check(gradle.includes('applicationId "' + appId + '"'), 'build.gradle applicationId does not match appId');
const vc = gradle.match(/versionCode\s+(\d+)/);
check(vc && +vc[1] >= 1, 'build.gradle needs an integer versionCode of at least 1');
const strings = read(main + 'res/values/strings.xml');
check(strings.includes('<string name="package_name">' + appId + '</string>'), 'strings.xml package_name does not match appId');
check(strings.includes('<string name="custom_url_scheme">' + appId + '</string>'), 'strings.xml custom_url_scheme does not match appId');
check(strings.includes('<string name="app_name">Pharma</string>'), 'strings.xml app_name should be Pharma');
const javaPath = main + 'java/' + appId.split('.').join('/') + '/MainActivity.java';
check(fs.existsSync(path.join(ROOT, javaPath)), 'MainActivity.java is not in the folder for ' + appId);
if (fs.existsSync(path.join(ROOT, javaPath))) check(read(javaPath).includes('package ' + appId + ';'), 'MainActivity.java package line does not match appId');

const manifest = read(main + 'AndroidManifest.xml');
const perms = (manifest.match(/<uses-permission[^>]*android:name="([^"]+)"/g) || []).map(s => s.match(/name="([^"]+)"/)[1]);
check(perms.length === 1 && perms[0] === 'android.permission.INTERNET', 'the only permission allowed is INTERNET, found: ' + perms.join(', '));
check(manifest.includes('android:allowBackup="false"'), 'allowBackup must be false');

// leftovers from the project this shell was copied from
for (const f of ['capacitor.config.json', 'android/app/build.gradle', main + 'AndroidManifest.xml', main + 'res/values/strings.xml', main + 'res/values/styles.xml', main + 'res/values/colors.xml', 'nativeShell.js', 'www/error.html', main + 'assets/public/error.html', 'android/ANDROID_APP.md']) {
  check(!/kodi/i.test(read(f)), f + ' still mentions Kodi');
}
// every launcher density has all three images
for (const d of ['ldpi', 'mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'])
  for (const n of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground'])
    check(fs.existsSync(path.join(ROOT, main + 'res/mipmap-' + d + '/' + n + '.png')), 'missing mipmap-' + d + '/' + n + '.png');
check(fs.existsSync(path.join(ROOT, main + 'res/drawable/splash.png')), 'missing drawable/splash.png');
check(read('www/error.html') === read(main + 'assets/public/error.html'), 'www/error.html differs from the copy in android assets');
check(/<script src="nativeShell\.js"( defer)?><\/script>/.test(read('index.html')), 'index.html must load nativeShell.js');
check(/'\.\/nativeShell\.js'/.test(read('sw.js')), 'sw.js SHELL_FILES must list ./nativeShell.js');

if (bad) process.exit(1);
console.log('PASS android shell: settings agree for ' + appId);
