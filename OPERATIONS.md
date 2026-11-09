# Pharma - Operations runbook

What to check, what to do when something breaks, and what to watch as pharmacies are added. Architecture is in `ARCHITECTURE.md`; database changes are in `MIGRATIONS.md`.

Run the SQL below in the Supabase dashboard -> SQL editor (it runs as an administrator and sees every pharmacy). Never paste results containing patient or customer details into chats or tickets.

## Every day (two minutes)

1. **Evening summaries went out:**
   ```sql
   select status, count(*) from sms_log
   where kind = 'summary' and created_at > now() - interval '1 day' group by status;
   ```
   Expect `sent` (and a few `failed` for bad numbers). Any `queued` after 19:00 Nairobi means the sender is stuck: see "Summaries stay queued".
2. **Scheduled jobs ran:**
   ```sql
   select j.jobname, d.status, d.start_time, left(d.return_message, 80) as msg
   from cron.job j
   left join lateral (select * from cron.job_run_details where jobid = j.jobid order by start_time desc limit 1) d on true;
   ```
   Every job should show `succeeded` with a recent `start_time` (`pharma-summary-drain` only runs 18:00-19:59 Nairobi, so a blank before its first evening is normal).
3. **Supabase dashboard -> Advisors:** no new security warnings.

## Every week

- **Slowest queries** (needs `pg_stat_statements`, which is enabled):
  ```sql
  select round(mean_exec_time::numeric, 1) as avg_ms, calls, left(query, 100) as query
  from pg_stat_statements order by mean_exec_time * calls desc limit 10;
  ```
  A query that is both slow and called often is the thing to fix before it hurts at more pharmacies.
- **Biggest tables:**
  ```sql
  select relname, pg_size_pretty(pg_total_relation_size(oid)) as size, reltuples::bigint as approx_rows
  from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace
  order by pg_total_relation_size(oid) desc limit 10;
  ```
- **Pharmacies near the end of their plan** (so nobody is locked out by surprise):
  ```sql
  select name, subscription_status, subscription_expires_at from pharmacies
  where subscription_expires_at < now() + interval '14 days' order by subscription_expires_at;
  ```
- **Supabase dashboard -> Reports:** database CPU, memory, connections. Sustained CPU above about 70% means upgrade the compute size or fix the slow query, whichever the slow-query list points to.

## When something breaks

### A pharmacy says "the app will not load / everything fails"
1. Is the Supabase project paused? Dashboard shows it. Restore it; on a paid plan this cannot happen. The daily Netlify `keep-alive` and the `pharma-housekeeping` job exist to prevent it on the free plan.
2. Is the pharmacy's trial or plan expired? `my_pharmacy_id()` returns nothing for expired plans, so every screen looks empty or errors. Extend or activate the plan in the admin console.
3. Browser console shows a stale file error after a deploy: the service worker is serving the old shell. Confirm `CACHE_NAME` in `sw.js` was bumped; the person can reload twice.

### Summaries stay queued
1. Check the sender's last responses: Supabase dashboard -> Edge Functions -> `send-queued-summaries` -> Logs. A `401` means the secret in Vault does not match `CRON_SHARED_SECRET`; set them to the same value.
2. Check SMS is configured: `select username is not null as has_user, api_key is not null as has_key from sms_platform_config where id = 1;`. If not, queued summaries are marked `failed` with "SMS is not set up on this server yet."
3. Trigger it by hand: `select public.nudge_summary_sender();` returns how many were queued. The drain job repeats this every five minutes between 18:00 and 19:59 Nairobi.
4. Check the provider balance (Africa's Talking). A failed row's `error` column says why (`out of balance`, `invalid phone number`, ...).

### Sign-up or password-reset texts are not arriving
- The platform-wide hourly cap may be hit (`OTP_GLOBAL_MAX_PER_HOUR`, default 300): the function replies with a "try again later" message. Raise it in the Edge Function secrets if the traffic is genuine.
- Check provider balance and the `send-otp` function logs.

### A report or screen got slow
1. Find the query in the weekly slow-query list.
2. `explain (analyze, buffers)` it. A sequential scan on a large table filtered by `pharmacy_id` means a missing index: add `(pharmacy_id, <filter column>)` through a migration.
3. Never fix slowness by downloading history into the browser (`CLAUDE.md` rule 11).

### A deploy went wrong
- **Site:** Netlify -> Deploys -> publish the previous deploy. Users get the old shell back after one reload.
- **Database change:** run the matching `*.ROLLBACK_if_needed.sql` from `migrations/`, then fix forward with a new migration.
- **Edge function:** redeploy the previous version's source from `supabase/functions/<name>/` (or the dashboard's version history).

