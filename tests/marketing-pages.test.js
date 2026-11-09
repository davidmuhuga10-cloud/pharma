// New public pages: Terms of Service, Privacy Policy, Cookie Policy, Features,
// Pricing and the Blog (index + 3 starter posts). Checks that:
//   1. every page exists and has the basic SEO tags (title, description, canonical);
//   2. the legal pages name Flovo Digital and Kenya, and never mention a business
//      registration number or a physical/office address (the user was explicit
//      that neither may appear);
//   3. sitemap.xml and robots.txt both know about every new page.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const PAGES = [
  'features.html', 'pricing.html', 'blog.html',
  'blog-stock-batch-expiry.html', 'blog-mpesa-credit-sales.html', 'blog-stock-take.html',
  'terms.html', 'privacy.html', 'cookies.html'
];
const LEGAL_PAGES = ['terms.html', 'privacy.html', 'cookies.html'];

// 1. Every page exists and carries the basics ------------------------------
for (const f of PAGES) {
  const p = path.join(root, f);
  check(fs.existsSync(p), f + ' exists');
  if (!fs.existsSync(p)) continue;
  const html = read(f);
  check(/<title>[^<]+<\/title>/.test(html), f + ' has a <title>');
  check(/<meta name="description" content="[^"]+">/.test(html), f + ' has a meta description');
  check(html.includes('rel="canonical" href="https://pharmamanagement.site/' + f + '"'), f + ' has the right canonical link');
  check(html.includes('href="terms.html"') && html.includes('href="privacy.html"') && html.includes('href="cookies.html"'),
    f + ' footer links to all three legal pages');
}

// 2. Legal pages: who we are, and what must never appear --------------------
for (const f of LEGAL_PAGES) {
  const html = read(f);
  check(html.includes('Flovo Digital'), f + ' names Flovo Digital as the provider');
  check(/laws of Kenya|Kenya.s Data Protection Act|Data Protection Act, 2019/.test(html), f + ' references Kenyan law');
  check(html.includes('info@flovodigital.com') && html.includes('+254 705 041 512'),
    f + ' gives the real contact email and phone');
  // Never a business registration / KRA PIN for Flovo itself, and never Flovo's own office address.
  check(!/\bBRS\b|business registration number|registration no\.?\s*[:#]/i.test(html), f + ' never mentions a business registration number');
  check(!/Dere Building|Machakos|P\.?O\.?\s*Box/i.test(html), f + ' never mentions Flovo\'s physical/office address');
}

// 3. terms.html specifically: the depth the user asked for ------------------
const terms = read('terms.html');
check(/Schedule: Data processing terms/.test(terms), 'terms.html has a data-processing Schedule, like Shule Web\'s terms');
check(/Annex A/.test(terms) && /Annex B/.test(terms) && /Annex C/.test(terms), 'terms.html has all three annexes');
check(/Limitation of liability/.test(terms), 'terms.html has a limitation-of-liability clause');
check(/Indemnity/.test(terms), 'terms.html has an indemnity clause');
check(/Disputes and governing law/.test(terms), 'terms.html has a disputes/governing-law clause');
check(/SMS [Ww]allet/.test(terms), 'terms.html explains the real SMS wallet / M-Pesa top-up feature');
check(/Pharmacy and Poisons Board/.test(terms), 'terms.html references the real Kenyan pharmacy regulator');

// 4. cookies.html: honest about there being no tracking ---------------------
const cookies = read('cookies.html');
check(/does not use advertising or tracking cookies|No advertising cookies/i.test(cookies), 'cookies.html says plainly there is no ad/tracking');

// 5. sitemap.xml and robots.txt know about every new page -------------------
const sitemap = read('sitemap.xml');
const robots = read('robots.txt');
for (const f of PAGES) {
  check(sitemap.includes('https://pharmamanagement.site/' + f), 'sitemap.xml lists ' + f);
  check(robots.includes('Allow: /' + f), 'robots.txt explicitly allows ' + f);
}

console.log(failed ? failed + ' marketing-pages checks failed' : 'PASS marketing-pages: Terms/Privacy/Cookies/Features/Pricing/Blog all present and correctly linked');
process.exit(failed ? 1 : 0);
