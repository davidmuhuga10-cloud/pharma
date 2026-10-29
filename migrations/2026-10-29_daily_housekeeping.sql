-- 2026-10-29: nightly housekeeping, kept deliberately tiny.
--
-- Two short-lived tables only ever need their last day or two of rows:
--   phone_otps              one-time codes (expire in minutes)
--   password_reset_attempts rate-limit hits (the app only looks back about an hour)
-- Left alone they just grow. This function deletes rows older than two days.
-- It does NOT touch sign_in_log (the admin portal reports on it) or any
-- pharmacy data.
--
-- Cost: both deletes are range deletes on small tables; on a quiet project the
-- whole run is a few milliseconds. It runs once a day at 00:30 UTC (03:30 in
-- Nairobi), when nobody is selling.
--
-- Also counts as real database activity every night, which helps keep a
-- free-tier project from being paused for inactivity (the daily web ping from
-- netlify/functions/keep-alive.js is the main safeguard; this is a second one
-- that does not depend on Netlify).

create or replace function public.housekeeping_daily()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_otps int;
  n_attempts int;
begin
  delete from public.phone_otps
   where created_at < now() - interval '2 days';
  get diagnostics n_otps = row_count;

  -- password_reset_attempts exists on the live project but is not created by
  -- schema.sql, so check for it instead of assuming (a fresh test database
  -- would otherwise fail here).
  n_attempts := 0;
  if to_regclass('public.password_reset_attempts') is not null then
    execute 'delete from public.password_reset_attempts where attempted_at < now() - interval ''2 days''';
    get diagnostics n_attempts = row_count;
  end if;

  return jsonb_build_object('otps_deleted', n_otps, 'reset_attempts_deleted', n_attempts, 'ran_at', now());
end;
$$;

-- Nobody signed in to the app (or the public API) may run it; only the
-- database's own scheduler and the owner of the project (SQL editor).
revoke all on function public.housekeeping_daily() from public, anon, authenticated;

-- Schedule it with pg_cron when that extension is available. Wrapped so the
-- same file also loads on a plain local Postgres (used by the tests), where
-- pg_cron does not exist.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'pharma-housekeeping';
    perform cron.schedule('pharma-housekeeping', '30 0 * * *', 'select public.housekeeping_daily()');
  end if;
end
$$;
