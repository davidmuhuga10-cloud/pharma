-- ROLLBACK for 2026-11-09_staff_access.sql
-- Run only if the per-staff permissions change misbehaves.
-- It puts every function and the view back exactly as they were, and removes
-- the permissions column and the change log. The saved permissions and the log
-- are DELETED by this file: if you want to keep them, copy them first with
--   select id, full_name, role, access from profiles where access is not null;
--   select * from staff_access_log;
-- Everybody then sees what they saw before this change (the old behaviour).

-- 1. Dashboard functions: drop the wrappers, give the original names back.
drop function if exists public.dashboard_data(uuid, text);
drop function if exists public.dashboard_data_custom(uuid, date, date);
do $$
begin
  if to_regprocedure('public.dashboard_data_raw(uuid,text)') is not null then
    alter function public.dashboard_data_raw(uuid, text) rename to dashboard_data;
  end if;
  if to_regprocedure('public.dashboard_data_custom_raw(uuid,date,date)') is not null then
    alter function public.dashboard_data_custom_raw(uuid, date, date) rename to dashboard_data_custom;
  end if;
end $$;
revoke all on function public.dashboard_data(uuid, text) from public, anon;
grant execute on function public.dashboard_data(uuid, text) to authenticated;
revoke all on function public.dashboard_data_custom(uuid, date, date) from public, anon;
grant execute on function public.dashboard_data_custom(uuid, date, date) to authenticated;
drop function if exists public.dashboard_filter(jsonb);

-- 2. Customer credit, supplier debt, stock value: original bodies.
create or replace function public.dashboard_extras(p_pharmacy_id uuid)
returns jsonb
language sql
stable
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
    'open_stock_take',    (select id from stock_takes where pharmacy_id = p_pharmacy_id and status = 'open' limit 1)
  )
$$;

create or replace function public.supplier_owed_summary(p_pharmacy_id uuid)
returns table(owed numeric, owed_count integer)
language sql
stable
set search_path = public
as $$
  with bal as (
    select s.opening_balance
           + coalesce((select sum(l.total_amount) from supplier_lpos l
                        where l.supplier_id = s.id and l.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(p.amount) from supplier_payments p
                        where p.supplier_id = s.id and p.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(r.credit_amount) from supplier_returns r
                        where r.supplier_id = s.id and r.pharmacy_id = p_pharmacy_id), 0) as b
      from suppliers s
     where s.pharmacy_id = p_pharmacy_id
  )
  select coalesce(sum(b) filter (where b > 0.5), 0)::numeric,
         (count(*) filter (where b > 0.5))::integer
    from bal
$$;

create or replace view public.v_drug_stock with (security_invoker = true) as
 SELECT d.id AS drug_id,
    d.pharmacy_id,
    d.name,
    d.unit,
        CASE
            WHEN p.low_stock_days IS NOT NULL AND NOT d.reorder_custom AND rt.units > 0 THEN ceil(rt.units::numeric / rt.span::numeric * p.low_stock_days::numeric)::integer
            ELSE d.reorder_level
        END AS reorder_level,
    d.default_price,
    d.is_prescription,
    d.pack_size,
    d.pack_label,
    COALESCE(sum(b.quantity_remaining) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0::bigint) AS qty_in_stock,
    COALESCE(sum(b.quantity_remaining) FILTER (WHERE b.expiry_date < CURRENT_DATE), 0::bigint) AS qty_expired,
    min(b.expiry_date) FILTER (WHERE b.quantity_remaining > 0 AND b.expiry_date >= CURRENT_DATE) AS soonest_expiry,
    COALESCE(sum(b.quantity_remaining::numeric * b.cost_price) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0::numeric) AS stock_value_cost,
    COALESCE(sum(b.quantity_remaining::numeric * b.sell_price) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0::numeric) AS stock_value_retail,
    COALESCE(bool_or(b.expiry_unknown) FILTER (WHERE b.quantity_remaining > 0), false) AS has_unknown_expiry,
    d.control_class,
    d.reorder_level AS reorder_own,
    d.reorder_custom,
        CASE
            WHEN rt.units > 0 THEN round(rt.units::numeric / rt.span::numeric, 3)
            ELSE NULL::numeric
        END AS daily_rate,
        CASE
            WHEN rt.units > 0 THEN round(COALESCE(sum(b.quantity_remaining) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0::bigint)::numeric / (rt.units::numeric / rt.span::numeric), 1)
            ELSE NULL::numeric
        END AS days_left,
    d.barcode
   FROM drugs d
     JOIN pharmacies p ON p.id = d.pharmacy_id
     LEFT JOIN batches b ON b.drug_id = d.id AND b.quantity_remaining > 0
     LEFT JOIN LATERAL ( SELECT GREATEST(COALESCE(( SELECT sum(si.quantity) AS sum
                   FROM sale_items si
                     JOIN sales s ON s.id = si.sale_id
                  WHERE si.drug_id = d.id AND NOT s.voided AND s.sold_at >= (now() - '30 days'::interval)), 0::bigint) - COALESCE(( SELECT sum(r.quantity) AS sum
                   FROM returns r
                  WHERE r.drug_id = d.id AND r.created_at >= (now() - '30 days'::interval)), 0::bigint), 0::bigint) AS units,
            GREATEST(7::numeric, LEAST(30::numeric, ceil(EXTRACT(epoch FROM now() - d.created_at) / 86400::numeric)))::integer AS span
          WHERE p.low_stock_days IS NOT NULL) rt ON true
  WHERE d.active
  GROUP BY d.id, p.id, rt.units, rt.span;

-- 3. The profile guard as it was (no 'access' rule), then drop the new pieces.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active
      or new.pharmacy_id is distinct from old.pharmacy_id
      or new.account_expires_at is distinct from old.account_expires_at) then
    if my_role() not in ('owner', 'co_owner') then
      raise exception 'Only the pharmacy owner can change role, active status, or account expiry';
    end if;
    if new.pharmacy_id is distinct from old.pharmacy_id then
      raise exception 'A profile cannot be moved to a different pharmacy';
    end if;
    if new.role = 'owner' and old.role is distinct from 'owner' then
      raise exception 'Cannot promote a staff member to owner';
    end if;
    if old.role = 'owner'
       and (new.role is distinct from old.role or new.active is distinct from old.active) then
      raise exception 'The pharmacy owner''s own role and access cannot be changed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_default_access on public.profiles;
drop function if exists public.profiles_default_access();
drop function if exists public.my_sales_today();
drop function if exists public.admin_staff_access(uuid);
drop function if exists public.admin_set_staff_access(uuid, jsonb);
drop function if exists public.set_staff_access(uuid, jsonb);
drop function if exists public.staff_access_apply(uuid, jsonb, text);
drop function if exists public.staff_can(text);
drop function if exists public.access_preset(text);
drop table if exists public.staff_access_log;
alter table public.profiles drop column if exists access;
