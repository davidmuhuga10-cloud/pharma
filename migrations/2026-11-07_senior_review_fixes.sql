-- 2026-11-07 Senior review fixes (security + speed)
--
-- Found by a full review of the database as it stands after the 30 Oct work.
-- Every fix is checked on a throwaway copy first (tests/run_tests.js section
-- "Senior review fixes 7 Nov"). Nothing here deletes or rewrites pharmacy
-- data. Safe to run more than once.
--
--  A. CRITICAL - a pharmacy owner could give their own pharmacy a free
--     subscription. The owner may update their own `pharmacies` row, and the
--     table-wide UPDATE right covered subscription_expires_at,
--     subscription_status and activated_at, so one request from the browser
--     console ("update pharmacies set subscription_expires_at = '2099-01-01'")
--     skipped the 90-day trial and every payment. Fixed twice over: the app
--     role may now update only the nine settings columns the Settings screen
--     really saves, AND a trigger refuses billing / counter changes from the
--     app role even if someone re-grants UPDATE later. The admin portal and
--     the M-Pesa / invoice functions run with their own rights and are not
--     affected.
--  B. HIGH - staff invite codes were 6 characters from md5(random()) (about
--     16 million values, not cryptographically random) and joining has no
--     limit on wrong guesses, so a signed-in stranger could script guesses
--     until one matched an unused invite and land inside someone else's
--     pharmacy. New codes are 10 characters from the database's secure random
--     generator (about a trillion values). Codes already handed out keep
--     working until they expire (7 days), so nobody's pending invite breaks.
--  C. HIGH - one-time-code (SMS) checks: wrong guesses were counted by
--     reading the row, then writing attempts + 1 - so many guesses sent at the
--     same instant were all counted as "attempt 1" and the 5-guess limit could
--     be bypassed. otp_check() does the check and the count in one locked
--     step. otp_issue() likewise makes the resend / per-number / per-IP /
--     platform-wide limits atomic, which also stops "SMS pumping" (a script
--     asking for codes for thousands of numbers to drain the SMS balance).
--  D. MEDIUM - the stock list view (v_drug_stock) scanned every depleted batch
--     a drug had ever had. Same numbers, but it now reads only batches that
--     still hold stock: 3-4x faster for a 3,000-product pharmacy and the gap
--     widens every year as history piles up.
--  E. MEDIUM - password_reset_attempts exists on the live project but was
--     never in schema.sql, so a rebuilt / branch database had a broken
--     "forgot password". Created here (does nothing where it already exists).
--  F. LOW - 6 indexes that were exact duplicates of the start of a bigger
--     index. They only slowed every sale / restock / expense down.
--  G. auth_user_id_for_email(): the password-reset function found an account
--     by downloading up to 20,000 users page by page. One indexed lookup now.
begin;

-- ---------------------------------------------------------------------------
-- A. Billing and counters are not the pharmacy's to edit
-- ---------------------------------------------------------------------------
revoke update on public.pharmacies from authenticated;
grant update (name, address, town, phone, email, kra_pin,
              low_stock_default, expiry_warn_days, vat_rate)
  on public.pharmacies to authenticated;

create or replace function public.protect_pharmacy_billing()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- current_user is the database role running the statement: 'authenticated'
  -- for a request from the app, but the function owner inside our own
  -- security-definer functions (admin_*, record_sale, sms_topup_complete ...),
  -- which are the only places these columns may change.
  if current_user in ('authenticated', 'anon') and (
       new.subscription_expires_at is distinct from old.subscription_expires_at
    or new.subscription_status     is distinct from old.subscription_status
    or new.activated_at            is distinct from old.activated_at
    or new.next_invoice_no         is distinct from old.next_invoice_no
    or new.next_lpo_no             is distinct from old.next_lpo_no
    or new.sms_enabled             is distinct from old.sms_enabled
    or new.sms_daily_cap           is distinct from old.sms_daily_cap
  ) then
    raise exception 'Plan, invoice numbers and SMS settings can only be changed by Pharma support';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_protect_pharmacy_billing on public.pharmacies;
