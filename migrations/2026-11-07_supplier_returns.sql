-- 2026-11-07 (night, later still): returning stock to a supplier - step 2 of 2.
-- Run 2026-11-07_supplier_returns_a_enum.sql first.
--
-- A pharmacy sends expired, damaged or wrongly delivered stock back to the supplier and gets
-- a credit. Until now the only way to remove that stock was a write-off, which hid the
-- credit and left the supplier balance too high.
--
-- What is new (no existing row is edited):
--   * supplier_returns: one row per return (drug, batch, quantity, credit, reason, who).
--     Row-level security on, indexed by pharmacy. The app cannot write to it directly.
--   * record_supplier_return(): takes the quantity off the batch, writes the stock audit
--     trail entry (kind 'supplier_return'), and records the credit, all in one step.
--     Owner, co-owner and pharmacist only.
--   * supplier_balances() and supplier_owed_summary() now take the credits off what a
--     supplier is owed, so the Suppliers list and the dashboard "Debt owed" agree with the
--     statement. A supplier with no returns gives exactly the same balance as before.
--   * The controlled drugs register accepts the new movement, so returning a controlled
--     drug is on the register as "Returned to supplier".

-- 1. controlled drugs register: allow the new kind --------------------------------------
alter table public.controlled_ledger drop constraint if exists controlled_ledger_kind_check;
alter table public.controlled_ledger add constraint controlled_ledger_kind_check
  check (kind in ('opening', 'restock', 'sale', 'return', 'void', 'correction',
                  'write_off', 'expired_disposal', 'stock_take', 'supplier_return'));

-- 2. the table -----------------------------------------------------------------------------
create table if not exists public.supplier_returns (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references public.pharmacies(id) on delete cascade,
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  drug_id       uuid not null references public.drugs(id),
  batch_id      uuid references public.batches(id) on delete set null,
  quantity      integer not null check (quantity > 0),
  unit_cost     numeric(10,2),
  credit_amount numeric(10,2) not null check (credit_amount >= 0),
  reason        text not null,
  returned_at   date not null default current_date,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index if not exists supplier_returns_pharmacy_idx on public.supplier_returns (pharmacy_id, supplier_id, returned_at desc);
create index if not exists supplier_returns_supplier_id_idx on public.supplier_returns (supplier_id);
create index if not exists supplier_returns_drug_id_idx on public.supplier_returns (drug_id);
create index if not exists supplier_returns_batch_id_idx on public.supplier_returns (batch_id);
create index if not exists supplier_returns_created_by_idx on public.supplier_returns (created_by);

alter table public.supplier_returns enable row level security;
drop policy if exists "reviewers read supplier_returns" on public.supplier_returns;
create policy "reviewers read supplier_returns" on public.supplier_returns for select
  using (pharmacy_id = my_pharmacy_id() and my_role() in ('owner', 'co_owner', 'pharmacist', 'accountant'));
revoke all on public.supplier_returns from anon, authenticated;
grant select on public.supplier_returns to authenticated;
grant select, insert, update, delete on public.supplier_returns to service_role;

-- 3. the function -------------------------------------------------------------------------
-- p_credit_amount empty = quantity x the batch's cost price. If the batch has no cost price
-- the person must type the credit (0 if the supplier gives none).
create or replace function public.record_supplier_return(
  p_pharmacy_id   uuid,
  p_supplier_id   uuid,
  p_batch_id      uuid,
  p_quantity      integer,
  p_reason        text,
  p_credit_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_batch    record;
  v_supplier record;
  v_credit   numeric;
  v_id       uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can return stock to a supplier';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Return quantity must be greater than zero';
  end if;
  if v_reason is null then
    raise exception 'Give a reason for the return. It goes on the stock audit trail';
  end if;

  select id, name into v_supplier from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id;
  if not found then
    raise exception 'Supplier not found';
  end if;

  select * into v_batch from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Batch not found';
  end if;
  if v_batch.supplier_id is not null and v_batch.supplier_id <> p_supplier_id then
    raise exception 'This batch came from a different supplier';
  end if;
  if p_quantity > v_batch.quantity_remaining then
    raise exception 'Only % left in this batch', v_batch.quantity_remaining;
  end if;

  if p_credit_amount is null then
    if v_batch.cost_price is null then
      raise exception 'This batch has no cost price. Type the credit the supplier gives (0 if none)';
    end if;
    v_credit := round(p_quantity * v_batch.cost_price, 2);
  else
    v_credit := p_credit_amount;
  end if;
  if v_credit < 0 or v_credit > 100000000 then
    raise exception 'The credit must be 0 or more';
  end if;

  update batches set quantity_remaining = quantity_remaining - p_quantity where id = p_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_batch.drug_id, p_batch_id, 'supplier_return', -p_quantity,
          'Returned to ' || v_supplier.name || ': ' || v_reason, auth.uid());

  insert into supplier_returns (pharmacy_id, supplier_id, drug_id, batch_id, quantity, unit_cost, credit_amount, reason, created_by)
  values (p_pharmacy_id, p_supplier_id, v_batch.drug_id, p_batch_id, p_quantity, v_batch.cost_price, v_credit, v_reason, auth.uid())
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'credit_amount', v_credit);
end;
$$;
revoke all on function public.record_supplier_return(uuid, uuid, uuid, integer, text, numeric) from public, anon;
grant execute on function public.record_supplier_return(uuid, uuid, uuid, integer, text, numeric) to authenticated;

-- 4. what a supplier is owed now also takes off the credits -----------------------------------
--   balance = opening balance + deliveries - payments - credits for returned stock
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
           - coalesce((select sum(r.credit_amount) from supplier_returns r
                        where r.supplier_id = s.id and r.pharmacy_id = p_pharmacy_id), 0)
    from suppliers s
   where s.pharmacy_id = p_pharmacy_id
$$;
revoke all on function public.supplier_balances(uuid) from public, anon;
grant execute on function public.supplier_balances(uuid) to authenticated;

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
                        where p.supplier_id = s.id and p.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(r.credit_amount) from supplier_returns r
                        where r.supplier_id = s.id and r.pharmacy_id = p_pharmacy_id), 0) as b
      from suppliers s
     where s.pharmacy_id = p_pharmacy_id
  )
  select coalesce(sum(b) filter (where b > 0.5), 0)::numeric,
         (count(*) filter (where b > 0.5))::integer
    from bal
$$;
revoke all on function public.supplier_owed_summary(uuid) from public, anon;
grant execute on function public.supplier_owed_summary(uuid) to authenticated;
