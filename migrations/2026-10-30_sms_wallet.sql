-- 2026-10-30 SMS wallet: buy SMS with M-Pesa and see what was used
--
-- Modelled on Kodi's SMS wallet. Each pharmacy has a KES balance; every SMS
-- sent costs sms_platform_config.price_per_sms (KES 1) per 160-character part;
-- a failed send is refunded automatically. A balance is only ever topped up by
-- sms_topup_complete(), which only the server (service role) can call after
-- Safaricom confirms the M-Pesa payment, exactly once per payment.
--
-- The app can read its own wallet but cannot write to any of these tables.
--
-- Safe to run more than once.
begin;

alter table public.sms_platform_config
  add column if not exists price_per_sms numeric(8,2) not null default 1;
update public.sms_platform_config set price_per_sms = 1 where id = 1 and price_per_sms = 2;
alter table public.sms_platform_config drop constraint if exists sms_platform_config_price_check;
alter table public.sms_platform_config add constraint sms_platform_config_price_check check (price_per_sms > 0);

alter table public.sms_log
  add column if not exists cost numeric(8,2) not null default 0,
  add column if not exists refunded boolean not null default false;

-- 1. Tables ------------------------------------------------------------------
create table if not exists public.sms_wallets (
  pharmacy_id uuid primary key references public.pharmacies(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.sms_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  kind text not null check (kind in ('topup', 'sms', 'refund', 'adjust')),
  amount numeric(12,2) not null,            -- KES, negative when SMS are charged
  balance_after numeric(12,2) not null,
  reference text,
  description text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sms_wallet_txn_pharmacy_created
  on public.sms_wallet_transactions (pharmacy_id, created_at desc);

create table if not exists public.sms_topup_requests (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  created_by uuid,
  amount numeric(10,2) not null check (amount > 0),
  sms_count integer,
  phone text,
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'confirmed', 'failed')),
  checkout_request_id text,
  merchant_request_id text,
  mpesa_receipt text,
  result_code integer,
  result_desc text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists idx_sms_topup_pharmacy_created on public.sms_topup_requests (pharmacy_id, created_at desc);
create unique index if not exists uq_sms_topup_checkout on public.sms_topup_requests (checkout_request_id) where checkout_request_id is not null;
create unique index if not exists uq_sms_topup_receipt on public.sms_topup_requests (mpesa_receipt) where mpesa_receipt is not null;

-- 2. Access: read-only for the pharmacy's owner / co-owner / pharmacist --------
alter table public.sms_wallets enable row level security;
alter table public.sms_wallet_transactions enable row level security;
alter table public.sms_topup_requests enable row level security;

drop policy if exists sms_wallets_read on public.sms_wallets;
create policy sms_wallets_read on public.sms_wallets for select to authenticated
  using (pharmacy_id = (select my_pharmacy_id()) and (select my_role()) in ('owner', 'co_owner', 'pharmacist'));
drop policy if exists sms_wallet_txn_read on public.sms_wallet_transactions;
create policy sms_wallet_txn_read on public.sms_wallet_transactions for select to authenticated
  using (pharmacy_id = (select my_pharmacy_id()) and (select my_role()) in ('owner', 'co_owner', 'pharmacist'));
drop policy if exists sms_topup_read on public.sms_topup_requests;
create policy sms_topup_read on public.sms_topup_requests for select to authenticated
  using (pharmacy_id = (select my_pharmacy_id()) and (select my_role()) in ('owner', 'co_owner', 'pharmacist'));

revoke all on public.sms_wallets, public.sms_wallet_transactions, public.sms_topup_requests from public, anon, authenticated;
grant select on public.sms_wallets, public.sms_wallet_transactions, public.sms_topup_requests to authenticated;

-- 3. Credit a paid M-Pesa purchase (server only, exactly once) -----------------
create or replace function public.sms_topup_complete(
  p_checkout_request_id text,
  p_result_code integer,
  p_result_desc text,
  p_receipt text default null,
  p_amount numeric default null,
  p_phone text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_req sms_topup_requests%rowtype;
  v_balance numeric;
begin
  if coalesce(p_checkout_request_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_checkout_id');
  end if;
  select * into v_req from sms_topup_requests where checkout_request_id = p_checkout_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_checkout_id');
  end if;

  -- Already credited: only fill in the receipt if the first answer had none.
  if v_req.status = 'confirmed' then
    if v_req.mpesa_receipt is null and coalesce(p_receipt, '') <> ''
       and not exists (select 1 from sms_topup_requests where mpesa_receipt = p_receipt) then
      update sms_topup_requests set mpesa_receipt = p_receipt where id = v_req.id;
    end if;
    return jsonb_build_object('ok', true, 'already', true, 'status', 'confirmed', 'amount', v_req.amount);
  end if;

  if p_result_code = 0 then
    -- What Safaricom says was paid must cover what this purchase asked for.
    if p_amount is not null and p_amount < v_req.amount then
      update sms_topup_requests
         set status = 'failed', result_code = p_result_code,
             result_desc = 'Amount paid (KES ' || p_amount || ') is less than KES ' || v_req.amount || ' - contact Pharma.',
             mpesa_receipt = nullif(p_receipt, '')
       where id = v_req.id;
      return jsonb_build_object('ok', false, 'reason', 'amount_mismatch', 'status', 'failed');
    end if;
    if coalesce(p_receipt, '') <> '' and exists (select 1 from sms_topup_requests where mpesa_receipt = p_receipt and id <> v_req.id) then
      return jsonb_build_object('ok', false, 'reason', 'receipt_already_used');
    end if;

    update sms_topup_requests
       set status = 'confirmed', paid_at = now(), result_code = 0, result_desc = p_result_desc,
           mpesa_receipt = nullif(p_receipt, '')
     where id = v_req.id;

    insert into sms_wallets (pharmacy_id, balance) values (v_req.pharmacy_id, v_req.amount)
      on conflict (pharmacy_id) do update set balance = sms_wallets.balance + excluded.balance, updated_at = now()
      returning balance into v_balance;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (v_req.pharmacy_id, 'topup', v_req.amount, v_balance,
              coalesce(nullif(p_receipt, ''), v_req.checkout_request_id), 'SMS bought with M-Pesa');
    return jsonb_build_object('ok', true, 'status', 'confirmed', 'amount', v_req.amount, 'balance', v_balance);
  end if;

  -- Not paid (cancelled, wrong PIN, no money, timed out).
  update sms_topup_requests set status = 'failed', result_code = p_result_code, result_desc = p_result_desc
   where id = v_req.id and status <> 'confirmed';
  return jsonb_build_object('ok', true, 'status', 'failed', 'result_code', p_result_code, 'result_desc', p_result_desc);
end;
$function$;

revoke all on function public.sms_topup_complete(text, integer, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.sms_topup_complete(text, integer, text, text, numeric, text) to service_role;

-- 4. Charge for each SMS when it is queued -------------------------------------
-- Same as before, plus: the price comes from sms_platform_config, the wallet
-- is charged per 160-character part, and a message that cannot be paid for
-- stops the batch with a plain message.
create or replace function public.sms_queue(p_pharmacy_id uuid, p_messages jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_msg jsonb;
  v_cust customers%rowtype;
  v_body text;
  v_kind text;
  v_ref uuid;
  v_enabled boolean;
  v_cap integer;
  v_used integer;
  v_queued jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_price numeric;
  v_cost numeric;
  v_balance numeric;
  v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can send SMS';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) = 0 then
    raise exception 'There is nothing to send';
  end if;
  if jsonb_array_length(p_messages) > 50 then
    raise exception 'Send at most 50 messages at a time';
  end if;

  select sms_enabled, sms_daily_cap into v_enabled, v_cap from pharmacies where id = p_pharmacy_id for update;
  if not v_enabled then
    raise exception 'SMS is switched off for this pharmacy (Customers > Messages)';
  end if;
  select coalesce((select price_per_sms from sms_platform_config where id = 1), 1) into v_price;
  select balance into v_balance from sms_wallets where pharmacy_id = p_pharmacy_id for update;
  v_balance := coalesce(v_balance, 0);
  select count(*) into v_used from sms_log
   where pharmacy_id = p_pharmacy_id and created_at >= v_since and status <> 'failed';

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_body := trim(coalesce(v_msg->>'body', ''));
    v_kind := coalesce(v_msg->>'kind', 'custom');
    v_ref := nullif(v_msg->>'ref_id', '')::uuid;
    if v_kind not in ('refill', 'credit', 'custom') then
      raise exception 'Unknown message type';
    end if;
    if v_body = '' or char_length(v_body) > 459 then
      raise exception 'A message must be between 1 and 459 characters';
    end if;

    select * into v_cust from customers
     where id = nullif(v_msg->>'customer_id', '')::uuid and pharmacy_id = p_pharmacy_id;
    if not found then
      raise exception 'Customer not found';
    end if;
    if not v_cust.sms_ok then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'opted_out');
      continue;
    end if;
    if v_cust.phone is null then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'no_phone');
      continue;
    end if;

    if v_kind = 'refill' then
      if v_ref is null or not exists (select 1 from refill_plans
                                       where id = v_ref and pharmacy_id = p_pharmacy_id and customer_id = v_cust.id) then
        raise exception 'That refill was not found for this customer';
      end if;
      if exists (select 1 from refill_plans where id = v_ref and last_reminded_on = today_ke()) then
        v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'already_reminded_today');
        continue;
      end if;
    end if;

    if v_used >= v_cap then
      raise exception 'Daily SMS limit reached (% a day). Try again tomorrow.', v_cap;
    end if;

    -- one part up to 160 characters, then 153 per part
    v_cost := v_price * (case when char_length(v_body) <= 160 then 1 else ceil(char_length(v_body) / 153.0) end);
    if v_balance < v_cost then
      raise exception 'Not enough SMS credit (KES % left). Buy SMS first.', round(v_balance, 2);
    end if;

    insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind, ref_id, created_by, cost)
    values (p_pharmacy_id, v_cust.id, v_cust.phone, v_body, v_kind, v_ref, auth.uid(), v_cost)
    returning id into v_id;
    v_used := v_used + 1;
    v_balance := v_balance - v_cost;
    update sms_wallets set balance = v_balance, updated_at = now() where pharmacy_id = p_pharmacy_id;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (p_pharmacy_id, 'sms', -v_cost, v_balance, v_id::text, 'SMS to ' || v_cust.phone);
    v_queued := v_queued || jsonb_build_object('id', v_id, 'to', v_cust.phone, 'body', v_body);

    if v_kind = 'refill' then
      update refill_plans set last_reminded_on = today_ke() where id = v_ref;
    end if;
  end loop;

  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped,
                            'used_today', v_used, 'daily_cap', v_cap, 'balance', v_balance);
