-- 2026-11-10_role_check_triggers_invoker.ROLLBACK_if_needed.sql
--
-- Undoes 2026-11-10_role_check_triggers_invoker.sql by putting the four
-- trigger functions back to SECURITY DEFINER with the default ACL, exactly as
-- 2026-11-10_role_checks_on_direct_writes.sql first created them.
--
-- Running this brings back the Supabase advisor warning
-- anon_security_definer_function_executable for these four functions, so only
-- run it if SECURITY INVOKER turns out to break one of the guarded screens --
-- which would show up as a legitimate user (owner or pharmacist) being told
-- "Only the owner or a pharmacist can ..." when they should be allowed.
--
-- No data is touched. The guard logic is identical either way; only the
-- security mode and the grants change.

create or replace function public.protect_drug_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.uid() is null then
    return NEW;
  end if;
  if coalesce(my_role()::text, '') not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist or a stock taker can add a drug';
  end if;
  return NEW;
end;
$function$;

create or replace function public.protect_batch_discount()
returns trigger
language plpgsql
security definer
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
security definer
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
security definer
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

grant execute on function public.protect_drug_insert() to public;
grant execute on function public.protect_batch_discount() to public;
grant execute on function public.protect_supplier_insert() to public;
grant execute on function public.protect_claim_status() to public;
