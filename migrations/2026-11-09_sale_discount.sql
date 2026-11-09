-- 2026-11-09  Discount on the whole bill, and reversing your own sale
--
-- WHAT WAS WRONG
--   Sellers give a discount on the final bill very often, and the app had no
--   place for it: the till had to be told a different price, or the cash taken
--   did not match the sale. A seller who made a slip could not undo it at all
--   (only the owner or a pharmacist could void a sale).
--
-- WHAT CHANGES
--   * sales.discount_amount: one amount in shillings off the whole bill (never per
--     drug). No cap, no reason, any role. It must stay below the bill total, so a
--     sale can never go to zero or below. It cannot be edited after the sale.
--   * record_sale gets an optional last argument p_discount (default 0). The old
--     six-argument version is dropped so the name is not ambiguous; callers that
--     send six arguments (the previous app version) keep working unchanged.
--     total_amount, VAT and the payments check all use the discounted total, so
--     takings, profit and the dashboard are right with no further change.
--   * record_return refunds the discounted share of a line (shelf price scaled by
--     total/subtotal). Sales without a discount refund exactly what they did.
--   * void_sale: the owner, co-owner and pharmacists can still reverse any sale.
--     A seller can reverse their OWN sale made today. sales.voided_by records who,
--     next to the existing voided_at and void_reason.
--   * sales_report_page also returns subtotal, discount_amount, voided_at, who
--     sold it and who reversed it, for the Sales Report and the sale detail.
--
-- WHY IT IS SAFE
--   Nothing existing changes: every old sale keeps discount_amount 0. Apply it
--   BEFORE the new app is live (the old app works with it; the new app needs it).
--   Safe to run twice. Rollback: 2026-11-09_sale_discount.ROLLBACK_if_needed.sql.

-- ---------------------------------------------------------------- columns
alter table public.sales add column if not exists discount_amount numeric(10,2) not null default 0
  constraint sales_discount_amount_check check (discount_amount >= 0);
alter table public.sales add column if not exists voided_by uuid;

-- ------------------------------------------------------------ record_sale
drop function if exists public.record_sale(uuid, jsonb, jsonb, text, text, uuid);

