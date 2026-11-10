-- 2026-11-10_role_checks_on_direct_writes.sql
--
-- Closes the "Direct writes bypass role checks" open item in OPERATIONS.md
-- (item 5) and makes the promise in js/core.js lines 25-27 true:
--   "This only decides what the screen offers. The real gate is the database
--    ... so a hidden button can never be bypassed by calling the API directly."
--
-- WHAT WAS WRONG
-- Four screens write their table directly over PostgREST instead of going
-- through a role-checked function. Their RLS policies are tenancy-only
-- (`pharmacy_id = my_pharmacy_id()`, with no role test), and `authenticated`
-- holds the column privileges, so the role gate existed only in the browser.
-- Any signed-in user of any role could reproduce the write with a direct API
-- call, whatever their role or per-staff permissions:
--
--   1. drugs UPDATE  (no screen uses this at all)
--      An attendant could set is_prescription = false, which is exactly what
--      record_sale reads to decide whether a patient must be recorded, and
--      active = false to hide any drug -- both refused by the proper
--      functions (edit_drug, set_drug_active, set_drug_control).
--      control_class was already safe (trg_protect_drug_control_class).
--   2. batches.discount_percent UPDATE  (js/stock-actions.js saveDiscount)
--      record_sale and quote_sale price a line as
--      sell_price * (1 - discount_percent/100), so a direct write of 100
--      sells that batch for nothing. UI-gated by can('discount') only.
--   3. suppliers INSERT  (js/suppliers.js saveSupplier)
--      Includes opening_balance, which feeds what the pharmacy believes it
--      owes. UI-gated by can('suppliers') only.
--   4. insurance_claims.status UPDATE  (js/claims-settings.js updateClaimStatus)
--      UI-gated by can('claims') only.
--
-- WHAT CHANGES
-- (1) is simply revoked: no screen, function or edge function writes drugs
-- directly, so the privilege has no user. Verified by searching every js/
-- file, admin.js, install.js, the Netlify functions and the Edge Functions.
--
-- (2), (3) and (4) stay as direct writes -- the screens keep working exactly
-- as they do today, with no front-end change -- but gain a BEFORE trigger
-- that enforces the same role rule the screen does. This is the pattern this
-- project already uses in protect_pharmacy_billing, protect_sms_cap and
-- protect_drug_control_class, so it should read as familiar.
--
-- The role lists mirror js/core.js exactly:
--   discount  -> owner, co_owner, pharmacist          (PHARMACIST_ACTIONS)
--   suppliers -> owner, co_owner, pharmacist          (write; accountant has
--                                                      view_suppliers only)
--   claims    -> owner, co_owner, pharmacist, accountant
-- and each also honours the owner's per-staff switches via staff_can(), so a
-- pharmacist who had "discount" switched off is refused here too.
--
-- drugs INSERT is also gated, but to owner, co_owner, pharmacist AND
-- stock_taker -- deliberately wider than the Add-a-drug screen's
-- can('edit_inventory'). import_stock_rows and sync_master_drugs create drugs
-- and already allow stock_taker, so a narrower list would break Import and
-- "Sync common drugs" for them, and allowing it grants a stock taker nothing
-- they cannot already do through those two functions.
--
-- Every trigger returns early when auth.uid() is null. That is the admin
-- context -- the Supabase SQL editor and the demo_* functions, which are
-- granted to postgres only -- and the service_role key, which bypasses RLS
-- altogether. So this exempts nothing that was not already unrestricted.
--
-- WHY IT IS SAFE
-- Safe to run twice (create or replace, drop trigger if exists). No data is
-- read, written or dropped. No function signature changes. No front-end
-- change, so no sw.js cache bump.

-- 1. drugs: remove the unused direct-write privilege ------------------------
-- INSERT stays: js/stock-actions.js saveNewDrug() uses it (gated below).
revoke update on public.drugs from authenticated;

-- 2. drugs INSERT: the role gate the Add-a-drug screen shows ----------------
create or replace function public.protect_drug_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.uid() is null then
    return NEW;   -- admin / service_role context, already unrestricted
  end if;
  if coalesce(my_role()::text, '') not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist or a stock taker can add a drug';
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_protect_drug_insert on public.drugs;
create trigger trg_protect_drug_insert
  before insert on public.drugs
  for each row execute function protect_drug_insert();

-- 3. batches.discount_percent: markdown changes the price a customer pays ---
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

drop trigger if exists trg_protect_batch_discount on public.batches;
create trigger trg_protect_batch_discount
  before update of discount_percent on public.batches
  for each row
  when (NEW.discount_percent is distinct from OLD.discount_percent)
  execute function protect_batch_discount();

-- 4. suppliers INSERT: opening_balance is money the pharmacy thinks it owes -
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

drop trigger if exists trg_protect_supplier_insert on public.suppliers;
create trigger trg_protect_supplier_insert
  before insert on public.suppliers
  for each row execute function protect_supplier_insert();

-- 5. insurance_claims.status ------------------------------------------------
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

drop trigger if exists trg_protect_claim_status on public.insurance_claims;
create trigger trg_protect_claim_status
  before update of status on public.insurance_claims
  for each row
  when (NEW.status is distinct from OLD.status)
  execute function protect_claim_status();
