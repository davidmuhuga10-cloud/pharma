/**
 * sms-topup.js — buy SMS with one M-Pesa prompt.
 * See _lib/daraja.js and _lib/supabaseRest.js for the Netlify environment
 * variables, and pay-callback.js for Safaricom's result.
 *
 * POST { action: 'start', amount, phone }   (Authorization: Bearer <session>)
 *   Creates an 'awaiting_payment' purchase and sends the PIN prompt to the
 *   phone. The KES paid goes into the pharmacy's SMS wallet; each SMS costs
 *   sms_platform_config.price_per_sms (KES 1 today).
 * POST { action: 'status', request_id, confirm? }
 *   Reads how the purchase stands. With confirm:true (the screen sends it
 *   every ~10s after the first 20s) a purchase still waiting is checked with
 *   Safaricom directly, in case their result message is slow or lost.
 *
 * Only the pharmacy's owner or co-owner can buy. Money is only ever added by
 * public.sms_topup_complete, exactly once per purchase.
 */
const daraja = require('./_lib/daraja');
const supa = require('./_lib/supabaseRest');

const MIN_KES = 50;
const MAX_KES = 150000;

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}
function fail(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

/** The signed-in buyer behind the request, checked fresh every time. */
async function requireBuyer(event, db) {
  const h = event.headers || {};
  const token = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  const user = await db.getUser(token);
  if (!user) throw fail(401, 'Please sign in again.');
  const rows = await db.select('profiles', `id=eq.${encodeURIComponent(user.id)}&select=id,pharmacy_id,role,active,account_expires_at`);
  const p = Array.isArray(rows) ? rows[0] : null;
  if (!p || p.active === false) throw fail(403, 'Please sign in again.');
  if (p.account_expires_at && new Date(p.account_expires_at) <= new Date()) throw fail(403, 'Please sign in again.');
  if (p.role !== 'owner' && p.role !== 'co_owner') throw fail(403, 'Only the owner can buy SMS.');
  return { userId: user.id, pharmacyId: p.pharmacy_id };
}

// The real work lives in run(event, deps) so tests can swap in a fake
// database and a fake M-Pesa; the handler itself takes only the event.
exports.handler = async (event) => run(event, {});

async function run(event, deps) {
  deps = deps || {};
  if (event.httpMethod !== 'POST') return json(405, { ok: false, message: 'Method not allowed.' });
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, message: 'Invalid request.' }); }
  try {
    const db = deps.db || supa.client();
    const buyer = await requireBuyer(event, db);
    const cfg = deps.cfg || daraja.config();
    if (payload.action === 'start') return json(200, await start(db, buyer, cfg, payload, deps.fetch));
    if (payload.action === 'status') return json(200, await status(db, buyer, cfg, payload, deps.fetch));
    return json(400, { ok: false, message: 'Unknown action.' });
  } catch (e) {
    if (e.statusCode) return json(e.statusCode, { ok: false, message: e.message });
    console.error('sms-topup error:', e);
    return json(500, { ok: false, message: 'Something went wrong. Please try again.' });
  }
}

async function pricePerSms(db) {
  const rows = await db.select('sms_platform_config', 'id=eq.1&select=price_per_sms');
  const p = Number(Array.isArray(rows) && rows[0] && rows[0].price_per_sms);
  return p > 0 ? p : 1;
}

