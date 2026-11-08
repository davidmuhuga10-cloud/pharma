-- 2026-11-07 (night, latest): Offline selling.
--
-- A sale made with no internet (phone off airplane mode, patchy rural signal, a brief
-- outage) is never lost. The app queues it on the device and sends it the moment a
-- connection comes back - this file is the database side of that: record_offline_sale(),
-- a new RPC the app calls instead of record_sale() only when it is recovering a sale that
-- was rung up while offline.
--
-- The one real rule this bends: every sale line has always had to point at a real batch
-- with real stock in it (sale_items.batch_id was NOT NULL, and batches.quantity_remaining
-- can never go negative - both on purpose, to keep the stock count trustworthy). Offline,
-- the device cannot know for certain that stock is still there by the time the sale
-- actually reaches the database - someone else may have sold the last of it in the
-- meantime. Rather than silently discard the sale (losing real money the pharmacy already
-- collected) or silently let stock go negative (breaking every other screen that assumes
-- it cannot), a shortfall line is recorded with no batch at all and flagged for the owner
-- to glance at (needs_review / review_note on sales). This should be rare - only when
-- stock genuinely ran out while offline - and every normal sale, online or off, is
-- completely unaffected: it still requires a real batch, same as always.
--
-- What changes:
--   * sale_items.batch_id is now nullable (was NOT NULL) - null only ever means "this line
--     was rung up offline and there was no stock left to actually take it from". A new
--     sale_items.shortfall flags exactly which lines these are.
--   * returns.batch_id is now nullable to match (a shortfall line can still be returned -
--     the refund/credit side works the same; there is just no batch to put stock back
--     into, because none was ever taken out).
--   * sales.client_ref: a device-generated id, so retrying a sync after a dropped
--     connection can never record the same sale twice.
--   * sales.recorded_offline, sales.needs_review, sales.review_note: so the owner can see,
--     at a glance, which sales were recorded offline and which of those need a look -
--     stock that went short, a credit sale that pushed a customer over their limit, or
--     money collected that does not quite match what the drugs would have cost at today's
--     batch prices (a price may have changed between going offline and syncing).
--
-- What does NOT change for a controlled drug (opioids, benzodiazepines, etc.): the
-- controlled register must only ever show dispensing that traces to a real batch - PPB
-- inspection depends on that. A controlled drug cannot be sold short: if stock runs out
-- for one mid-sale, the sale still completes and the money is still kept (nothing about
-- the sale or the payment is ever lost), but that specific line is recorded with no
-- controlled-ledger entry and a loud note explaining why, instead of inventing a
-- dispensing record that never happened. This is the rarest of rare cases - a controlled
-- drug, sold offline, after every batch already ran out - and it is designed to be
-- impossible to miss, not to be silently patched over.

alter table public.sale_items alter column batch_id drop not null;
alter table public.sale_items add column if not exists shortfall boolean not null default false;

alter table public.returns alter column batch_id drop not null;

alter table public.sales add column if not exists client_ref uuid;
create unique index if not exists sales_pharmacy_client_ref_idx on public.sales (pharmacy_id, client_ref) where client_ref is not null;

alter table public.sales add column if not exists recorded_offline boolean not null default false;
alter table public.sales add column if not exists needs_review boolean not null default false;
alter table public.sales add column if not exists review_note text;
create index if not exists sales_needs_review_idx on public.sales (pharmacy_id, needs_review) where needs_review;

