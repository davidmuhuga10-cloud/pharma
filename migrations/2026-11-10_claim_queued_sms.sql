-- 2026-11-10_claim_queued_sms.sql
--
-- WHY
-- ---
-- The evening-summary queue can send the same message twice.
--
-- send-queued-summaries (the edge function) picks work up like this:
--
--     select id, to_phone, body from sms_log
--      where kind = 'summary' and status = 'queued'
--      order by created_at limit 100
--
-- ...then calls the SMS provider, and only afterwards marks each row 'sent'.
-- Nothing reserves those rows in between. Two invocations running at the same
-- time therefore read the SAME hundred rows and both send them.
--
-- That is not hypothetical. The two cron jobs collide by construction:
--
--     jobid 3   30 15 * * *        queue_evening_summaries()   <- also nudges the sender
--     jobid 4   */5 15-16 * * *    nudge_summary_sender()      <- fires at :30 as well
--
-- At 15:30 UTC every day both run in the same minute, and both post to the
-- edge function. It has not been noticed because only one summary message has
-- ever been sent on this project - there is no production history yet. With
-- real pharmacies it means owners get the same evening summary twice and the
-- SMS bill is paid twice.
--
-- WHAT THIS DOES
-- --------------
-- Adds the step that is missing: claiming. A worker atomically moves rows from
-- 'queued' to 'sending' and is handed only the rows IT claimed, using
--
--     for update skip locked
--
-- which is the standard Postgres queue pattern: two concurrent claims get
-- disjoint sets instead of the same one. Overlap stops being a correctness
-- problem - it just means the work is shared out.
--
-- Rows in flight need a way back, or a worker that dies mid-send would strand
-- them in 'sending' for ever. claimed_at records when a row was taken, and
-- requeue_stalled_summaries() puts anything in flight for more than 15 minutes
-- back to 'queued' so the next nudge picks it up. That is the "fail safely,
-- recover fast" half: a crashed sender costs a delay, not a lost message.
--
-- nudge_summary_sender() gains one line to run that sweeper before it counts
-- the queue. It already runs every 5 minutes, so no new schedule is needed.
-- Counting only 'queued' also means it stops nudging while a send is genuinely
-- in flight, which reduces the pile-up that caused the overlap.
--
-- *** ORDER MATTERS - READ THIS ***
-- Apply in this order, or summaries stop going out until both halves are in:
--   1. This migration.
--   2. Deploy the updated send-queued-summaries edge function (it must call
--      claim_queued_summaries() instead of selecting 'queued' rows directly).
-- Between the two steps the old edge function keeps working: it still selects
-- 'queued' rows, so nothing breaks - it simply is not protected yet. Deploying
-- the new function BEFORE this migration would break it, because
-- claim_queued_summaries() would not exist.
--
-- Nothing is deleted. No existing row changes meaning: 'queued', 'sent' and
-- 'failed' keep their current behaviour and 'sending' is new.
--
-- Applies in one transaction.

begin;

