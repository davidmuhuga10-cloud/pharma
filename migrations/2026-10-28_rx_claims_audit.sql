-- ============================================================================
-- PHARMA — review fixes part 3, 2026-10-28
-- Applied live as migration: rx_enforcement_atomic_claims_and_audit_reasons
-- Safe to re-run.
--
--   * insurance_claims.status constrained to the four states the UI filters on
--   * record_correction / record_write_off require a reason (audit trail)
--   * record_sale enforces prescription capture server-side, and creates the
--     insurance claim inside the sale's own transaction
-- ============================================================================

-- insurance_claims.status was free text with a default of 'pending' and no
-- constraint, so a typo ('Paid', 'submited') silently created a status the
-- Reports filter would never match again.
alter table insurance_claims drop constraint if exists insurance_claims_status_check;
update insurance_claims set status = lower(trim(status))
where status is distinct from lower(trim(status));
update insurance_claims set status = 'pending'
where status not in ('pending', 'submitted', 'paid', 'rejected');
alter table insurance_claims
  add constraint insurance_claims_status_check
  check (status in ('pending', 'submitted', 'paid', 'rejected'));

-- record_correction(): a correction overwrites a counted quantity outright,
-- which is the easiest way in the whole app to make stock appear or vanish.
-- The reason was optional and the app sent null when the box was left blank,
-- so the stock_adjustments audit row — the thing a PPB GSDP inspection
-- actually reads — recorded the change with no explanation at all.
create or replace function record_correction(
  p_pharmacy_id uuid,
  p_batch_id uuid,
  p_new_quantity integer,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug_id uuid;
  v_old_qty integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can correct stock';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'Quantity cannot be negative';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Give a reason for the correction — it goes on the stock audit trail';
  end if;

  select drug_id, quantity_remaining into v_drug_id, v_old_qty
  from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id
  for update;

  if v_drug_id is null then
    raise exception 'Batch not found';
  end if;

  update batches set quantity_remaining = p_new_quantity where id = p_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_drug_id, p_batch_id, 'correction', p_new_quantity - v_old_qty, trim(p_reason), auth.uid());
end;
$$;

-- record_write_off(): same audit-trail argument — stock leaves the building
-- and the adjustment row is the only record of why.
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
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Give a reason for the write-off — it goes on the stock audit trail';
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
  values (p_pharmacy_id, v_drug_id, p_batch_id, p_type, -p_quantity, trim(p_reason), auth.uid());
end;
$$;

-- record_sale(): two more gaps.
--
-- (a) Prescription capture was enforced only in the browser. openRxCapture()
--     demands a patient name before an Rx drug reaches the cart, but nothing
--     stopped a direct RPC call from recording an Rx sale with no patient at
--     all — and for a prescription-only medicine that record is a legal
--     requirement, not a nicety.
--
-- (b) The insurance claim was created by a SECOND statement from the browser
--     after record_sale returned. If that insert failed — connection dropped
--     at the till, tab closed — the sale was already committed and the claim
--     simply never existed, so the pharmacy silently lost the money it was
--     owed. It now happens inside the same transaction as the sale, and for
--     every insurance payment line rather than only the first one.
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
  v_drug record;
  v_patient text;
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
  v_method payment_method;
  v_reference text;
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

    select id, name, is_prescription into v_drug
    from drugs where id = v_drug_id and pharmacy_id = p_pharmacy_id;
    if v_drug.id is null then
      raise exception 'Drug not found';
    end if;

    v_patient := nullif(trim(coalesce(v_item->>'patient_name', '')), '');
    if v_drug.is_prescription and v_patient is null then
      raise exception '% is a prescription-only medicine — record the patient''s name', v_drug.name;
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
              v_patient, nullif(trim(coalesce(v_item->>'prescriber_name', '')), ''));

      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, ref_sale_id, created_by)
      values (p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take, v_sale_id, auth.uid());

      v_qty_remaining_to_fill := v_qty_remaining_to_fill - v_take;
    end loop;

    if v_qty_remaining_to_fill > 0 then
      raise exception 'Not enough stock for %: short by %', v_drug.name, v_qty_remaining_to_fill;
    end if;
  end loop;

  if abs(v_subtotal) < 0.01 then
    raise exception 'Sale total is zero';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_amount := (v_payment->>'amount')::numeric;
    v_method := (v_payment->>'method')::payment_method;
    v_reference := nullif(trim(coalesce(v_payment->>'reference', '')), '');
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every payment line needs an amount greater than zero';
    end if;
    v_payments_total := v_payments_total + v_amount;

    insert into sales_payments (sale_id, pharmacy_id, method, amount, reference)
    values (v_sale_id, p_pharmacy_id, v_method, v_amount, v_reference);

    -- the claim is part of the sale, not a follow-up round trip
    if v_method = 'insurance' then
      insert into insurance_claims (pharmacy_id, sale_id, scheme, amount, status, created_by)
      values (p_pharmacy_id, v_sale_id,
              coalesce(v_reference, nullif(trim(coalesce(p_insurance_scheme, '')), ''), 'Unspecified'),
              v_amount, 'pending', auth.uid());
    end if;
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

grant execute on function record_sale(uuid, jsonb, jsonb, text, text) to authenticated;
grant execute on function record_correction(uuid, uuid, integer, text) to authenticated;
grant execute on function record_write_off(uuid, uuid, integer, text, adjustment_type) to authenticated;
