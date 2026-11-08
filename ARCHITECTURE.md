# Pharma - Architecture

How the system fits together, and why. For day-to-day running see `OPERATIONS.md`; for changing the database see `MIGRATIONS.md`; for working rules see `CLAUDE.md`.

## The pieces

```
 Browser / installed PWA / Android shell           Netlify                    Supabase project
 ┌──────────────────────────────┐   static files   ┌────────────┐
 │ index.html + style.css       │ <─────────────── │ site root  │
 │ js/*.js  (one global scope)  │                  └────────────┘
 │ vendor-supabase.js           │                  ┌────────────────────┐        ┌─────────────────────────────────────┐
 │ sw.js (caches the shell only)│ ──── REST/RPC ─────────────────────────────────> │ PostgREST  -> Postgres (RLS on)    │
 └──────────────┬───────────────┘   (anon key + user JWT)                         │ Auth (phone-as-email login, JWT)    │
                │ functions.invoke                                                 │ Edge Functions (Deno)               │
                └───────────────────────────────────────────────────────────────> │ pg_cron, pg_net, Vault              │
                                          ┌─────────────────────┐                  └───────────────┬─────────────────────┘
                 daily 03:00 UTC ───────> │ Netlify Functions   │ ── service role ──────────────────┘
                                          │ keep-alive,         │
                                          │ sms-topup, pay-cb   │ <── M-Pesa (Daraja) callbacks
                                          └─────────────────────┘
   Edge functions call Africa's Talking (SMS).
```

- **Frontend:** vanilla JavaScript, no build step. The files in `js/` are plain scripts sharing one global scope, loaded in the order listed in `index.html` (`core.js` first, `main.js` last). `sw.js` caches only the app shell, never data; bump `CACHE_NAME` whenever a cached file changes.
- **Database:** one Supabase Postgres project. `schema.sql` is the full definition; `migrations/` holds the dated changes (see `MIGRATIONS.md`).
- **Edge functions** (`supabase/functions/`): `send-otp`, `verify-otp`, `signup-by-phone`, `reset-password-by-phone` (phone sign-up and password reset by text code, JWT verification off because the person is not signed in yet), `send-sms` (customer reminders and the evening summary, JWT verification on), `send-queued-summaries` (cron only, JWT verification off, protected by a shared secret header).
- **Netlify functions** (`netlify/functions/`): `keep-alive` (daily ping), `sms-topup` and `pay-callback` (buying SMS credit by M-Pesa; they use the service-role key and the `MPESA_*` variables).
- **Android app:** a Capacitor shell that loads the live site (`android/`, `capacitor.config.json`).

## Tenancy (one database, many pharmacies)

Every business table has a `pharmacy_id` column. Row-level security (RLS) on every table restricts rows to `pharmacy_id = my_pharmacy_id()`.

- `my_pharmacy_id()` reads the signed-in user's profile and **returns nothing once the pharmacy's trial or plan has expired**, so a locked-out pharmacy fails closed in the database, not only in the browser.
- The function is `STABLE`, so Postgres evaluates it once per query and uses it as an index condition; it does not run per row. Every pharmacy-filtered table has an index starting with `pharmacy_id` (rule 11 in `CLAUDE.md`).
- Money, stock and audit tables are written only by `security definer` functions (`record_sale`, `record_restock`, `void_sale`, `record_expense`, ...) that check the caller's role and pharmacy. The browser calls them through `sb.rpc(...)`.
- Reporting functions that return totals (`sales_report`, `dashboard_data`, `supplier_balances`, ...) are `security invoker`, so RLS still applies to the rows they read.
- `tests/run_tests.js` fails if any table has RLS off, if the API roles hold more than the privileges they need, or if signed-out users hold anything.

## Roles

| Role | In short (the exact lists are the `*_ACTIONS` arrays and `can()` in `js/core.js`) |
|---|---|
| owner, co_owner | Everything in their pharmacy: settings, staff invites, SMS, support access |
| pharmacist | Selling, stock, reports, controlled-drugs register |
| attendant (seller) | Selling, customers, view stock and reports, blind cash-drawer count |
| stock_taker | Restock, stock corrections and stock takes; read-only elsewhere |
| accountant | Read-only reports, claims, suppliers, expenses, cash-drawer review |
| platform admin | One account only (`admin.html`): sees all pharmacies' plans and billing; enters a pharmacy only through "Get support" (owner grants 1 to 24 hours) or the logged 8-hour direct access |

