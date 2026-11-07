-- 2026-11-07 (night): "Get support" - a pharmacy owner lets the Pharma admin into
-- their pharmacy for a chosen number of hours, to look at a problem and fix it.
--
-- How it works (nothing in the existing pharmacy security rules is loosened):
--   * support_access: one row per grant (pharmacy, who granted, when it ends, when stopped).
--   * support_session: which pharmacy the admin currently has open (one row per admin).
--   * my_pharmacy_id() / my_role() gain ONE extra first step: if the caller is the
--     platform admin AND has a support session AND that pharmacy has a live grant
--     (not stopped, not past its end time), they act as a co-owner of THAT pharmacy.
--     Otherwise they behave exactly as before. When the time is up (or the owner
--     stops it) the extra step finds nothing, so access ends by itself with no job.
--   * Every pharmacy table already filters on my_pharmacy_id(), so isolation between
--     pharmacies is unchanged: a grant opens only the pharmacy that gave it.
--   * The admin's own profile (its "home") is needed so records the admin saves
--     have a valid "created by"; it is created separately, not in this file.
--
-- Added: 3 tables (closed to the app and the public API), 8 functions.
-- Changed: my_pharmacy_id(), my_role(), my_subscription() (extra first step only).

-- 1. Tables ------------------------------------------------------------------
create table if not exists public.support_access (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references public.pharmacies(id) on delete cascade,
  granted_by   uuid references public.profiles(id) on delete set null,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  check (expires_at > granted_at)
);
create index if not exists support_access_pharmacy_idx on public.support_access (pharmacy_id, expires_at desc);

create table if not exists public.support_session (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  pharmacy_id  uuid not null references public.pharmacies(id) on delete cascade,
  opened_at    timestamptz not null default now()
);
create index if not exists support_session_pharmacy_idx on public.support_session (pharmacy_id);

create table if not exists public.support_access_events (
  id           uuid primary key default gen_random_uuid(),
  access_id    uuid not null references public.support_access(id) on delete cascade,
  pharmacy_id  uuid not null references public.pharmacies(id) on delete cascade,
  kind         text not null check (kind in ('opened')),
  at           timestamptz not null default now()
);
create index if not exists support_access_events_pharmacy_idx on public.support_access_events (pharmacy_id, at desc);

alter table public.support_access enable row level security;
alter table public.support_session enable row level security;
alter table public.support_access_events enable row level security;
revoke all on public.support_access, public.support_session, public.support_access_events from anon, authenticated;

-- 2. Who is the caller acting as? (the only change to the core rules) ----------
create or replace function public.my_pharmacy_id()
returns uuid language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(
    (select ss.pharmacy_id
       from support_session ss
       join platform_admins pa on pa.user_id = ss.user_id
      where ss.user_id = auth.uid()
        and exists (select 1 from support_access sa
                     where sa.pharmacy_id = ss.pharmacy_id and sa.revoked_at is null and sa.expires_at > now())),
    (select p.pharmacy_id
       from profiles p
       join pharmacies ph on ph.id = p.pharmacy_id
      where p.id = auth.uid() and p.active
        and (p.account_expires_at is null or p.account_expires_at > now())
        and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
             or exists (select 1 from platform_admins pa where pa.user_id = p.id)))
  );
$function$;

create or replace function public.my_role()
returns user_role language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(
    (select 'co_owner'::user_role
       from support_session ss
       join platform_admins pa on pa.user_id = ss.user_id
      where ss.user_id = auth.uid()
        and exists (select 1 from support_access sa
                     where sa.pharmacy_id = ss.pharmacy_id and sa.revoked_at is null and sa.expires_at > now())),
    (select p.role
       from profiles p
       join pharmacies ph on ph.id = p.pharmacy_id
      where p.id = auth.uid() and p.active
        and (p.account_expires_at is null or p.account_expires_at > now())
        and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
             or exists (select 1 from platform_admins pa where pa.user_id = p.id)))
  );
$function$;

-- Plan state for the pharmacy the caller is working in (their own, or the one the
-- admin has open for support). Works while locked.
create or replace function public.my_subscription()
returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'pharmacy_name', ph.name,
    'status', ph.subscription_status,
    'expires_at', ph.subscription_expires_at,
    'days_left', case when ph.subscription_expires_at is null then null
                      else ceil(extract(epoch from (ph.subscription_expires_at - now())) / 86400.0)::int end,
    'locked', ph.subscription_expires_at is not null and ph.subscription_expires_at <= now()
              and not exists (select 1 from platform_admins pa where pa.user_id = auth.uid()))
  from pharmacies ph
  where ph.id = coalesce(
    (select ss.pharmacy_id from support_session ss
       join platform_admins pa on pa.user_id = ss.user_id
      where ss.user_id = auth.uid()
        and exists (select 1 from support_access sa
                     where sa.pharmacy_id = ss.pharmacy_id and sa.revoked_at is null and sa.expires_at > now())),
    (select p.pharmacy_id from profiles p where p.id = auth.uid()));
$function$;

-- 3. The owner's side -------------------------------------------------------------
-- Let the Pharma admin in for 1, 2, 4, 8 or 24 hours. A new grant replaces a live one.
create or replace function public.grant_support_access(p_hours integer)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pharmacy uuid := my_pharmacy_id();
  v_row support_access;
