// Ordering low-stock drugs from a supplier by WhatsApp. Nothing here is saved or sent by the
// app itself - it only builds the message and the WhatsApp link, exactly like js/customers.js
// already does for reminders. Run from the project folder:   node tests/supplier-order.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const src = read('js/supplier-order.js'), stock = read('js/reports-stock.js'), index = read('index.html'), sw = read('sw.js');

const ctx = { console, esc: s => String(s), qtyUnit: (n, u) => n + ' ' + u, toast: () => {}, $: () => null, STATE: {} };
vm.createContext(ctx); vm.runInContext(src, ctx);

// phone numbers, as a supplier might have typed them
check(ctx.supplierWaPhone('0712345678') === '254712345678', 'a local 07 number becomes 2547...');
check(ctx.supplierWaPhone('0112345678') === '254112345678', 'a local 01 number becomes 2541...');
check(ctx.supplierWaPhone('+254 712 345 678') === '254712345678', 'spaces and a plus sign are stripped');
check(ctx.supplierWaPhone('254712345678') === '254712345678', 'already in international form is left as is');
check(ctx.supplierWaPhone('712345678') === '254712345678', 'a 9-digit number with no leading 0 is still understood');
check(ctx.supplierWaPhone('') === null && ctx.supplierWaPhone(null) === null, 'no phone number gives nothing to link to');
check(ctx.supplierWaPhone('12345') === null, 'a number too short to be real is refused');
check(ctx.supplierWaPhone('020 2211334') === null, 'a landline (020...) is not treated as a WhatsApp number');

// the message
const msg = ctx.supplierOrderMessage('Hodhi Chemist', 'Medisel', [{ name: 'Paracetamol', qty: 30, unit: 'tablet' }, { name: 'Amoxil', qty: 10, unit: 'bottle' }]);
check(/Hodhi Chemist/.test(msg) && /Medisel/.test(msg), 'the message names the pharmacy and the supplier');
check(/1\. Paracetamol - 30 tablet/.test(msg) && /2\. Amoxil - 10 bottle/.test(msg), 'each drug is numbered with its quantity');
const msgNoSupName = ctx.supplierOrderMessage('Hodhi Chemist', '', [{ name: 'X', qty: 1, unit: 'pack' }]);
check(/^Hello, this is Hodhi Chemist/.test(msgNoSupName), 'a supplier with no name still reads naturally');

// the WhatsApp link
const link = ctx.supplierOrderLink('254712345678', 'Hello');
check(link === 'https://wa.me/254712345678?text=Hello', 'the link opens WhatsApp chat with the supplier, message pre-filled');
check(ctx.supplierOrderLink('254712345678', 'a & b?').indexOf('a%20%26%20b') !== -1, 'special characters in the message are encoded');

// wiring
check(/openSupplierOrder/.test(stock) && /can\('suppliers'\)/.test(stock.slice(stock.indexOf('openSupplierOrder') - 200, stock.indexOf('openSupplierOrder') + 50)), 'the button is on the Low Stock report, only for people who may manage suppliers');
check(/js\/supplier-order\.js/.test(index) && /\.\/js\/supplier-order\.js/.test(sw), 'the script is loaded and kept offline');
check(index.indexOf('supplier-order.js') > index.indexOf('suppliers.js') && index.indexOf('supplier-order.js') < index.indexOf('js/main.js'), 'it loads after suppliers.js and before main.js');
check(/soMessageEdited\s*=\s*true/.test(src), 'typing in the message stops it being rewritten when a tick changes');
check(/navigator\.clipboard\.writeText/.test(src) && /execCommand\('copy'\)/.test(src), 'copying the message has a fallback for an older browser');
check(/nothing is sent by the app and nothing is saved/.test(src), 'the file is clear that sending happens in the person\'s own WhatsApp');
if (failed) process.exit(1);
console.log('supplier order: ok');
