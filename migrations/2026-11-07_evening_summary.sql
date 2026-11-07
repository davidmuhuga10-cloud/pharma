-- 2026-11-07 (night, later still): the evening summary SMS.
--
-- A short text at the end of the day: today's sales, whether the cash drawer was closed and by
-- how much, and how much stock is low or expiring. Off for every pharmacy until the owner turns
-- it on, sets a phone number, and picks which parts to include - nothing is forced on anyone.
--
-- What is new (no existing row is edited):
--   * pharmacies.evening_summary_enabled, evening_summary_phone, evening_summary_sections: off,
--     empty, and all three parts selected, for every pharmacy, old and new.
--   * evening_summary_text(): builds the message from only the parts chosen.
--   * queue_evening_summary_now(): the owner's "Send a test now" button. Same checks as every
--     other message (SMS must be on, the daily limit, one summary a day).
--   * queue_evening_summaries(): the automatic nightly sweep, run once a day by the database's
--     own scheduler (pg_cron) at 18:30 Nairobi time. It only queues the message; sending it is
--     a best-effort nudge to the SMS sender (see note below) wrapped so a missing or broken
--     nudge never stops the message being queued correctly.
--   * sms_log accepts the new kind 'summary'.
--
-- A note on the automatic send: the nightly sweep queues the message in the same table and the
-- same way a person sending a message does, then asks the SMS sender to go look for new messages
-- (through pg_net, Postgres's own way of making a web request, only if that extension is
-- available). This part reaches outside the database, so unlike everything else in this file it
-- cannot be rehearsed here - the first real evening is the real test. Turn it on for one
-- pharmacy first and check the message arrives before telling others about it.

alter table public.pharmacies add column if not exists evening_summary_enabled boolean not null default false;
alter table public.pharmacies add column if not exists evening_summary_phone text;
alter table public.pharmacies add column if not exists evening_summary_sections text[] not null default array['sales', 'cash', 'stock'];

alter table public.sms_log drop constraint if exists sms_log_kind_check;
alter table public.sms_log add constraint sms_log_kind_check check (kind in ('refill', 'credit', 'custom', 'summary'));

grant update (evening_summary_enabled, evening_summary_phone, evening_summary_sections) on public.pharmacies to authenticated;

-- A phone number as typed in Settings, turned into the digits an SMS provider wants
-- (2547XXXXXXXX / 2541XXXXXXXX). null when it does not look like a real number.
create or replace function public.evening_summary_normalize_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if left(d, 1) = '0' and length(d) = 10 and left(d, 2) in ('07', '01') then return '254' || substring(d from 2); end if;
  if left(d, 3) = '254' and length(d) = 12 then return d; end if;
  if length(d) = 9 and left(d, 1) in ('7', '1') then return '254' || d; end if;
  return null;
end;
$$;

-- Keep only a usable phone number; a typo or an empty field turns the feature off rather than
-- queuing a message nobody can receive.
create or replace function public.evening_summary_guard_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.evening_summary_phone is not null then
    NEW.evening_summary_phone := evening_summary_normalize_phone(NEW.evening_summary_phone);
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_evening_summary_guard_phone on public.pharmacies;
create trigger trg_evening_summary_guard_phone
  before insert or update of evening_summary_phone on public.pharmacies
  for each row execute function evening_summary_guard_phone();

