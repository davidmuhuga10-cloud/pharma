/**
 * pay-callback.js — where Safaricom sends the result of an M-Pesa prompt
 * started by sms-topup.js. The address carries MPESA_CALLBACK_SECRET
 * (/.netlify/functions/pay-callback/<secret>) so only Safaricom, who was
 * given it with the prompt, can reach it; anything else gets 404.
 *
 * Money goes into the wallet only through public.sms_topup_complete
 * (migrations/2026-10-30_sms_wallet.sql), which only credits a purchase this
 * site started, for at least the amount it asked for, and exactly once -
 * Safaricom may send the same result more than once. Safaricom always gets
 * "accepted" back once the secret matches, so it does not keep retrying a
 * message we have already recorded.
 */
const crypto = require('crypto');
const daraja = require('./_lib/daraja');
const supa = require('./_lib/supabaseRest');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function secretMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given)); const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Netlify's Node runtime refuses any handler that takes a third argument, so
// the real work lives in run(event, deps) - deps lets the tests swap in a
// fake database - and the handler itself takes only the event.
exports.handler = async (event) => run(event, {});

async function run(event, deps) {
  deps = deps || {};
  const cfg = deps.cfg || daraja.config();
  const pathPart = String(event.path || event.rawUrl || '').split('?')[0].split('/').filter(Boolean).pop() || '';
  let given = pathPart;
  try { given = decodeURIComponent(pathPart); } catch (e) { /* keep raw */ }
  if (event.httpMethod !== 'POST' || !secretMatches(given, cfg.callbackSecret)) return json(404, { ok: false });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(200, { ResultCode: 0, ResultDesc: 'Accepted' }); }
  const r = daraja.parseCallback(body);
  if (!r) { console.error('pay-callback: unrecognised body', event.body); return json(200, { ResultCode: 0, ResultDesc: 'Accepted' }); }

  try {
    const db = deps.db || supa.client();
    const data = await db.rpc('sms_topup_complete', {
      p_checkout_request_id: r.checkoutRequestId, p_result_code: r.resultCode, p_result_desc: r.resultDesc,
      p_receipt: r.receipt, p_amount: r.amount, p_phone: r.phone
    });
    if (data && data.ok === false) console.error('pay-callback: not credited', r.checkoutRequestId, data);
  } catch (e) {
    console.error('pay-callback error', e);
    return json(500, { ResultCode: 1, ResultDesc: 'Try again' });
  }
  return json(200, { ResultCode: 0, ResultDesc: 'Accepted' });
}
module.exports.run = run;
