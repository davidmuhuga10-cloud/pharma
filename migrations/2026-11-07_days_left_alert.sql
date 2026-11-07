-- 2026-11-07 (night, later): "days of stock left" alert, next to the fixed reorder level.
--
-- A pharmacy can now say "warn me when a drug will last fewer than N days". The app works
-- out how fast each drug sells from the last 30 days of sales. A drug can still have its own
-- fixed number, and that number always wins.
--
-- Nothing changes for any pharmacy until its owner types a number of days in Settings:
-- low_stock_days is empty (off) for every pharmacy, old and new.
--
-- What changes (no existing row is edited except the new flag column in step 2):
--   1. pharmacies.low_stock_days: the number of days; empty = off.
--   2. drugs.reorder_custom: true when a person chose that drug's own number. Existing drugs
--      whose number differs from the pharmacy default are marked true, so a number someone
--      picked is kept when the days alert is turned on. Everything else starts false.
--   3. v_drug_stock: the column reorder_level now means the number in force. With days off, or
--      a pinned drug, or a drug with no sales in 30 days, it is exactly the stored number as
--      before. Otherwise it is ceil(units sold per day x days). Every screen, report and view
--      that already compares stock with reorder_level (low stock, reorder list, dashboard)
--      follows without any other change. New columns at the end: reorder_own (the stored
--      number), reorder_custom, daily_rate, days_left.
--   4. edit_drug(): one optional extra argument, p_reorder_custom. Old callers still work.
--   5. Owners may update low_stock_days (column permission).

-- 1 + 2 -------------------------------------------------------------------------------
alter table public.pharmacies
  add column if not exists low_stock_days integer check (low_stock_days between 1 and 90);

alter table public.drugs
  add column if not exists reorder_custom boolean not null default false;

update public.drugs d
   set reorder_custom = true
  from public.pharmacies p
 where p.id = d.pharmacy_id and d.reorder_level <> p.low_stock_default and not d.reorder_custom;

-- 5 -----------------------------------------------------------------------------------
grant update (low_stock_days) on public.pharmacies to authenticated;

-- 3 -----------------------------------------------------------------------------------
-- Sales speed: units sold in the last 30 days (voided sales and returns taken off), over
-- the number of days the drug has existed, between 7 and 30. Worked out only for
-- pharmacies that turned the days alert on, so the others pay nothing for it.
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
                     / (rt.units::numeric / rt.span), 1) end) as days_left
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

-- 4 -----------------------------------------------------------------------------------
-- p_reorder_custom: true = this drug has its own number (p_reorder_level required);
-- false = use the days alert (p_reorder_level may be empty, the stored number is kept);
-- empty = leave the flag as it is (what older app versions send).
drop function if exists public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text);
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
  p_reorder_custom boolean default null
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
      pack_label = nullif(trim(coalesce(p_pack_label, '')), '')
    where id = p_drug_id and pharmacy_id = p_pharmacy_id;
  exception when unique_violation then
    raise exception 'Another drug is already named "%". Pick a different name.', v_name;
  end;
end;
$$;

revoke all on function public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text, boolean) from public, anon;
grant execute on function public.edit_drug(uuid, uuid, text, uuid, drug_form, text, integer, boolean, integer, text, boolean) to authenticated;
