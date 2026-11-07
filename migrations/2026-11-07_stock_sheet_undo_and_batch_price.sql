-- 2026-11-07 (night, later still): two small gaps the owner asked for by name.
--
-- 1. A direct "fix the price on this batch" button. Today a wrong selling or
--    cost price on a batch can only be fixed by voiding the sale, setting the
--    batch to 0 with Correct count, and receiving the drug again at the right
--    price. correct_batch_price() fixes it in one step. Deliberately
--    owner/co-owner only (same reasoning as correct_batch_expiry: it changes
--    money without changing the physical stock on the shelf), and recorded in
--    the existing price_changes table (source 'batch') so it shows up in the
--    drug's price history like any other price change.
--
-- 2. A one-click undo for an applied Excel stock sheet. apply_stock_sheet()
--    now also saves a before/after snapshot of what it changed to a new
--    stock_sheet_uploads table and returns an upload_id. undo_stock_sheet()
--    puts back only the single most recent, not-yet-undone upload, and only
--    the fields nothing else has touched again since (anything changed again
--    in the meantime is left alone and reported, never silently overwritten).
--    If the sheet opened a stock take that is still open (not yet approved),
--    undo cancels it, same as pressing Cancel by hand. If it was already
--    approved, real stock has already moved and is not touched — the owner is
--    told so rather than this function guessing how to reverse a stock move.
--
-- Nothing existing is edited or deleted. Not yet applied to the live project.

-- 1 -----------------------------------------------------------------------------------
create table if not exists public.stock_sheet_uploads (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  take_id     uuid references public.stock_takes(id),
  changes     jsonb not null default '[]'::jsonb,
  changed     integer not null default 0,
  counted     integer not null default 0,
  applied_by  uuid references public.profiles(id),
  applied_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references public.profiles(id)
);
create index if not exists stock_sheet_uploads_pharmacy_idx on public.stock_sheet_uploads (pharmacy_id, applied_at desc);
alter table public.stock_sheet_uploads enable row level security;
drop policy if exists "tenant read stock_sheet_uploads" on public.stock_sheet_uploads;
create policy "tenant read stock_sheet_uploads" on public.stock_sheet_uploads for select using (pharmacy_id = my_pharmacy_id());
revoke all on public.stock_sheet_uploads from anon, authenticated;
grant select on public.stock_sheet_uploads to authenticated;
grant select, insert, update, delete on public.stock_sheet_uploads to service_role;

-- 2 -----------------------------------------------------------------------------------
-- apply_stock_sheet(): same behaviour as before, plus a before/after snapshot of
-- every row it actually changes, saved to stock_sheet_uploads. Returns the same
-- fields as before, plus upload_id (null when nothing was changed or counted).
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

revoke all on function public.apply_stock_sheet(uuid, jsonb) from public, anon;
grant execute on function public.apply_stock_sheet(uuid, jsonb) to authenticated;

-- 3 -----------------------------------------------------------------------------------
-- Puts back the single most recent, not-yet-undone sheet upload. See the note
-- at the top of this file for exactly what is and isn't reverted.
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

revoke all on function public.undo_stock_sheet(uuid, uuid) from public, anon;
grant execute on function public.undo_stock_sheet(uuid, uuid) to authenticated;

-- 4 -----------------------------------------------------------------------------------
-- Fixes a wrong sell price (and, optionally, cost price) on one batch directly.
-- Deliberately owner/co-owner only: see the note at the top of this file.
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

revoke all on function public.correct_batch_price(uuid, uuid, numeric, numeric) from public, anon;
grant execute on function public.correct_batch_price(uuid, uuid, numeric, numeric) to authenticated;
