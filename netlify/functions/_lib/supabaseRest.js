/**
 * supabaseRest.js — the server side's door into Pharma's database for the
 * Netlify functions (sms-topup.js, pay-callback.js). Plain HTTPS calls to
 * Supabase's own REST API, so the functions need no npm packages at all
 * (Pharma has no build step).
 *
 * Netlify environment variable (set by the owner in Netlify → Site
 * configuration → Environment variables; never put it in code or chat):
 *   SUPABASE_SERVICE_ROLE_KEY  Pharma's service_role key (Supabase → Project
 *                              Settings → API). It bypasses row-level
 *                              security, so it must only ever live here.
 * SUPABASE_URL is optional (defaults to Pharma's project).
 */
const DEFAULT_URL = 'https://ovegzdlrhlcpjfcsoumu.supabase.co';

function client(env = process.env, fetchImpl = fetch) {
  const url = String(env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) { const e = new Error('Payments are being set up. Please try again later.'); e.statusCode = 503; throw e; }
  /* Which headers carry the key depends on which kind of key it is.
     A new-format key (sb_secret_…) is an opaque string, not a JWT, and
     Supabase authenticates it from the "apikey" header on its own - that is
     the documented way to use one. Sending it as "Authorization: Bearer
     sb_secret_…" instead hands it to the part of Supabase that expects a
     signed user token, which is not what it is.
     A legacy service_role key IS a JWT and Supabase still expects it in both
     headers, so that path is left exactly as it was: whichever key Netlify
     holds today keeps behaving today's way, byte for byte. This only changes
     what happens on the day that key is replaced with a new-format one.
     getUser() below is deliberately different and is not affected - it sends
     the browser's own session token as the Bearer, never the service key. */
  const isOpaqueKey = key.startsWith('sb_');
  const headers = (extra) => Object.assign(
    { apikey: key, 'content-type': 'application/json', accept: 'application/json' },
    isOpaqueKey ? {} : { authorization: `Bearer ${key}` },
    extra || {}
  );
  async function call(method, path, body, extra) {
    const res = await fetchImpl(`${url}${path}`, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) { const e = new Error(`Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`); e.status = res.status; throw e; }
    return data;
  }
  return {
    /** The signed-in user behind a browser's access token, or null. */
    async getUser(token) {
      if (!token) return null;
      const res = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: key, authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const u = await res.json().catch(() => null);
      return u && u.id ? u : null;
    },
    select: (table, query) => call('GET', `/rest/v1/${table}?${query}`),
    insert: (table, row) => call('POST', `/rest/v1/${table}`, row, { prefer: 'return=representation' }).then((d) => (Array.isArray(d) ? d[0] : d)),
    update: (table, query, patch) => call('PATCH', `/rest/v1/${table}?${query}`, patch, { prefer: 'return=minimal' }),
    rpc: (fn, args) => call('POST', `/rest/v1/rpc/${fn}`, args || {})
  };
}

module.exports = { client, DEFAULT_URL };
