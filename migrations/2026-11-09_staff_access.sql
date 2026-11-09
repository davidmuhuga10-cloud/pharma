-- 2026-11-09  Per-staff permissions ("what can this person see")
--
-- WHAT WAS WRONG
--   Every staff member saw the same money screens. A Seller (attendant) could
--   open profit and margin, stock value, what the shop owes suppliers, the whole
--   shop's takings and the Stock Valuation report. Owners asked to choose, person
--   by person, what each member of staff may see.
--
-- WHAT CHANGES
--   * profiles.access (jsonb, null = "Everything", the old behaviour).
--   * staff_can(key): does the signed-in person hold this permission?
--   * dashboard_data / dashboard_data_custom keep their names and shape but drop
--     the figures the caller may not see (the old bodies become *_raw, which the
--     browser can no longer call). dashboard_extras, supplier_owed_summary and
--     v_drug_stock blank the figures the same way.
--   * my_sales_today(): a seller's own sales for today (nothing about anyone else).
--   * set_staff_access (owner) and admin_set_staff_access (platform admin) are the
--     ONLY ways to change profiles.access; every change is logged in
--     staff_access_log (who, when, before, after). Last save wins.
--   * New Sellers start on the "Sales and stock only" preset. Everyone who exists
--     today keeps seeing what they saw (access stays null).
--
-- WHY IT IS SAFE
--   Nobody's access changes when this runs (null = everything). The wrappers
--   return exactly what the old functions returned for those people. Apply it
--   AFTER the new app is live: a Seller on the preset would otherwise hit a
--   dashboard that still expects the removed figures.
--
-- LIMIT (be honest with owners)
--   Row level security here is per pharmacy, not per role, so a technical Seller
--   could still read batches.cost_price or the sales tables straight through the
--   API. This closes the screens, exports and the database functions the app uses;
--   it is not a wall against someone who writes their own API calls.

-- ---------------------------------------------------------------- column
alter table public.profiles add column if not exists access jsonb;

-- ------------------------------------------------------------ audit table
create table if not exists public.staff_access_log (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references public.pharmacies(id) on delete cascade,
  profile_id       uuid not null,
  changed_by       uuid,
  changed_by_name  text,
  via              text not null check (via in ('owner', 'admin')),
  old_access       jsonb,
  new_access       jsonb,
  changed_at       timestamptz not null default now()
);
create index if not exists staff_access_log_pharmacy_idx
  on public.staff_access_log (pharmacy_id, changed_at desc);
alter table public.staff_access_log enable row level security;
drop policy if exists "owner reads staff_access_log" on public.staff_access_log;
create policy "owner reads staff_access_log" on public.staff_access_log
  for select to authenticated
  using (pharmacy_id = my_pharmacy_id() and my_role() in ('owner', 'co_owner'));
revoke all on public.staff_access_log from public, anon, authenticated;
grant select on public.staff_access_log to authenticated;

