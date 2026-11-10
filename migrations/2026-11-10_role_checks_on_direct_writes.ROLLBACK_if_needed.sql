-- 2026-11-10_role_checks_on_direct_writes.ROLLBACK_if_needed.sql
--
-- Undoes 2026-11-10_role_checks_on_direct_writes.sql: drops the four new
-- triggers and their functions, and restores the UPDATE privilege on drugs.
-- No data is touched or dropped by either the migration or this rollback.
--
-- Running this puts the four direct-write screens back to being gated only in
-- the browser, so only run it if one of those screens has actually broken,
-- and say which one in the changelog when you do.

drop trigger if exists trg_protect_drug_insert on public.drugs;
drop trigger if exists trg_protect_batch_discount on public.batches;
drop trigger if exists trg_protect_supplier_insert on public.suppliers;
drop trigger if exists trg_protect_claim_status on public.insurance_claims;

drop function if exists public.protect_drug_insert();
drop function if exists public.protect_batch_discount();
drop function if exists public.protect_supplier_insert();
drop function if exists public.protect_claim_status();

-- Restores the privilege exactly as it was: all columns of drugs.
grant update on public.drugs to authenticated;
