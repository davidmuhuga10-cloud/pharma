# Pharma - Setup and deployment

How to stand up a copy of Pharma (a new environment, or a rebuild). Running the live system day to day is in `OPERATIONS.md`; how the pieces fit is in `ARCHITECTURE.md`.

## 1. Database (Supabase)

1. Create a Supabase project.
2. Run `schema.sql` in the SQL editor. It contains every table, view, function, policy and grant, including everything folded in from `migrations/`.
3. Enable the `pg_cron`, `pg_net` and Vault extensions (Database -> Extensions). `pg_net` goes in the `extensions` schema.
4. Auth settings: confirm the sign-up and password options in `OPERATIONS.md` ("Open items").
5. Put the project URL and the public (publishable) key in `config.js`. Never put the service-role key there.

## 2. Edge functions

Deploy each folder in `supabase/functions/`:

| Function | JWT verification |
|---|---|
| `send-otp`, `verify-otp`, `signup-by-phone`, `reset-password-by-phone` | off (the person is not signed in yet) |
| `send-sms` | on |
| `send-queued-summaries` | off (protected by the `x-cron-secret` header) |

Secrets (Edge Functions -> Secrets): `CRON_SHARED_SECRET` (a long random value), `OTP_TOKEN_SECRET`, and optionally `OTP_GLOBAL_MAX_PER_HOUR`.

Store the same cron secret and the sender's URL in Vault so the database can call it:

```sql
select vault.create_secret('<the same value as CRON_SHARED_SECRET>', 'pharma_cron_shared_secret');
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/send-queued-summaries', 'pharma_cron_sender_url');
```

Text messages: put the Africa's Talking username, API key and sender id in the `sms_platform_config` row with `id = 1`. Until it is filled in, queued messages are marked failed with "SMS is not set up on this server yet."

## 3. Site (Netlify)

1. Connect the repository as a static site (publish directory `.`, functions directory `netlify/functions`; both are set in `netlify.toml`).
2. Set the environment variables used by `sms-topup` and `pay-callback`: the `MPESA_*` values and `SUPABASE_SERVICE_ROLE_KEY`.
3. The daily keep-alive runs from `netlify.toml` (`0 3 * * *`).
4. After every deploy that changes a cached file, `CACHE_NAME` in `sw.js` must have been bumped.

## 4. First pharmacy

The first person to sign up ("Create an account") becomes that pharmacy's owner and starts a 90-day trial; starter drug categories are created automatically. Then: add drugs (or use "Sync common drugs" or the Excel stock sheet), restock with real batches (quantity, price, expiry), and fill in the pharmacy's address, town and phone in Settings - they appear on every printed report and receipt. Staff join with an invite code the owner creates in Settings.

## 5. Check it works

```bash
npm test                                       # JavaScript tests
cd tests && npm install && node run_tests.js   # SQL tests, against a local throwaway Postgres only (tests/README.md)
```

Then sign in on a phone and a desktop browser, sell one item, and confirm the receipt prints.
