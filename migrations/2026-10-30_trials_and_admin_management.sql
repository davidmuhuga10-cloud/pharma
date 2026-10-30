-- 2026-10-30 Trials, activation, and admin pharmacy management
--
-- Admin-side request: every pharmacy gets a 3-month (90-day) free trial from
-- sign-up and becomes "active" once the first payment is made. The admin side
-- must show trial days left / status, let the admin extend or reduce trial
-- days, mark a pharmacy as paid (active), and permanently delete a pharmacy.
-- When a trial ends unpaid the pharmacy is locked out of the app until the
-- admin activates it. Modelled on Kodi's admin_extend_trial /
-- admin_activate_subscription / admin_delete_landlord.
--
-- All management functions are gated by is_platform_admin(), so only the
-- single platform-admin account (David Kinyua, 0705041512) can call them.
--
-- Safe to run more than once.
begin;

-- 1. Subscription columns on pharmacies -------------------------------------
alter table public.pharmacies
  add column if not exists subscription_status text not null default 'trial',
  add column if not exists subscription_expires_at timestamptz,
  add column if not exists activated_at timestamptz;

alter table public.pharmacies drop constraint if exists pharmacies_subscription_status_check;
alter table public.pharmacies add constraint pharmacies_subscription_status_check
  check (subscription_status in ('trial', 'active'));

-- Backfill existing pharmacies: a trial that runs 90 days from when they
-- signed up. (Only the demo accounts exist today.)
update public.pharmacies
  set subscription_expires_at = created_at + interval '90 days'
  where subscription_expires_at is null;