create or replace function public.record_sale(p_pharmacy_id uuid, p_items jsonb, p_payments jsonb, p_customer_name text DEFAULT NULL::text, p_insurance_scheme text DEFAULT NULL::text, p_customer_id uuid DEFAULT NULL::uuid, p_discount numeric DEFAULT 0)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_drug_id uuid;
  v_drug record;
  v_patient text;
  v_prescriber text;
  v_rx text;
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
  v_credit_total numeric(10,2) := 0;
  v_cust customers%rowtype;
  v_bal numeric;
  v_customer_name text := p_customer_name;
  v_discount numeric(10,2) := round(coalesce(p_discount, 0), 2);
  v_total numeric(10,2);
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

  select coalesce(sum((x->>'amount')::numeric), 0) into v_credit_total
    from jsonb_array_elements(p_payments) x where x->>'method' = 'credit';
  if v_credit_total > 0 and p_customer_id is null then
    raise exception 'Choose the customer this credit is for';
  end if;
  if p_customer_id is not null then
    select * into v_cust from customers where id = p_customer_id and pharmacy_id = p_pharmacy_id for update;
    if not found then
      raise exception 'Customer not found';
    end if;
    if v_credit_total > 0 then
      if not v_cust.active then
        raise exception '%''s account is closed', v_cust.name;
      end if;
      v_bal := customer_balance(p_customer_id);
      if v_cust.credit_limit is not null and v_bal + v_credit_total > v_cust.credit_limit + 0.005 then
        raise exception '% is over their credit limit: owes %, limit %, this sale adds %',
          v_cust.name, round(v_bal, 2), v_cust.credit_limit, round(v_credit_total, 2);
      end if;
    end if;
    v_customer_name := v_cust.name;
  end if;

  select vat_rate into v_vat_rate from pharmacies where id = p_pharmacy_id;

  update pharmacies set next_invoice_no = next_invoice_no + 1
  where id = p_pharmacy_id
  returning next_invoice_no - 1 into v_invoice_seq;

  insert into sales (pharmacy_id, payment_method, customer_name, customer_id, insurance_scheme, invoice_number, created_by)
  values (p_pharmacy_id, 'cash', v_customer_name, p_customer_id, p_insurance_scheme,
          'INV-' || lpad(v_invoice_seq::text, 6, '0'), auth.uid())
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty_needed := (v_item->>'quantity')::integer;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;

    select id, name, is_prescription, control_class into v_drug
    from drugs where id = v_drug_id and pharmacy_id = p_pharmacy_id;
    if v_drug.id is null then
      raise exception 'Drug not found';
    end if;

    v_patient := nullif(trim(coalesce(v_item->>'patient_name', '')), '');
    v_prescriber := nullif(trim(coalesce(v_item->>'prescriber_name', '')), '');
    v_rx := nullif(trim(coalesce(v_item->>'rx_number', '')), '');
    if v_drug.is_prescription and v_patient is null then
      raise exception '% is a prescription-only medicine — record the patient''s name', v_drug.name;
    end if;
    if v_drug.control_class <> 'none' and (v_patient is null or v_prescriber is null or v_rx is null) then
      raise exception '% is a controlled drug — record the patient, the prescriber and the prescription number', v_drug.name;
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

      insert into sale_items (sale_id, pharmacy_id, drug_id, batch_id, quantity, unit_price, line_total,
                              patient_name, prescriber_name, rx_number)
      values (v_sale_id, p_pharmacy_id, v_drug_id, v_batch.id, v_take, v_effective_price, v_line_total,
              v_patient, v_prescriber, v_rx);

      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, ref_sale_id, created_by)
      values (p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take, v_sale_id, auth.uid());

      if v_drug.control_class <> 'none' then
        perform controlled_ledger_add(p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take,
                                      v_patient, v_prescriber, v_rx, v_sale_id, null, auth.uid());
      end if;

      v_qty_remaining_to_fill := v_qty_remaining_to_fill - v_take;
    end loop;

    if v_qty_remaining_to_fill > 0 then
      raise exception 'Not enough stock for %: short by %', v_drug.name, v_qty_remaining_to_fill;
    end if;
  end loop;

  if abs(v_subtotal) < 0.01 then
    raise exception 'Sale total is zero';
  end if;

  -- One amount in shillings off the whole bill (not per drug). No cap and no
  -- reason, but it can never take the bill to zero or below.
  if v_discount < 0 then
    raise exception 'The discount cannot be negative';
  end if;
  if v_discount >= v_subtotal then
    raise exception 'The discount must be less than the bill total (%)', v_subtotal;
  end if;
  v_total := v_subtotal - v_discount;

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

    if v_method = 'insurance' then
      insert into insurance_claims (pharmacy_id, sale_id, scheme, amount, status, created_by)
      values (p_pharmacy_id, v_sale_id,
              coalesce(v_reference, nullif(trim(coalesce(p_insurance_scheme, '')), ''), 'Unspecified'),
              v_amount, 'pending', auth.uid());
    end if;
  end loop;

  if abs(v_payments_total - v_total) > 0.01 then
    raise exception 'Payments (%) do not add up to the sale total (%)', v_payments_total, v_total;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id order by id limit 1;

  update sales
  set subtotal = v_subtotal,
      discount_amount = v_discount,
      vat_amount = round(v_total * v_vat_rate / (100 + v_vat_rate), 2),
      total_amount = v_total,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end
  where id = v_sale_id;

  if p_customer_id is not null then
    update refill_plans
       set last_filled = today_ke(), last_reminded_on = null
     where customer_id = p_customer_id and pharmacy_id = p_pharmacy_id and active
       and drug_id in (select (x->>'drug_id')::uuid from jsonb_array_elements(p_items) x);
  end if;

  return v_sale_id;
end;
$function$;
revoke all on function public.record_sale(uuid, jsonb, jsonb, text, text, uuid, numeric) from public, anon;
grant execute on function public.record_sale(uuid, jsonb, jsonb, text, text, uuid, numeric) to authenticated;

