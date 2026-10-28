-- ============================================================================
-- PHARMA — review fixes, 2026-10-28
-- Safe to re-run. Every statement is CREATE OR REPLACE / idempotent; no data
-- is touched and no table is dropped.
--
-- 1. quote_sale()            NEW — authoritative FEFO price quote for the cart
-- 2. record_sale()           deterministic FEFO order + per-item qty validation
-- 3. record_return()         stop over-returning and returning a voided sale
-- 4. record_write_off()      stop a negative quantity fabricating stock
-- 5. record_restock()        stop writing a price onto another tenant's drug
-- 6. record_supplier_lpo()   same cross-tenant check, per line item
-- 7. profiles guard trigger  protect the literal 'owner' row from a co_owner
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. quote_sale() — what the cart should actually charge
-- ----------------------------------------------------------------------------
-- The Sell screen prices a cart from drugs.default_price, but record_sale
-- prices every line from the batch FEFO lands on, including that batch's
-- markdown (batches.discount_percent). Those two numbers are only equal while
-- a drug has exactly one batch at the current price. The moment there is an
-- older batch left at a different price, or any batch is marked down, the
-- client asks for payments summing to the wrong total and record_sale rejects
-- the whole sale with "Payments do not add up to the sale total".
--
-- This runs record_sale's pricing loop read-only so the client can charge the
-- real number. Same FEFO order, same rounding, same markdown maths — kept
-- byte-for-byte in step with record_sale below.
create or replace function quote_sale(p_pharmacy_id uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_drug_id uuid;
  v_qty integer;
  v_fill integer;
  v_batch record;
  v_take integer;
  v_price numeric(10,2);
  v_line numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', true, 'total', 0, 'lines', '[]'::jsonb);
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;
    v_fill := v_qty;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
    loop
      exit when v_fill <= 0;
      v_take := least(v_batch.quantity_remaining, v_fill);
      v_price := round(v_batch.sell_price * (1 - v_batch.discount_percent / 100.0), 2);
      v_line := round(v_take * v_price, 2);
      v_subtotal := v_subtotal + v_line;
      v_lines := v_lines || jsonb_build_object(
        'drug_id', v_drug_id, 'batch_id', v_batch.id, 'quantity', v_take,
        'unit_price', v_price, 'line_total', v_line,
        'discount_percent', v_batch.discount_percent);
      v_fill := v_fill - v_take;
    end loop;

    if v_fill > 0 then
      return jsonb_build_object('ok', false, 'short_drug_id', v_drug_id,
                                'short_by', v_fill, 'total', v_subtotal, 'lines', v_lines);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'total', v_subtotal, 'lines', v_lines);
end;
$$;

