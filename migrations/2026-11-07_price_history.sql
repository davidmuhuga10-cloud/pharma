-- 2026-11-07 (night, later still): price history for every price change.
--
-- Every change of a drug's selling price is now recorded in price_changes (old price, new price,
-- who, when, and where it came from), whether it came from a restock, a stock sheet or an edit.
-- A trigger does the recording, so no price change can be missed. The first price a drug ever
-- gets is not a "change" and is not recorded. apply_stock_sheet() no longer writes the record
-- itself (the trigger does), otherwise each sheet change would be listed twice.
-- No existing row is edited.

create or replace function public.record_price_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.default_price is not null and new.default_price is not null
     and old.default_price is distinct from new.default_price then
    insert into price_changes (pharmacy_id, drug_id, old_price, new_price, source, changed_by)
    values (new.pharmacy_id, new.id, old.default_price, new.default_price,
            coalesce(nullif(current_setting('pharma.price_source', true), ''), 'restock'), auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.record_price_change() from public, anon, authenticated;

drop trigger if exists trg_record_price_change on public.drugs;
create trigger trg_record_price_change
  after update of default_price on public.drugs
  for each row execute function public.record_price_change();

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

    if r ? 'name' or r ? 'unit' or r ? 'reorder' then
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
        perform set_config('pharma.price_source', 'sheet', true);   -- the trigger below records the change
        update drugs set default_price = v_price where id = v_id and pharmacy_id = p_pharmacy_id;
        perform set_config('pharma.price_source', '', true);
        update batches set sell_price = v_price
         where drug_id = v_id and pharmacy_id = p_pharmacy_id and quantity_remaining > 0;
        v_changed := v_changed + 1;
      end if;
    end if;

    if r ? 'counted' then
      perform stock_take_count(p_pharmacy_id, v_take, v_id, (r->>'counted')::integer);
      v_counted := v_counted + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'counted', v_counted, 'take_id', v_take);
end;
$$;

revoke all on function public.apply_stock_sheet(uuid, jsonb) from public, anon;
grant execute on function public.apply_stock_sheet(uuid, jsonb) to authenticated;