create trigger trg_protect_pharmacy_billing
  before update on public.pharmacies
  for each row execute function public.protect_pharmacy_billing();

-- ---------------------------------------------------------------------------
-- B. Staff invite codes: 10 characters, cryptographically random
-- ---------------------------------------------------------------------------
create or replace function public.create_staff_invite(p_pharmacy_id uuid, p_role user_role, p_expires_hours integer default null::integer)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_code text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() or my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the pharmacy owner can invite staff';
  end if;
  if p_role = 'owner' then
    raise exception 'Cannot invite another owner';
  end if;
  if p_role = 'accountant' and (p_expires_hours is null or p_expires_hours <= 0) then
    raise exception 'An accountant''s account must have a time limit';
  end if;
  if p_expires_hours is not null and p_expires_hours <= 0 then
    raise exception 'The time limit must be greater than zero hours';
  end if;

  -- gen_random_uuid() is the database's secure random generator; the first 12
  -- hex characters of a version-4 uuid are all random (40 bits).
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  insert into staff_invites (pharmacy_id, code, role, created_by, account_expires_hours)
  values (p_pharmacy_id, v_code, p_role, auth.uid(), p_expires_hours);

  return v_code;
end;
$function$;

-- ---------------------------------------------------------------------------
-- E. password_reset_attempts (already live; make schema.sql match)
-- ---------------------------------------------------------------------------
create table if not exists public.password_reset_attempts (
  id           bigint generated always as identity primary key,
  phone_key    text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists password_reset_attempts_phone_time
  on public.password_reset_attempts (phone_key, attempted_at desc);
alter table public.password_reset_attempts enable row level security;
revoke all on public.password_reset_attempts from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- C. One-time codes: atomic limits and atomic checking (server-side only)
-- ---------------------------------------------------------------------------
alter table public.phone_otps add column if not exists ip text;
create index if not exists idx_phone_otps_ip_time on public.phone_otps (ip, created_at desc) where ip is not null;
create index if not exists idx_phone_otps_created on public.phone_otps (created_at desc);

-- Records a new code if every limit allows it; says why not otherwise.
create or replace function public.otp_issue(
  p_phone text, p_purpose text, p_code_hash text,
  p_ip text default null,
  p_ttl_seconds integer default 300,
  p_cooldown_seconds integer default 30,
  p_phone_max integer default 5,
  p_phone_window_seconds integer default 900,
  p_ip_max integer default 10,
  p_global_max integer default 300
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_last timestamptz;
  v_count integer;
begin
  -- one request at a time per number + purpose, so two taps at the same
  -- instant cannot both slip past the cooldown
  perform pg_advisory_xact_lock(hashtextextended('otp:' || p_phone || ':' || p_purpose, 0));

  select max(created_at), count(*) into v_last, v_count
    from phone_otps
   where phone = p_phone and purpose = p_purpose
     and created_at > now() - make_interval(secs => p_phone_window_seconds);

  if v_last is not null and v_last > now() - make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object('ok', false, 'reason', 'cooldown',
      'wait_seconds', greatest(1, ceil(extract(epoch from (v_last + make_interval(secs => p_cooldown_seconds) - now())))::integer));
  end if;
  if v_count >= p_phone_max then
    return jsonb_build_object('ok', false, 'reason', 'phone_limit');
  end if;
  if p_ip is not null and p_ip <> '' and
     (select count(*) from phone_otps where ip = p_ip and created_at > now() - interval '1 hour') >= p_ip_max then
    return jsonb_build_object('ok', false, 'reason', 'ip_limit');
  end if;
  if (select count(*) from phone_otps where created_at > now() - interval '1 hour') >= p_global_max then
    return jsonb_build_object('ok', false, 'reason', 'global_limit');
  end if;

  insert into phone_otps (phone, purpose, code_hash, expires_at, ip)
  values (p_phone, p_purpose, p_code_hash, now() + make_interval(secs => p_ttl_seconds), nullif(p_ip, ''));
  return jsonb_build_object('ok', true);
end;
$function$;

-- Checks a typed code against the newest unused code and counts the miss, as
-- one locked step (the row is locked, so parallel guesses queue up).
create or replace function public.otp_check(
  p_phone text, p_purpose text, p_code_hash text, p_max_attempts integer default 5
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r phone_otps%rowtype;
begin
  select * into r from phone_otps
   where phone = p_phone and purpose = p_purpose and consumed_at is null
   order by created_at desc limit 1
   for update;
  if not found then
    return jsonb_build_object('status', 'none');
  end if;
  if r.expires_at < now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if r.attempts >= p_max_attempts then
    update phone_otps set consumed_at = now() where id = r.id;
    return jsonb_build_object('status', 'locked');
  end if;
  if r.code_hash = p_code_hash then
    update phone_otps set consumed_at = now() where id = r.id;
    return jsonb_build_object('status', 'ok');
  end if;
  update phone_otps set attempts = attempts + 1 where id = r.id;
  return jsonb_build_object('status', 'wrong', 'left', greatest(0, p_max_attempts - (r.attempts + 1)));
end;
$function$;

-- ---------------------------------------------------------------------------
-- G. Find an account by its login address with one indexed lookup
-- ---------------------------------------------------------------------------
create or replace function public.auth_user_id_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'auth'
as $function$
  select id from auth.users where email = lower(p_email) limit 1;
$function$;

revoke all on function public.otp_issue(text, text, text, text, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.otp_check(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.auth_user_id_for_email(text) from public, anon, authenticated;
grant execute on function public.otp_issue(text, text, text, text, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.otp_check(text, text, text, integer) to service_role;
grant execute on function public.auth_user_id_for_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- D. Stock list: only look at batches that still hold stock
-- ---------------------------------------------------------------------------
-- Same columns, same numbers (a depleted batch adds 0 to every total and is
-- already ignored by soonest_expiry / has_unknown_expiry); the condition moves
-- into the join so the partial index on batches with stock can be used.
create or replace view public.v_drug_stock with (security_invoker = true) as
 select d.id as drug_id,
    d.pharmacy_id,
    d.name,
    d.unit,
    d.reorder_level,
    d.default_price,
    d.is_prescription,
    d.pack_size,
    d.pack_label,
    coalesce(sum(b.quantity_remaining) filter (where (b.expiry_date >= current_date)), (0)::bigint) as qty_in_stock,
    coalesce(sum(b.quantity_remaining) filter (where (b.expiry_date < current_date)), (0)::bigint) as qty_expired,
    min(b.expiry_date) filter (where ((b.quantity_remaining > 0) and (b.expiry_date >= current_date))) as soonest_expiry,
    coalesce(sum(((b.quantity_remaining)::numeric * b.cost_price)) filter (where (b.expiry_date >= current_date)), (0)::numeric) as stock_value_cost,
    coalesce(sum(((b.quantity_remaining)::numeric * b.sell_price)) filter (where (b.expiry_date >= current_date)), (0)::numeric) as stock_value_retail,
    coalesce(bool_or(b.expiry_unknown) filter (where (b.quantity_remaining > 0)), false) as has_unknown_expiry,
    d.control_class
   from (drugs d
     left join batches b on (((b.drug_id = d.id) and (b.quantity_remaining > 0))))
  where d.active
  group by d.id;

-- ---------------------------------------------------------------------------
-- F. Duplicate indexes (each is the first column(s) of a bigger index)
-- ---------------------------------------------------------------------------
drop index if exists public.drugs_pharmacy_id_idx;                         -- drugs_pharmacy_id_active_idx
drop index if exists public.expenses_pharmacy_id_idx;                      -- expenses_pharmacy_id_expense_date_idx
drop index if exists public.supplier_payments_pharmacy_id_idx;             -- ..._pharmacy_id_supplier_id_paid_at_idx
drop index if exists public.supplier_payments_pharmacy_supplier_idx;       -- ..._pharmacy_id_supplier_id_paid_at_idx
drop index if exists public.supplier_lpos_pharmacy_id_idx;                 -- ..._pharmacy_id_supplier_id_delivered_at_idx
drop index if exists public.sale_items_drug_id_idx;                        -- sale_items_drug_sale_idx

commit;
