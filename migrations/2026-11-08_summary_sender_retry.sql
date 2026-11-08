-- 2026-11-08: evening summary sender - make it drain the whole queue and retry.
--
-- Already applied to the live project (as three migrations); recorded here so a rebuilt project
-- ends up identical. Safe to run again.
--
-- Why: the nightly job queued the summary messages and nudged the sender once. The sender handled
-- at most 200 messages per call, and if the nudge failed (or more than 200 were queued) the rest
-- stayed 'queued' until the next night. pg_net, which the nudge needs, was also not installed.
--
-- 1. pg_net, in the "extensions" schema (not "public").
-- 2. nudge_summary_sender(): if any summary is still queued, call the sender again.
-- 3. pg_cron job pharma-summary-drain: every 5 minutes between 15:00 and 16:59 UTC (18:00-19:59
--    Nairobi), when the nightly queue is being sent. It does nothing when the queue is empty.
--
-- The sender itself (supabase/functions/send-queued-summaries, version 3) loops in rounds of 100
-- inside a 110 second budget, so one nudge normally empties the queue.
--
-- Needs the two vault secrets described in the edge function header:
--   pharma_cron_sender_url, pharma_cron_shared_secret

-- Guarded so a plain Postgres (the local test database) can still load this file.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;

create or replace function public.nudge_summary_sender()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_queued integer;
  v_url    text;
  v_secret text;
begin
  select count(*) into v_queued from sms_log where kind = 'summary' and status = 'queued';
  if v_queued = 0 then return 0; end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'pharma_cron_sender_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'pharma_cron_shared_secret';
  if v_url is null or v_secret is null then return v_queued; end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body    := '{}'::jsonb
  );
  return v_queued;
end;
$$;

revoke all on function public.nudge_summary_sender() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'pharma-summary-drain') then
      perform cron.unschedule('pharma-summary-drain');
    end if;
    perform cron.schedule('pharma-summary-drain', '*/5 15-16 * * *', 'select public.nudge_summary_sender()');
  end if;
end $$;
