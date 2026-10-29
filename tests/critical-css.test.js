// The loading screen is drawn from index.html before style.css arrives, so
// index.html carries its own copy of the loading-screen styles. If that copy
// and the "critical" block in style.css ever differ, the screen would visibly
// change the moment style.css loads. This fails when they differ, and when the
// markup in index.html differs from loadScreenHtml() in app.js.
// Run from the project folder: node tests/critical-css.test.js
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };

const html = read('index.html'), css = read('style.css'), js = read('app.js');
const inline = (html.match(/<style id="critical">([\s\S]*?)<\/style>/) || [])[1];
check(!!inline, 'index.html has <style id="critical">');
const block = (css.match(/\/\* critical:start[\s\S]*?\/\* critical:end \*\//) || [])[0];
check(!!block, 'style.css has the critical:start/end block');
if (inline && block) check(inline.trim() === block.trim(), 'inline critical CSS is identical to the block in style.css');

const markup = (html.match(/<div id="app">([\s\S]*?)<\/div>\s*<div id="printArea"/) || [])[1];
const fn = (js.match(/function loadScreenHtml\(\) \{\s*return '([\s\S]*?)';\s*\}/) || [])[1];
check(!!markup && !!fn, 'found the loading screen markup in index.html and loadScreenHtml() in app.js');
if (markup && fn) check(markup.trim() === fn.replace(/\\'/g, "'").trim(), 'index.html loading markup is identical to loadScreenHtml()');

// the loading screen must stay light on requests: no images, no external fonts
check(!/<img|url\(|@import/.test(inline || ''), 'critical CSS makes no extra requests');
if (failed) process.exit(1);
console.log('PASS critical css: loading screen styles and markup match everywhere');
