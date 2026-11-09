-- 2026-11-09  The platform admin does not show up in a pharmacy's Staff list
--
-- WHAT WAS WRONG
--   The platform admin account lives in Demo Pharmacy as a co-owner. When the admin
--   opens another pharmacy for support (Goodlife), the database still lets them read
--   their OWN profile row, so "Pharma Admin - Co-owner" showed up under Settings >
--   Staff of that pharmacy (and shows in Demo Pharmacy's own list). A support or
--   admin account must not appear in any pharmacy's Staff list.
--
-- WHAT CHANGES
--   * New function hidden_staff_ids(): of the profiles the caller can see (their
--     pharmacy's, plus their own row), the ids that are platform admins. The app drops
--     those people from the Staff list. It never reveals an admin the caller could not
--     already see.
--   * Read-only. Nothing else changes: the admin keeps signing in and working as before.
--
-- Safe to run twice. Rollback: 2026-11-09_hide_platform_admin_from_staff.ROLLBACK_if_needed.sql.

create or replace function public.hidden_staff_ids()
returns setof uuid
language sql stable security definer set search_path to 'public'
as $function$
  select p.id
  from profiles p
  where (p.pharmacy_id = my_pharmacy_id() or p.id = auth.uid())
    and exists (select 1 from platform_admins pa where pa.user_id = p.id);
$function$;

revoke all on function public.hidden_staff_ids() from public, anon;
grant execute on function public.hidden_staff_ids() to authenticated;
