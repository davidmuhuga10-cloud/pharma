-- 2026-10-29 (d) Scalability: missing indexes + server-side sales report
--
-- Safe to run more than once. Nothing here changes or deletes data.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app.js.
--
-- 1. Indexes. Every table is filtered by pharmacy_id (row level security does
--    it on every query), but a few tables had no index starting with
--    pharmacy_id, so each query read every pharmacy's rows. These fix that.
-- 2. sales_report() / sales_report_page(). The Reports screen used to download
--    every sale, item and payment of the period and add them up in the
--    browser (and broke outright once a period had a few hundred sales).
--    The database now does the adding up, and the list is fetched one page
--    at a time.
-- 3. supplier_balances(). The Suppliers list used to download every delivery
--    and payment ever made just to work out who is owed what.

-- ---------------------------------------------------------------- indexes
create index if not exists sales_payments_pharmacy_idx
  on public.sales_payments (pharmacy_id);

-- "Top sellers" and stock-movement style queries: which sales sold this drug.
create index if not exists sale_items_drug_sale_idx
  on public.sale_items (drug_id, sale_id);

-- Selling takes the oldest-expiry batch with stock first (FEFO).
create index if not exists batches_fefo_idx
  on public.batches (pharmacy_id, drug_id, expiry_date, created_at, id)
  where quantity_remaining > 0;

create index if not exists returns_pharmacy_created_idx
  on public.returns (pharmacy_id, created_at desc);

create index if not exists insurance_claims_pharmacy_status_idx
  on public.insurance_claims (pharmacy_id, status, created_at desc);

create index if not exists held_sales_pharmacy_idx
  on public.held_sales (pharmacy_id);

create index if not exists suppliers_pharmacy_name_idx
  on public.suppliers (pharmacy_id, name);

create index if not exists staff_invites_pharmacy_idx
  on public.staff_invites (pharmacy_id);

-- ------------------------------------------------------- sales_report()
-- Totals for the Reports screen. security invoker: row level security still
-- decides what the caller can see, exactly as when the browser read the
-- tables directly. Voided sales are counted as transactions but not in money.
create or replace function public.sales_report(
  p_pharmacy_id uuid,
  p_start       timestamptz,
  p_end         timestamptz default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with s as (
    select id, total_amount, voided
      from sales
     where pharmacy_id = p_pharmacy_id
       and sold_at >= p_start
       and (p_end is null or sold_at < p_end)
  ),
  by_method as (
    select p.method::text as method, sum(p.amount) as amount
      from sales_payments p
      join s on s.id = p.sale_id and not s.voided
     where p.pharmacy_id = p_pharmacy_id
     group by p.method
  ),
  top as (
    select d.name, sum(i.quantity)::bigint as qty, sum(i.line_total) as value
      from sale_items i
      join s on s.id = i.sale_id and not s.voided
      left join drugs d on d.id = i.drug_id
     where i.pharmacy_id = p_pharmacy_id
     group by d.name
     order by sum(i.quantity) desc
     limit 8
  )
  select jsonb_build_object(
    'total',    coalesce((select sum(total_amount) from s where not voided), 0),
    'count',    (select count(*) from s),
    'by_method', coalesce((select jsonb_object_agg(method, amount) from by_method), '{}'::jsonb),
    'top_drugs', coalesce((select jsonb_agg(jsonb_build_object(
                    'name', coalesce(name, 'Unknown'), 'qty', qty, 'value', value)
                    order by qty desc) from top), '[]'::jsonb)
  )
$$;

revoke all on function public.sales_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_report(uuid, timestamptz, timestamptz) to authenticated;

-- -------------------------------------------------- sales_report_page()
-- One page of the transaction list, newest first, each sale with its payment
-- lines attached (small: usually one). Items are NOT included - the app asks
-- for them only when someone opens a sale.
create or replace function public.sales_report_page(
  p_pharmacy_id uuid,
  p_start       timestamptz,
  p_end         timestamptz default null,
  p_limit       integer default 20,
  p_offset      integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sold_at desc, x.id), '[]'::jsonb)
    from (
      select s.id, s.invoice_number, s.sold_at, s.total_amount, s.payment_method,
             s.customer_name, s.insurance_scheme, s.voided, s.void_reason,
             coalesce((select jsonb_agg(jsonb_build_object(
                         'id', p.id, 'method', p.method, 'amount', p.amount, 'reference', p.reference))
                         from sales_payments p
                        where p.sale_id = s.id and p.pharmacy_id = p_pharmacy_id), '[]'::jsonb) as payments
        from sales s
       where s.pharmacy_id = p_pharmacy_id
         and s.sold_at >= p_start
         and (p_end is null or s.sold_at < p_end)
       order by s.sold_at desc, s.id
       limit greatest(1, least(coalesce(p_limit, 20), 1000))
      offset greatest(0, coalesce(p_offset, 0))
    ) x
$$;

revoke all on function public.sales_report_page(uuid, timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function public.sales_report_page(uuid, timestamptz, timestamptz, integer, integer) to authenticated;

-- ------------------------------------------------- supplier_balances()
-- What each supplier is owed, worked out in the database. The Suppliers list
-- used to download every delivery and every payment ever recorded just to add
-- them up in the browser. Same rule as supplier_owed_summary():
--   balance = opening_balance + all deliveries - all payments
create or replace function public.supplier_balances(p_pharmacy_id uuid)
returns table (supplier_id uuid, balance numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select s.id,
         s.opening_balance
           + coalesce((select sum(l.total_amount) from supplier_lpos l
                        where l.supplier_id = s.id and l.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(p.amount) from supplier_payments p
                        where p.supplier_id = s.id and p.pharmacy_id = p_pharmacy_id), 0)
    from suppliers s
   where s.pharmacy_id = p_pharmacy_id
$$;

revoke all on function public.supplier_balances(uuid) from public, anon;
grant execute on function public.supplier_balances(uuid) to authenticated;