-- ---------------------------------------------------------------------------
-- 1. Let a row say it is in flight.
--
-- sms_log.status is constrained to queued/sent/failed, so 'sending' has to be
-- allowed before anything can claim a row. Found the hard way: the first draft
-- of this migration passed all of its own structural checks and then failed at
-- the first real claim with "violates check constraint sms_log_status_check".
-- Structural checks are not behavioural ones - tests/sms-claim.sql is what
-- actually exercises this.
-- ---------------------------------------------------------------------------
alter table public.sms_log drop constraint if exists sms_log_status_check;
alter table public.sms_log add constraint sms_log_status_check
  check (status = any (array['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text]));

alter table public.sms_log
  add column if not exists claimed_at timestamptz;

comment on column public.sms_log.claimed_at is
  'When a sender claimed this row (status went to ''sending''). Used by requeue_stalled_summaries() to recover messages from a worker that died mid-send. Null unless the row is, or has been, in flight.';

-- Makes both the claim and the sweeper index-only rather than scanning the
-- whole log as it grows.
create index if not exists sms_log_queue_idx
  on public.sms_log (kind, status, created_at)
  where status in ('queued', 'sending');

-- ---------------------------------------------------------------------------
-- 2. The claim. This is the whole fix.
-- ---------------------------------------------------------------------------
create or replace function public.claim_queued_summaries(p_limit integer default 100)
returns table (id uuid, to_phone text, body text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500';
  end if;

  -- "for update skip locked" is what makes this safe under concurrency: a
  -- second worker running at the same moment skips the rows this one has
  -- locked rather than waiting for them or, worse, reading them too. Each
  -- worker therefore gets its own disjoint batch.
  return query
  update public.sms_log l
     set status = 'sending',
         claimed_at = now()
   where l.id in (
     select c.id
       from public.sms_log c
      where c.kind = 'summary'
        and c.status = 'queued'
      order by c.created_at
      limit p_limit
      for update skip locked
   )
  returning l.id, l.to_phone, l.body;
end;
$function$;

-- Only the server-side sender may claim work. The browser must never see this.
revoke all on function public.claim_queued_summaries(integer) from public, anon, authenticated;
grant execute on function public.claim_queued_summaries(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Recovery: a worker that dies mid-send must not strand its messages.
-- ---------------------------------------------------------------------------
create or replace function public.requeue_stalled_summaries(p_older_than interval default interval '15 minutes')
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  -- 15 minutes is comfortably longer than the edge function's own ~110 second
  -- budget, so this can only ever catch a send that really is dead, never one
  -- still working.
  update public.sms_log
     set status = 'queued',
         claimed_at = null,
         error = 'Sending was interrupted; re-queued automatically.'
   where kind = 'summary'
     and status = 'sending'
     and claimed_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.requeue_stalled_summaries(interval) from public, anon, authenticated;
grant execute on function public.requeue_stalled_summaries(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Run the sweeper from the nudge that already runs every 5 minutes.
--    Body is otherwise unchanged from what is running now.
-- ---------------------------------------------------------------------------
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
  -- Added 2026-11-10: put back anything a dead sender left in flight, before
  -- deciding whether there is work to do. Costs nothing when there is none.
  perform public.requeue_stalled_summaries();

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

-- ---------------------------------------------------------------------------
-- 5. Prove it before committing.
-- ---------------------------------------------------------------------------
do $guard$
declare n integer;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='sms_log' and column_name='claimed_at')
  then raise exception 'sms_log.claimed_at was not created'; end if;

  -- the status constraint must now permit 'sending', or no row can be claimed
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'public.sms_log'::regclass and conname = 'sms_log_status_check')
     !~ 'sending'
  then raise exception 'sms_log_status_check still does not allow ''sending'''; end if;

  -- and the four states it must allow, no more
  select count(*) into n from unnest(array['queued','sending','sent','failed']) s
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.sms_log'::regclass and conname = 'sms_log_status_check') like '%' || s || '%';
  if n <> 4 then raise exception 'sms_log_status_check is missing one of the four states (matched %)', n; end if;

  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='sms_log_queue_idx')
  then raise exception 'sms_log_queue_idx was not created'; end if;

  -- the claim must use SKIP LOCKED, or it does not fix anything
  if pg_get_functiondef('public.claim_queued_summaries(integer)'::regprocedure)
       !~* 'for update skip locked'
  then raise exception 'claim_queued_summaries is missing "for update skip locked"'; end if;

  -- the nudge must call the sweeper
  if pg_get_functiondef('public.nudge_summary_sender()'::regprocedure)
       !~* 'requeue_stalled_summaries'
  then raise exception 'nudge_summary_sender does not call the sweeper'; end if;

  -- neither new function may be reachable from the browser
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.proname in ('claim_queued_summaries','requeue_stalled_summaries')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));
  if n <> 0 then raise exception '% new function(s) are reachable by anon/authenticated', n; end if;

  raise notice 'sms claim migration: all 5 checks passed';
end
$guard$;

commit;
