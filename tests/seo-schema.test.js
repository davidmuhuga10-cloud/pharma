// index.html carries a SoftwareApplication JSON-LD block so Google can show price
// and category in results. Kept by hand in sync with the <meta> tags above it;
// this only checks it is present and parses as JSON.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
check(!!m, 'index.html has a JSON-LD <script> block');
if (m) {
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { check(false, 'the JSON-LD block is valid JSON: ' + e.message); }
  if (data) {
    check(data['@type'] === 'SoftwareApplication', 'the block describes a SoftwareApplication');
    check(data.url === 'https://pharmamanagement.site/', 'the url matches the canonical link');
    check(data.offers && data.offers.price === '0', 'the offer shows the free trial');
  }
}
console.log(failed ? failed + ' seo-schema checks failed' : 'PASS seo-schema: index.html has a valid SoftwareApplication block');
process.exit(failed ? 1 : 0);
