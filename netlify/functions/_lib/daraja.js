/**
 * daraja.js — Safaricom Daraja "M-Pesa Express" (STK Push) for buying SMS
 * with one prompt. See sms-topup.js (start a payment / check it) and
 * pay-callback.js (Safaricom's result).
 *
 * Netlify environment variables (set by the owner in Netlify → Site
 * configuration → Environment variables; never put them in code or chat):
 *   MPESA_ENV             "production" once Daraja go-live is approved,
 *                         otherwise "sandbox" (Safaricom's test system)
 *   MPESA_CONSUMER_KEY    from the Daraja app
 *   MPESA_CONSUMER_SECRET from the Daraja app
 *   MPESA_PASSKEY         emailed by Safaricom after go-live
 *   MPESA_SHORTCODE       for a till: the STORE / head-office number
 *                         (for a paybill: the paybill number)
 *   MPESA_TILL_NUMBER     the till customers pay (leave empty for a paybill)
 *   MPESA_CALLBACK_SECRET any long random text; it becomes part of the
 *                         private address Safaricom sends results to
 * Optional: MPESA_BASE_URL (tests point this at a pretend Daraja).
 *
 * Note: Safaricom refuses callback addresses containing words such as
 * "mpesa" or "safaricom", which is why the callback function is called
 * pay-callback.
 */

function config(env = process.env) {
  const prod = String(env.MPESA_ENV || '').toLowerCase() === 'production';
  const till = String(env.MPESA_TILL_NUMBER || '').trim();
  const cfg = {
    baseUrl: (env.MPESA_BASE_URL || (prod ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke')).replace(/\/+$/, ''),
    consumerKey: String(env.MPESA_CONSUMER_KEY || '').trim(),
    consumerSecret: String(env.MPESA_CONSUMER_SECRET || '').trim(),
    passkey: String(env.MPESA_PASSKEY || '').trim(),
    shortcode: String(env.MPESA_SHORTCODE || '').trim(),
    till,
    transactionType: till ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    partyB: till || String(env.MPESA_SHORTCODE || '').trim(),
    callbackSecret: String(env.MPESA_CALLBACK_SECRET || '').trim(),
    siteUrl: String(env.URL || env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '')
  };
  cfg.configured = !!(cfg.consumerKey && cfg.consumerSecret && cfg.passkey && cfg.shortcode && cfg.callbackSecret && cfg.siteUrl);
  return cfg;
}

/** 07XXXXXXXX / 01XXXXXXXX / +2547... / 2547... / 7XXXXXXXX -> 2547XXXXXXXX. null if not a Kenyan mobile. */
function normalizePhone(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  let n = null;
  if (/^0[17]\d{8}$/.test(d)) n = '254' + d.slice(1);
  else if (/^254[17]\d{8}$/.test(d)) n = d;
  else if (/^[17]\d{8}$/.test(d)) n = '254' + d;
  return n;
}

/** Daraja wants Kenya time, YYYYMMDDHHmmss. */
function timestamp(date = new Date()) {
  const k = new Date(date.getTime() + 3 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${k.getUTCFullYear()}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}${p(k.getUTCHours())}${p(k.getUTCMinutes())}${p(k.getUTCSeconds())}`;
}

function password(cfg, ts) {
  return Buffer.from(cfg.shortcode + cfg.passkey + ts).toString('base64');
}

function callbackUrl(cfg) {
  return `${cfg.siteUrl}/.netlify/functions/pay-callback/${encodeURIComponent(cfg.callbackSecret)}`;
}

function stkPushBody(cfg, { amount, phone, ts }) {
  return {
    BusinessShortCode: cfg.shortcode,
    Password: password(cfg, ts),
    Timestamp: ts,
    TransactionType: cfg.transactionType,
    Amount: Math.round(amount),
    PartyA: phone,
    PartyB: cfg.partyB,
    PhoneNumber: phone,
    CallBackURL: callbackUrl(cfg),
    AccountReference: 'Pharma SMS',
    TransactionDesc: 'SMS credits'
  };
}

/** Pulls the useful parts out of Safaricom's result message. */
function parseCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return null;
  const items = (cb.CallbackMetadata && Array.isArray(cb.CallbackMetadata.Item)) ? cb.CallbackMetadata.Item : [];
  const get = (name) => { const it = items.find((i) => i && i.Name === name); return it ? it.Value : undefined; };
  const amount = get('Amount');
  const phone = get('PhoneNumber');
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    merchantRequestId: cb.MerchantRequestID ? String(cb.MerchantRequestID) : null,
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc || ''),
    receipt: get('MpesaReceiptNumber') ? String(get('MpesaReceiptNumber')) : null,
    amount: amount === undefined ? null : Number(amount),
    phone: phone === undefined ? null : String(phone)
  };
}

/** Plain words for the landlord when a payment did not go through. */
function friendlyResult(code, desc) {
  switch (Number(code)) {
    case 0: return 'Paid.';
    case 1032: return 'The M-Pesa prompt was cancelled on the phone.';
    case 1037: return 'The phone did not respond in time. Check the phone is on and has network, then try again.';
    case 1: return 'Not enough money in M-Pesa for this payment.';
    case 2001: return 'Wrong M-Pesa PIN. Try again.';
    case 1001: return 'Another M-Pesa payment is in progress on that phone. Wait a moment and try again.';
    case 1019: return 'The prompt expired before it was answered. Try again.';
    case 1025: case 9999: return 'M-Pesa could not send the prompt. Try again.';
    default: return desc ? `M-Pesa: ${desc}` : 'The payment did not go through.';
  }
}

async function getToken(cfg, fetchImpl = fetch) {
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
  const res = await fetchImpl(`${cfg.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { authorization: `Basic ${auth}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Daraja token failed (${res.status})`);
  return data.access_token;
}

async function stkPush(cfg, { amount, phone }, fetchImpl = fetch) {
  const token = await getToken(cfg, fetchImpl);
  const ts = timestamp();
  const res = await fetchImpl(`${cfg.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(stkPushBody(cfg, { amount, phone, ts }))
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && String(data.ResponseCode) === '0' && data.CheckoutRequestID) {
    return { ok: true, checkoutRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID || null };
  }
  return { ok: false, status: res.status, code: data.errorCode || data.ResponseCode, message: data.errorMessage || data.ResponseDescription || data.CustomerMessage || '' };
}

/** Asks Safaricom how a prompt ended. { done:false } while still waiting. */
async function stkQuery(cfg, checkoutRequestId, fetchImpl = fetch) {
  const token = await getToken(cfg, fetchImpl);
  const ts = timestamp();
  const res = await fetchImpl(`${cfg.baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: cfg.shortcode, Password: password(cfg, ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId })
  });
  const data = await res.json().catch(() => ({}));
  if (data.ResultCode !== undefined && data.ResultCode !== null && data.ResultCode !== '') {
    return { done: true, resultCode: Number(data.ResultCode), resultDesc: String(data.ResultDesc || '') };
  }
  return { done: false };
}

module.exports = { config, normalizePhone, timestamp, password, callbackUrl, stkPushBody, parseCallback, friendlyResult, getToken, stkPush, stkQuery };