Staff join with a short invite code the owner creates. Roles are checked in the database functions that move money and stock, not only by hiding buttons in the browser. One known gap: some plain tables (for example `drugs`) can still be updated directly by any signed-in staff member of the pharmacy; see `OPERATIONS.md`, open items.

## Main data flows

- **Sign-in:** phone number + password (the phone is mapped to an auth identity). Sign-up and password reset go through the OTP edge functions: a text code is sent, verified, and only then is the account created or the password changed.
- **Selling:** cart in the browser -> `quote_sale` (prices) -> `record_sale` (FEFO deduction from the soonest-expiring batch, split payments, invoice number, insurance claim rows) in one transaction. Voids and returns have their own functions and refuse double credit.
- **Stock:** each restock creates a batch with its own expiry and price. Stock per drug is a view over batches (`v_drug_stock`).
- **Lists:** the database returns at most 1,000 rows per request, so any list that can grow is read through `fetchAllRows()` in `js/core.js`, a page at a time with a stable order. `tests/paging.test.js` fails if a growing table is listed any other way.
- **Totals:** computed in the database (`sales_report`, `dashboard_data`, `supplier_balances`), never by downloading history to add it up in the browser.
- **Evening summary SMS:** see below.

## Scheduled work

| Job (pg_cron, UTC) | Schedule | What it does |
|---|---|---|
| `pharma-housekeeping` | 00:30 daily | `housekeeping_daily()`: cleans old logs, keeps the project active |
| `pharma-demo-tick` | minute 5, 05:00-17:00 | `demo_tick()`: the self-running demo pharmacy |
| `pharma-evening-summary` | 15:30 daily (18:30 Nairobi) | `queue_evening_summaries()`: writes one `sms_log` row (`kind='summary'`, `status='queued'`) per opted-in pharmacy, then nudges the sender |
| `pharma-summary-drain` | every 5 min, 15:00-16:59 | `nudge_summary_sender()`: if any summary is still queued, nudge the sender again. Does nothing when the queue is empty |
| Netlify `keep-alive` | 03:00 daily | calls `keep_alive()` so a quiet free-tier project does not pause |

**Evening summary path:** `queue_evening_summaries()` -> `pg_net` HTTP POST with an `x-cron-secret` header (URL and secret stored in Vault as `pharma_cron_sender_url` and `pharma_cron_shared_secret`) -> `send-queued-summaries` checks the secret, then sends queued messages in rounds of 100, five at a time, inside a 110-second budget, and marks each row `sent` or `failed`. Anything left over is picked up by the next drain nudge.

## Secrets and configuration

| Where | What |
|---|---|
| `config.js` | Supabase URL and the public (anon/publishable) key. Public by design; RLS is the protection |
| Supabase Edge Function secrets | `CRON_SHARED_SECRET`, `OTP_TOKEN_SECRET`, optional `OTP_GLOBAL_MAX_PER_HOUR` (default 300 texts per hour across the platform) |
| Supabase Vault | `pharma_cron_sender_url`, `pharma_cron_shared_secret` (same value as `CRON_SHARED_SECRET`) |
| Database table `sms_platform_config` | Africa's Talking username, key and sender id (row `id = 1`) |
| Netlify environment variables | `MPESA_*`, `SUPABASE_SERVICE_ROLE_KEY` for `sms-topup` and `pay-callback` |

The service-role key never goes in the browser or in this repository.

## Known limits and what to watch as pharmacies are added

| Area | Today | Watch for |
|---|---|---|
| Direct database connections | 60 on the current compute size; the browser talks to PostgREST, which pools them | Slow queries holding connections, not the number of pharmacies. Watch CPU and the slowest queries (see `OPERATIONS.md`) |
| Dashboards and reports | Computed in the database per pharmacy, indexed by `pharmacy_id` | A year-wide range on a pharmacy with a very large sales history; add a summary table if it gets slow |
| Platform-wide texts | One shared hourly cap for OTP texts | Raise `OTP_GLOBAL_MAX_PER_HOUR` before a marketing push that sends many sign-ups at once |
| Audit and log tables | Cleaned by `housekeeping_daily()` | Tables that are not cleaned grow forever; partition (`pg_partman` is available) if one reaches tens of millions of rows |
| Admin overview | Scans across pharmacies | Fine at tens of pharmacies; becomes a summary-table job at hundreds |
| Evening summary | One text per pharmacy per night through one function | Fine to thousands of pharmacies; the drain job covers retries |