end;
$function$;

-- 5. Refund an SMS that failed to send -----------------------------------------
create or replace function public.sms_refund_failed()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_balance numeric;
begin
  if new.status = 'failed' and old.status is distinct from 'failed' and new.cost > 0 and not new.refunded then
    insert into sms_wallets (pharmacy_id, balance) values (new.pharmacy_id, new.cost)
      on conflict (pharmacy_id) do update set balance = sms_wallets.balance + excluded.balance, updated_at = now()
      returning balance into v_balance;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (new.pharmacy_id, 'refund', new.cost, v_balance, new.id::text, 'SMS not delivered, refunded');
    new.refunded := true;
  end if;
  return new;
end;
$function$;
drop trigger if exists trg_sms_refund_failed on public.sms_log;
create trigger trg_sms_refund_failed before update of status on public.sms_log
  for each row execute function public.sms_refund_failed();
revoke all on function public.sms_refund_failed() from public, anon, authenticated;

-- 6. What the app shows: balance, price and usage ------------------------------
create or replace function public.my_sms_wallet()
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_pid uuid := my_pharmacy_id();
  v_price numeric := coalesce((select price_per_sms from sms_platform_config where id = 1), 1);
  v_balance numeric;
begin
  if v_pid is null or my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Not authorized';
  end if;
  select coalesce((select balance from sms_wallets where pharmacy_id = v_pid), 0) into v_balance;
  return jsonb_build_object(
    'balance', v_balance,
    'price_per_sms', v_price,
    'available_sms', floor(v_balance / v_price),
    'sent_30d', (select count(*) from sms_log where pharmacy_id = v_pid and status <> 'failed' and created_at > now() - interval '30 days'),
    'spent_30d', (select coalesce(sum(cost), 0) from sms_log where pharmacy_id = v_pid and status <> 'failed' and created_at > now() - interval '30 days'),
    'bought_30d', (select coalesce(sum(amount), 0) from sms_wallet_transactions where pharmacy_id = v_pid and kind = 'topup' and created_at > now() - interval '30 days')
  );
