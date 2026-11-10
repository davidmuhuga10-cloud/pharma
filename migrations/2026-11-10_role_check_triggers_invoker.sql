-- 2026-11-10_role_check_triggers_invoker.sql
--
-- Correction to 2026-11-10_role_checks_on_direct_writes.sql, added as its own
-- file because that one was already applied (MIGRATIONS.md rule 2).
--
-- WHAT WAS WRONG
-- The four trigger functions that migration added were created SECURITY
-- DEFINER with the default ACL. That made them appear on the REST surface as
-- /rest/v1/rpc/protect_* and raised a new Supabase security advisor warning,
-- anon_security_definer_function_executable. Calling a trigger function that
-- way fails regardless -- Postgres refuses a trigger function invoked outside
-- a trigger -- so nothing was exploitable, but it broke MIGRATIONS.md rule 6
-- ("security-definer functions set search_path and revoke execute from
-- public/anon") and left a warning on the dashboard.
--
-- WHAT CHANGES
--  1. SECURITY INVOKER instead of SECURITY DEFINER. These functions need no
--     elevated rights: they only call auth.uid(), my_role() and staff_can(),
--     and the last two are SECURITY DEFINER already. This also matches the
--     three trigger functions this project already had --
--     protect_pharmacy_billing, protect_sms_cap and
--     protect_drug_control_class -- which are all INVOKER. That is why those
--     three never appeared in the advisor.
--  2. Execute revoked from public, anon and authenticated. A trigger does not
--     need EXECUTE on its function in order to fire; that is checked when the
--     trigger is created, not each time it runs. So the guards keep working
--     while the functions leave the REST surface entirely.
--
-- The guard logic itself is byte-for-byte the same. The triggers themselves
-- are not touched, so they keep pointing at these same function names.
--
-- WHY IT IS SAFE
-- Verified on a local throwaway copy loaded from schema.sql before applying:
-- the full role matrix (attendant, accountant, pharmacist, stock_taker and
-- owner against all five writes) is identical before and after both changes;
-- the triggers still fire with execute revoked; and a direct call as
-- authenticated is refused with "permission denied for function". Verified
-- again on the live project afterwards: attendant still refused on all three
-- writes, owner still works on all three, and all four functions report
-- is_security_definer = false with execute denied to both anon and
-- authenticated.
--
-- A note for whoever runs the SQL tests: tests/00_auth_stub.sql does not grant
-- usage on the auth schema to the authenticated role, but real Supabase does
-- (every RLS policy calling auth.uid() depends on it). Without that grant a
-- SECURITY INVOKER function calling auth.uid() fails locally with "permission
-- denied for schema auth" even though it is fine in production, which makes
-- the local run stricter than reality. Adding
--   grant usage on schema auth to authenticated, anon;
--   grant execute on function auth.uid() to authenticated, anon;
-- to that stub makes the harness faithful. This migration does not change the
-- stub; it is a test-harness fix, noted here so it is not lost.
--
-- Safe to run twice (create or replace, and revoke is idempotent).

create or replace function public.protect_drug_insert()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if auth.uid() is null then
    return NEW;   -- admin / service_role context, already unrestricted
  end if;
  -- wider than the Add-a-drug screen's can('edit_inventory') on purpose:
  -- import_stock_rows and sync_master_drugs create drugs and allow stock_taker.
  if coalesce(my_role()::text, '') not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist or a stock taker can add a drug';
  end if;
  return NEW;
end;
$function$;

create or replace function public.protect_batch_discount()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if auth.uid() is null then
    return NEW;
  end if;
  if coalesce(my_role()::text, '') not in ('owner', 'co_owner', 'pharmacist')
     or not staff_can('discount') then
    raise exception 'Only the owner or a pharmacist can mark down a batch';
  end if;
  return NEW;
end;
$function$;

create or replace function public.protect_supplier_insert()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if auth.uid() is null then
    return NEW;
  end if;
  if coalesce(my_role()::text, '') not in ('owner', 'co_owner', 'pharmacist')
     or not staff_can('suppliers') then
    raise exception 'Only the owner or a pharmacist can add a supplier';
  end if;
  return NEW;
end;
$function$;

create or replace function public.protect_claim_status()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if auth.uid() is null then
    return NEW;
  end if;
  if coalesce(my_role()::text, '') not in ('owner', 'co_owner', 'pharmacist', 'accountant')
     or not staff_can('claims') then
    raise exception 'You do not have permission to change a claim''s status';
  end if;
  return NEW;
end;
$function$;

revoke all on function public.protect_drug_insert() from public, anon, authenticated;
revoke all on function public.protect_batch_discount() from public, anon, authenticated;
revoke all on function public.protect_supplier_insert() from public, anon, authenticated;
revoke all on function public.protect_claim_status() from public, anon, authenticated;
