-- Pharma admin portal — run ONCE in Supabase: Dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to re-run. Adds tables/functions only; changes no existing data.

-- ============================================================================
-- 10. PLATFORM ADMIN PORTAL (/admin) — same pattern as Kodi's admin
-- ----------------------------------------------------------------------------
-- The admin portal (admin.html) uses the same Supabase project and the same
-- phone + password login as the main app. What makes an account an admin is
-- a row in platform_admins — a separate table, NOT a flag on profiles,
-- because profiles rows are user-editable (RLS lets a user update their own
-- row), whereas platform_admins has RLS on with zero policies, so nobody can
-- read or write it through the API at all. Rows are added by hand, from the
-- Supabase SQL editor or a migration.
--
-- Every pharmacy is otherwise RLS-limited to its own data, so the portal
-- never queries tables directly: it calls admin_overview() and
-- admin_pharmacy_detail(), SECURITY DEFINER functions that refuse to run
-- unless is_platform_admin() is true for the caller. Read-only by design —
-- nothing here changes a pharmacy's data.
--
-- Sign-in history: Supabase only keeps each user's LATEST sign-in
-- (auth.users.last_sign_in_at), so sign_in_log records every one going
-- forward, filled by a trigger on auth.users. No app.js change was needed.
-- The trigger swallows its own errors, so logging can never block a login.
-- ============================================================================

create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
revoke all on platform_admins from anon, authenticated;

create table if not exists sign_in_log (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  signed_in_at timestamptz not null default now(),
  source       text not null default 'login'   -- 'login' (trigger) | 'backfill' (one-off, from auth.sessions)
);
create index if not exists sign_in_log_user_time on sign_in_log (user_id, signed_in_at desc);
create index if not exists sign_in_log_time on sign_in_log (signed_in_at desc);
alter table sign_in_log enable row level security;
revoke all on sign_in_log from anon, authenticated;

create or replace function log_sign_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is not null
     and (tg_op = 'INSERT' or new.last_sign_in_at is distinct from old.last_sign_in_at) then
    begin
      insert into public.sign_in_log (user_id, signed_in_at) values (new.id, new.last_sign_in_at);
    exception when others then
      null;  -- never let sign-in logging get in the way of a real login
    end;
  end if;
  return new;
end;
$$;
revoke all on function log_sign_in() from public, anon, authenticated;

drop trigger if exists on_auth_user_sign_in on auth.users;
create trigger on_auth_user_sign_in
  after insert or update of last_sign_in_at on auth.users
  for each row execute function public.log_sign_in();

-- One-off backfill so history doesn't start empty: every session Supabase
-- still holds, plus each user's latest sign-in (skipped when a session
-- already covers it to within a minute). Only runs on an empty log.
insert into sign_in_log (user_id, signed_in_at, source)
select x.user_id, x.t, 'backfill' from (
  select s.user_id, s.created_at as t from auth.sessions s where s.user_id is not null and s.created_at is not null
  union all
  select u.id, u.last_sign_in_at from auth.users u
  where u.last_sign_in_at is not null
    and not exists (select 1 from auth.sessions s where s.user_id = u.id
                    and abs(extract(epoch from (s.created_at - u.last_sign_in_at))) < 60)
) x
where not exists (select 1 from sign_in_log);

create or replace function is_platform_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;
revoke all on function is_platform_admin() from public, anon;
grant execute on function is_platform_admin() to authenticated;

