-- 2026-11-07 (night, later): the platform admin can open any pharmacy directly.
--
-- Like "Login as School" in Shule Web, but with no password, no code and no email
-- link: the admin opens a pharmacy from the admin console and works inside it as a
-- co-owner. "Get support" (the owner giving access for chosen hours) stays exactly as
-- it is; it is now a courtesy, not a requirement.
--
-- What changes (nothing is deleted, no existing row is touched):
--   * admin_open_support(): no longer needs a live grant. Only the platform admin can
--     call it. Every open is logged: kind 'opened' when the owner had given access,
--     'opened_direct' when not.
--   * my_pharmacy_id() / my_role() / my_subscription() / support_context(): the admin's
--     open session works without a grant, and ends by itself 8 hours after it was opened.
--   * support_access_events: access_id may be empty (direct opens have no grant) and
--     kind accepts 'opened_direct'.
-- Everything else (how each pharmacy's data is kept apart, the owner's Get support
-- screen, grant / stop / history) is unchanged.

-- 1. Log table: allow direct opens ---------------------------------------------------
alter table public.support_access_events alter column access_id drop not null;
alter table public.support_access_events drop constraint if exists support_access_events_kind_check;
alter table public.support_access_events
  add constraint support_access_events_kind_check check (kind in ('opened', 'opened_direct'));

-- 2. Who is the caller acting as? The admin's open session counts for 8 hours. ---------
create or replace function public.my_pharmacy_id()
returns uuid language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(
    (select ss.pharmacy_id
       from support_session ss
       join platform_admins pa on pa.user_id = ss.user_id
      where ss.user_id = auth.uid()
        and ss.opened_at > now() - interval '8 hours'),
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
        and ss.opened_at > now() - interval '8 hours'),
    (select p.role
       from profiles p
       join pharmacies ph on ph.id = p.pharmacy_id
      where p.id = auth.uid() and p.active
        and (p.account_expires_at is null or p.account_expires_at > now())
        and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
             or exists (select 1 from platform_admins pa where pa.user_id = p.id)))
  );
$function$;

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
        and ss.opened_at > now() - interval '8 hours'),
    (select p.pharmacy_id from profiles p where p.id = auth.uid()));
$function$;

-- 3. Open a pharmacy (admin only). A live grant is no longer needed. -------------------
create or replace function public.admin_open_support(p_pharmacy_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_access support_access;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from pharmacies where id = p_pharmacy_id) then
    raise exception 'Pharmacy not found';
  end if;
  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'The admin account has no home pharmacy profile yet, so it cannot save changes. Ask the developer to add it.';
  end if;
  select * into v_access from support_access
   where pharmacy_id = p_pharmacy_id and revoked_at is null and expires_at > now()
   order by expires_at desc limit 1;
  insert into support_session (user_id, pharmacy_id) values (auth.uid(), p_pharmacy_id)
  on conflict (user_id) do update set pharmacy_id = excluded.pharmacy_id, opened_at = now();
  insert into support_access_events (access_id, pharmacy_id, kind)
  values (v_access.id, p_pharmacy_id, case when v_access.id is null then 'opened_direct' else 'opened' end);
  return jsonb_build_object('pharmacy_id', p_pharmacy_id,
           'expires_at', now() + interval '8 hours', 'granted_by_owner', v_access.id is not null);
end;
$function$;

-- 4. What the app asks after sign-in: "am I the admin working inside a pharmacy?" ------
create or replace function public.support_context()
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object('pharmacy_id', ss.pharmacy_id, 'pharmacy_name', ph.name,
           'expires_at', ss.opened_at + interval '8 hours')
    from support_session ss
    join platform_admins pa on pa.user_id = ss.user_id
    join pharmacies ph on ph.id = ss.pharmacy_id
   where ss.user_id = auth.uid()
     and ss.opened_at > now() - interval '8 hours';
$function$;

revoke all on function public.admin_open_support(uuid), public.support_context() from public, anon;
grant execute on function public.admin_open_support(uuid), public.support_context() to authenticated;