grant execute on function quote_sale(uuid, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- 2. record_sale() — deterministic FEFO order, and reject a bad quantity
-- ----------------------------------------------------------------------------
-- Changes vs the previous version:
--   * `order by expiry_date` alone is ambiguous when two batches share an
--     expiry date, so quote_sale and record_sale could pick different batches
--     (and therefore different prices) for the same cart. Both now tie-break
--     on created_at then id.
--   * a quantity of 0 or less used to fall straight through the fill loop and
--     be silently dropped from the sale instead of being rejected.
create or replace function record_sale(
  p_pharmacy_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_insurance_scheme text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_drug_id uuid;
  v_qty_needed integer;
  v_qty_remaining_to_fill integer;
  v_batch record;
  v_take integer;
  v_effective_price numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_line_total numeric(10,2);
  v_vat_rate numeric(5,2);
  v_payments_total numeric(10,2) := 0;
  v_amount numeric(10,2);
  v_method_count integer;
  v_first_method payment_method;
  v_invoice_seq integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a sale';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'A sale needs at least one payment';
  end if;

  select vat_rate into v_vat_rate from pharmacies where id = p_pharmacy_id;

  update pharmacies set next_invoice_no = next_invoice_no + 1
  where id = p_pharmacy_id
  returning next_invoice_no - 1 into v_invoice_seq;

  insert into sales (pharmacy_id, payment_method, customer_name, insurance_scheme, invoice_number, created_by)
  values (p_pharmacy_id, 'cash', p_customer_name, p_insurance_scheme, 'INV-' || lpad(v_invoice_seq::text, 6, '0'), auth.uid())
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty_needed := (v_item->>'quantity')::integer;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;
    v_qty_remaining_to_fill := v_qty_needed;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
      for update
    loop
      exit when v_qty_remaining_to_fill <= 0;
      v_take := least(v_batch.quantity_remaining, v_qty_remaining_to_fill);
      v_effective_price := round(v_batch.sell_price * (1 - v_batch.discount_percent / 100.0), 2);

      update batches set quantity_remaining = quantity_remaining - v_take where id = v_batch.id;

      v_line_total := round(v_take * v_effective_price, 2);
      v_subtotal := v_subtotal + v_line_total;

      insert into sale_items (sale_id, pharmacy_id, drug_id, batch_id, quantity, unit_price, line_total, patient_name, prescriber_name)
      values (v_sale_id, p_pharmacy_id, v_drug_id, v_batch.id, v_take, v_effective_price, v_line_total,
              v_item->>'patient_name', v_item->>'prescriber_name');

      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, ref_sale_id, created_by)
      values (p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take, v_sale_id, auth.uid());

      v_qty_remaining_to_fill := v_qty_remaining_to_fill - v_take;
    end loop;

    if v_qty_remaining_to_fill > 0 then
      raise exception 'Not enough stock for drug %: short by %', v_drug_id, v_qty_remaining_to_fill;
    end if;
  end loop;

  if abs(v_subtotal) < 0.01 then
    raise exception 'Sale total is zero';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_amount := (v_payment->>'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every payment line needs an amount greater than zero';
    end if;
    v_payments_total := v_payments_total + v_amount;
    insert into sales_payments (sale_id, pharmacy_id, method, amount, reference)
    values (v_sale_id, p_pharmacy_id, (v_payment->>'method')::payment_method, v_amount, v_payment->>'reference');
  end loop;

  if abs(v_payments_total - v_subtotal) > 0.01 then
    raise exception 'Payments (%) do not add up to the sale total (%)', v_payments_total, v_subtotal;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id order by id limit 1;

  update sales
  set subtotal = v_subtotal,
      vat_amount = round(v_subtotal * v_vat_rate / (100 + v_vat_rate), 2),
      total_amount = v_subtotal,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end
  where id = v_sale_id;

  return v_sale_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. record_return() — the same line could be returned over and over
-- ----------------------------------------------------------------------------
-- The old version only checked p_quantity against sale_items.quantity, never
-- against what had already been returned off that line. Returning 5 of a
-- 5-unit line five times credited 25 units of stock and logged five refunds,
-- with nothing to stop it. It also had no idea whether the sale had since been
-- voided — void_sale refuses to run once a return exists, but not the reverse,
-- so void-then-return credited the same stock twice.
create or replace function record_return(
  p_pharmacy_id uuid,
  p_sale_item_id uuid,
  p_quantity integer,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_refund numeric(10,2);
  v_already integer;
  v_voided boolean;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a return';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Return quantity must be greater than zero';
  end if;

  -- for update serializes two tills returning the same line at the same moment
  select * into v_item from sale_items
  where id = p_sale_item_id and pharmacy_id = p_pharmacy_id
  for update;
  if not found then
    raise exception 'Sale item not found';
  end if;

  select voided into v_voided from sales where id = v_item.sale_id;
  if coalesce(v_voided, false) then
    raise exception 'That sale was voided — its stock has already been put back, so it cannot be returned as well';
  end if;

  select coalesce(sum(quantity), 0) into v_already
  from returns where sale_item_id = p_sale_item_id;

  if p_quantity + v_already > v_item.quantity then
    raise exception 'Only % of this line can still be returned (% sold, % already returned)',
      v_item.quantity - v_already, v_item.quantity, v_already;
  end if;

  v_refund := round(p_quantity * v_item.unit_price, 2);

  update batches set quantity_remaining = quantity_remaining + p_quantity where id = v_item.batch_id;

  insert into returns (pharmacy_id, sale_item_id, drug_id, batch_id, quantity, reason, refund_amount, created_by)
  values (p_pharmacy_id, p_sale_item_id, v_item.drug_id, v_item.batch_id, p_quantity, p_reason, v_refund, auth.uid());

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'return', p_quantity, p_reason, auth.uid());
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. record_write_off() — a negative quantity added stock instead of removing it
-- ----------------------------------------------------------------------------
-- `quantity_remaining - p_quantity` with a negative p_quantity increases the
-- batch, and the audit row logs it as a positive 'write_off'. Nothing in the
-- old function or the table constraints rejected it, so any pharmacist could
-- invent stock from a write-off form.
create or replace function record_write_off(
  p_pharmacy_id uuid,
  p_batch_id uuid,
  p_quantity integer,
  p_reason text,
  p_type adjustment_type default 'write_off'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug_id uuid;
  v_remaining integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can write off stock';
  end if;
  if p_type not in ('write_off', 'expired_disposal') then
    raise exception 'Invalid write-off type';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Write-off quantity must be greater than zero';
  end if;

  select drug_id, quantity_remaining into v_drug_id, v_remaining
  from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id
  for update;

  if v_drug_id is null then
    raise exception 'Batch not found';
  end if;
  if p_quantity > v_remaining then
    raise exception 'Only % left in this batch', v_remaining;
  end if;

  update batches set quantity_remaining = quantity_remaining - p_quantity where id = p_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_drug_id, p_batch_id, p_type, -p_quantity, p_reason, auth.uid());
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. record_restock() — wrote a price onto a drug in a different pharmacy
-- ----------------------------------------------------------------------------
-- p_drug_id was never checked against p_pharmacy_id. The new batch got the
-- caller's own pharmacy_id (so RLS still hid it), but the function ends with
--   update drugs set default_price = p_sell_price where id = p_drug_id;
-- and runs SECURITY DEFINER, so a hand-made RPC call with another pharmacy's
-- drug id rewrote that pharmacy's shelf price. Validating ownership closes it
-- and turns a silent cross-tenant write into "Drug not found".
create or replace function record_restock(
  p_pharmacy_id uuid,
  p_drug_id uuid,
  p_quantity integer,
  p_cost_price numeric,
  p_sell_price numeric,
  p_expiry_date date,
  p_batch_no text default null,
  p_supplier text default null,
  p_supplier_id uuid default null,
  p_expiry_unknown boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_expiry date;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can restock';
  end if;
  if not exists (select 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Drug not found';
  end if;
  if p_supplier_id is not null
     and not exists (select 1 from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Supplier not found';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Restock quantity must be greater than zero';
  end if;
  if p_sell_price is null or p_sell_price < 0 then
    raise exception 'Enter a selling price';
  end if;

  if p_expiry_unknown then
    v_expiry := (current_date + interval '3 years')::date;
  else
    if p_expiry_date is null then
      raise exception 'Expiry date is required unless expiry is marked unknown';
    end if;
    v_expiry := p_expiry_date;
  end if;

  insert into batches (pharmacy_id, drug_id, batch_no, supplier, supplier_id, quantity_received,
                        quantity_remaining, cost_price, sell_price, expiry_date, expiry_unknown, created_by)
  values (p_pharmacy_id, p_drug_id, p_batch_no, p_supplier, p_supplier_id, p_quantity,
          p_quantity, p_cost_price, p_sell_price, v_expiry, p_expiry_unknown, auth.uid())
  returning id into v_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, created_by)
  values (p_pharmacy_id, p_drug_id, v_batch_id, 'restock', p_quantity, auth.uid());

  update drugs set default_price = p_sell_price where id = p_drug_id and pharmacy_id = p_pharmacy_id;

  return v_batch_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. record_supplier_lpo() — same cross-tenant write, one per line item
-- ----------------------------------------------------------------------------
create or replace function record_supplier_lpo(
  p_pharmacy_id uuid,
  p_supplier_id uuid,
  p_items jsonb,
  p_delivered_at date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lpo_id uuid;
  v_lpo_seq integer;
  v_supplier_name text;
  v_item jsonb;
  v_drug_id uuid;
  v_quantity integer;
  v_cost_price numeric(10,2);
  v_sell_price numeric(10,2);
  v_expiry_unknown boolean;
  v_batch_no text;
  v_batch_id uuid;
  v_expiry date;
  v_line_total numeric(10,2);
  v_total numeric(10,2) := 0;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a supplier delivery';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'An LPO needs at least one item';
  end if;

  select name into v_supplier_name from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id;
  if v_supplier_name is null then
    raise exception 'Supplier not found';
  end if;

  update pharmacies set next_lpo_no = next_lpo_no + 1
  where id = p_pharmacy_id
  returning next_lpo_no - 1 into v_lpo_seq;

  insert into supplier_lpos (pharmacy_id, supplier_id, lpo_number, delivered_at, notes, created_by)
  values (p_pharmacy_id, p_supplier_id, 'LPO-' || lpad(v_lpo_seq::text, 6, '0'), coalesce(p_delivered_at, current_date), p_notes, auth.uid())
  returning id into v_lpo_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_cost_price := (v_item->>'cost_price')::numeric;
    v_sell_price := coalesce(nullif(v_item->>'sell_price', '')::numeric, v_cost_price);
    v_batch_no := v_item->>'batch_no';
    v_expiry_unknown := coalesce((v_item->>'expiry_unknown')::boolean, false);

    if not exists (select 1 from drugs where id = v_drug_id and pharmacy_id = p_pharmacy_id) then
      raise exception 'Drug not found on this delivery';
    end if;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Each line item needs a quantity greater than zero';
    end if;
    if v_cost_price is null then
      raise exception 'Each line item needs a cost price';
    end if;

    if v_expiry_unknown then
      v_expiry := (current_date + interval '3 years')::date;
    else
      v_expiry := nullif(v_item->>'expiry_date', '')::date;
      if v_expiry is null then
        raise exception 'Expiry date is required unless expiry is marked unknown';
      end if;
    end if;

    insert into batches (pharmacy_id, drug_id, batch_no, supplier, supplier_id, quantity_received,
                          quantity_remaining, cost_price, sell_price, expiry_date, expiry_unknown, created_by)
    values (p_pharmacy_id, v_drug_id, v_batch_no, v_supplier_name, p_supplier_id, v_quantity,
            v_quantity, v_cost_price, v_sell_price, v_expiry, v_expiry_unknown, auth.uid())
    returning id into v_batch_id;

    insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, created_by)
    values (p_pharmacy_id, v_drug_id, v_batch_id, 'restock', v_quantity, auth.uid());

    update drugs set default_price = v_sell_price where id = v_drug_id and pharmacy_id = p_pharmacy_id;

    v_line_total := round(v_quantity * v_cost_price, 2);
    v_total := v_total + v_line_total;

    insert into supplier_lpo_items (lpo_id, pharmacy_id, drug_id, batch_id, quantity, cost_price, line_total)
    values (v_lpo_id, p_pharmacy_id, v_drug_id, v_batch_id, v_quantity, v_cost_price, v_line_total);
  end loop;

  update supplier_lpos set total_amount = v_total where id = v_lpo_id;

  return v_lpo_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. prevent_profile_privilege_escalation() — protect the owner's own row
-- ----------------------------------------------------------------------------
-- co_owner is "full equal access to owner", and the profiles UPDATE policy lets
-- a co_owner update any row in the pharmacy. The old trigger only blocked
-- promotion TO 'owner' — it never stopped a co_owner from demoting or
-- deactivating the literal owner. Since nothing can ever mint a new 'owner'
-- (bootstrap_pharmacy only runs at signup), that locked the real owner out of
-- their own pharmacy permanently, with no way back. The owner's role and
-- active flag are now immutable from the API; an owner can still edit their own
-- name, phone and language.
create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active
      or new.pharmacy_id is distinct from old.pharmacy_id
      or new.account_expires_at is distinct from old.account_expires_at) then
    if my_role() not in ('owner', 'co_owner') then
      raise exception 'Only the pharmacy owner can change role, active status, or account expiry';
    end if;
    if new.pharmacy_id is distinct from old.pharmacy_id then
      raise exception 'A profile cannot be moved to a different pharmacy';
    end if;
    if new.role = 'owner' and old.role is distinct from 'owner' then
      raise exception 'Cannot promote a staff member to owner';
    end if;
    if old.role = 'owner'
       and (new.role is distinct from old.role or new.active is distinct from old.active) then
      raise exception 'The pharmacy owner''s own role and access cannot be changed';
    end if;
  end if;
  return new;
end;
$$;
