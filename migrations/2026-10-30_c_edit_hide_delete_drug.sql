-- 2026-10-30 (c): fix a mistyped drug, stop selling a drug, delete one added by mistake.
--
-- Until now a drug could be added but never changed or removed. Three functions,
-- all callable only by the owner, a co-owner or a pharmacist of the same pharmacy:
--
--   edit_drug         name, category, form, unit, reorder level, prescription flag, pack size/label.
--                     Past sales show the new name too (they point at the drug, not a copy of its name).
--   set_drug_active   false = stop selling (hidden from Sell, Inventory and the low-stock lists, all history kept);
--                     true  = bring it back. Hiding is refused while any stock is left, including expired stock,
--                     so nothing disappears from the shelf count.
--   delete_drug       only for a drug that never had a batch, sale, return, order line, adjustment or
--                     controlled-drug entry. Anything else must be hidden instead.
--
-- Safe to re-run.

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
  p_pack_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
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
  if p_reorder_level is null or p_reorder_level < 0 then
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

  begin
    update drugs set
      name = v_name,
      category_id = p_category_id,
      form = coalesce(p_form, form),
      unit = coalesce(nullif(trim(coalesce(p_unit, '')), ''), unit),
      reorder_level = p_reorder_level,
      is_prescription = coalesce(p_is_prescription, is_prescription),
      pack_size = p_pack_size,
      pack_label = nullif(trim(coalesce(p_pack_label, '')), '')
    where id = p_drug_id and pharmacy_id = p_pharmacy_id;
  exception when unique_violation then
    raise exception 'Another drug is already named "%". Pick a different name.', v_name;
  end;
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

revoke all on function public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text) from public, anon;
revoke all on function public.set_drug_active(uuid, uuid, boolean) from public, anon;
revoke all on function public.delete_drug(uuid, uuid) from public, anon;
grant execute on function public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text) to authenticated;
grant execute on function public.set_drug_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.delete_drug(uuid, uuid) to authenticated;