-- Internal: one row of usage stats per pharmacy. Not callable through the
-- API by anyone (execute revoked) — only from inside the two admin_*
-- functions below, which do the admin check first.
--
-- Status buckets ("is this pharmacy actually using Pharma?"):
--   setting_up   no drugs and no sales yet, but someone was active in the last 7 days
--   not_started  no drugs and no sales, and nobody active in the last 7 days
--   active_today last activity today (Nairobi time)
--   active_week  last activity within 7 days
--   quiet        last activity 8–30 days ago
--   dormant      no activity for over 30 days
-- "Activity" = the latest of: a staff sign-in, a staff session refresh
-- (app open), a sale, or any stock movement.
create or replace function admin_pharmacy_stats()
returns table (
  id uuid, name text, town text, phone text, created_at timestamptz,
  owner_name text, owner_phone text,
  staff_count integer, active_staff integer,
  last_sign_in_at timestamptz, last_seen_at timestamptz,
  sign_ins_7d integer, sign_ins_30d integer,
  last_sale_at timestamptz, sales_count integer, sales_30d integer, sales_value_30d numeric,
  drugs_count integer, last_stock_at timestamptz,
  last_active_at timestamptz, status text
)
language sql stable
security definer
set search_path = public
as $$
  with staff as (
    select pr.pharmacy_id, pr.id as user_id, pr.full_name, pr.phone, pr.role, pr.active, pr.account_expires_at,
           u.last_sign_in_at,
           (select max(s.updated_at) from auth.sessions s where s.user_id = pr.id) as last_seen_at
    from profiles pr
    left join auth.users u on u.id = pr.id
  ),
  base as (
    select p.id, p.name, p.town, p.phone, p.created_at,
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
         end as status
  from withact w;
$$;
revoke all on function admin_pharmacy_stats() from public, anon, authenticated;

-- Everything the portal's overview screen shows, in one call.
create or replace function admin_overview()
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not is_platform_admin() then
    raise exception 'Not authorized';
  end if;

  with st as (select * from admin_pharmacy_stats()),
  events as (
    -- one row per (pharmacy, Nairobi calendar day) with any activity, last 30 days
    select pr.pharmacy_id, (l.signed_in_at at time zone 'Africa/Nairobi')::date as day, 1 as sign_in, 0 as sale
      from sign_in_log l join profiles pr on pr.id = l.user_id
      where l.signed_in_at > now() - interval '31 days'
    union all
    select sa.pharmacy_id, (sa.sold_at at time zone 'Africa/Nairobi')::date, 0, 1
      from sales sa where not sa.voided and sa.sold_at > now() - interval '31 days'
    union all
    select a.pharmacy_id, (a.created_at at time zone 'Africa/Nairobi')::date, 0, 0
      from stock_adjustments a where a.created_at > now() - interval '31 days' and a.type <> 'sale'
  ),
  days as (
    select d::date as day
    from generate_series((now() at time zone 'Africa/Nairobi')::date - 29,
                         (now() at time zone 'Africa/Nairobi')::date, interval '1 day') d
  )
  select jsonb_build_object(
    'generated_at', now(),
    'summary', (select jsonb_build_object(
        'pharmacies',      count(*),
        'new_30d',         count(*) filter (where created_at > now() - interval '30 days'),
        'active_week',     count(*) filter (where status in ('active_today', 'active_week')),
        'active_today',    count(*) filter (where status = 'active_today'),
        'setting_up',      count(*) filter (where status = 'setting_up'),
        'quiet',           count(*) filter (where status = 'quiet'),
        'dormant',         count(*) filter (where status = 'dormant'),
        'not_started',     count(*) filter (where status = 'not_started'),
        'staff',           coalesce(sum(staff_count), 0),
        'sales_30d',       coalesce(sum(sales_30d), 0),
        'sales_value_30d', coalesce(sum(sales_value_30d), 0)
      ) from st),
    'sign_ins_7d',  (select count(*) from sign_in_log where signed_in_at > now() - interval '7 days'),
    'sign_ins_30d', (select count(*) from sign_in_log where signed_in_at > now() - interval '30 days'),
    'pharmacies', coalesce((select jsonb_agg(to_jsonb(st) order by st.last_active_at desc nulls last, st.created_at desc) from st), '[]'::jsonb),
    'recent_sign_ins', coalesce((select jsonb_agg(to_jsonb(x) order by x.signed_in_at desc) from (
        select l.signed_in_at, l.source, pr.full_name, pr.role, pr.phone, p.id as pharmacy_id, p.name as pharmacy_name,
               exists (select 1 from platform_admins pa where pa.user_id = l.user_id) as is_admin
        from sign_in_log l
        join profiles pr on pr.id = l.user_id
        join pharmacies p on p.id = pr.pharmacy_id
        order by l.signed_in_at desc
        limit 25) x), '[]'::jsonb),
    'daily', (select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'active_pharmacies', (select count(distinct e.pharmacy_id) from events e where e.day = d.day),
        'sign_ins', (select coalesce(sum(e.sign_in), 0) from events e where e.day = d.day),
        'sales',    (select coalesce(sum(e.sale), 0) from events e where e.day = d.day)
      ) order by d.day) from days d)
  ) into v;

  return v;
