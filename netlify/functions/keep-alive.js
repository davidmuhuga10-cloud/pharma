// keep-alive.js - a scheduled Netlify Function that reads one value from
// Pharma's Supabase project once a day.
//
// Why: the free tier pauses a project after about 7 days with no activity, and
// a paused project makes the whole app fail with no obvious cause. One real
// request a day prevents that. The pg_cron job "pharma-housekeeping"
// (migrations/2026-10-29_daily_housekeeping.sql) is a second safeguard.
//
// It calls keep_alive(), which returns a timestamp and nothing else (no
// pharmacy data), using the public key already in config.js. No dependencies,
// no secrets.
//
// Schedule: [functions."keep-alive"] in netlify.toml.
const SUPABASE_URL = 'https://ovegzdlrhlcpjfcsoumu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5L7-aCEhUgaMMX83IzhWXg_yyUHtALP';

exports.handler = async () => {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/rpc/keep_alive',
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: '{}'
      }
    );
    console.log('keep-alive: pinged Supabase, status', res.status, 'at', new Date().toISOString());
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    // A network hiccup needs no action: the next daily run tries again.
    console.error('keep-alive: ping failed:', e.message);
    return { statusCode: 200, body: 'ping failed, will retry on next schedule' };
  }
};
