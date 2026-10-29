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
 * Cost: one request for one column of one row. No dependencies, no secret
 * keys: it uses the public publishable key that is already in config.js
 * (row level security is what protects the data). Whether the row comes back
 * does not matter; Supabase counts the request either way.
 *
 * Schedule: see [functions."keep-alive"] in netlify.toml.
 */
const SUPABASE_URL = 'https://ovegzdlrhlcpjfcsoumu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5L7-aCEhUgaMMX83IzhWXg_yyUHtALP';

exports.handler = async () => {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/pharmacies?select=id&limit=1',
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } }
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