end;
$$;
revoke all on function admin_overview() from public, anon;
grant execute on function admin_overview() to authenticated;

-- One pharmacy's full picture for the portal's detail screen.
create or replace function admin_pharmacy_detail(p_pharmacy_id uuid)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not is_platform_admin() then
    raise exception 'Not authorized';
  end if;
  if not exists (select 1 from pharmacies where id = p_pharmacy_id) then
    raise exception 'Pharmacy not found';
  end if;

  with days as (
    select d::date as day
    from generate_series((now() at time zone 'Africa/Nairobi')::date - 29,
                         (now() at time zone 'Africa/Nairobi')::date, interval '1 day') d
  )
  select jsonb_build_object(
    'pharmacy', (select to_jsonb(st) || jsonb_build_object(
                    'address', p.address, 'email', p.email, 'kra_pin', p.kra_pin)
                 from admin_pharmacy_stats() st join pharmacies p on p.id = st.id
                 where st.id = p_pharmacy_id),
    'counts', jsonb_build_object(
      'batches_in_stock', (select count(*) from batches b where b.pharmacy_id = p_pharmacy_id and b.quantity_remaining > 0),
      'suppliers',        (select count(*) from suppliers s where s.pharmacy_id = p_pharmacy_id),
      'lpos',             (select count(*) from supplier_lpos l where l.pharmacy_id = p_pharmacy_id),
      'expenses',         (select count(*) from expenses e where e.pharmacy_id = p_pharmacy_id and not e.voided),
      'sales_value_all',  (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p_pharmacy_id and not sa.voided),
      'first_sale_at',    (select min(sa.sold_at) from sales sa where sa.pharmacy_id = p_pharmacy_id)
    ),
    'staff', coalesce((select jsonb_agg(to_jsonb(x) order by x.last_sign_in_at desc nulls last) from (
        select pr.id, pr.full_name, pr.phone, pr.role, pr.active, pr.account_expires_at, pr.created_at,
               u.last_sign_in_at,
               (select max(s.updated_at) from auth.sessions s where s.user_id = pr.id) as last_seen_at,
               (select count(*) from sign_in_log l where l.user_id = pr.id
                  and l.signed_in_at > now() - interval '30 days') as sign_ins_30d,
               exists (select 1 from platform_admins pa where pa.user_id = pr.id) as is_admin
        from profiles pr left join auth.users u on u.id = pr.id
        where pr.pharmacy_id = p_pharmacy_id) x), '[]'::jsonb),
    'sign_ins', coalesce((select jsonb_agg(to_jsonb(x) order by x.signed_in_at desc) from (
        select l.signed_in_at, l.source, pr.full_name, pr.role
        from sign_in_log l join profiles pr on pr.id = l.user_id
        where pr.pharmacy_id = p_pharmacy_id
        order by l.signed_in_at desc
        limit 50) x), '[]'::jsonb),
    'daily', (select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'sales', (select count(*) from sales sa where sa.pharmacy_id = p_pharmacy_id and not sa.voided
                    and (sa.sold_at at time zone 'Africa/Nairobi')::date = d.day),
        'sales_value', (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p_pharmacy_id and not sa.voided
                    and (sa.sold_at at time zone 'Africa/Nairobi')::date = d.day),
        'sign_ins', (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
                    where pr.pharmacy_id = p_pharmacy_id and (l.signed_in_at at time zone 'Africa/Nairobi')::date = d.day)
      ) order by d.day) from days d)
  ) into v;

  return v;
end;
$$;
revoke all on function admin_pharmacy_detail(uuid) from public, anon;
grant execute on function admin_pharmacy_detail(uuid) to authenticated;

-- To make an account a platform admin (run once in the Supabase SQL editor):
--   insert into platform_admins (user_id, note)
--   select id, 'Daudi' from profiles where phone = '0705041512';

insert into platform_admins (user_id, note)
select id, 'Daudi' from profiles where phone = '0705041512'
on conflict (user_id) do nothing;
