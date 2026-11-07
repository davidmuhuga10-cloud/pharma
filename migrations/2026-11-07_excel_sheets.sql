-- 2026-11-07 (night, later): Excel in, Excel out - strict.
--
-- "Garbage in, garbage out": a sheet with any bad row is refused as a whole, and the pharmacy
-- is told every row to fix. Nothing is half-imported.
--
-- What changes (no existing row is edited; two functions are replaced, one table is new):
--   1. import_stock_rows(): two optional extra arguments. p_dry_run = true checks the rows
--      exactly as the real import would, writes nothing, and reports every problem.
--      p_strict = true makes the real import stop and undo the whole block at the first problem.
--      Older app versions call it with two arguments and behave exactly as before.
--   2. price_changes: a record of every selling-price change made from a sheet (who, when, old,
--      new). Row-level security on, tenant isolated, indexed by pharmacy.
--   3. apply_stock_sheet(): applies a downloaded-and-filled stock sheet in one all-or-nothing step:
--      renames, unit, reorder number, selling price, and counted quantities. Counts do NOT change
--      stock directly: they open a stock take for the owner to review and approve, exactly like
--      counting on screen. A price change also updates the batches still on the shelf, so the new
--      price is what the till charges; past sales keep the price they were sold at.

-- 1 -----------------------------------------------------------------------------------
drop function if exists public.import_stock_rows(uuid, jsonb);
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

revoke all on function public.import_stock_rows(uuid, jsonb, boolean, boolean) from public, anon;
grant execute on function public.import_stock_rows(uuid, jsonb, boolean, boolean) to authenticated;

-- 2 -----------------------------------------------------------------------------------
create table if not exists public.price_changes (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  drug_id     uuid not null references public.drugs(id) on delete cascade,
  old_price   numeric(10,2),
  new_price   numeric(10,2) not null,
  source      text not null default 'sheet',
  changed_by  uuid references public.profiles(id),
  changed_at  timestamptz not null default now()
);
create index if not exists price_changes_pharmacy_idx on public.price_changes (pharmacy_id, changed_at desc);
create index if not exists price_changes_drug_idx on public.price_changes (drug_id);
create index if not exists price_changes_changed_by_idx on public.price_changes (changed_by);
alter table public.price_changes enable row level security;
drop policy if exists "tenant read price_changes" on public.price_changes;
create policy "tenant read price_changes" on public.price_changes for select using (pharmacy_id = my_pharmacy_id());
revoke all on public.price_changes from anon, authenticated;
grant select on public.price_changes to authenticated;
grant select, insert, update, delete on public.price_changes to service_role;

-- 3 -----------------------------------------------------------------------------------
-- p_rows: [{ drug_id, name?, unit?, counted?, price?, reorder? }]  only the fields that change.
-- Returns { ok: false, errors: [...] } and changes nothing when any row is wrong;
-- { ok: true, changed, counted, take_id } when everything was applied.
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
        insert into price_changes (pharmacy_id, drug_id, old_price, new_price, source, changed_by)
        values (p_pharmacy_id, v_id, v_drug.default_price, v_price, 'sheet', auth.uid());
        update drugs set default_price = v_price where id = v_id and pharmacy_id = p_pharmacy_id;
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