-- ------------------------------------------------------------ record_return
create or replace function public.record_return(p_pharmacy_id uuid, p_sale_item_id uuid, p_quantity integer, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_item record;
  v_refund numeric(10,2);
  v_already integer;
  v_sale sales%rowtype;
  v_credit numeric(10,2);
  v_noted numeric(10,2);
  v_note numeric(10,2);
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

  select * into v_item from sale_items
  where id = p_sale_item_id and pharmacy_id = p_pharmacy_id
  for update;
  if not found then
    raise exception 'Sale item not found';
  end if;

  select * into v_sale from sales where id = v_item.sale_id;
  if coalesce(v_sale.voided, false) then
    raise exception 'That sale was voided — its stock has already been put back, so it cannot be returned as well';
  end if;

  select coalesce(sum(quantity), 0) into v_already
  from returns where sale_item_id = p_sale_item_id;

  if p_quantity + v_already > v_item.quantity then
    raise exception 'Only % of this line can still be returned (% sold, % already returned)',
      v_item.quantity - v_already, v_item.quantity, v_already;
  end if;

  -- A discounted bill refunds the discounted share: the shelf price scaled by
  -- what was actually charged. Older sales have total = subtotal, so no change.
  v_refund := round(p_quantity * v_item.unit_price
                    * case when coalesce(v_sale.subtotal, 0) > 0 then v_sale.total_amount / v_sale.subtotal else 1 end, 2);

  update batches set quantity_remaining = quantity_remaining + p_quantity where id = v_item.batch_id;

  insert into returns (pharmacy_id, sale_item_id, drug_id, batch_id, quantity, reason, refund_amount, created_by)
  values (p_pharmacy_id, p_sale_item_id, v_item.drug_id, v_item.batch_id, p_quantity, p_reason, v_refund, auth.uid());

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, ref_sale_id, created_by)
  values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'return', p_quantity, p_reason, v_item.sale_id, auth.uid());

  if v_sale.customer_id is not null then
    select coalesce(sum(amount), 0) into v_credit from sales_payments
     where sale_id = v_sale.id and method = 'credit';
    if v_credit > 0 then
      select coalesce(sum(amount), 0) into v_noted from customer_payments
       where sale_id = v_sale.id and kind = 'credit_note' and not voided;
      v_note := least(v_refund, v_credit - v_noted);
      if v_note > 0 then
        insert into customer_payments (pharmacy_id, customer_id, kind, amount, note, sale_id, created_by)
        values (p_pharmacy_id, v_sale.customer_id, 'credit_note', v_note,
                'Return on ' || coalesce(v_sale.invoice_number, 'sale'), v_sale.id, auth.uid());
      end if;
    end if;
  end if;
end;
$function$;

-- ---------------------------------------------------------------- void_sale
create or replace function public.void_sale(p_pharmacy_id uuid, p_sale_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_item record;
  v_sale sales%rowtype;
  v_has_returns boolean;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Not allowed to reverse a sale';
  end if;

  select * into v_sale from sales where id = p_sale_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Sale not found';
  end if;
  -- The owner and pharmacists can reverse any sale. A seller can reverse their
  -- own sale from today (a slip at the till); the owner sees who did it and when.
  if my_role() = 'attendant'
     and (v_sale.created_by is distinct from auth.uid()
          or (v_sale.sold_at at time zone 'Africa/Nairobi')::date <> today_ke()) then
    raise exception 'Only the owner or a pharmacist can reverse this sale';
  end if;
  if v_sale.voided then
    raise exception 'This sale is already voided';
  end if;

  select exists (
    select 1 from returns r join sale_items si on si.id = r.sale_item_id
    where si.sale_id = p_sale_id
  ) into v_has_returns;
  if v_has_returns then
    raise exception 'This sale already has a return recorded against it — void the remaining items individually via returns instead of voiding the whole sale';
  end if;

  for v_item in select * from sale_items where sale_id = p_sale_id loop
    update batches set quantity_remaining = quantity_remaining + v_item.quantity where id = v_item.batch_id;
    insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, ref_sale_id, created_by)
    values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'void', v_item.quantity, p_reason, p_sale_id, auth.uid());
  end loop;

  update sales set voided = true, voided_at = now(), void_reason = p_reason, voided_by = auth.uid()
   where id = p_sale_id;
end;
$function$;

-- ------------------------------------------------------- sales_report_page
create or replace function public.sales_report_page(p_pharmacy_id uuid, p_start timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sold_at desc, x.id), '[]'::jsonb)
    from (
      select s.id, s.invoice_number, s.sold_at, s.total_amount, s.payment_method,
             s.customer_name, s.insurance_scheme, s.voided, s.void_reason,
             s.subtotal, s.discount_amount, s.voided_at, s.created_by,
             (select pr.full_name from profiles pr where pr.id = s.created_by) as sold_by,
             (select pr.full_name from profiles pr where pr.id = s.voided_by) as voided_by_name,
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
$function$;
