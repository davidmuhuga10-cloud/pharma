-- 2026-11-07 (night, later still): closing the cash drawer.
--
-- At the end of a shift the person counts the cash in the drawer. The app works out how much
-- should be there (cash sales, cash customer payments, less cash refunds, cash expenses and
-- cash supplier payments since the last closing, plus the float left last time), and records the
-- difference. A seller does a BLIND count: they type what they counted before seeing the
-- expected figure. Owners, co-owners and pharmacists see the figures first and can read the
-- history. If counted and expected differ, a short reason is required.
--
-- What is new (no existing row is edited):
--   * cash_closings: one row per closing (row-level security on, indexed by pharmacy).
--   * cash_drawer_summary(): the live figures for the open period.
--   * close_cash_drawer(): records a closing. Two people closing at the same moment are queued
--     (the pharmacy row is locked), so a period can never be counted twice.

create table if not exists public.cash_closings (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references public.pharmacies(id) on delete cascade,
  closed_by         uuid references public.profiles(id),
  closed_at         timestamptz not null default now(),
  period_start      timestamptz not null,
  opening           numeric(12,2) not null,
  cash_sales        numeric(12,2) not null,
  customer_payments numeric(12,2) not null,
  refunds           numeric(12,2) not null,
  expenses          numeric(12,2) not null,
  supplier_payments numeric(12,2) not null,
  expected          numeric(12,2) not null,
  counted           numeric(12,2) not null check (counted >= 0),
  kept              numeric(12,2) not null check (kept >= 0),
  difference        numeric(12,2) not null,
  note              text
);
create index if not exists cash_closings_pharmacy_idx on public.cash_closings (pharmacy_id, closed_at desc);
create index if not exists cash_closings_closed_by_idx on public.cash_closings (closed_by);
alter table public.cash_closings enable row level security;
drop policy if exists "reviewers read cash_closings" on public.cash_closings;
create policy "reviewers read cash_closings" on public.cash_closings for select
  using (pharmacy_id = my_pharmacy_id() and my_role() in ('owner', 'co_owner', 'pharmacist', 'accountant'));
revoke all on public.cash_closings from anon, authenticated;
grant select on public.cash_closings to authenticated;
grant select, insert, update, delete on public.cash_closings to service_role;

-- The figures for the period that started at the last closing (or at the start of today, Nairobi
-- time, when the drawer was never closed). Used by the two functions below; not callable by the app.
create or replace function public.cash_drawer_figures(p_pharmacy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start    timestamptz;
  v_opening  numeric := 0;
  v_sales    numeric;
  v_cust     numeric;
  v_refunds  numeric;
  v_exp      numeric;
  v_supp     numeric;
  v_last     record;
begin
  select * into v_last from cash_closings where pharmacy_id = p_pharmacy_id order by closed_at desc limit 1;
  if found then
    v_start := v_last.closed_at;
    v_opening := v_last.kept;
  else
    v_start := (today_ke()::timestamp at time zone 'Africa/Nairobi');
  end if;

  select coalesce(sum(sp.amount), 0) into v_sales
    from sales_payments sp join sales s on s.id = sp.sale_id
   where sp.pharmacy_id = p_pharmacy_id and sp.method = 'cash' and not s.voided and s.sold_at >= v_start;

  select coalesce(sum(amount), 0) into v_cust
    from customer_payments
   where pharmacy_id = p_pharmacy_id and kind = 'payment' and method = 'cash' and not voided and paid_at >= v_start;

  -- a refund counts as cash only when the original sale was paid at least partly in cash
  select coalesce(sum(r.refund_amount), 0) into v_refunds
    from returns r
    join sale_items si on si.id = r.sale_item_id
   where r.pharmacy_id = p_pharmacy_id and r.created_at >= v_start
     and exists (select 1 from sales_payments sp where sp.sale_id = si.sale_id and sp.method = 'cash');

  select coalesce(sum(amount), 0) into v_exp
    from expenses where pharmacy_id = p_pharmacy_id and method = 'cash' and not voided and created_at >= v_start;

  select coalesce(sum(amount), 0) into v_supp
    from supplier_payments where pharmacy_id = p_pharmacy_id and method = 'cash' and created_at >= v_start;

  return jsonb_build_object(
    'period_start', v_start, 'opening', v_opening, 'cash_sales', v_sales, 'customer_payments', v_cust,
    'refunds', v_refunds, 'expenses', v_exp, 'supplier_payments', v_supp,
    'expected', v_opening + v_sales + v_cust - v_refunds - v_exp - v_supp);
end;
$$;
revoke all on function public.cash_drawer_figures(uuid) from public, anon, authenticated;

create or replace function public.cash_drawer_summary(p_pharmacy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := my_role();
  v_f    jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if v_role not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'You cannot close the cash drawer';
  end if;
  v_f := cash_drawer_figures(p_pharmacy_id);
  if v_role = 'attendant' then
    -- a blind count: the seller does not see what the drawer should hold
    return jsonb_build_object('blind', true, 'period_start', v_f->'period_start');
  end if;
  return v_f || jsonb_build_object('blind', false);
end;
$$;
revoke all on function public.cash_drawer_summary(uuid) from public, anon;
grant execute on function public.cash_drawer_summary(uuid) to authenticated;

create or replace function public.close_cash_drawer(
  p_pharmacy_id uuid,
  p_counted     numeric,
  p_kept        numeric,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := my_role();
  v_f    jsonb;
  v_diff numeric;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id   uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if v_role not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'You cannot close the cash drawer';
  end if;
  if p_counted is null or p_counted < 0 or p_counted > 100000000 then
    raise exception 'Enter the cash you counted, 0 or more';
  end if;
  if p_kept is null or p_kept < 0 or p_kept > p_counted then
    raise exception 'The cash left in the drawer cannot be more than you counted';
  end if;
  perform 1 from pharmacies where id = p_pharmacy_id for update;   -- one closing at a time
  v_f := cash_drawer_figures(p_pharmacy_id);
  v_diff := p_counted - (v_f->>'expected')::numeric;
  if v_diff <> 0 and v_note is null then
    -- the message does not say short or over, so a blind count cannot be probed
    raise exception 'The count does not match what the system expects. Write a short reason.';
  end if;
  insert into cash_closings (pharmacy_id, closed_by, period_start, opening, cash_sales, customer_payments,
                             refunds, expenses, supplier_payments, expected, counted, kept, difference, note)
  values (p_pharmacy_id, auth.uid(), (v_f->>'period_start')::timestamptz, (v_f->>'opening')::numeric,
          (v_f->>'cash_sales')::numeric, (v_f->>'customer_payments')::numeric, (v_f->>'refunds')::numeric,
          (v_f->>'expenses')::numeric, (v_f->>'supplier_payments')::numeric, (v_f->>'expected')::numeric,
          p_counted, p_kept, v_diff, v_note)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'expected', (v_f->>'expected')::numeric, 'counted', p_counted, 'difference', v_diff);
end;
$$;
revoke all on function public.close_cash_drawer(uuid, numeric, numeric, text) from public, anon;
grant execute on function public.close_cash_drawer(uuid, numeric, numeric, text) to authenticated;
