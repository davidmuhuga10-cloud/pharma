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

**There is a working, automatic, restore-tested daily backup.** Set up 10 Nov 2026.

Supabase Free keeps no backup you can restore from, so the backup lives outside
Supabase: a scheduled GitHub Action in a **separate private repository**,
`davidmuhuga10-cloud/BACKUPS`. It costs nothing.

### How it works

Every night at **01:17 UTC (04:17 Nairobi)**, that repository's
`.github/workflows/backup.yml` runs and:

1. counts every row in every table of `public`, on the live database;
2. dumps the `public` schema, the rows of `auth.users`, and `auth.users`'
   structure;
3. restores all of it into a throwaway Postgres 17 inside the same run, and
   checks **every table came back with exactly the count from step 1**;
4. commits the dump only if that matched - the commit message says
   "restore verified";
5. keeps 14 daily, 8 weekly (Sundays) and 12 monthly (1st) copies.

Nobody has to press anything. The "Run workflow" button is only for testing.

### Why the repository must stay private

The dumps hold patients' names and phone numbers, controlled-drug records,
customers' debts and the password hashes in `auth.users`. The code repository
`davidmuhuga10-cloud/pharma` is **public**, which is why the backups are
somewhere else. Never copy a dump, or that repository's secret, into the
public repo.

### The one secret

`SUPABASE_DB_URL` in that repository's Actions secrets: the **session pooler**
URI from Supabase (Connect -> Connection string -> Session pooler), port
**5432**. Two hosts that do not work, both for real reasons:

- the direct `db.<ref>.supabase.co` host is IPv6-only on the Free plan and
  GitHub's runners have no IPv6, so it times out;
- the transaction pooler on **6543** cannot be dumped from - `pg_dump` needs
  session mode.

The workflow also installs the Postgres **17** client and puts it first on
`PATH`. The runner ships an older client, and `pg_dump` refuses a server newer
than itself ("aborting because of server version mismatch").

### Getting a few rows back

```bash
gunzip -c daily/2026-11-09_public.sql.gz > restore.sql
createdb oneoff && psql oneoff -f restore.sql
psql oneoff -c "select * from sales where sold_at::date = '2026-11-08';"
```

Pull out what you need and put it back through the app, or with a small,
specific `insert`/`update`. **Never** load a whole dump over the live database
to recover a few rows - that wipes everything since the dump.

### Rebuilding the whole project

1. New Supabase project; run `schema.sql` in its SQL editor.
2. Restore **`auth_users.sql` first, then `public.sql`.** The order matters:
   `public.profiles.id` references `auth.users(id)`, and restoring `public`
   first means Postgres cannot re-create `profiles_id_fkey` and drops it with
   only a warning - you get a database that looks right but has quietly lost a
   constraint. The nightly check asserts that key exists, so this cannot
   regress unnoticed.
3. Check the counts against that date's `counts.txt`.
4. Repoint the app: `config.js`, Netlify's `SUPABASE_URL`, redeploy the Edge
   Functions.
5. People sign in again with their existing passwords - the hashes came across.

### What it does not cover

Edge Functions, Netlify environment variables and Supabase project settings
(those live in this repo and in the two dashboards), and anything written
between the last run and the failure - up to 24 hours. Closing that window
needs Supabase's paid point-in-time recovery, not a more frequent dump.

### If it breaks

GitHub emails the owner when a run fails. **A red run means that night has no
backup** - read the log before anything else. GitHub also disables scheduled
workflows in a repository with no activity for 60 days; nightly commits keep
resetting that clock, but it is the first thing to check if backups ever stop.

Practise a restore into a local Postgres once, so the first time is not during
an emergency. The nightly run already proves the dump *can* be restored; this
is about you knowing the steps.

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
3. **The project is on the Supabase Free plan** (dashboard header, 8 Nov 2026) while one pharmacy is paying. The missing-backup half of this is now solved outside Supabase - see Backups and recovery; backups run nightly and are restore-tested. What Free still costs you: the project pauses after about a week of no activity, and there is no point-in-time recovery, so the most you can lose is one day's work. Moving to Pro remains the right call before adding pharmacies, but it is no longer the thing standing between you and losing the data.
4. **The paying pharmacy is recorded as `trial` with expiry 2027-12-31.** Mark it as paid in the admin console so billing reports are right.
5. ~~**Direct writes to `drugs`.**~~ **Fixed 10 Nov 2026** by
   `migrations/2026-11-10_role_checks_on_direct_writes.sql`, without touching a
   single screen. It turned out no screen used `drugs` UPDATE at all, so that
   privilege was simply revoked; the three writes that *are* used (adding a
   drug, marking a batch down, adding a supplier) kept working and gained a
   `BEFORE` trigger enforcing the same role rule the screen shows. The same
   migration covered `batches.discount_percent` - where writing 100 sold a
   batch for nothing - `suppliers.opening_balance`, and claim status, all of
   which had the same gap. See the CHANGELOG entry for the verification.

## Deploying the discount release (9 Nov 2026)

The migration `migrations/2026-11-09_sale_discount.sql` is already on the live project (9 Nov 2026; the app that was live before keeps working with it). Deploy the new app (cache `hodhi-shell-v4j`) to switch the discount on. On a NEW project, run the migration before deploying. The new checkout calls `record_sale` with a discount, which the old database does not accept. Check: `select column_name from information_schema.columns where table_name='sales' and column_name in ('discount_amount','voided_by');` returns two rows. To undo: `migrations/2026-11-09_sale_discount.ROLLBACK_if_needed.sql` (sale totals stay right; the record of discounts and who reversed what is dropped).

The staff-permissions trigger `profiles_default_access` is already enabled (checked 9 Nov 2026).
