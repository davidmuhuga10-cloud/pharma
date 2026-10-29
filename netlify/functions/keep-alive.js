/**
 * keep-alive.js — a scheduled Netlify Function that reads one row from
 * Pharma's Supabase project once a day.
 *
 * Why: Supabase's free tier pauses a project after about 7 days with no
 * activity, and a paused project makes the whole app fail with no obvious
 * cause. One real request a day means that can never happen from a quiet
 * week. (Kodi does the same every 3 days; Pharma runs daily.) A second
 * safeguard lives inside the database: the pg_cron job "pharma-housekeeping"
 * (migrations/2026-10-29_daily_housekeeping.sql) runs every night too.
 *
 * Cost: one request that asks the database for the time. No dependencies, no
 * secret keys: it uses the public publishable key that is already in
 * config.js, and keep_alive() returns a timestamp and nothing else - no
 * pharmacy data. (It used to read one row from `pharmacies`; since the
 * 2026-10-29 lock-down the signed-out key holds no table access at all, so
 * that read is refused and would no longer touch the database.)
 *
 * Schedule: see [functions."keep-alive"] in netlify.toml.
 */
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
    // A network hiccup is not something anyone needs to act on: the next
    // daily run tries again, and the database job is a second safeguard.
    console.error('keep-alive: ping failed:', e.message);
    return { statusCode: 200, body: 'ping failed, will retry on next schedule' };
  }
};
