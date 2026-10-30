-- 2026-10-30 Lock a pharmacy out when its trial / paid plan has ended
--
-- Every row-level-security policy asks my_pharmacy_id() / my_role() who the
-- caller is. Making those two return nothing once the pharmacy's
-- subscription_expires_at has passed shuts the pharmacy out of ALL its data
-- at the database, not just on the screen. The platform admin is never
-- locked out. Paying (admin_activate_pharmacy) or adding days
-- (admin_extend_trial) lifts the lock straight away.
--
-- my_subscription() lets the app read the plan state even while locked, so it
-- can show "trial ended" instead of a blank screen.
--
-- Safe to run more than once.
begin;

create or replace function public.my_pharmacy_id()
returns uuid language sql stable security definer set search_path to 'public'
as $function$
  select p.pharmacy_id
  from profiles p
  join pharmacies ph on ph.id = p.pharmacy_id
  where p.id = auth.uid() and p.active
    and (p.account_expires_at is null or p.account_expires_at > now())
    and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
         or exists (select 1 from platform_admins pa where pa.user_id = p.id));
$function$;

create or replace function public.my_role()
returns user_role language sql stable security definer set search_path to 'public'
as $function$
  select p.role
  from profiles p
  join pharmacies ph on ph.id = p.pharmacy_id
  where p.id = auth.uid() and p.active
    and (p.account_expires_at is null or p.account_expires_at > now())
    and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
         or exists (select 1 from platform_admins pa where pa.user_id = p.id));
$function$;

-- Plan state for the signed-in user's own pharmacy (works while locked).
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
              and not exists (select 1 from platform_admins pa where pa.user_id = p.id))
  from profiles p
  join pharmacies ph on ph.id = p.pharmacy_id
  where p.id = auth.uid();
$function$;

revoke all on function public.my_subscription() from public, anon;
grant execute on function public.my_subscription() to authenticated;

commit;
