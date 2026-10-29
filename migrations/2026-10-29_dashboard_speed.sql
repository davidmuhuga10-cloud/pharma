-- 2026-10-29: faster dashboard.
--
-- The dashboard used to download every supplier, every supplier delivery (LPO)
-- and every supplier payment, then add them up in the browser to find "Debt
-- owed". That is three requests whose size grows with every delivery and
-- payment ever recorded. This function does the same sum inside the database
-- and returns one small row: the total owed and how many suppliers are owed.
--
-- Same rule as before, supplier by supplier:
--   balance = opening_balance + all deliveries - all payments
-- and only balances above 0.5 count as owed.
--
-- security invoker: row level security still decides what the caller can see,
-- exactly as when the browser read the tables directly.

create or replace function public.supplier_owed_summary(p_pharmacy_id uuid)
returns table (owed numeric, owed_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  with bal as (
    select s.opening_balance
           + coalesce((select sum(l.total_amount) from supplier_lpos l
                        where l.supplier_id = s.id and l.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(p.amount) from supplier_payments p
                        where p.supplier_id = s.id and p.pharmacy_id = p_pharmacy_id), 0) as b
      from suppliers s
     where s.pharmacy_id = p_pharmacy_id
  )
  select coalesce(sum(b) filter (where b > 0.5), 0)::numeric,
         (count(*) filter (where b > 0.5))::integer
    from bal
$$;

revoke all on function public.supplier_owed_summary(uuid) from public, anon;
grant execute on function public.supplier_owed_summary(uuid) to authenticated;

create index if not exists supplier_payments_pharmacy_supplier_idx
  on supplier_payments (pharmacy_id, supplier_id);
