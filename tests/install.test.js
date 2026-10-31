// The "Install Pharma" popup and the install details that make the website
// look like the Android app. Run from the project folder: node tests/install.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const html = read('index.html'), sw = read('sw.js'), man = JSON.parse(read('manifest.json'));
check(/<script src="install\.js"><\/script>/.test(html), 'index.html loads install.js');
check(sw.includes("'./install.js'"), 'sw.js pre-caches install.js');
try { new vm.Script(read('install.js'), { filename: 'install.js' }); } catch (e) { check(false, 'install.js parses: ' + e.message); }
// The fixed "Install Pharma app" bar on the sign-in pages, and the install progress
const ij = read('install.js');
check(ij.includes("id = 'pxBar'") && ij.includes('.auth-wrap'), 'install.js draws the bar on the sign-in screen (.auth-wrap)');
check(ij.includes("'installing'") && ij.includes('SLOW_MS'), 'install.js shows "Installing" and lets the person retry if it stalls');
check(/HIDE_DAYS = 3/.test(ij) && /if \(!isIOS && !isAndroid\) return;/.test(ij), 'popup hides for 3 days and is phones/tablets only');
check(!/'slow'/.test(ij), 'no third "Taking long?" screen');
check(html.includes('class="auth-wrap"') || read('js/auth.js').includes('auth-wrap'), 'the sign-in markup still uses .auth-wrap');
// Chrome only offers install when these are all present
check(man.display === 'standalone', 'manifest display is standalone');
check(man.start_url && man.name && man.short_name, 'manifest has name and start_url');
check(man.icons.some(i => i.sizes === '192x192') && man.icons.some(i => i.sizes === '512x512'), 'manifest has 192 and 512 icons');
check(/addEventListener\('fetch'/.test(sw), 'service worker has a fetch handler');
// Same green as the Android app (capacitor.config.json splash and status bar)
const cap = JSON.parse(read('capacitor.config.json'));
check(man.theme_color.toLowerCase() === cap.plugins.StatusBar.backgroundColor.toLowerCase(), 'manifest theme_color matches the Android status bar');
check(man.background_color.toLowerCase() === cap.plugins.SplashScreen.backgroundColor.toLowerCase(), 'manifest background_color matches the Android splash');
check(/rel="apple-touch-icon"/.test(html) && /apple-mobile-web-app-capable/.test(html), 'index.html has the iPhone home-screen tags');
if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('PASS install: popup and bar wired in, installable manifest, matches the Android app colours');
