-- 2026-11-07 (night, later still): barcode scanning.
--
-- A drug can have a barcode. Once it does, scanning it (camera, or a USB scanner, which just
-- types very fast and presses Enter) finds that drug straight away on Sell and Inventory,
-- instead of typing the name. A drug with no barcode works exactly as before.
--
-- What is new (no existing row is edited):
--   * drugs.barcode: empty for every drug, old and new, until someone scans or types one in.
--     Two drugs in the same pharmacy cannot share a barcode - the same rule, and the same
--     "bring the hidden one back instead" message, that already applies to a drug's name.
--   * v_drug_stock carries the barcode, so Sell and Inventory can match against it without
--     a second query.
--   * edit_drug() takes one more, optional argument: p_barcode. Old callers still work and
--     leave the barcode as it is (the app always sends the current value, same as pack_label).

alter table public.drugs add column if not exists barcode text;

-- trimmed, and empty counts as none - never a row storing ''.
create or replace function public.barcode_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  NEW.barcode := nullif(trim(coalesce(NEW.barcode, '')), '');
  return NEW;
end;
$$;
drop trigger if exists trg_barcode_guard on public.drugs;
create trigger trg_barcode_guard
  before insert or update of barcode on public.drugs
  for each row execute function barcode_guard();

create unique index if not exists drugs_pharmacy_barcode_idx on public.drugs (pharmacy_id, barcode) where barcode is not null;

create or replace view public.v_drug_stock with (security_invoker = true) as
 select d.id as drug_id,
    d.pharmacy_id,
    d.name,
    d.unit,
    (case when p.low_stock_days is not null and not d.reorder_custom and rt.units > 0
          then ceil(rt.units::numeric / rt.span * p.low_stock_days)::integer
          else d.reorder_level end) as reorder_level,
    d.default_price,
    d.is_prescription,
    d.pack_size,
    d.pack_label,
    coalesce(sum(b.quantity_remaining) filter (where (b.expiry_date >= current_date)), (0)::bigint) as qty_in_stock,
    coalesce(sum(b.quantity_remaining) filter (where (b.expiry_date < current_date)), (0)::bigint) as qty_expired,
    min(b.expiry_date) filter (where ((b.quantity_remaining > 0) and (b.expiry_date >= current_date))) as soonest_expiry,
    coalesce(sum(((b.quantity_remaining)::numeric * b.cost_price)) filter (where (b.expiry_date >= current_date)), (0)::numeric) as stock_value_cost,
    coalesce(sum(((b.quantity_remaining)::numeric * b.sell_price)) filter (where (b.expiry_date >= current_date)), (0)::numeric) as stock_value_retail,
    coalesce(bool_or(b.expiry_unknown) filter (where (b.quantity_remaining > 0)), false) as has_unknown_expiry,
    d.control_class,
    d.reorder_level as reorder_own,
    d.reorder_custom,
    (case when rt.units > 0 then round(rt.units::numeric / rt.span, 3) end) as daily_rate,
    (case when rt.units > 0
          then round(coalesce(sum(b.quantity_remaining) filter (where (b.expiry_date >= current_date)), 0)::numeric
                     / (rt.units::numeric / rt.span), 1) end) as days_left,
    d.barcode
   from public.drugs d
     join public.pharmacies p on p.id = d.pharmacy_id
     left join public.batches b on (((b.drug_id = d.id) and (b.quantity_remaining > 0)))
     left join lateral (
       select greatest(
                coalesce((select sum(si.quantity) from public.sale_items si
                            join public.sales s on s.id = si.sale_id
                           where si.drug_id = d.id and not s.voided
                             and s.sold_at >= now() - interval '30 days'), 0)
              - coalesce((select sum(r.quantity) from public.returns r
                           where r.drug_id = d.id and r.created_at >= now() - interval '30 days'), 0), 0) as units,
              greatest(7, least(30, ceil(extract(epoch from (now() - d.created_at)) / 86400)))::integer as span
        where p.low_stock_days is not null
     ) rt on true
  where d.active
  group by d.id, p.id, rt.units, rt.span;

drop function if exists public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text, boolean);
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

revoke all on function public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text, boolean, text) from public, anon;
grant execute on function public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text, boolean, text) to authenticated;
