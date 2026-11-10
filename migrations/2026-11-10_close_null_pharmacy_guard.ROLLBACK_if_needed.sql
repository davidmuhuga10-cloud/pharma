-- 2026-11-10_close_null_pharmacy_guard.ROLLBACK_if_needed.sql
--
-- Undoes 2026-11-10_close_null_pharmacy_guard.sql by restoring the exact
-- previous body (byte-for-byte, re-extracted from the unmodified
-- schema.sql that was live before that migration) for all 42 functions.
-- No data is touched or dropped by either the migration or this rollback;
-- only these function bodies change. Safe to run if the migration causes
-- an unexpected problem; re-apply the migration once the SQL is fixed.

create or replace function public.apply_stock_sheet(p_pharmacy_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          jsonb;
  v_i        integer := 0;
  v_id       uuid;
  v_drug     drugs%rowtype;
  v_seen     uuid[] := '{}';
  v_names    text[] := '{}';
  v_errors   jsonb := '[]'::jsonb;
  v_role     text := my_role();
  v_take     uuid;
  v_changed  integer := 0;
  v_counted  integer := 0;
  v_price    numeric;
  v_nm       text;
  v_has_count boolean := false;
  v_msg      text;
  v_row_change jsonb;
  v_changes  jsonb := '[]'::jsonb;
  v_upload   uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if v_role not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can upload a stock sheet';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nothing to apply';
  end if;
  if jsonb_array_length(p_rows) > 3000 then
    raise exception 'A sheet can change at most 3000 drugs at a time';
  end if;

  -- Pass 1: check every row, write nothing.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_msg := null;
    v_id := null;
    begin
      v_id := nullif(r->>'drug_id', '')::uuid;
    exception when others then v_id := null;
    end;
    select * into v_drug from drugs where id = v_id and pharmacy_id = p_pharmacy_id;
    if v_id is null or not found then
      v_msg := 'This drug is not in your system. New drugs are added with Import, not with this sheet';
    elsif not v_drug.active then
      v_msg := 'This drug is hidden. Bring it back from Hidden drugs first';
    elsif v_id = any (v_seen) then
      v_msg := 'This drug appears twice in the sheet';
    elsif v_role = 'stock_taker' and (r ? 'name' or r ? 'unit' or r ? 'price' or r ? 'reorder') then
      v_msg := 'A stock taker can upload counts only';
    else
      v_seen := v_seen || v_id;
      if r ? 'name' then
        v_nm := btrim(coalesce(r->>'name', ''));
        if v_nm = '' then v_msg := 'The drug name is empty';
        elsif exists (select 1 from drugs where pharmacy_id = p_pharmacy_id and id <> v_id and lower(name) = lower(v_nm)) or lower(v_nm) = any (v_names) then
          v_msg := 'Another drug is already named "' || v_nm || '"';
        else v_names := v_names || lower(v_nm); end if;
      end if;
      if v_msg is null and r ? 'unit' and btrim(coalesce(r->>'unit', '')) = '' then v_msg := 'The unit is empty'; end if;
      if v_msg is null and r ? 'counted' then
        if coalesce(r->>'counted', '') !~ '^[0-9]+$' then v_msg := 'Counted qty must be a whole number, 0 or more';
        else v_has_count := true; end if;
      end if;
      if v_msg is null and r ? 'price' then
        if coalesce(r->>'price', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' or (r->>'price')::numeric <= 0 then
          v_msg := 'Sell price must be a number above 0 (at most 2 decimals)';
        end if;
      end if;
      if v_msg is null and r ? 'reorder' and coalesce(r->>'reorder', '') !~ '^[0-9]+$' then
        v_msg := 'Reorder level must be a whole number, 0 or more';
      end if;
    end if;
    if v_msg is not null and jsonb_array_length(v_errors) < 50 then   -- the first 50 are enough to fix a sheet
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'row', v_i, 'name', left(coalesce(r->>'name', v_drug.name, ''), 80), 'message', v_msg));
    end if;
  end loop;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'errors', v_errors);
  end if;
  if v_has_count and exists (select 1 from stock_takes where pharmacy_id = p_pharmacy_id and status = 'open') then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object(
      'row', 0, 'name', '', 'message', 'A stock take is already open. Approve or cancel it in Stock Take first, then upload again')));
  end if;

  -- Pass 2: apply everything. Any failure here undoes the whole sheet.
  if v_has_count then
    v_take := start_stock_take(p_pharmacy_id, 'Excel count ' || to_char(today_ke(), 'DD Mon YYYY'));
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := (r->>'drug_id')::uuid;
    select * into v_drug from drugs where id = v_id and pharmacy_id = p_pharmacy_id for update;
    v_row_change := null;

    if r ? 'name' or r ? 'unit' or r ? 'reorder' then
      v_row_change := jsonb_build_object(
        'drug_id', v_id,
        'name_before', v_drug.name,
        'name_after', coalesce(nullif(btrim(r->>'name'), ''), v_drug.name),
        'unit_before', v_drug.unit,
        'unit_after', coalesce(nullif(btrim(r->>'unit'), ''), v_drug.unit),
        'reorder_before', v_drug.reorder_level,
        'reorder_after', case when r ? 'reorder' then (r->>'reorder')::integer else v_drug.reorder_level end,
        'reorder_custom_before', v_drug.reorder_custom
      );
      update drugs set
        name = coalesce(nullif(btrim(r->>'name'), ''), name),
        unit = coalesce(nullif(btrim(r->>'unit'), ''), unit),
        reorder_level = case when r ? 'reorder' then (r->>'reorder')::integer else reorder_level end,
        reorder_custom = case when r ? 'reorder' then true else reorder_custom end
      where id = v_id and pharmacy_id = p_pharmacy_id;
      v_changed := v_changed + 1;
    end if;

    if r ? 'price' then
      v_price := (r->>'price')::numeric;
      if v_drug.default_price is distinct from v_price then
        v_row_change := coalesce(v_row_change, jsonb_build_object('drug_id', v_id)) ||
          jsonb_build_object('price_before', v_drug.default_price, 'price_after', v_price);
        perform set_config('pharma.price_source', 'sheet', true);   -- the trigger below records the change
        update drugs set default_price = v_price where id = v_id and pharmacy_id = p_pharmacy_id;
        perform set_config('pharma.price_source', '', true);
        update batches set sell_price = v_price
         where drug_id = v_id and pharmacy_id = p_pharmacy_id and quantity_remaining > 0;
        v_changed := v_changed + 1;
      end if;
    end if;

    if v_row_change is not null then
      v_changes := v_changes || jsonb_build_array(v_row_change);
    end if;

    if r ? 'counted' then
      perform stock_take_count(p_pharmacy_id, v_take, v_id, (r->>'counted')::integer);
      v_counted := v_counted + 1;
    end if;
  end loop;

  if v_changed > 0 or v_counted > 0 then
    insert into stock_sheet_uploads (pharmacy_id, take_id, changes, changed, counted, applied_by)
    values (p_pharmacy_id, v_take, v_changes, v_changed, v_counted, auth.uid())
    returning id into v_upload;
  end if;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'counted', v_counted, 'take_id', v_take, 'upload_id', v_upload);
