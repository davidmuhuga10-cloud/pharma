-- 2026-11-10_claim_queued_sms.ROLLBACK_if_needed.sql
--
-- Undoes 2026-11-10_claim_queued_sms.sql.
--
-- *** ORDER MATTERS ***
--   1. FIRST redeploy the OLD send-queued-summaries edge function (the one
--      that selects status='queued' rows directly).
--   2. THEN run this.
-- The other way round, the deployed sender calls claim_queued_summaries(),
-- which this drops, and no evening summaries go out at all.
--
-- Running this restores the double-send bug it was written to fix: two senders
-- firing at once will again read the same rows and send the same messages
-- twice. The cron jobs still collide at 15:30 UTC, so that is a live risk, not
-- a theoretical one. Do not run this unless the claim itself is causing a
-- worse problem.
--
-- Any message sitting in 'sending' when this runs would become invalid under
-- the narrowed constraint, so those are put back to 'queued' first. They will
-- be sent by the next nudge. A message that was mid-flight at the provider
-- when its row was re-queued may therefore be sent twice - unavoidable when
-- removing the mechanism that prevents exactly that.
--
-- No message is deleted. claimed_at is dropped, so the record of when each row
-- was picked up is lost.
--
-- Applies in one transaction.

begin;

-- Nothing may be in flight when 'sending' stops being a legal status.
update public.sms_log
   set status = 'queued',
       claimed_at = null,
       error = 'Re-queued while removing the claim mechanism.'
 where status = 'sending';

drop function if exists public.claim_queued_summaries(integer);
drop function if exists public.requeue_stalled_summaries(interval);

-- nudge_summary_sender() back to the version without the sweeper call.
create or replace function public.nudge_summary_sender()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_queued integer;
  v_url text;
  v_secret text;
begin
  select count(*) into v_queued from sms_log where kind = 'summary' and status = 'queued';
  if v_queued = 0 then return 0; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'pharma_cron_sender_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'pharma_cron_shared_secret';
  if v_url is null or v_secret is null then return v_queued; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb
  );
  return v_queued;
end;
$function$;

revoke all on function public.nudge_summary_sender() from public, anon, authenticated;

drop index if exists public.sms_log_queue_idx;
alter table public.sms_log drop column if exists claimed_at;

-- Back to the three original statuses.
alter table public.sms_log drop constraint if exists sms_log_status_check;
alter table public.sms_log add constraint sms_log_status_check
  check (status = any (array['queued'::text, 'sent'::text, 'failed'::text]));

do $guard$
declare n integer;
begin
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public'
                and p.proname in ('claim_queued_summaries','requeue_stalled_summaries'))
  then raise exception 'the claim/sweep functions are still present'; end if;

  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='sms_log' and column_name='claimed_at')
  then raise exception 'sms_log.claimed_at is still present'; end if;

  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'public.sms_log'::regclass and conname = 'sms_log_status_check') ~ 'sending'
  then raise exception 'sms_log_status_check still allows ''sending'''; end if;

  select count(*) into n from public.sms_log where status not in ('queued','sent','failed');
  if n <> 0 then raise exception '% row(s) hold a status that is no longer legal', n; end if;

  raise notice 'sms claim rollback: all 4 checks passed';
end
$guard$;

commit;
