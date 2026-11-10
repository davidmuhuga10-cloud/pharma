-- 2026-11-10_retry_safe_writes.ROLLBACK_if_needed.sql
--
-- Undoes 2026-11-10_retry_safe_writes.sql: puts the five functions back to
-- their original argument lists and bodies, and removes the client_request_id
-- columns and their unique indexes.
--
-- WHEN YOU WOULD RUN THIS
-- Only if the retry-safety change itself is causing a problem. Note the order
-- it has to happen in, because the front-end and the database must agree:
--
--   1. FIRST revert the front-end (git revert the commit that added
--      p_client_request_id, push, and wait for Netlify to deploy).
--   2. THEN run this.
--
-- Doing it the other way round breaks every sale in between: the deployed
-- browser would send p_client_request_id to a function that no longer accepts
-- it, and PostgREST answers "could not find the function" - the sale button
-- simply fails.
--
-- *** THIS DROPS DATA ***
-- The client_request_id columns are dropped, so the record of which request
-- created which row is lost. No sale, payment, batch, delivery or expense is
-- deleted - only that one bookkeeping column on each. If you might want to
-- re-apply the migration later, save the values first, e.g.:
--   create table _saved_request_ids as
--     select 'sales' as t, id, client_request_id from sales where client_request_id is not null
--     union all select 'expenses', id, client_request_id from expenses where client_request_id is not null;
--
-- Function bodies below were taken from a clean rebuild of schema.sql that was
-- verified (md5 of pg_get_functiondef) to match the live definitions exactly
-- before the migration was written. They are the originals, not retyped.
--
-- Applies in one transaction.

begin;