### Rotating the SMS or cron secrets
1. Create the new value. 2. Set `CRON_SHARED_SECRET` in Edge Function secrets. 3. Update Vault: `select vault.update_secret((select id from vault.secrets where name = 'pharma_cron_shared_secret'), '<new value>');`. 4. Run `select public.nudge_summary_sender();` with something queued and confirm it is sent.

## Releasing a change (checklist)

1. Database first (see `MIGRATIONS.md`), then the site.
2. `npm test` (JavaScript tests) and, for database changes, the SQL tests (`tests/README.md`).
3. Bump `CACHE_NAME` in `sw.js` if any cached file changed; raise `versionCode` for Android uploads.
4. Look at the screen you changed at desktop width and phone width.
5. Update `CHANGELOG.md`, `README.md`, `PHARMA_PROJECT_STATUS.md`.

## Backups and recovery

- Backups are a property of the Supabase plan: Free has none you can restore from; Pro has daily backups; point-in-time recovery is a paid add-on. **This project is on Free**, so today there is no restorable backup unless you make one yourself (weekly `pg_dump`, see Open items). With a paying pharmacy, daily backups are the minimum to hold.
- Practise a restore once into a new, empty project and open the app against it. An untested backup is a guess.

## Capacity guide (when to act)

| Pharmacies | What to have in place |
|---|---|
| 1 to 10 | Daily checks above. Move from Free to Pro for backups and no pausing. Keep dashboards on the database functions |
| 10 to 20 | Watch the weekly slow-query list. Move to a paid plan if still on Free (no pausing, backups). Add an uptime check on the site |
| 20 to 100 | Watch CPU and memory; size the compute up before sustained CPU stays high. Raise `OTP_GLOBAL_MAX_PER_HOUR` with sign-up volume. Review the admin overview query |
| 100 to 1,000 | Summary tables for dashboards and the admin overview, partition or archive audit and sales-history tables, read replica or larger compute, a status page and an on-call routine |

The 60 direct connections in the dashboard are not a limit on pharmacies: the browser uses PostgREST, which pools them. Slow queries and CPU are what run out first.

## Open items needing the owner

These cannot be done from the code and are not yet confirmed:

1. **Public sign-up in Supabase Auth: checked 8 Nov 2026, it is off** ("Allow new users to sign up", anonymous sign-ins and manual linking all disabled). Accounts can only be created by the app's own `signup-by-phone` function. Re-check it after any Auth settings change.
2. **Leaked-password protection** (Auth -> Attack Protection) is off in the advisor report; turn it on if the plan allows it (it may need a paid plan).
3. **The project is on the Supabase Free plan** (dashboard header, 8 Nov 2026) while one pharmacy is paying. Free has no backups you can restore from and pauses after about a week of no activity. Moving to Pro (daily backups, no pausing) is the single most valuable change before adding pharmacies. Until then, take your own export: `pg_dump` of the project's database connection string, weekly, kept off the computer it was made on.
4. **The paying pharmacy is recorded as `trial` with expiry 2027-12-31.** Mark it as paid in the admin console so billing reports are right.
5. **Direct writes to `drugs`.** A signed-in attendant can change fields such as `is_prescription` and `reorder_level` through the API, bypassing role checks in the app's functions. Fixing it needs the screens that edit drugs moved to a role-checked function first; do not simply revoke the privilege, or those screens break.

## Deploying the discount release (9 Nov 2026)

The migration `migrations/2026-11-09_sale_discount.sql` is already on the live project (9 Nov 2026; the app that was live before keeps working with it). Deploy the new app (cache `hodhi-shell-v4f`) to switch the discount on. On a NEW project, run the migration before deploying. The new checkout calls `record_sale` with a discount, which the old database does not accept. Check: `select column_name from information_schema.columns where table_name='sales' and column_name in ('discount_amount','voided_by');` returns two rows. To undo: `migrations/2026-11-09_sale_discount.ROLLBACK_if_needed.sql` (sale totals stay right; the record of discounts and who reversed what is dropped).

The staff-permissions trigger `profiles_default_access` is already enabled (checked 9 Nov 2026).