end;
$function$;
revoke all on function public.my_sms_wallet() from public, anon;
grant execute on function public.my_sms_wallet() to authenticated;

-- 7. Admin: see and adjust a pharmacy's SMS credit -----------------------------
create or replace function public.admin_sms_wallet(p_pharmacy_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'balance', coalesce((select balance from sms_wallets where pharmacy_id = p_pharmacy_id), 0),
    'price_per_sms', coalesce((select price_per_sms from sms_platform_config where id = 1), 1),
    'sent_30d', (select count(*) from sms_log where pharmacy_id = p_pharmacy_id and status <> 'failed' and created_at > now() - interval '30 days'),
    'sent_all', (select count(*) from sms_log where pharmacy_id = p_pharmacy_id and status <> 'failed'),
    'bought_all', (select coalesce(sum(amount), 0) from sms_wallet_transactions where pharmacy_id = p_pharmacy_id and kind = 'topup'),
    'recent', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from (
        select kind, amount, balance_after, description, created_at
        from sms_wallet_transactions where pharmacy_id = p_pharmacy_id
        order by created_at desc limit 8) t), '[]'::jsonb)
  );
end;
$function$;

-- Add or remove KES credit by hand (positive adds, negative removes).
create or replace function public.admin_adjust_sms_credit(p_pharmacy_id uuid, p_amount numeric, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_balance numeric;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter an amount in KES (negative to remove)'; end if;
  if not exists (select 1 from pharmacies where id = p_pharmacy_id) then raise exception 'Pharmacy not found'; end if;
  insert into sms_wallets (pharmacy_id, balance) values (p_pharmacy_id, 0) on conflict (pharmacy_id) do nothing;
  update sms_wallets set balance = balance + p_amount, updated_at = now()
   where pharmacy_id = p_pharmacy_id returning balance into v_balance;
  insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, description)
    values (p_pharmacy_id, 'adjust', p_amount, v_balance, coalesce(nullif(trim(p_note), ''), 'Adjusted by Pharma'));
  return jsonb_build_object('ok', true, 'balance', v_balance);
exception when check_violation then
  raise exception 'That would take the balance below zero';
end;
$function$;

revoke all on function public.admin_sms_wallet(uuid) from public, anon;
revoke all on function public.admin_adjust_sms_credit(uuid, numeric, text) from public, anon;
grant execute on function public.admin_sms_wallet(uuid) to authenticated;
grant execute on function public.admin_adjust_sms_credit(uuid, numeric, text) to authenticated;

commit;