-- Same job as record_sale(), called instead of it only when the app is sending a sale
-- that was rung up offline. p_client_ref is required (the app generates one the moment
-- the sale is queued on the device, before it ever tries to send it) so a retried sync
-- after a dropped connection is recognized and never recorded twice. p_sold_at is the
-- real time the sale happened on the device, not whenever it happens to sync - clamped to
-- a sane window so a wrong device clock cannot plant a sale far in the past or future.
create or replace function public.record_offline_sale(
  p_pharmacy_id uuid,
  p_client_ref uuid,
  p_sold_at timestamptz,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_insurance_scheme text default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
  v_sale_id uuid;
  v_sold_at timestamptz;
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
  v_last_price numeric(10,2);
  v_had_any_batch boolean;
  v_line_total numeric(10,2);
  v_computed_subtotal numeric(10,2) := 0;
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
  v_notes text[] := '{}';
  v_review boolean := false;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a sale';
  end if;
  if p_client_ref is null then
    raise exception 'Missing offline reference — cannot safely record this sale';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'A sale needs at least one payment';
  end if;

  -- Already recorded (a retried sync after the first attempt actually succeeded but the
  -- device never saw the reply) — hand back the same result instead of recording it twice.
  select id, needs_review, review_note, invoice_number into v_existing
    from sales where pharmacy_id = p_pharmacy_id and client_ref = p_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_existing.id, 'duplicate', true,
      'needs_review', v_existing.needs_review, 'review_note', v_existing.review_note,
      'invoice_number', v_existing.invoice_number);
  end if;

  -- A device clock can be wrong; keep the reported time inside a sane window rather than
  -- trusting it blindly or rejecting the sale over it.
  v_sold_at := least(greatest(coalesce(p_sold_at, now()), now() - interval '30 days'), now());

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
      -- Over the limit is not blocked here — the device could not have checked the live
      -- balance while offline, and the credit was already extended in the shop. Flagged
      -- instead, same as a stock shortfall.
      v_bal := customer_balance(p_customer_id);
      if v_cust.credit_limit is not null and v_bal + v_credit_total > v_cust.credit_limit + 0.005 then
        v_notes := array_append(v_notes, v_cust.name || ' is now over their credit limit (owes ' ||
          round(v_bal + v_credit_total, 2) || ', limit ' || v_cust.credit_limit || ')');
        v_review := true;
      end if;
    end if;
    v_customer_name := v_cust.name;
  end if;

  select vat_rate into v_vat_rate from pharmacies where id = p_pharmacy_id;

  update pharmacies set next_invoice_no = next_invoice_no + 1
  where id = p_pharmacy_id
  returning next_invoice_no - 1 into v_invoice_seq;

  insert into sales (pharmacy_id, payment_method, customer_name, customer_id, insurance_scheme, invoice_number,
                      sold_at, client_ref, recorded_offline, created_by, created_at)
  values (p_pharmacy_id, 'cash', v_customer_name, p_customer_id, p_insurance_scheme,
          'INV-' || lpad(v_invoice_seq::text, 6, '0'), v_sold_at, p_client_ref, true, auth.uid(), now())
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty_needed := (v_item->>'quantity')::integer;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;

    select id, name, is_prescription, control_class, default_price into v_drug
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
    v_last_price := null;
    v_had_any_batch := false;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
      for update
    loop
      exit when v_qty_remaining_to_fill <= 0;
      v_had_any_batch := true;
      v_take := least(v_batch.quantity_remaining, v_qty_remaining_to_fill);
      v_effective_price := round(v_batch.sell_price * (1 - v_batch.discount_percent / 100.0), 2);
      v_last_price := v_effective_price;

      update batches set quantity_remaining = quantity_remaining - v_take where id = v_batch.id;

      v_line_total := round(v_take * v_effective_price, 2);
      v_computed_subtotal := v_computed_subtotal + v_line_total;

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

    -- Stock ran out before the offline sale could be fully covered by real batches. The
    -- sale still goes through in full — the money was already collected in the shop — but
    -- this line has no batch to point at, so it is flagged instead of inventing one.
    if v_qty_remaining_to_fill > 0 then
      v_effective_price := coalesce(v_last_price, v_drug.default_price, 0);
      v_line_total := round(v_qty_remaining_to_fill * v_effective_price, 2);
      v_computed_subtotal := v_computed_subtotal + v_line_total;

      insert into sale_items (sale_id, pharmacy_id, drug_id, batch_id, quantity, unit_price, line_total,
                              patient_name, prescriber_name, rx_number, shortfall)
      values (v_sale_id, p_pharmacy_id, v_drug_id, null, v_qty_remaining_to_fill, v_effective_price, v_line_total,
              v_patient, v_prescriber, v_rx, true);

      if v_drug.control_class <> 'none' then
        v_notes := array_append(v_notes, v_drug.name || ' (controlled) — ' || v_qty_remaining_to_fill ||
          ' sold with no matching batch. This cannot go on the controlled register as dispensed —' ||
          ' check against paper records and true up stock by hand.');
      else
        v_notes := array_append(v_notes, v_drug.name || ' short by ' || v_qty_remaining_to_fill ||
          ' — someone else may have sold the last of it while this device was offline.');
      end if;
      v_review := true;
    end if;
  end loop;

  if abs(v_computed_subtotal) < 0.01 and v_credit_total = 0 then
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

    if v_method = 'insurance' then
      insert into insurance_claims (pharmacy_id, sale_id, scheme, amount, status, created_by)
      values (p_pharmacy_id, v_sale_id,
              coalesce(v_reference, nullif(trim(coalesce(p_insurance_scheme, '')), ''), 'Unspecified'),
              v_amount, 'pending', auth.uid());
    end if;
  end loop;

  -- Unlike record_sale(), a mismatch between what was actually collected and what the
  -- drugs would cost at today's batch prices does not block the sale — the money was
  -- already taken in the shop, against whatever price the device last knew. It is kept
  -- exactly as collected, and flagged if the two figures genuinely differ (a price may
  -- have changed between going offline and syncing).
  if abs(v_payments_total - v_computed_subtotal) > 0.5 then
    v_notes := array_append(v_notes, 'Collected ' || round(v_payments_total, 2) ||
      ', but today''s prices work out to ' || round(v_computed_subtotal, 2) ||
      ' — a price may have changed while this device was offline.');
    v_review := true;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id order by id limit 1;

  update sales
  set subtotal = v_payments_total,
      vat_amount = round(v_payments_total * v_vat_rate / (100 + v_vat_rate), 2),
      total_amount = v_payments_total,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end,
      needs_review = v_review,
      review_note = case when array_length(v_notes, 1) > 0 then array_to_string(v_notes, ' · ') else null end
  where id = v_sale_id;

  if p_customer_id is not null then
    update refill_plans
       set last_filled = today_ke(), last_reminded_on = null
     where customer_id = p_customer_id and pharmacy_id = p_pharmacy_id and active
       and drug_id in (select (x->>'drug_id')::uuid from jsonb_array_elements(p_items) x);
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'duplicate', false,
    'needs_review', v_review,
    'review_note', case when array_length(v_notes, 1) > 0 then array_to_string(v_notes, ' · ') else null end,
    'invoice_number', 'INV-' || lpad(v_invoice_seq::text, 6, '0'));
