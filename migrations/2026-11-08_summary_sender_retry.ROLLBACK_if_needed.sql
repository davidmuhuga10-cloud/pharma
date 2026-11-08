-- Undo 2026-11-08_summary_sender_retry.sql. Run only if the retry job misbehaves.
-- The nightly queueing is unaffected; messages then wait for the nightly nudge as before.
-- pg_net is left installed (other things may use it).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'pharma-summary-drain') then
      perform cron.unschedule('pharma-summary-drain');
    end if;
  end if;
end $$;
drop function if exists public.nudge_summary_sender();
