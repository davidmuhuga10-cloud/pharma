-- 2026-10-30 Senior review fixes (performance only; no data or RLS logic change)
--
-- Safe to run more than once. Changes no row-level-security *logic* — the
-- profiles policy below is recreated with an identical rule, only rewritten
-- so the auth lookup runs once per query instead of once per row.
--
-- Applied live to project ovegzdlrhlcpjfcsoumu on 2026-10-30.
--
-- 1. Covering indexes for three foreign keys that had none (Supabase
--    performance advisor 0001). They speed up joins/look-ups by these keys
--    and the referential-integrity checks on them. Tiny tables today, so no
--    lock concern; added now so they are in place before data grows.
create index if not exists supplier_lpo_items_drug_id_idx on public.supplier_lpo_items (drug_id);
create index if not exists supplier_lpos_supplier_id_idx   on public.supplier_lpos (supplier_id);
create index if not exists supplier_payments_supplier_id_idx on public.supplier_payments (supplier_id);

-- 2. profiles SELECT policy re-evaluated auth.uid() for every row scanned
--    (advisor 0003, auth_rls_initplan). Wrapping it in a scalar sub-select
--    makes Postgres evaluate it once. Same visibility rule as before:
--    a member sees colleagues in their own pharmacy, plus their own row.
drop policy if exists "read colleagues in same pharmacy" on public.profiles;
create policy "read colleagues in same pharmacy" on public.profiles
  for select using (pharmacy_id = my_pharmacy_id() or id = (select auth.uid()));