-- ----------------------------------------------------------------- presets
-- Used by the new-seller trigger. The browser keeps the same lists in
-- js/core.js (ACCESS_PRESETS); tests/staff-access.test.js checks they agree.
create or replace function public.access_preset(p_name text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case p_name
    when 'sales_stock' then jsonb_build_object(
      'see_profit', false, 'see_stock_value', false, 'see_debt', false,
      'see_shop_sales', false, 'see_top_sellers', true, 'see_customer_debt', false,
      'rpt_valuation', false, 'rpt_sales', true, 'see_cost_prices', false,
      'export', true, 'controlled', 'view')
    when 'no_profit' then jsonb_build_object(
      'see_profit', false, 'see_stock_value', false, 'see_debt', true,
      'see_shop_sales', true, 'see_top_sellers', true, 'see_customer_debt', true,
      'rpt_valuation', false, 'rpt_sales', true, 'see_cost_prices', true,
      'export', true, 'controlled', 'record')
    else null
  end
$$;
revoke all on function public.access_preset(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- staff_can
-- Owner and co-owner always pass. No saved access = everything (the old
-- behaviour). A key that is not mentioned = allowed. Signed out = no.
create or replace function public.staff_can(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when pr.role in ('owner', 'co_owner') then true
             when pr.access is null then true
             when pr.access ? p_key then coalesce(pr.access ->> p_key, 'true') <> 'false'
             else true
           end
      from profiles pr
     where pr.id = auth.uid()
  ), false)
$$;
revoke all on function public.staff_can(text) from public, anon;
grant execute on function public.staff_can(text) to authenticated;

-- --------------------------------------------- new Sellers get the preset
create or replace function public.profiles_default_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'attendant' and new.access is null then
    new.access := access_preset('sales_stock');
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_default_access() from public, anon, authenticated;
drop trigger if exists profiles_default_access on public.profiles;
create trigger profiles_default_access
  before insert on public.profiles
  for each row execute function public.profiles_default_access();

-- ------------------------------------- nobody edits their own access directly
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access is distinct from old.access
     and coalesce(current_setting('app.staff_access_writer', true), '') <> '1' then
    raise exception 'Staff permissions can only be changed from the Permissions screen';
  end if;
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

-- ------------------------------------------------------------- the writers
-- Internal: checks the shape, writes the profile, writes the log line.
create or replace function public.staff_access_apply(p_profile_id uuid, p_access jsonb, p_via text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target   profiles%rowtype;
  v_key      text;
  v_val      jsonb;
  v_allowed  text[] := array['see_profit','see_stock_value','see_debt','see_shop_sales',
                             'see_top_sellers','see_customer_debt','rpt_valuation','rpt_sales',
                             'see_cost_prices','export','controlled'];
  v_name     text;
begin
  select * into v_target from profiles where id = p_profile_id;
  if not found then
    raise exception 'Staff member not found';
  end if;
  if v_target.role in ('owner', 'co_owner') then
    raise exception 'The owner and co-owner always see everything';
  end if;

  if p_access is not null then
    if jsonb_typeof(p_access) <> 'object' then
      raise exception 'Permissions must be an object';
    end if;
    for v_key, v_val in select * from jsonb_each(p_access) loop
      if not (v_key = any (v_allowed)) then
        raise exception 'Unknown permission: %', v_key;
      end if;
      if v_key = 'controlled' then
        if v_val not in ('"off"'::jsonb, '"view"'::jsonb, '"record"'::jsonb) then
          raise exception 'controlled must be off, view or record';
        end if;
      elsif jsonb_typeof(v_val) <> 'boolean' then
        raise exception '% must be true or false', v_key;
      end if;
    end loop;
  end if;

  select full_name into v_name from profiles where id = auth.uid();

  perform set_config('app.staff_access_writer', '1', true);
  update profiles set access = p_access where id = p_profile_id;
  perform set_config('app.staff_access_writer', '', true);

  insert into staff_access_log (pharmacy_id, profile_id, changed_by, changed_by_name, via, old_access, new_access)
  values (v_target.pharmacy_id, p_profile_id, auth.uid(),
          coalesce(v_name, case when p_via = 'admin' then 'Platform admin' end),
          p_via, v_target.access, p_access);

  return jsonb_build_object('id', p_profile_id, 'access', p_access);
end;
$$;
revoke all on function public.staff_access_apply(uuid, jsonb, text) from public, anon, authenticated;

-- Owner / co-owner, for staff in their own pharmacy only.
create or replace function public.set_staff_access(p_profile_id uuid, p_access jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the pharmacy owner can change staff permissions';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and pharmacy_id = my_pharmacy_id()) then
    raise exception 'Staff member not found';
  end if;
  return staff_access_apply(p_profile_id, p_access, 'owner');
end;
$$;
revoke all on function public.set_staff_access(uuid, jsonb) from public, anon;
grant execute on function public.set_staff_access(uuid, jsonb) to authenticated;

-- Platform admin, any pharmacy.
create or replace function public.admin_set_staff_access(p_profile_id uuid, p_access jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Not authorized';
  end if;
  return staff_access_apply(p_profile_id, p_access, 'admin');
end;
$$;
revoke all on function public.admin_set_staff_access(uuid, jsonb) from public, anon;
grant execute on function public.admin_set_staff_access(uuid, jsonb) to authenticated;

-- Platform admin: one pharmacy's staff with their access, plus the change log.
create or replace function public.admin_staff_access(p_pharmacy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Not authorized';
  end if;
  return jsonb_build_object(
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
                'id', pr.id, 'full_name', pr.full_name, 'role', pr.role,
                'active', pr.active, 'access', pr.access) order by pr.full_name)
              from profiles pr where pr.pharmacy_id = p_pharmacy_id), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(to_jsonb(x) order by x.changed_at desc) from (
                select l.changed_at, l.via, l.changed_by_name, l.old_access, l.new_access,
                       pr.full_name as staff_name
                  from staff_access_log l
                  left join profiles pr on pr.id = l.profile_id
                 where l.pharmacy_id = p_pharmacy_id
                 order by l.changed_at desc
                 limit 30) x), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_staff_access(uuid) from public, anon;
grant execute on function public.admin_staff_access(uuid) to authenticated;

-- ---------------------------------------------------- my own sales, today
create or replace function public.my_sales_today()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total',        coalesce(sum(s.total_amount), 0),
    'count',        count(*),
    'last_sold_at', max(s.sold_at))
    from sales s
   where s.pharmacy_id = my_pharmacy_id()
     and s.created_by = auth.uid()
     and not s.voided
     and s.sold_at >= (today_ke()::timestamp at time zone 'Africa/Nairobi')
$$;
revoke all on function public.my_sales_today() from public, anon;
grant execute on function public.my_sales_today() to authenticated;

-- ------------------------------------------------- dashboard: strip figures
create or replace function public.dashboard_filter(r jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not staff_can('see_profit') then
    r := r - 'cost_total' - 'profit_total' - 'profit_prev_total';
  end if;
  if not staff_can('see_shop_sales') then
    r := r - 'sales_total' - 'sales_prev_total' - 'trend' - 'rush';
    r := jsonb_set(r, '{top_sellers}',
           coalesce((select jsonb_agg(e - 'revenue') from jsonb_array_elements(r -> 'top_sellers') e), '[]'::jsonb));
  end if;
  if not staff_can('see_top_sellers') then
    r := jsonb_set(r, '{top_sellers}', '[]'::jsonb);
  end if;
  return r;
end;
$$;
revoke all on function public.dashboard_filter(jsonb) from public, anon, authenticated;

-- Keep the old bodies as *_raw (once), closed to the browser, and put a
-- wrapper with the same name and shape in front.
do $$
begin
  if to_regprocedure('public.dashboard_data_raw(uuid,text)') is null then
    alter function public.dashboard_data(uuid, text) rename to dashboard_data_raw;
  end if;
  if to_regprocedure('public.dashboard_data_custom_raw(uuid,date,date)') is null then
    alter function public.dashboard_data_custom(uuid, date, date) rename to dashboard_data_custom_raw;
  end if;
end $$;
revoke all on function public.dashboard_data_raw(uuid, text) from public, anon, authenticated;
revoke all on function public.dashboard_data_custom_raw(uuid, date, date) from public, anon, authenticated;

create or replace function public.dashboard_data(p_pharmacy_id uuid, p_range text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return dashboard_filter(dashboard_data_raw(p_pharmacy_id, p_range));
end;
$$;
revoke all on function public.dashboard_data(uuid, text) from public, anon;
grant execute on function public.dashboard_data(uuid, text) to authenticated;

create or replace function public.dashboard_data_custom(p_pharmacy_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return dashboard_filter(dashboard_data_custom_raw(p_pharmacy_id, p_start, p_end));
end;
$$;
revoke all on function public.dashboard_data_custom(uuid, date, date) from public, anon;
grant execute on function public.dashboard_data_custom(uuid, date, date) to authenticated;

-- ------------------------------ customer credit, supplier debt, stock value
create or replace function public.dashboard_extras(p_pharmacy_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'credit_owed',        case when staff_can('see_customer_debt')
                               then coalesce((select sum(balance) from v_customer_balances
                                               where pharmacy_id = p_pharmacy_id and balance > 0.5), 0)
                          end,
    'credit_customers',   case when staff_can('see_customer_debt')
                               then (select count(*) from v_customer_balances
                                      where pharmacy_id = p_pharmacy_id and balance > 0.5)
                          end,
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
  select case when staff_can('see_debt')
              then coalesce(sum(b) filter (where b > 0.5), 0)::numeric else 0::numeric end,
         case when staff_can('see_debt')
              then (count(*) filter (where b > 0.5))::integer else 0 end
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
    CASE WHEN staff_can('see_stock_value')
         THEN COALESCE(sum(b.quantity_remaining::numeric * b.cost_price) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0::numeric)
    END AS stock_value_cost,
    CASE WHEN staff_can('see_stock_value')
         THEN COALESCE(sum(b.quantity_remaining::numeric * b.sell_price) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0::numeric)
    END AS stock_value_retail,
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