async function start(db, buyer, cfg, payload, fetchImpl) {
  // A pharmacy whose trial or plan has ended is locked out; it must be
  // activated first, so no payment is taken from a locked account.
  const ph = await db.select('pharmacies', `id=eq.${buyer.pharmacyId}&select=subscription_expires_at`);
  const ends = Array.isArray(ph) && ph[0] && ph[0].subscription_expires_at;
  if (ends && new Date(ends) <= new Date()) throw fail(403, 'Your plan has ended. Contact the Pharma team to activate it.');

  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || Math.round(amount) !== amount) throw fail(400, 'Enter a whole amount in KES.');
  if (amount < MIN_KES) throw fail(400, `The smallest top-up is KES ${MIN_KES}.`);
  if (amount > MAX_KES) throw fail(400, `The largest top-up at once is KES ${MAX_KES.toLocaleString('en-US')}.`);
  const phone = daraja.normalizePhone(payload.phone);
  if (!phone) throw fail(400, 'Enter a Safaricom number like 0712 345 678.');
  if (!cfg.configured) throw fail(503, 'M-Pesa payments are being set up. Please try again later.');

  // One prompt at a time: a second tap within 25 seconds would only confuse the phone.
  const since = new Date(Date.now() - 25 * 1000).toISOString();
  const recent = await db.select('sms_topup_requests',
    `pharmacy_id=eq.${buyer.pharmacyId}&status=eq.awaiting_payment&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`);
  if (Array.isArray(recent) && recent.length) throw fail(429, 'A prompt was just sent. Check the phone, or wait a few seconds and try again.');

  const price = await pricePerSms(db);
  const smsCount = Math.floor(amount / price);
  const row = await db.insert('sms_topup_requests', {
    pharmacy_id: buyer.pharmacyId, created_by: buyer.userId, amount, status: 'awaiting_payment',
    phone, sms_count: smsCount
  });
  if (!row || !row.id) throw new Error('insert failed');

  let push;
  try { push = await daraja.stkPush(cfg, { amount, phone }, fetchImpl); }
  catch (e) { console.error('stkPush error', e); push = { ok: false, message: '' }; }
  if (!push.ok) {
    await db.update('sms_topup_requests', `id=eq.${row.id}`, { status: 'failed', result_desc: push.message || 'Prompt not sent' });
    console.error('stkPush refused', push);
    throw fail(502, 'M-Pesa could not send the prompt right now. Check the number and try again.');
  }
  await db.update('sms_topup_requests', `id=eq.${row.id}`, { checkout_request_id: push.checkoutRequestId, merchant_request_id: push.merchantRequestId });
  return { ok: true, request_id: row.id, amount, sms: smsCount, phone };
}

async function status(db, buyer, cfg, payload, fetchImpl) {
  const id = String(payload.request_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail(400, 'Missing purchase.');
  const read = async () => {
    const rows = await db.select('sms_topup_requests',
      `id=eq.${id}&pharmacy_id=eq.${buyer.pharmacyId}&select=id,status,amount,sms_count,phone,mpesa_receipt,result_code,result_desc,checkout_request_id,created_at`);
    return Array.isArray(rows) ? rows[0] : null;
  };
  let r = await read();
  if (!r) throw fail(404, 'Purchase not found.');

  const ageMs = Date.now() - new Date(r.created_at).getTime();
  if (r.status === 'awaiting_payment' && payload.confirm && r.checkout_request_id && cfg.configured && ageMs > 20000) {
    try {
      const q = await daraja.stkQuery(cfg, r.checkout_request_id, fetchImpl);
      if (q.done) {
        await db.rpc('sms_topup_complete', { p_checkout_request_id: r.checkout_request_id, p_result_code: q.resultCode, p_result_desc: q.resultDesc });
        r = await read();
      }
    } catch (e) { console.error('stkQuery error', e); }
  }

  let balance = null; let availableSms = null;
  if (r.status === 'confirmed') {
    const w = await db.select('sms_wallets', `pharmacy_id=eq.${buyer.pharmacyId}&select=balance`);
    balance = Array.isArray(w) && w[0] ? Number(w[0].balance) : null;
    if (balance != null) availableSms = Math.floor(balance / (await pricePerSms(db)));
  }
  return {
    ok: true,
    status: r.status === 'confirmed' ? 'paid' : r.status === 'failed' ? 'failed' : 'waiting',
    amount: Number(r.amount), sms: r.sms_count, phone: r.phone,
    receipt: r.mpesa_receipt, balance, available_sms: availableSms,
    // result_code 0 on a failed purchase = money moved but less than asked: say so plainly.
    money_taken: r.status === 'failed' && Number(r.result_code) === 0,
    message: r.status !== 'failed' ? undefined : Number(r.result_code) === 0 ? (r.result_desc || 'Contact Pharma.') : daraja.friendlyResult(r.result_code, r.result_desc)
  };
}

module.exports.start = start;
module.exports.status = status;
module.exports.requireBuyer = requireBuyer;
module.exports.run = run;