-- 2. New pharmacies start a 90-day trial ------------------------------------
-- bootstrap_pharmacy is unchanged except for the two trial columns on the
-- INSERT; folded into schema.sql alongside this migration.
create or replace function public.bootstrap_pharmacy(p_name text, p_full_name text, p_phone text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pharmacy_id uuid;
  v_cat text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a pharmacy';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'Give the pharmacy a name';
  end if;

  insert into pharmacies (name, phone, subscription_status, subscription_expires_at)
  values (trim(p_name), p_phone, 'trial', now() + interval '90 days')
  returning id into v_pharmacy_id;

  insert into profiles (id, pharmacy_id, full_name, phone, role)
  values (auth.uid(), v_pharmacy_id, p_full_name, p_phone, 'owner');

  foreach v_cat in array array[
    'Analgesics/Antipyretics', 'Antibiotics/Antifungals/Amoebicides',
    'Bronchodilators/Anti-Allergy', 'Antacids/Anti-H-Pylori', 'Antimalarials',
    'Anti-DM', 'Hypertensives/Convulsants', 'Antiemetics/Laxatives',
    'Contraceptives', 'Supplements', 'Eye/Ear Drops', 'ORS',
    'Injectables', 'Powders/Creams', 'Non-Pharmaceuticals', 'Others'
  ] loop
    insert into drug_categories (pharmacy_id, name) values (v_pharmacy_id, v_cat);
  end loop;

  return v_pharmacy_id;
end;
$function$;

-- 3. Trial / subscription fields in the admin overview ----------------------
-- Adds three columns to admin_pharmacy_stats(); admin_overview() and
-- admin_pharmacy_detail() pass the whole row through to_jsonb(), so the new
-- fields reach the admin screen automatically. Signature changes, so drop
-- then recreate (the two callers resolve it by name at run time).
drop function if exists public.admin_pharmacy_stats();
create function public.admin_pharmacy_stats()
 returns table(id uuid, name text, town text, phone text, created_at timestamptz,
   owner_name text, owner_phone text, staff_count integer, active_staff integer,
   last_sign_in_at timestamptz, last_seen_at timestamptz, sign_ins_7d integer, sign_ins_30d integer,
   last_sale_at timestamptz, sales_count integer, sales_30d integer, sales_value_30d numeric,
   drugs_count integer, last_stock_at timestamptz, last_active_at timestamptz, status text,
   subscription_status text, subscription_expires_at timestamptz, trial_days_left integer)
 language sql stable security definer set search_path to 'public'
as $function$
  with staff as (
    select pr.pharmacy_id, pr.id as user_id, pr.full_name, pr.phone, pr.role, pr.active, pr.account_expires_at,
           u.last_sign_in_at,
           (select max(s.updated_at) from auth.sessions s where s.user_id = pr.id) as last_seen_at
    from profiles pr
    left join auth.users u on u.id = pr.id
  ),
  base as (
    select p.id, p.name, p.town, p.phone, p.created_at,
      p.subscription_status, p.subscription_expires_at,
      (select s.full_name from staff s where s.pharmacy_id = p.id and s.role = 'owner' limit 1) as owner_name,
      (select s.phone     from staff s where s.pharmacy_id = p.id and s.role = 'owner' limit 1) as owner_phone,
      (select count(*) from staff s where s.pharmacy_id = p.id)::int as staff_count,
      (select count(*) from staff s where s.pharmacy_id = p.id and s.active
         and (s.account_expires_at is null or s.account_expires_at > now()))::int as active_staff,
      (select max(s.last_sign_in_at) from staff s where s.pharmacy_id = p.id) as last_sign_in_at,
      (select max(s.last_seen_at) from staff s where s.pharmacy_id = p.id) as last_seen_at,
      (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
         where pr.pharmacy_id = p.id and l.signed_in_at > now() - interval '7 days')::int as sign_ins_7d,
      (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
         where pr.pharmacy_id = p.id and l.signed_in_at > now() - interval '30 days')::int as sign_ins_30d,
      (select max(sa.created_at) from sales sa where sa.pharmacy_id = p.id) as last_sale_at,
      (select count(*) from sales sa where sa.pharmacy_id = p.id and not sa.voided)::int as sales_count,
      (select count(*) from sales sa where sa.pharmacy_id = p.id and not sa.voided
         and sa.sold_at > now() - interval '30 days')::int as sales_30d,
      (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p.id and not sa.voided
         and sa.sold_at > now() - interval '30 days') as sales_value_30d,
      (select count(*) from drugs d where d.pharmacy_id = p.id and d.active)::int as drugs_count,
      (select max(a.created_at) from stock_adjustments a where a.pharmacy_id = p.id) as last_stock_at
    from pharmacies p
  ),
  withact as (
    select b.*, greatest(b.last_sign_in_at, b.last_seen_at, b.last_sale_at, b.last_stock_at) as last_active_at
    from base b
  )
  select w.id, w.name, w.town, w.phone, w.created_at, w.owner_name, w.owner_phone,
         w.staff_count, w.active_staff, w.last_sign_in_at, w.last_seen_at,
         w.sign_ins_7d, w.sign_ins_30d, w.last_sale_at, w.sales_count, w.sales_30d, w.sales_value_30d,
         w.drugs_count, w.last_stock_at, w.last_active_at,
         case
           when w.drugs_count = 0 and w.sales_count = 0 then
             case when w.last_active_at > now() - interval '7 days' then 'setting_up' else 'not_started' end
           when (w.last_active_at at time zone 'Africa/Nairobi')::date
                = (now() at time zone 'Africa/Nairobi')::date  then 'active_today'
           when w.last_active_at > now() - interval '7 days'  then 'active_week'
           when w.last_active_at > now() - interval '30 days' then 'quiet'
           else 'dormant'
         end as status,
         w.subscription_status,
         w.subscription_expires_at,
         case when w.subscription_expires_at is null then null
              else ceil(extract(epoch from (w.subscription_expires_at - now())) / 86400.0)::int
         end as trial_days_left
  from withact w;
$function$;

-- 4. Admin: extend or reduce trial days -------------------------------------
-- Positive days extend, negative reduce. Adds on top of whatever is left (or
-- from today if already expired). Does not change the subscription status.
create or replace function public.admin_extend_trial(p_pharmacy_id uuid, p_days integer)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_new timestamptz;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if p_days is null or p_days = 0 then raise exception 'Enter a number of days (negative to reduce)'; end if;
  update pharmacies
     set subscription_expires_at = greatest(now(), coalesce(subscription_expires_at, now())) + (p_days || ' days')::interval
   where id = p_pharmacy_id
   returning subscription_expires_at into v_new;
  if not found then raise exception 'Pharmacy not found'; end if;
  return jsonb_build_object('ok', true, 'expires_at', v_new);
end;
$function$;

-- 5. Admin: mark a pharmacy paid (active) for a number of days --------------
create or replace function public.admin_activate_pharmacy(p_pharmacy_id uuid, p_days integer)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_new timestamptz;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if p_days is null or p_days <= 0 then raise exception 'Enter a number of days greater than 0'; end if;
  update pharmacies
     set subscription_status = 'active',
         activated_at = coalesce(activated_at, now()),
         subscription_expires_at = now() + (p_days || ' days')::interval
   where id = p_pharmacy_id
   returning subscription_expires_at into v_new;
  if not found then raise exception 'Pharmacy not found'; end if;
  return jsonb_build_object('ok', true, 'expires_at', v_new);
end;
$function$;

-- 6. Admin: permanently delete a pharmacy -----------------------------------
-- Only allowed once the pharmacy's trial / subscription has ended (matches
-- the admin requirement). The caller must pass the exact pharmacy name as a
-- typed confirmation (the app also re-enters the admin password first). All
-- pharmacy data cascades from the pharmacies row; the staff auth logins are
-- removed too so the phone numbers are free again.
create or replace function public.admin_delete_pharmacy(p_pharmacy_id uuid, p_confirm_name text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_name text;
  v_expires timestamptz;
  v_user_ids uuid[];
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  select name, subscription_expires_at into v_name, v_expires from pharmacies where id = p_pharmacy_id;
  if v_name is null then raise exception 'Pharmacy not found'; end if;
  if trim(coalesce(p_confirm_name, '')) <> v_name then
    raise exception 'The name you typed does not match the pharmacy name';
  end if;
  if v_expires is null or v_expires > now() then
    raise exception 'This pharmacy''s trial has not ended yet — reduce its trial days to zero first if you really need to delete it';
  end if;
  -- Never delete a pharmacy that holds a platform-admin account.
  if exists (select 1 from profiles pr join platform_admins pa on pa.user_id = pr.id
             where pr.pharmacy_id = p_pharmacy_id) then
    raise exception 'This pharmacy contains an admin account and cannot be deleted here';
  end if;

  select array_agg(id) into v_user_ids from profiles where pharmacy_id = p_pharmacy_id;
  delete from pharmacies where id = p_pharmacy_id;        -- cascades to all pharmacy data and profiles
  if v_user_ids is not null then
    delete from auth.users where id = any(v_user_ids);     -- free up the phone-number logins
  end if;
  return jsonb_build_object('ok', true, 'deleted', v_name);
end;
$function$;

-- 7. Only the signed-in platform admin may call these -----------------------
revoke all on function public.admin_extend_trial(uuid, integer) from public, anon;
revoke all on function public.admin_activate_pharmacy(uuid, integer) from public, anon;
revoke all on function public.admin_delete_pharmacy(uuid, text) from public, anon;
grant execute on function public.admin_extend_trial(uuid, integer) to authenticated;
grant execute on function public.admin_activate_pharmacy(uuid, integer) to authenticated;
grant execute on function public.admin_delete_pharmacy(uuid, text) to authenticated;

commit;