begin
  if v_pharmacy is null or my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the pharmacy owner can give support access';
  end if;
  if is_platform_admin() then raise exception 'Support access is given by the pharmacy, not the admin'; end if;
  if p_hours is null or p_hours not in (1, 2, 4, 8, 24) then
    raise exception 'Choose 1, 2, 4, 8 or 24 hours';
  end if;
  update support_access set revoked_at = now()
   where pharmacy_id = v_pharmacy and revoked_at is null and expires_at > now();
  insert into support_access (pharmacy_id, granted_by, expires_at)
  values (v_pharmacy, auth.uid(), now() + make_interval(hours => p_hours))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'granted_at', v_row.granted_at, 'expires_at', v_row.expires_at);
end;
$function$;

-- Stop access now. Also closes the admin's open session on this pharmacy.
create or replace function public.revoke_support_access()
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pharmacy uuid := my_pharmacy_id();
  v_n integer;
begin
  if v_pharmacy is null or my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the pharmacy owner can stop support access';
  end if;
  update support_access set revoked_at = now()
   where pharmacy_id = v_pharmacy and revoked_at is null and expires_at > now();
  get diagnostics v_n = row_count;
  delete from support_session where pharmacy_id = v_pharmacy;
  return jsonb_build_object('stopped', v_n);
end;
$function$;

-- What the owner sees: the live grant (if any) and the last 10 grants.
create or replace function public.my_support_access()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_pharmacy uuid := my_pharmacy_id();
begin
  if v_pharmacy is null or my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the pharmacy owner can see support access';
  end if;
  return jsonb_build_object(
    'active', (select jsonb_build_object('id', sa.id, 'granted_at', sa.granted_at, 'expires_at', sa.expires_at)
                 from support_access sa
                where sa.pharmacy_id = v_pharmacy and sa.revoked_at is null and sa.expires_at > now()
                order by sa.expires_at desc limit 1),
    'history', coalesce((
      select jsonb_agg(h order by h.granted_at desc) from (
        select sa.granted_at, sa.expires_at, sa.revoked_at,
               (select count(*) from support_access_events e where e.access_id = sa.id) as opened_count,
               (select max(e.at) from support_access_events e where e.access_id = sa.id) as last_opened_at
          from support_access sa where sa.pharmacy_id = v_pharmacy
         order by sa.granted_at desc limit 10) h), '[]'::jsonb));
end;
$function$;

-- 4. The admin's side -------------------------------------------------------------
-- Pharmacies that currently have a live grant.
create or replace function public.admin_support_status()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('pharmacy_id', sa.pharmacy_id, 'granted_at', sa.granted_at, 'expires_at', sa.expires_at,
             'open', exists (select 1 from support_session ss where ss.pharmacy_id = sa.pharmacy_id and ss.user_id = auth.uid())))
      from support_access sa
     where sa.revoked_at is null and sa.expires_at > now()), '[]'::jsonb);
end;
$function$;

-- Open a pharmacy that gave access. Needs the admin's own profile so saved records have a valid author.
create or replace function public.admin_open_support(p_pharmacy_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_access support_access;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  select * into v_access from support_access
   where pharmacy_id = p_pharmacy_id and revoked_at is null and expires_at > now()
   order by expires_at desc limit 1;
  if v_access.id is null then
    raise exception 'This pharmacy has not given support access, or it has ended';
  end if;
  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'The admin account has no home pharmacy profile yet, so it cannot save changes. Ask the developer to add it.';
  end if;
  insert into support_session (user_id, pharmacy_id) values (auth.uid(), p_pharmacy_id)
  on conflict (user_id) do update set pharmacy_id = excluded.pharmacy_id, opened_at = now();
  insert into support_access_events (access_id, pharmacy_id, kind) values (v_access.id, p_pharmacy_id, 'opened');
  return jsonb_build_object('pharmacy_id', p_pharmacy_id, 'expires_at', v_access.expires_at);
end;
$function$;

create or replace function public.admin_close_support()
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  delete from support_session where user_id = auth.uid();
  return jsonb_build_object('closed', true);
end;
$function$;

-- The app asks this after sign-in: "am I the admin working inside a pharmacy for support?"
create or replace function public.support_context()
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object('pharmacy_id', ss.pharmacy_id, 'pharmacy_name', ph.name,
           'expires_at', (select max(sa.expires_at) from support_access sa
                           where sa.pharmacy_id = ss.pharmacy_id and sa.revoked_at is null and sa.expires_at > now()))
    from support_session ss
    join platform_admins pa on pa.user_id = ss.user_id
    join pharmacies ph on ph.id = ss.pharmacy_id
   where ss.user_id = auth.uid()
     and exists (select 1 from support_access sa
                  where sa.pharmacy_id = ss.pharmacy_id and sa.revoked_at is null and sa.expires_at > now());
$function$;

revoke all on function public.grant_support_access(integer), public.revoke_support_access(), public.my_support_access(),
  public.admin_support_status(), public.admin_open_support(uuid), public.admin_close_support(), public.support_context()
  from public, anon;
grant execute on function public.grant_support_access(integer), public.revoke_support_access(), public.my_support_access(),
  public.admin_support_status(), public.admin_open_support(uuid), public.admin_close_support(), public.support_context()
  to authenticated;