end;
$$;

create or replace function approve_stock_take(p_pharmacy_id uuid, p_take_id uuid, p_reasons jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take stock_takes%rowtype;
  v_item record;
  v_delta integer;
  v_reason text;
  v_batch record;
  v_need integer;
  v_take_qty integer;
  v_avail integer;
  v_cost numeric(12,2) := 0;
  v_changed integer := 0;
  v_name text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can approve a stock take';
  end if;
  select * into v_take from stock_takes where id = p_take_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Stock take not found';
  end if;
  if v_take.status <> 'open' then
    raise exception 'This stock take is already closed';
  end if;
  if not exists (select 1 from stock_take_items where take_id = p_take_id) then
    raise exception 'Nothing has been counted yet';
  end if;

  -- 1. every difference needs a sensible reason, checked before anything moves
  for v_item in
    select i.*, d.name from stock_take_items i join drugs d on d.id = i.drug_id
     where i.take_id = p_take_id and i.counted_qty <> i.system_qty
  loop
    v_delta := v_item.counted_qty - v_item.system_qty;
    v_reason := nullif(trim(coalesce(p_reasons->>(v_item.drug_id::text), '')), '');
    if v_reason is null then
      raise exception 'Pick a reason for the difference on %', v_item.name;
    end if;
    if v_delta < 0 and v_reason not in ('damaged', 'expired', 'missing', 'other') then
      raise exception 'A shortage of % must be damaged, expired, missing or other', v_item.name;
    end if;
    if v_delta > 0 and v_reason not in ('found', 'other') then
      raise exception 'Extra stock of % must be marked found or other', v_item.name;
    end if;
  end loop;

  -- 2. apply
  for v_item in
    select i.*, d.name from stock_take_items i join drugs d on d.id = i.drug_id
     where i.take_id = p_take_id and i.counted_qty <> i.system_qty
     order by d.name
  loop
    v_delta := v_item.counted_qty - v_item.system_qty;
    v_reason := trim(p_reasons->>(v_item.drug_id::text));
    v_name := v_item.name;

    if v_delta < 0 then
      v_need := -v_delta;
      select coalesce(sum(quantity_remaining), 0) into v_avail from batches
       where drug_id = v_item.drug_id and pharmacy_id = p_pharmacy_id;
      if v_avail < v_need then
        raise exception 'Stock of % changed since it was counted (only % left). Count it again.', v_name, v_avail;
      end if;
      for v_batch in
        select * from batches
         where drug_id = v_item.drug_id and pharmacy_id = p_pharmacy_id and quantity_remaining > 0
         order by expiry_date asc, created_at asc, id asc
         for update
      loop
        exit when v_need <= 0;
        v_take_qty := least(v_batch.quantity_remaining, v_need);
        update batches set quantity_remaining = quantity_remaining - v_take_qty where id = v_batch.id;
        insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
        values (p_pharmacy_id, v_item.drug_id, v_batch.id, 'stock_take', -v_take_qty,
                'Stock take: ' || v_reason, auth.uid());
        v_cost := v_cost - v_take_qty * coalesce(v_batch.cost_price, 0);
        v_need := v_need - v_take_qty;
      end loop;
    else
      select * into v_batch from batches
       where drug_id = v_item.drug_id and pharmacy_id = p_pharmacy_id and expiry_date >= current_date
       order by expiry_date desc, created_at desc, id desc
       limit 1
       for update;
      if not found then
        raise exception '% has no in-date batch to put the extra stock on. Restock it instead.', v_name;
      end if;
      update batches set quantity_remaining = quantity_remaining + v_delta where id = v_batch.id;
      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
      values (p_pharmacy_id, v_item.drug_id, v_batch.id, 'stock_take', v_delta,
              'Stock take: ' || v_reason, auth.uid());
      v_cost := v_cost + v_delta * coalesce(v_batch.cost_price, 0);
    end if;

    update stock_take_items set reason = v_reason, applied_delta = v_delta where id = v_item.id;
    v_changed := v_changed + 1;
  end loop;

  update stock_takes
     set status = 'approved', approved_by = auth.uid(), approved_at = now(), total_cost_variance = round(v_cost, 2)
   where id = p_take_id;

  return jsonb_build_object('adjusted', v_changed, 'total_cost_variance', round(v_cost, 2));
end;
$$;

create or replace function cancel_stock_take(p_pharmacy_id uuid, p_take_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can cancel a stock take';
  end if;
  update stock_takes set status = 'cancelled'
   where id = p_take_id and pharmacy_id = p_pharmacy_id and status = 'open';
  if not found then
    raise exception 'This stock take is not open';
  end if;
end;
$$;

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

create or replace function correct_batch_expiry(p_pharmacy_id uuid, p_batch_id uuid, p_new_expiry_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the owner or co-owner can correct a batch''s expiry date';
  end if;
  if p_new_expiry_date is null then
    raise exception 'Enter an expiry date';
  end if;
  if not exists (select 1 from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Batch not found';
  end if;

  update batches set expiry_date = p_new_expiry_date, expiry_unknown = false where id = p_batch_id;
end;
$$;

create or replace function public.correct_batch_price(p_pharmacy_id uuid, p_batch_id uuid, p_new_sell_price numeric, p_new_cost_price numeric default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch batches%rowtype;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the owner or co-owner can correct a batch''s price';
  end if;
  if p_new_sell_price is null or p_new_sell_price <= 0 then
    raise exception 'Sell price must be more than zero';
  end if;
  if p_new_cost_price is not null and p_new_cost_price < 0 then
    raise exception 'Cost price cannot be negative';
  end if;

  select * into v_batch from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Batch not found';
  end if;

  if v_batch.sell_price is distinct from p_new_sell_price then
    insert into price_changes (pharmacy_id, drug_id, old_price, new_price, source, changed_by)
    values (p_pharmacy_id, v_batch.drug_id, v_batch.sell_price, p_new_sell_price, 'batch', auth.uid());
  end if;

  update batches set
    sell_price = p_new_sell_price,
    cost_price = coalesce(p_new_cost_price, cost_price)
  where id = p_batch_id and pharmacy_id = p_pharmacy_id;
end;
$$;

create or replace function customer_statement(p_pharmacy_id uuid, p_customer_id uuid)
returns table (
  entry_at timestamptz,
  kind text,
  ref text,
  amount numeric,
  note text,
  voided boolean,
  running numeric,
  pay_id uuid,
  sale_id uuid
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  return query
  with lines as (
    select s.sold_at as entry_at,
           'credit'::text as kind,
           coalesce(s.invoice_number, 'Sale') as ref,
           sp.amount as amount,
           null::text as note,
           s.voided as voided,
           sp.amount as delta_raw,
           null::uuid as pay_id,
           s.id as sale_id
      from sales_payments sp join sales s on s.id = sp.sale_id
     where s.customer_id = p_customer_id and s.pharmacy_id = p_pharmacy_id and sp.method = 'credit'
    union all
    select cp.paid_at, cp.kind, coalesce(cp.reference, initcap(coalesce(cp.method, ''))), cp.amount,
           coalesce(cp.note, cp.void_reason), cp.voided, -cp.amount, cp.id, cp.sale_id
      from customer_payments cp
     where cp.customer_id = p_customer_id and cp.pharmacy_id = p_pharmacy_id
  )
  select l.entry_at, l.kind, l.ref, l.amount, l.note, l.voided,
         sum(case when l.voided then 0 else l.delta_raw end) over (order by l.entry_at, l.kind, l.ref rows unbounded preceding),
         l.pay_id, l.sale_id
    from lines l
   order by l.entry_at, l.kind, l.ref;
end;
$$;

create or replace function public.dashboard_data_custom_raw(p_pharmacy_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_prev_start timestamptz;
  v_prev_end timestamptz;
  v_span_days numeric;
  v_bucket text;
  v_sales_total numeric;
  v_sales_prev_total numeric;
  v_cost_total numeric;
  v_cost_prev_total numeric;
  v_profit_total numeric;
  v_profit_prev_total numeric;
  v_trend jsonb;
  v_rush jsonb;
  v_top_sellers jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Invalid date range';
  end if;

  v_start := p_start::timestamptz;
  v_end := (p_end + 1)::timestamptz; -- exclusive, so the end date's whole day is included
  v_span_days := extract(epoch from (v_end - v_start)) / 86400;
  v_prev_start := v_start - (v_end - v_start);
  v_prev_end := v_start;

  v_bucket := case
    when v_span_days <= 1 then 'hour'
    when v_span_days <= 31 then 'day'
    when v_span_days <= 366 then 'week'
    else 'month'
  end;

  select coalesce(sum(total_amount), 0) into v_sales_total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end;

  select coalesce(sum(total_amount), 0) into v_sales_prev_total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_prev_start and sold_at < v_prev_end;

  select coalesce(sum(si.quantity * coalesce(b.cost_price, 0)), 0) into v_cost_total
    from sale_items si
    join sales sa on sa.id = si.sale_id
    join batches b on b.id = si.batch_id
    where si.pharmacy_id = p_pharmacy_id and sa.voided = false and sa.sold_at >= v_start and sa.sold_at < v_end;

  select coalesce(sum(si.quantity * coalesce(b.cost_price, 0)), 0) into v_cost_prev_total
    from sale_items si
    join sales sa on sa.id = si.sale_id
    join batches b on b.id = si.batch_id
    where si.pharmacy_id = p_pharmacy_id and sa.voided = false and sa.sold_at >= v_prev_start and sa.sold_at < v_prev_end;

  v_profit_total := v_sales_total - v_cost_total;
  v_profit_prev_total := v_sales_prev_total - v_cost_prev_total;

  select coalesce(jsonb_agg(jsonb_build_object('bucket_start', bucket_start, 'total', total) order by bucket_start), '[]'::jsonb)
    into v_trend
  from (
    select date_trunc(v_bucket, sold_at) as bucket_start, sum(total_amount) as total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
    group by 1
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('idx', idx, 'total', total) order by idx), '[]'::jsonb)
    into v_rush
  from (
    select floor(extract(hour from sold_at) / 3)::int as idx, sum(total_amount) as total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
    group by 1
  ) r;

  select coalesce(jsonb_agg(jsonb_build_object('drug_id', drug_id, 'name', name, 'units', units, 'revenue', revenue) order by units desc), '[]'::jsonb)
    into v_top_sellers
  from (
    select si.drug_id, d.name, sum(si.quantity) as units, sum(si.line_total) as revenue
    from sale_items si
    join sales sa on sa.id = si.sale_id
    join drugs d on d.id = si.drug_id
    where si.pharmacy_id = p_pharmacy_id and sa.voided = false and sa.sold_at >= v_start and sa.sold_at < v_end
    group by si.drug_id, d.name
    order by units desc
    limit 50
  ) ts;

  return jsonb_build_object(
    'range', 'custom',
    'start', v_start,
    'end', v_end,
    'bucket', v_bucket,
    'sales_total', v_sales_total,
    'sales_prev_total', v_sales_prev_total,
    'cost_total', v_cost_total,
    'profit_total', v_profit_total,
    'profit_prev_total', v_profit_prev_total,
    'trend', v_trend,
    'rush', v_rush,
    'top_sellers', v_top_sellers
  );
end;
$$;

create or replace function public.dashboard_data_raw(p_pharmacy_id uuid, p_range text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz := now();
  v_prev_start timestamptz;
  v_prev_end timestamptz;
  v_bucket text;
  v_sales_total numeric;
  v_sales_prev_total numeric;
  v_cost_total numeric;
  v_cost_prev_total numeric;
  v_profit_total numeric;
  v_profit_prev_total numeric;
  v_trend jsonb;
  v_rush jsonb;
  v_top_sellers jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if p_range not in ('today', 'week', 'month', 'year') then
    raise exception 'Invalid range — expected today, week, month or year';
  end if;

  case p_range
    when 'today' then
      v_start := date_trunc('day', now());
      v_prev_start := v_start - interval '1 day';
      v_prev_end := v_start;
      v_bucket := 'hour';
    when 'week' then
      -- A rolling "last 7 days" (today and the 6 days before it, Nairobi days),
      -- compared with the 7 days before that. It never restarts on a Monday,
      -- so the graph always has a full week of points.
      v_start := ((today_ke() - 6)::timestamp at time zone 'Africa/Nairobi');
      v_prev_start := v_start - interval '7 days';
      v_prev_end := v_start;
      v_bucket := 'day';
    when 'month' then
      v_start := date_trunc('month', now());
      v_prev_start := v_start - interval '1 month';
      v_prev_end := v_start;
      v_bucket := 'week';
    when 'year' then
      v_start := date_trunc('year', now());
      v_prev_start := v_start - interval '1 year';
      v_prev_end := v_start;
      v_bucket := 'month';
  end case;

  select coalesce(sum(total_amount), 0) into v_sales_total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end;

  select coalesce(sum(total_amount), 0) into v_sales_prev_total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_prev_start and sold_at < v_prev_end;

  select coalesce(sum(si.quantity * coalesce(b.cost_price, 0)), 0) into v_cost_total
    from sale_items si
    join sales sa on sa.id = si.sale_id
    join batches b on b.id = si.batch_id
    where si.pharmacy_id = p_pharmacy_id and sa.voided = false and sa.sold_at >= v_start and sa.sold_at < v_end;

  select coalesce(sum(si.quantity * coalesce(b.cost_price, 0)), 0) into v_cost_prev_total
    from sale_items si
    join sales sa on sa.id = si.sale_id
    join batches b on b.id = si.batch_id
    where si.pharmacy_id = p_pharmacy_id and sa.voided = false and sa.sold_at >= v_prev_start and sa.sold_at < v_prev_end;

  v_profit_total := v_sales_total - v_cost_total;
  v_profit_prev_total := v_sales_prev_total - v_cost_prev_total;

  if p_range = 'week' then
    -- One point for each of the 7 days, zero on a day with no sales, so the
    -- line always spans the whole week.
    select jsonb_agg(jsonb_build_object('bucket_start', g.day, 'total', coalesce(t.total, 0)) order by g.day)
      into v_trend
    from generate_series((today_ke() - 6)::timestamp, today_ke()::timestamp, interval '1 day') as g(day)
    left join (
      select date_trunc('day', sold_at at time zone 'Africa/Nairobi') as day, sum(total_amount) as total
      from sales
      where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
      group by 1
    ) t on t.day = g.day;
  else
    select coalesce(jsonb_agg(jsonb_build_object('bucket_start', bucket_start, 'total', total) order by bucket_start), '[]'::jsonb)
      into v_trend
    from (
      select date_trunc(v_bucket, sold_at) as bucket_start, sum(total_amount) as total
      from sales
      where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
      group by 1
    ) t;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('idx', idx, 'total', total) order by idx), '[]'::jsonb)
    into v_rush
  from (
    select floor(extract(hour from sold_at) / 3)::int as idx, sum(total_amount) as total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
    group by 1
  ) r;

  select coalesce(jsonb_agg(jsonb_build_object('drug_id', drug_id, 'name', name, 'units', units, 'revenue', revenue) order by units desc), '[]'::jsonb)
    into v_top_sellers
  from (
    select si.drug_id, d.name, sum(si.quantity) as units, sum(si.line_total) as revenue
    from sale_items si
    join sales sa on sa.id = si.sale_id
    join drugs d on d.id = si.drug_id
    where si.pharmacy_id = p_pharmacy_id and sa.voided = false and sa.sold_at >= v_start and sa.sold_at < v_end
    group by si.drug_id, d.name
    order by units desc
    limit 50
  ) ts;

  return jsonb_build_object(
    'range', p_range,
    'start', v_start,
    'end', v_end,
    'bucket', v_bucket,
    'sales_total', v_sales_total,
    'sales_prev_total', v_sales_prev_total,
    'cost_total', v_cost_total,
    'profit_total', v_profit_total,
    'profit_prev_total', v_profit_prev_total,
    'trend', v_trend,
    'rush', v_rush,
    'top_sellers', v_top_sellers
  );
end;
$$;

create or replace function public.delete_drug(p_pharmacy_id uuid, p_drug_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can delete a drug';
  end if;
  perform 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Drug not found';
  end if;
  -- Batches would be deleted along with the drug, so they must be checked by hand.
  if exists (select 1 from batches where drug_id = p_drug_id) then
    raise exception 'This drug has stock history, so it cannot be deleted. Use Stop selling instead.';
  end if;
  begin
    delete from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id;
  exception when foreign_key_violation then
    raise exception 'This drug has sales or stock records, so it cannot be deleted. Use Stop selling instead.';
  end;
end;
$$;

create or replace function public.edit_drug(
  p_pharmacy_id uuid,
  p_drug_id uuid,
  p_name text,
  p_category_id uuid,
  p_form drug_form,
  p_unit text,
  p_reorder_level integer,
  p_is_prescription boolean,
  p_pack_size integer,
  p_pack_label text,
  p_reorder_custom boolean default null,
  p_barcode text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_barcode text := nullif(trim(coalesce(p_barcode, '')), '');
  v_clash record;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can change a drug';
  end if;
  if v_name = '' then
    raise exception 'Give the drug a name';
  end if;
  if (p_reorder_custom is distinct from false) and (p_reorder_level is null or p_reorder_level < 0) then
    raise exception 'Reorder level must be zero or more';
  end if;
  if p_reorder_level is not null and p_reorder_level < 0 then
    raise exception 'Reorder level must be zero or more';
  end if;
  if p_pack_size is not null and p_pack_size <= 0 then
    raise exception 'Pack size must be more than zero';
  end if;
  perform 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Drug not found';
  end if;
  if p_category_id is not null
     and not exists (select 1 from drug_categories where id = p_category_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Category not found';
  end if;

  select id, active into v_clash
    from drugs
   where pharmacy_id = p_pharmacy_id and id <> p_drug_id and lower(name) = lower(v_name)
   limit 1;
  if found then
    if v_clash.active then
      raise exception 'Another drug is already named "%". Pick a different name.', v_name;
    else
      raise exception 'A hidden drug is already named "%". Bring that one back from Hidden drugs instead.', v_name;
    end if;
  end if;

  if v_barcode is not null then
    select name, active into v_clash
      from drugs
     where pharmacy_id = p_pharmacy_id and id <> p_drug_id and barcode = v_barcode
     limit 1;
    if found then
      if v_clash.active then
        raise exception 'That barcode is already used by "%".', v_clash.name;
      else
        raise exception 'That barcode is already used by "%", a hidden drug. Bring that one back from Hidden drugs instead.', v_clash.name;
      end if;
    end if;
  end if;

  begin
    update drugs set
      name = v_name,
      category_id = p_category_id,
      form = coalesce(p_form, form),
      unit = coalesce(nullif(trim(coalesce(p_unit, '')), ''), unit),
      reorder_level = coalesce(p_reorder_level, reorder_level),
      reorder_custom = coalesce(p_reorder_custom, reorder_custom),
      is_prescription = coalesce(p_is_prescription, is_prescription),
      pack_size = p_pack_size,
      pack_label = nullif(trim(coalesce(p_pack_label, '')), ''),
      barcode = v_barcode
    where id = p_drug_id and pharmacy_id = p_pharmacy_id;
  exception when unique_violation then
    raise exception 'Another drug is already named "%", or already uses that barcode.', v_name;
  end;
end;
$$;

create or replace function public.import_stock_rows(
  p_pharmacy_id uuid,
  p_rows        jsonb,
  p_dry_run     boolean default false,
  p_strict      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          jsonb;
  v_i        integer := 0;
  v_name     text;
  v_drug_id  uuid;
  v_form     text;
  v_cat      uuid;
  v_expiry   date;
  v_imported integer := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_valid_forms constant text[] := array['tablet','capsule','syrup','injection','cream_ointment','drops','suppository','inhaler','iv_fluid','other'];
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can import stock';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nothing to import';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'Import at most 500 rows at a time';
  end if;

  begin   -- everything below is undone at the end of a dry run
    for r in select * from jsonb_array_elements(p_rows)
    loop
      v_i := v_i + 1;
      begin   -- a bad row rolls back only itself
        v_name := btrim(coalesce(r->>'name', ''));
        if v_name = '' then
          raise exception 'The drug name is empty';
        end if;

        select id into v_drug_id from drugs
         where pharmacy_id = p_pharmacy_id and lower(name) = lower(v_name)
         limit 1;

        if v_drug_id is null then
          v_form := coalesce(r->>'form', 'other');
          if not (v_form = any (v_valid_forms)) then v_form := 'other'; end if;
          v_cat := null;
          if coalesce(r->>'category_id', '') <> '' then
            select id into v_cat from drug_categories
             where id = (r->>'category_id')::uuid and pharmacy_id = p_pharmacy_id;
          end if;
          insert into drugs (pharmacy_id, name, form, unit, category_id)
          values (p_pharmacy_id, v_name, v_form::drug_form, coalesce(nullif(r->>'unit', ''), 'unit'), v_cat)
          returning id into v_drug_id;
        end if;

        v_expiry := nullif(r->>'expiry', '')::date;

        perform record_restock(
          p_pharmacy_id,
          v_drug_id,
          nullif(r->>'qty', '')::integer,
          nullif(r->>'cost_price', '')::numeric,
          nullif(r->>'sell_price', '')::numeric,
          v_expiry,
          nullif(r->>'batch_no', ''),
          nullif(r->>'supplier', ''),
          null,
          v_expiry is null
        );
        v_imported := v_imported + 1;
      exception when others then
        if p_strict and not p_dry_run then
          raise exception 'Row %: % (%)', v_i, sqlerrm, left(coalesce(r->>'name', ''), 80);
        end if;
        -- keep the report short: the first 20 problems are enough to fix a sheet
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'row', v_i, 'name', left(coalesce(r->>'name', ''), 80), 'message', sqlerrm));
        end if;
      end;
      v_drug_id := null;
    end loop;

    if p_dry_run then
      raise exception '__dry_run_done__';
    end if;
  exception when others then
    if sqlerrm <> '__dry_run_done__' then
      raise;
    end if;
  end;

  return jsonb_build_object(
    'imported', v_imported,
    'failed',   v_i - v_imported,
    'errors',   v_errors,
    'dry_run',  p_dry_run
  );
end;
$$;

create or replace function mark_refilled(p_pharmacy_id uuid, p_plan_id uuid, p_filled_on date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can update a refill';
  end if;
  if p_filled_on is not null and p_filled_on > today_ke() then
    raise exception 'The fill date cannot be in the future';
  end if;
  update refill_plans
     set last_filled = coalesce(p_filled_on, today_ke()), last_reminded_on = null
   where id = p_plan_id and pharmacy_id = p_pharmacy_id and active;
  if not found then
    raise exception 'Refill not found';
  end if;
end;
$$;

create or replace function public.queue_evening_summary_now(p_pharmacy_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean; v_cap integer; v_used integer; v_phone text; v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
  v_body text; v_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can send the evening summary';
  end if;
  select sms_enabled, sms_daily_cap, evening_summary_phone into v_enabled, v_cap, v_phone from pharmacies where id = p_pharmacy_id for update;
  if not v_enabled then
    raise exception 'SMS is switched off for this pharmacy (Customers > Messages)';
  end if;
  if v_phone is null then
    raise exception 'Add a phone number for the evening summary first';
  end if;
  if exists (select 1 from sms_log where pharmacy_id = p_pharmacy_id and kind = 'summary' and created_at >= v_since and status <> 'failed') then
    raise exception 'Today''s summary was already sent';
  end if;
  select count(*) into v_used from sms_log where pharmacy_id = p_pharmacy_id and created_at >= v_since and status <> 'failed';
  if v_used >= v_cap then
    raise exception 'Daily SMS limit reached (% a day). Try again tomorrow.', v_cap;
  end if;
  v_body := evening_summary_text(p_pharmacy_id);
  if v_body is null then
    raise exception 'There is nothing to report yet today';
  end if;
  insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind, created_by)
  values (p_pharmacy_id, null, v_phone, v_body, 'summary', auth.uid())
  returning id into v_id;
  return jsonb_build_object('queued', jsonb_build_array(jsonb_build_object('id', v_id, 'to', v_phone, 'body', v_body)),
                            'skipped', '[]'::jsonb, 'used_today', v_used + 1, 'daily_cap', v_cap);
end;
$$;

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

create or replace function record_customer_payment(
  p_pharmacy_id uuid,
  p_customer_id uuid,
  p_amount numeric,
  p_method text default 'cash',
  p_reference text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust customers%rowtype;
  v_bal numeric;
  v_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
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
$$;

create or replace function record_expense(
  p_pharmacy_id uuid,
  p_category text,
  p_description text,
  p_amount numeric,
  p_method text default 'cash',
  p_expense_date date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
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
$$;

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

create or replace function record_supplier_payment(
  p_pharmacy_id uuid,
  p_supplier_id uuid,
  p_amount numeric,
  p_method text default 'cash',
  p_reference text default null,
  p_paid_at date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a supplier payment';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Supplier not found';
  end if;

  insert into supplier_payments (pharmacy_id, supplier_id, amount, method, reference, paid_at, notes, created_by)
  values (p_pharmacy_id, p_supplier_id, p_amount, p_method::supplier_payment_method, p_reference, coalesce(p_paid_at, current_date), p_notes, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

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

create or replace function save_customer(
  p_pharmacy_id uuid,
  p_name text,
  p_phone text default null,
  p_credit_limit numeric default null,
  p_notes text default null,
  p_id uuid default null,
  p_sms_ok boolean default true,
  p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_old customers%rowtype;
  v_id uuid;
  v_role user_role := my_role();
  v_dupe text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if v_role not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can add customers';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'Enter the customer''s name';
  end if;
  if p_credit_limit is not null and p_credit_limit < 0 then
    raise exception 'The credit limit cannot be negative';
  end if;
  v_phone := normalize_ke_phone(p_phone);
  if v_phone is not null then
    select name into v_dupe from customers
     where pharmacy_id = p_pharmacy_id and phone = v_phone and id is distinct from p_id;
    if v_dupe is not null then
      raise exception 'That phone number already belongs to % in your customer list', v_dupe;
    end if;
  end if;

  if p_id is null then
    if v_role = 'attendant' and p_credit_limit is not null then
      raise exception 'Only the owner or a pharmacist can set a credit limit';
    end if;
    insert into customers (pharmacy_id, name, phone, credit_limit, notes, sms_ok, created_by)
    values (p_pharmacy_id, trim(p_name), v_phone, p_credit_limit, nullif(trim(coalesce(p_notes, '')), ''),
            coalesce(p_sms_ok, true), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into v_old from customers where id = p_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Customer not found';
  end if;
  if v_role = 'attendant' and (p_credit_limit is distinct from v_old.credit_limit
                              or coalesce(p_active, true) is distinct from v_old.active) then
    raise exception 'Only the owner or a pharmacist can change a credit limit or close an account';
  end if;
  if coalesce(p_active, true) = false and customer_balance(p_id) > 0.5 then
    raise exception 'This customer still owes %. Collect or write it off before closing the account.',
      round(customer_balance(p_id), 2);
  end if;

  update customers
     set name = trim(p_name), phone = v_phone, credit_limit = p_credit_limit,
         notes = nullif(trim(coalesce(p_notes, '')), ''), sms_ok = coalesce(p_sms_ok, true),
         active = coalesce(p_active, true)
   where id = p_id;
  return p_id;
end;
$$;

create or replace function save_refill_plan(
  p_pharmacy_id uuid,
  p_customer_id uuid,
  p_drug_name text,
  p_interval_days integer,
  p_drug_id uuid default null,
  p_last_filled date default null,
  p_qty integer default null,
  p_notes text default null,
  p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_drug_name, '')), '');
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can set up a refill';
  end if;
  if not exists (select 1 from customers where id = p_customer_id and pharmacy_id = p_pharmacy_id and active) then
    raise exception 'Customer not found';
  end if;
  if p_drug_id is not null then
    select coalesce(v_name, name) into v_name from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id;
    if v_name is null then
      raise exception 'Drug not found';
    end if;
  end if;
  if v_name is null then
    raise exception 'Say which medicine this refill is for';
  end if;
  if p_interval_days is null or p_interval_days < 1 or p_interval_days > 365 then
    raise exception 'Refill every how many days? Enter 1 to 365.';
  end if;
  if p_qty is not null and p_qty <= 0 then
    raise exception 'The quantity must be more than zero';
  end if;
  if p_last_filled is not null and p_last_filled > today_ke() then
    raise exception 'The last fill date cannot be in the future';
  end if;

  if p_id is null then
    insert into refill_plans (pharmacy_id, customer_id, drug_id, drug_name, qty, interval_days, last_filled, notes, created_by)
    values (p_pharmacy_id, p_customer_id, p_drug_id, v_name, p_qty, p_interval_days,
            coalesce(p_last_filled, today_ke()), nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
    returning id into v_id;
  else
    update refill_plans
       set customer_id = p_customer_id, drug_id = p_drug_id, drug_name = v_name, qty = p_qty,
           interval_days = p_interval_days, last_filled = coalesce(p_last_filled, last_filled),
           notes = nullif(trim(coalesce(p_notes, '')), '')
     where id = p_id and pharmacy_id = p_pharmacy_id
     returning id into v_id;
    if v_id is null then
      raise exception 'Refill not found';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function set_batch_expiry(p_pharmacy_id uuid, p_batch_id uuid, p_expiry_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can set a batch''s expiry date';
  end if;
  if p_expiry_date is null then
    raise exception 'Enter an expiry date';
  end if;
  if not exists (select 1 from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Batch not found';
  end if;

  update batches set expiry_date = p_expiry_date, expiry_unknown = false where id = p_batch_id;
end;
$$;

create or replace function public.set_drug_active(p_pharmacy_id uuid, p_drug_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left bigint;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can stop or restart selling a drug';
  end if;
  if p_active is null then
    raise exception 'Say whether to stop or restart selling';
  end if;
  perform 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Drug not found';
  end if;

  if not p_active then
    select coalesce(sum(quantity_remaining), 0) into v_left
      from batches where drug_id = p_drug_id and pharmacy_id = p_pharmacy_id and quantity_remaining > 0;
    if v_left > 0 then
      raise exception '% still in stock (expired stock counts). Sell it or write it off first, then stop selling this drug.', v_left;
    end if;
  end if;

  update drugs set active = p_active where id = p_drug_id and pharmacy_id = p_pharmacy_id;
end;
$$;

create or replace function set_drug_control(p_pharmacy_id uuid, p_drug_id uuid, p_class text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug drugs%rowtype;
  v_cur integer;
  v_last integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can change whether a drug is controlled';
  end if;
  if p_class is null or p_class not in ('none', 'dda', 'psy') then
    raise exception 'Choose not controlled, dangerous drug (DDA) or psychotropic';
  end if;
  select * into v_drug from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Drug not found';
  end if;
  if v_drug.control_class = p_class then
    return;
  end if;

  perform set_config('pharma.control_change', 'on', true);
  update drugs
     set control_class = p_class,
         is_prescription = case when p_class <> 'none' then true else is_prescription end
   where id = p_drug_id;
  perform set_config('pharma.control_change', 'off', true);

  if p_class <> 'none' then
    select coalesce(sum(quantity_remaining), 0)::integer into v_cur from batches where drug_id = p_drug_id;
    select balance_after into v_last from controlled_ledger where drug_id = p_drug_id order by seq desc limit 1;
    if v_last is null or v_last <> v_cur then
      perform controlled_ledger_add(p_pharmacy_id, p_drug_id, null, 'opening', v_cur - coalesce(v_last, 0),
                                    null, null, null, null,
                                    case when v_last is null then 'Opening balance when marked controlled'
                                         else 'Balance re-checked when marked controlled again' end,
                                    auth.uid());
    end if;
  end if;
end;
$$;

create or replace function set_sms_enabled(p_pharmacy_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the owner can switch SMS on or off';
  end if;
  update pharmacies set sms_enabled = coalesce(p_enabled, true) where id = p_pharmacy_id;
end;
$$;

create or replace function public.sms_queue(p_pharmacy_id uuid, p_messages jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_msg jsonb;
  v_cust customers%rowtype;
  v_body text;
  v_kind text;
  v_ref uuid;
  v_enabled boolean;
  v_cap integer;
  v_used integer;
  v_queued jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_price numeric;
  v_cost numeric;
  v_balance numeric;
  v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can send SMS';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) = 0 then
    raise exception 'There is nothing to send';
  end if;
  if jsonb_array_length(p_messages) > 50 then
    raise exception 'Send at most 50 messages at a time';
  end if;

  select sms_enabled, sms_daily_cap into v_enabled, v_cap from pharmacies where id = p_pharmacy_id for update;
  if not v_enabled then
    raise exception 'SMS is switched off for this pharmacy (Customers > Messages)';
  end if;
  select coalesce((select price_per_sms from sms_platform_config where id = 1), 1) into v_price;
  select balance into v_balance from sms_wallets where pharmacy_id = p_pharmacy_id for update;
  v_balance := coalesce(v_balance, 0);
  select count(*) into v_used from sms_log
   where pharmacy_id = p_pharmacy_id and created_at >= v_since and status <> 'failed';

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_body := trim(coalesce(v_msg->>'body', ''));
    v_kind := coalesce(v_msg->>'kind', 'custom');
    v_ref := nullif(v_msg->>'ref_id', '')::uuid;
    if v_kind not in ('refill', 'credit', 'custom') then
      raise exception 'Unknown message type';
    end if;
    if v_body = '' or char_length(v_body) > 459 then
      raise exception 'A message must be between 1 and 459 characters';
    end if;

    select * into v_cust from customers
     where id = nullif(v_msg->>'customer_id', '')::uuid and pharmacy_id = p_pharmacy_id;
    if not found then
      raise exception 'Customer not found';
    end if;
    if not v_cust.sms_ok then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'opted_out');
      continue;
    end if;
    if v_cust.phone is null then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'no_phone');
      continue;
    end if;

    if v_kind = 'refill' then
      if v_ref is null or not exists (select 1 from refill_plans
                                       where id = v_ref and pharmacy_id = p_pharmacy_id and customer_id = v_cust.id) then
        raise exception 'That refill was not found for this customer';
      end if;
      if exists (select 1 from refill_plans where id = v_ref and last_reminded_on = today_ke()) then
        v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'already_reminded_today');
        continue;
      end if;
    end if;

    if v_used >= v_cap then
      raise exception 'Daily SMS limit reached (% a day). Try again tomorrow.', v_cap;
    end if;

    -- one part up to 160 characters, then 153 per part
    v_cost := v_price * (case when char_length(v_body) <= 160 then 1 else ceil(char_length(v_body) / 153.0) end);
    if v_balance < v_cost then
      raise exception 'Not enough SMS credit (KES % left). Buy SMS first.', round(v_balance, 2);
    end if;

    insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind, ref_id, created_by, cost)
    values (p_pharmacy_id, v_cust.id, v_cust.phone, v_body, v_kind, v_ref, auth.uid(), v_cost)
    returning id into v_id;
    v_used := v_used + 1;
    v_balance := v_balance - v_cost;
    update sms_wallets set balance = v_balance, updated_at = now() where pharmacy_id = p_pharmacy_id;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (p_pharmacy_id, 'sms', -v_cost, v_balance, v_id::text, 'SMS to ' || v_cust.phone);
    v_queued := v_queued || jsonb_build_object('id', v_id, 'to', v_cust.phone, 'body', v_body);

    if v_kind = 'refill' then
      update refill_plans set last_reminded_on = today_ke() where id = v_ref;
    end if;
  end loop;

  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped,
                            'used_today', v_used, 'daily_cap', v_cap, 'balance', v_balance);
end;
$function$;

create or replace function start_stock_take(p_pharmacy_id uuid, p_label text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can start a stock take';
  end if;
  if exists (select 1 from stock_takes where pharmacy_id = p_pharmacy_id and status = 'open') then
    raise exception 'A stock take is already open. Finish or cancel it first.';
  end if;
  insert into stock_takes (pharmacy_id, label, created_by)
  values (p_pharmacy_id, coalesce(nullif(trim(coalesce(p_label, '')), ''), 'Stock take ' || to_char(today_ke(), 'DD Mon YYYY')), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function stock_take_count(p_pharmacy_id uuid, p_take_id uuid, p_drug_id uuid, p_counted integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take stock_takes%rowtype;
  v_sys integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can count stock';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'The count cannot be negative';
  end if;
  select * into v_take from stock_takes where id = p_take_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Stock take not found';
  end if;
  if v_take.status <> 'open' then
    raise exception 'This stock take is already closed';
  end if;
  if not exists (select 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id and active) then
    raise exception 'Drug not found';
  end if;

  select coalesce(sum(quantity_remaining), 0)::integer into v_sys from batches where drug_id = p_drug_id;

  insert into stock_take_items (take_id, pharmacy_id, drug_id, system_qty, counted_qty, counted_by)
  values (p_take_id, p_pharmacy_id, p_drug_id, v_sys, p_counted, auth.uid())
  on conflict (take_id, drug_id)
  do update set system_qty = excluded.system_qty, counted_qty = excluded.counted_qty,
                counted_by = excluded.counted_by, counted_at = now(), reason = null;
  return jsonb_build_object('system_qty', v_sys, 'counted_qty', p_counted, 'difference', p_counted - v_sys);
end;
$$;

create or replace function stock_take_remove_count(p_pharmacy_id uuid, p_take_id uuid, p_drug_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can count stock';
  end if;
  if not exists (select 1 from stock_takes where id = p_take_id and pharmacy_id = p_pharmacy_id and status = 'open') then
    raise exception 'This stock take is not open';
  end if;
  delete from stock_take_items where take_id = p_take_id and drug_id = p_drug_id and pharmacy_id = p_pharmacy_id;
end;
$$;

create or replace function stop_refill_plan(p_pharmacy_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can stop a refill';
  end if;
  update refill_plans set active = false where id = p_plan_id and pharmacy_id = p_pharmacy_id and active;
  if not found then
    raise exception 'Refill not found';
  end if;
end;
$$;

create or replace function sync_master_drugs(
  p_pharmacy_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_master record;
  v_drug_id uuid;
  v_category_id uuid;
  v_batch_id uuid;
  v_quantity integer;
  v_sell_price numeric(10,2);
  v_cost_price numeric(10,2);
  v_reorder_level integer;
  v_expiry_date date;
  v_expiry_unknown boolean;
  v_default_reorder integer;
  v_results jsonb := '[]'::jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can sync drugs';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one drug to sync';
  end if;

  select low_stock_default into v_default_reorder from pharmacies where id = p_pharmacy_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_master from master_drugs where id = (v_item->>'master_drug_id')::uuid;
    if v_master is null then
      raise exception 'Unknown master drug: %', v_item->>'master_drug_id';
    end if;

    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Enter a valid quantity for %', v_master.name;
    end if;

    v_sell_price := nullif(v_item->>'sell_price', '')::numeric;
    if v_sell_price is null or v_sell_price <= 0 then
      raise exception 'Enter a selling price for %', v_master.name;
    end if;

    v_cost_price := nullif(v_item->>'cost_price', '')::numeric;
    v_reorder_level := coalesce(nullif(v_item->>'reorder_level', '')::integer, v_default_reorder, 5);

    if coalesce(v_item->>'expiry_date', '') <> '' then
      v_expiry_date := (v_item->>'expiry_date')::date;
      v_expiry_unknown := false;
    else
      v_expiry_date := (current_date + interval '3 years')::date;
      v_expiry_unknown := true;
    end if;

    select id into v_drug_id from drugs where pharmacy_id = p_pharmacy_id and name = v_master.name;

    if v_drug_id is null then
      select id into v_category_id from drug_categories
      where pharmacy_id = p_pharmacy_id and name = v_master.category_name;
      if v_category_id is null then
        insert into drug_categories (pharmacy_id, name) values (p_pharmacy_id, v_master.category_name)
        returning id into v_category_id;
      end if;

      insert into drugs (pharmacy_id, category_id, name, form, unit, reorder_level, default_price, is_prescription)
      values (p_pharmacy_id, v_category_id, v_master.name, v_master.form, v_master.unit, v_reorder_level, v_sell_price, v_master.is_prescription)
      returning id into v_drug_id;
    else
      update drugs set default_price = v_sell_price where id = v_drug_id;
    end if;

    insert into batches (pharmacy_id, drug_id, quantity_received, quantity_remaining, cost_price, sell_price,
                          expiry_date, expiry_unknown, received_at, created_by)
    values (p_pharmacy_id, v_drug_id, v_quantity, v_quantity, v_cost_price, v_sell_price,
            v_expiry_date, v_expiry_unknown, current_date, auth.uid())
    returning id into v_batch_id;

    insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
    values (p_pharmacy_id, v_drug_id, v_batch_id, 'restock', v_quantity, 'Synced from master catalog', auth.uid());

    v_results := v_results || jsonb_build_object('master_drug_id', v_master.id, 'drug_id', v_drug_id, 'batch_id', v_batch_id);
  end loop;

  return v_results;
end;
$$;

create or replace function public.undo_stock_sheet(p_pharmacy_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_up         stock_sheet_uploads%rowtype;
  v_latest     uuid;
  v_change     jsonb;
  v_drug       drugs%rowtype;
  v_reverted   integer := 0;
  v_skipped    jsonb := '[]'::jsonb;
  v_take       stock_takes%rowtype;
  v_count_note text := null;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner, co-owner, or a pharmacist can undo a stock sheet';
  end if;

  select * into v_up from stock_sheet_uploads where id = p_upload_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'That upload was not found';
  end if;
  if v_up.undone_at is not null then
    raise exception 'That upload was already undone';
  end if;

  select id into v_latest from stock_sheet_uploads
   where pharmacy_id = p_pharmacy_id and undone_at is null
   order by applied_at desc limit 1;
  if v_latest is distinct from p_upload_id then
    raise exception 'Only the most recent upload can be undone, and a newer one has been applied since';
  end if;

  for v_change in select * from jsonb_array_elements(v_up.changes) loop
    select * into v_drug from drugs where id = (v_change->>'drug_id')::uuid and pharmacy_id = p_pharmacy_id for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('drug_id', v_change->>'drug_id', 'reason', 'This drug no longer exists'));
      continue;
    end if;

    -- Each field is only put back if nothing has changed it again since the sheet
    -- set it — otherwise it is left exactly as it is now and reported, not overwritten.
    if v_change ? 'name_after' and v_drug.name = (v_change->>'name_after')
       and v_drug.name is distinct from (v_change->>'name_before') then
      update drugs set name = (v_change->>'name_before') where id = v_drug.id;
      v_reverted := v_reverted + 1;
    end if;

    if v_change ? 'unit_after' and v_drug.unit = (v_change->>'unit_after')
       and v_drug.unit is distinct from (v_change->>'unit_before') then
      update drugs set unit = (v_change->>'unit_before') where id = v_drug.id;
      v_reverted := v_reverted + 1;
    end if;

    if v_change ? 'reorder_after' and v_drug.reorder_level = (v_change->>'reorder_after')::integer
       and v_drug.reorder_level is distinct from (v_change->>'reorder_before')::integer then
      update drugs set reorder_level = (v_change->>'reorder_before')::integer,
                        reorder_custom = coalesce((v_change->>'reorder_custom_before')::boolean, reorder_custom)
       where id = v_drug.id;
      v_reverted := v_reverted + 1;
    end if;

    if v_change ? 'price_after' then
      if v_drug.default_price = (v_change->>'price_after')::numeric
         and v_drug.default_price is distinct from (v_change->>'price_before')::numeric then
        perform set_config('pharma.price_source', 'undo', true);
        update drugs set default_price = (v_change->>'price_before')::numeric where id = v_drug.id;
        perform set_config('pharma.price_source', '', true);
        update batches set sell_price = (v_change->>'price_before')::numeric
         where drug_id = v_drug.id and pharmacy_id = p_pharmacy_id
           and quantity_remaining > 0 and sell_price = (v_change->>'price_after')::numeric;
        v_reverted := v_reverted + 1;
      elsif v_drug.default_price is distinct from (v_change->>'price_after')::numeric then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'drug_id', v_drug.id, 'name', v_drug.name, 'reason', 'Its price has changed again since the sheet, so it was left alone'));
      end if;
    end if;
  end loop;

  if v_up.take_id is not null then
    select * into v_take from stock_takes where id = v_up.take_id and pharmacy_id = p_pharmacy_id for update;
    if found and v_take.status = 'open' then
      update stock_takes set status = 'cancelled' where id = v_take.id;
      v_count_note := 'cancelled';
    elsif found and v_take.status = 'approved' then
      v_count_note := 'already_approved';
    end if;
  end if;

  update stock_sheet_uploads set undone_at = now(), undone_by = auth.uid() where id = p_upload_id;

  return jsonb_build_object('reverted', v_reverted, 'left_alone', v_skipped, 'count_status', v_count_note);
end;
$$;

create or replace function void_customer_payment(p_pharmacy_id uuid, p_payment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay customer_payments%rowtype;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can reverse a customer payment';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Give a reason for reversing this payment';
  end if;
  select * into v_pay from customer_payments where id = p_payment_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Payment not found';
  end if;
  if v_pay.kind <> 'payment' then
    raise exception 'This entry came from a return. Reverse the return instead.';
  end if;
  if v_pay.voided then
    raise exception 'This payment is already reversed';
  end if;
  update customer_payments
     set voided = true, voided_at = now(), void_reason = trim(p_reason)
   where id = p_payment_id;
end;
$$;

create or replace function void_expense(p_pharmacy_id uuid, p_expense_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_voided boolean;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can void an expense';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  select voided into v_already_voided from expenses where id = p_expense_id and pharmacy_id = p_pharmacy_id;
  if v_already_voided is null then
    raise exception 'Expense not found';
  end if;
  if v_already_voided then
    raise exception 'This expense is already voided';
  end if;

  update expenses set voided = true, voided_at = now(), void_reason = trim(p_reason) where id = p_expense_id;
end;
$$;

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