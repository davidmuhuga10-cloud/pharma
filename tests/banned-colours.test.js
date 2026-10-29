// Project rule: NO gray text anywhere. Text uses only the palette's text colours
// (--ink / --ink-soft #201E1B, white on green, the green/amber/red inks).
// This scans the app's CSS, JS and HTML for
//   1. the known retired grays (#8A837C, #6B6560), anywhere, and
//   2. any `color:` (text colour, not background/border) that is a mid-gray
//      hex or rgb() value: low saturation and mid lightness.
// Backgrounds, borders and shadows may stay neutral; only text is policed.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const FILES = ['style.css', 'admin.css', 'admin.js', 'index.html', 'admin.html', 'nativeShell.js', 'www/index.html', 'www/error.html'];
// The app's code lives in js/ (split out of the old app.js)
fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).forEach(f => FILES.push('js/' + f));
const RETIRED = [{ hex: '8a837c', rgb: /138\s*,\s*131\s*,\s*124/ }, { hex: '6b6560', rgb: /107\s*,\s*101\s*,\s*96/ }];

function toRgb(v) {
  v = v.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return m[1].split('').map(c => parseInt(c + c, 16));
  m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}
// mid-gray: channels within 16 of each other, lightness between 30% and 80%
function isMidGray(rgb) {
  const max = Math.max(...rgb), min = Math.min(...rgb), l = (max + min) / 2 / 255;
  return max - min <= 16 && l >= 0.30 && l <= 0.80;
}
// a text `color:` declaration, not background-color / border-color / outline-color etc.
const COLOR_DECL = /(^|[^-\w])color\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g;

if (require.main === module) {
  let bad = 0;
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const b of RETIRED) if (t.toLowerCase().includes(b.hex) || b.rgb.test(t)) { console.log('FAIL retired gray #' + b.hex.toUpperCase() + ' in ' + f); bad++; }
    let m;
    while ((m = COLOR_DECL.exec(t))) {
      const rgb = toRgb(m[2]);
      if (rgb && isMidGray(rgb)) {
        const line = t.slice(0, m.index).split('\n').length;
        console.log('FAIL gray text colour ' + m[2] + ' at ' + f + ':' + line); bad++;
      }
    }
  }
  if (bad) process.exit(1);
  console.log('PASS banned colours: no gray text in ' + FILES.join(', '));
}
module.exports = { toRgb, isMidGray, COLOR_DECL };