end;
$$;

revoke all on function public.record_offline_sale(uuid, uuid, timestamptz, jsonb, jsonb, text, text, uuid) from public, anon;
grant execute on function public.record_offline_sale(uuid, uuid, timestamptz, jsonb, jsonb, text, text, uuid) to authenticated;

-- sales_report_page() already lists every sale in the period for the Sales Report
-- screen — it just needs to also say which ones were recorded offline and which of
-- those need a look, so the owner has somewhere to actually see it instead of these
-- columns only existing in the database. Purely additive: three more fields on a row
-- the app already reads: nothing existing changes shape.
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
             s.recorded_offline, s.needs_review, s.review_note,
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

-- dashboard_extras() is the dashboard's own "needs your attention" strip (credit
-- owed, refills due, a controlled-drug mismatch, a stock take left open) - a
-- flagged sale belongs right there too, so the owner sees it the moment they open
-- the app instead of having to remember to go looking in the Sales Report.
create or replace function dashboard_extras(p_pharmacy_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'credit_owed',        coalesce((select sum(balance) from v_customer_balances
                                     where pharmacy_id = p_pharmacy_id and balance > 0.5), 0),
    'credit_customers',   (select count(*) from v_customer_balances
                            where pharmacy_id = p_pharmacy_id and balance > 0.5),
    'refills_due',        (select count(*) from v_refills
                            where pharmacy_id = p_pharmacy_id and days_overdue >= 0),
    'controlled_mismatch', (select count(*) from v_controlled_register
                             where pharmacy_id = p_pharmacy_id and shelf_qty <> ledger_qty),
    'open_stock_take',    (select id from stock_takes where pharmacy_id = p_pharmacy_id and status = 'open' limit 1),
    'sales_needing_review', (select count(*) from sales
                               where pharmacy_id = p_pharmacy_id and needs_review and not voided)
  )
$$;
revoke all on function dashboard_extras(uuid) from public, anon;
grant execute on function dashboard_extras(uuid) to authenticated;