-- ---------------------------------------------------------------------------
-- 1. The original functions, restored. Created first, new ones dropped after.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_sale(p_pharmacy_id uuid, p_items jsonb, p_payments jsonb, p_customer_name text DEFAULT NULL::text, p_insurance_scheme text DEFAULT NULL::text, p_customer_id uuid DEFAULT NULL::uuid, p_discount numeric DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if p_pharmacy_id is null or p_pharmacy_id is distinct from my_pharmacy_id() then
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

drop function public.record_sale(uuid,jsonb,jsonb,text,text,uuid,numeric,uuid);

revoke all on function public.record_sale(uuid,jsonb,jsonb,text,text,uuid,numeric) from public, anon;
grant execute on function public.record_sale(uuid,jsonb,jsonb,text,text,uuid,numeric) to authenticated;

CREATE OR REPLACE FUNCTION public.record_customer_payment(p_pharmacy_id uuid, p_customer_id uuid, p_amount numeric, p_method text DEFAULT 'cash'::text, p_reference text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cust customers%rowtype;
  v_bal numeric;
  v_id uuid;
begin
  if p_pharmacy_id is null or p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a customer payment';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero';
  end if;
  if coalesce(p_method, 'cash') not in ('cash', 'mpesa', 'bank', 'other') then
    raise exception 'Choose cash, M-Pesa, bank or other';
  end if;

  select * into v_cust from customers where id = p_customer_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Customer not found';
  end if;
  v_bal := customer_balance(p_customer_id);
  if p_amount > v_bal + 0.005 then
    raise exception '% owes only %. Enter that amount or less.', v_cust.name, greatest(round(v_bal, 2), 0);
  end if;

  insert into customer_payments (pharmacy_id, customer_id, kind, amount, method, reference, note, created_by)
  values (p_pharmacy_id, p_customer_id, 'payment', round(p_amount, 2), coalesce(p_method, 'cash'),
          nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$;

drop function public.record_customer_payment(uuid,uuid,numeric,text,text,text,uuid);

revoke all on function public.record_customer_payment(uuid,uuid,numeric,text,text,text) from public, anon;
grant execute on function public.record_customer_payment(uuid,uuid,numeric,text,text,text) to authenticated;

CREATE OR REPLACE FUNCTION public.record_restock(p_pharmacy_id uuid, p_drug_id uuid, p_quantity integer, p_cost_price numeric, p_sell_price numeric, p_expiry_date date, p_batch_no text DEFAULT NULL::text, p_supplier text DEFAULT NULL::text, p_supplier_id uuid DEFAULT NULL::uuid, p_expiry_unknown boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch_id uuid;
  v_expiry date;
begin
  if p_pharmacy_id is null or p_pharmacy_id is distinct from my_pharmacy_id() then
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
$function$;

drop function public.record_restock(uuid,uuid,integer,numeric,numeric,date,text,text,uuid,boolean,uuid);

revoke all on function public.record_restock(uuid,uuid,integer,numeric,numeric,date,text,text,uuid,boolean) from public, anon;
grant execute on function public.record_restock(uuid,uuid,integer,numeric,numeric,date,text,text,uuid,boolean) to authenticated;

CREATE OR REPLACE FUNCTION public.record_supplier_lpo(p_pharmacy_id uuid, p_supplier_id uuid, p_items jsonb, p_delivered_at date DEFAULT NULL::date, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if p_pharmacy_id is null or p_pharmacy_id is distinct from my_pharmacy_id() then
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
$function$;

drop function public.record_supplier_lpo(uuid,uuid,jsonb,date,text,uuid);

revoke all on function public.record_supplier_lpo(uuid,uuid,jsonb,date,text) from public, anon;
grant execute on function public.record_supplier_lpo(uuid,uuid,jsonb,date,text) to authenticated;

CREATE OR REPLACE FUNCTION public.record_expense(p_pharmacy_id uuid, p_category text, p_description text, p_amount numeric, p_method text DEFAULT 'cash'::text, p_expense_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_expense_id uuid;
begin
  if p_pharmacy_id is null or p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record an expense';
  end if;
  if p_description is null or trim(p_description) = '' then
    raise exception 'Give the expense a short description';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Expense amount must be greater than zero';
  end if;

  insert into expenses (pharmacy_id, category, description, amount, method, expense_date, notes, created_by)
  values (p_pharmacy_id, coalesce(nullif(trim(p_category), ''), 'other'), trim(p_description), p_amount,
          coalesce(nullif(p_method, '')::supplier_payment_method, 'cash'), coalesce(p_expense_date, current_date), p_notes, auth.uid())
  returning id into v_expense_id;

  return v_expense_id;
end;
$function$;

drop function public.record_expense(uuid,text,text,numeric,text,date,text,uuid);

revoke all on function public.record_expense(uuid,text,text,numeric,text,date,text) from public, anon;
grant execute on function public.record_expense(uuid,text,text,numeric,text,date,text) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. The indexes and columns. This is the part that loses data (see above).
-- ---------------------------------------------------------------------------
drop index if exists public.sales_client_request_id_key;
alter table public.sales drop column if exists client_request_id;
drop index if exists public.customer_payments_client_request_id_key;
alter table public.customer_payments drop column if exists client_request_id;
drop index if exists public.batches_client_request_id_key;
alter table public.batches drop column if exists client_request_id;
drop index if exists public.supplier_lpos_client_request_id_key;
alter table public.supplier_lpos drop column if exists client_request_id;
drop index if exists public.expenses_client_request_id_key;
alter table public.expenses drop column if exists client_request_id;


-- ---------------------------------------------------------------------------
-- 3. Confirm the rollback landed before committing.
-- ---------------------------------------------------------------------------
do $guard$
declare n integer;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and column_name='client_request_id'
     and table_name in ('sales','customer_payments','batches','supplier_lpos','expenses');
  if n <> 0 then raise exception '% client_request_id column(s) still present', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.proname in ('record_sale','record_customer_payment','record_restock',
                       'record_supplier_lpo','record_expense');
  if n <> 5 then raise exception 'expected 5 functions, found %', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.proname in ('record_sale','record_customer_payment','record_restock',
                       'record_supplier_lpo','record_expense')
     and pg_get_function_arguments(p.oid) like '%p_client_request_id%';
  if n <> 0 then raise exception '% function(s) still take p_client_request_id', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.proname in ('record_sale','record_customer_payment','record_restock',
                       'record_supplier_lpo','record_expense')
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% function(s) executable by anon after rollback', n; end if;

  raise notice 'rollback complete: all 4 checks passed';
end
$guard$;

commit;