-- Builds today's message from only the sections the pharmacy picked. Returns null when there is
-- nothing to say (every chosen section is empty), so an empty message is never sent.
create or replace function public.evening_summary_text(p_pharmacy_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sections text[];
  v_start timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
  v_sale_count integer; v_sale_total numeric;
  v_closing record;
  v_low integer; v_expiring integer;
  v_parts text[] := '{}';
begin
  select evening_summary_sections into v_sections from pharmacies where id = p_pharmacy_id;
  if v_sections is null then v_sections := array['sales', 'cash', 'stock']; end if;

  -- worked out regardless of which sections are chosen: the cash section below uses it too,
  -- to decide whether a drawer that was never closed today is worth mentioning
  select count(*), coalesce(sum(total_amount), 0) into v_sale_count, v_sale_total
    from sales where pharmacy_id = p_pharmacy_id and not voided and sold_at >= v_start;

  if 'sales' = any(v_sections) and v_sale_count > 0 then
    v_parts := array_append(v_parts, v_sale_count || (case when v_sale_count = 1 then ' sale, ' else ' sales, ' end) || 'KES ' || trim(to_char(v_sale_total, '999,999,999')));
  end if;

  if 'cash' = any(v_sections) then
    select * into v_closing from cash_closings where pharmacy_id = p_pharmacy_id and closed_at >= v_start order by closed_at desc limit 1;
    if found then
      v_parts := array_append(v_parts, 'Cash drawer closed, ' || (case when abs(v_closing.difference) < 0.005 then 'exact' when v_closing.difference < 0 then 'short KES ' || trim(to_char(abs(v_closing.difference), '999,999,999')) else 'over KES ' || trim(to_char(v_closing.difference, '999,999,999')) end));
    elsif v_sale_count > 0 then
      -- only worth flagging when someone actually sold something today and never closed the
      -- drawer; a quiet day with no sales and no closing is not something to report
      v_parts := array_append(v_parts, 'Cash drawer not closed yet');
    end if;
  end if;

  if 'stock' = any(v_sections) then
    select count(*) filter (where qty_in_stock <= reorder_level), count(*) filter (where soonest_expiry is not null and soonest_expiry <= current_date + 30)
      into v_low, v_expiring
      from v_drug_stock where pharmacy_id = p_pharmacy_id;
    if coalesce(v_low, 0) > 0 or coalesce(v_expiring, 0) > 0 then
      v_parts := array_append(v_parts, coalesce(v_low, 0) || ' low on stock, ' || coalesce(v_expiring, 0) || ' expiring within 30 days');
    end if;
  end if;

  if array_length(v_parts, 1) is null then return null; end if;
  return (select name from pharmacies where id = p_pharmacy_id) || ' - end of day: ' || array_to_string(v_parts, '. ') || '.';
end;
$$;
revoke all on function public.evening_summary_text(uuid) from public, anon;
grant execute on function public.evening_summary_text(uuid) to authenticated;

-- One pharmacy, right now: the daily cap, "already sent today" and the usual kind check, then one
-- row in sms_log. Returns the same shape as sms_queue() so the app and the send-sms Edge Function
-- handle it exactly the same way.
create or replace function public.queue_evening_summary_now(p_pharmacy_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean; v_cap integer; v_used integer; v_phone text; v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
  v_body text; v_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can send the evening summary';
  end if;
  select sms_enabled, sms_daily_cap, evening_summary_phone into v_enabled, v_cap, v_phone from pharmacies where id = p_pharmacy_id for update;
  if not v_enabled then
    raise exception 'SMS is switched off for this pharmacy (Customers > Messages)';
  end if;
  if v_phone is null then
    raise exception 'Add a phone number for the evening summary first';
  end if;
  if exists (select 1 from sms_log where pharmacy_id = p_pharmacy_id and kind = 'summary' and created_at >= v_since and status <> 'failed') then
    raise exception 'Today''s summary was already sent';
  end if;
  select count(*) into v_used from sms_log where pharmacy_id = p_pharmacy_id and created_at >= v_since and status <> 'failed';
  if v_used >= v_cap then
    raise exception 'Daily SMS limit reached (% a day). Try again tomorrow.', v_cap;
  end if;
  v_body := evening_summary_text(p_pharmacy_id);
  if v_body is null then
    raise exception 'There is nothing to report yet today';
  end if;
  insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind, created_by)
  values (p_pharmacy_id, null, v_phone, v_body, 'summary', auth.uid())
  returning id into v_id;
  return jsonb_build_object('queued', jsonb_build_array(jsonb_build_object('id', v_id, 'to', v_phone, 'body', v_body)),
                            'skipped', '[]'::jsonb, 'used_today', v_used + 1, 'daily_cap', v_cap);
end;
$$;
revoke all on function public.queue_evening_summary_now(uuid) from public, anon;
grant execute on function public.queue_evening_summary_now(uuid) to authenticated;

-- Every pharmacy that turned the summary on, once a day, run by pg_cron (see below). Only the
-- database's own scheduler may call it - nobody signed in to the app can. Any one pharmacy's
-- problem (a bad phone, SMS off, over the cap) is skipped, never stops the others.
create or replace function public.queue_evening_summaries()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
  v_ph record; v_used integer; v_body text; v_count integer := 0;
  v_url text; v_secret text;
begin
  for v_ph in select id, sms_daily_cap, evening_summary_phone from pharmacies
               where evening_summary_enabled and sms_enabled and evening_summary_phone is not null
  loop
    continue when exists (select 1 from sms_log where pharmacy_id = v_ph.id and kind = 'summary' and created_at >= v_since and status <> 'failed');
    select count(*) into v_used from sms_log where pharmacy_id = v_ph.id and created_at >= v_since and status <> 'failed';
    continue when v_used >= v_ph.sms_daily_cap;
    v_body := evening_summary_text(v_ph.id);
    continue when v_body is null;
    insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind) values (v_ph.id, null, v_ph.evening_summary_phone, v_body, 'summary');
    v_count := v_count + 1;
  end loop;

  -- Best-effort nudge to the sender. A missing extension, a missing secret, or any error here
  -- never stops the queuing above - the messages above are already safely queued either way.
  if v_count > 0 then
    begin
      select decrypted_secret into v_url from vault.decrypted_secrets where name = 'pharma_cron_sender_url';
      select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'pharma_cron_shared_secret';
      if v_url is not null and v_secret is not null then
        perform net.http_post(url := v_url, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret), body := '{}'::jsonb);
      end if;
    exception when others then
      null; -- queuing already succeeded; the nightly cron will try the nudge again next time
    end;
  end if;
  return v_count;
end;
$$;
revoke all on function public.queue_evening_summaries() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'pharma-evening-summary';
    perform cron.schedule('pharma-evening-summary', '30 15 * * *', 'select public.queue_evening_summaries()');  -- 18:30 Nairobi time
  end if;
end
$$;
