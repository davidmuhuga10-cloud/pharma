-- Evening-summary queue: claiming, and recovery from a dead sender.
--
-- WHAT THIS GUARDS
-- Before 10 November 2026 the sender picked work up with a plain
--   select ... where status = 'queued' limit 100
-- and only marked rows 'sent' after calling the provider. Two senders running
-- at the same time read the SAME rows and both sent them. The two cron jobs
-- collide at 15:30 UTC every day by construction (queue_evening_summaries
-- nudges, and nudge_summary_sender fires at :30 too), so this was reachable -
-- it simply had not been noticed, because only one summary had ever been sent.
--
-- claim_queued_summaries() now moves rows to 'sending' with
-- "for update skip locked", so concurrent senders get disjoint batches.
--
-- THE CONCURRENCY PART CANNOT BE TESTED FROM ONE CONNECTION. Two overlapping
-- transactions are needed, so run tests/sms-claim.sh instead of this file on
-- its own. This file holds the single-connection checks and the fixture.
--
-- HOW TO RUN (never against production):
--   createdb hodhi_test
--   psql hodhi_test -f tests/00_auth_stub.sql
--   psql hodhi_test -f schema.sql
--   psql hodhi_test -f migrations/2026-11-10_claim_queued_sms.sql
--   bash tests/sms-claim.sh                 # includes this file

\set ON_ERROR_STOP on

create table if not exists _claim_audit (worker text, sms_id uuid);

-- Fixture: one pharmacy, ten queued summaries.
do $fix$
declare o uuid; ph uuid;
begin
  delete from _claim_audit;
  delete from sms_log where kind = 'summary';
  insert into auth.users default values returning id into o;
  perform test_set_user(o);
  ph := bootstrap_pharmacy('SMS Claim Test', 'Owner', '0700000055');
  insert into sms_log (pharmacy_id, to_phone, body, kind, status, cost)
  select ph, '254700000' || lpad(i::text, 3, '0'), 'summary ' || i, 'summary', 'queued', 1
    from generate_series(1, 10) i;
end
$fix$;

-- ---------------------------------------------------------------------------
-- Single-connection checks
-- ---------------------------------------------------------------------------
create temp table r (n int generated always as identity, ok boolean, label text);

do $t$
declare n int; m int;
begin
  -- 'sending' must be an allowed status, or nothing can be claimed at all.
  -- (The first draft of the migration missed this and failed on the first
  -- real claim.)
  begin
    update sms_log set status = 'sending'
     where id = (select id from sms_log where kind='summary' limit 1);
    insert into r (ok, label) values (true, 'sms_log.status accepts ''sending''');
    update sms_log set status = 'queued' where status = 'sending';
  exception when check_violation then
    insert into r (ok, label) values (false,
      'sms_log.status REJECTS ''sending'' - the claim cannot work (widen sms_log_status_check)');
  end;

  -- a claim hands back exactly what it asked for, and moves those rows
  select count(*) into n from claim_queued_summaries(4);
  insert into r (ok, label) values (n = 4, 'claim_queued_summaries(4) returns 4 rows (got ' || n || ')');

  select count(*) into n from sms_log where kind='summary' and status='sending';
  insert into r (ok, label) values (n = 4, 'those 4 rows are now in flight (got ' || n || ')');

  select count(*) into n from sms_log where kind='summary' and status='queued';
  insert into r (ok, label) values (n = 6, '6 remain queued (got ' || n || ')');

  select count(*) into n from sms_log where status='sending' and claimed_at is null;
  insert into r (ok, label) values (n = 0, 'every claimed row records when it was claimed');

  -- a claim never returns the same row twice
  select count(*) into n from claim_queued_summaries(100);
  select count(*) into m from sms_log where kind='summary' and status='sending';
  insert into r (ok, label) values (n = 6, 'a second claim takes only the 6 still queued (got ' || n || ')');
  insert into r (ok, label) values (m = 10, 'all 10 are now in flight, none twice (got ' || m || ')');

  select count(*) into n from claim_queued_summaries(100);
  insert into r (ok, label) values (n = 0, 'claiming an empty queue returns nothing (got ' || n || ')');

  -- a send still in progress must not be swept back
  select requeue_stalled_summaries() into n;
  insert into r (ok, label) values (n = 0,
    'the sweeper leaves a send that is still in progress alone (swept ' || n || ')');

  -- a dead sender's rows must come back
  update sms_log set claimed_at = now() - interval '30 minutes' where status = 'sending';
  select requeue_stalled_summaries() into n;
  insert into r (ok, label) values (n = 10, 'the sweeper re-queues all 10 from a dead sender (got ' || n || ')');

  select count(*) into n from sms_log where kind='summary' and status='queued';
  insert into r (ok, label) values (n = 10, 'all 10 are queued again and will be retried (got ' || n || ')');

  select count(*) into n from sms_log where status='queued' and claimed_at is not null;
  insert into r (ok, label) values (n = 0, 're-queued rows no longer look claimed');

  -- limits
  begin
    perform claim_queued_summaries(0);
    insert into r (ok, label) values (false, 'claim_queued_summaries(0) should be refused');
  exception when others then
    insert into r (ok, label) values (true, 'claim_queued_summaries refuses a nonsense limit');
  end;

  -- the browser must never be able to claim or sweep work
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.proname in ('claim_queued_summaries','requeue_stalled_summaries')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));
  insert into r (ok, label) values (n = 0,
    'neither claim nor sweep is reachable by anon or authenticated (found ' || n || ')');

  -- the nudge must sweep before it counts, or a dead sender blocks the queue
  insert into r (ok, label) values (
    pg_get_functiondef('public.nudge_summary_sender()'::regprocedure) ~* 'requeue_stalled_summaries',
    'nudge_summary_sender() runs the sweeper before counting the queue');
end
$t$;

select case when ok then '  PASS  ' else '  FAIL  ' end || label as result from r order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as summary from r;

do $$
declare n int;
begin
  select count(*) into n from r where not ok;
  if n > 0 then raise exception '% CHECK(S) FAILED', n; end if;
end $$;

-- leave the queue full for the concurrency part in tests/sms-claim.sh
update sms_log set status = 'queued', claimed_at = null where kind = 'summary';
