-- 2026-11-07 (later): the demo always shows every stock state.
--
-- A demo that is "all healthy" hides half the app. This keeps, every day:
--   * 3 drugs out of stock and 4 drugs low (held there: not sold, not restocked)
--   * at least 3 batches already expired (old ones are written off after 60 days
--     and fresh ones take their place)
--   * at least 2 batches expiring within 30 days and 5 within 90 days
-- Everything else stays healthy: sold from and restocked as before.
--
-- Cost: a handful of small queries once a day, from the same hourly job.
-- Only touches pharmacies listed in demo_config. Server-only, like the rest.

alter table public.demo_config
  add column if not exists hold_out uuid[] not null default '{}',   -- drugs kept out of stock
  add column if not exists hold_low uuid[] not null default '{}';   -- drugs kept low

-- Drugs the sale and restock steps must leave alone.
create or replace function public.demo_held(p_pharmacy_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select hold_out || hold_low from demo_config where pharmacy_id = p_pharmacy_id), '{}')
$$;

-- Sales, restocks and the daily job skip the held drugs. Patching the existing
-- definitions keeps this file small; each patch is checked, and skipped if already done.
do $$
declare
  d text;
  n text;
begin
  d := pg_get_functiondef('public.demo_restock_low(uuid,timestamptz)'::regprocedure);
  if d not like '%demo_held%' then
    n := replace(d, 'and d.active and d.default_price is not null',
                    'and d.active and d.default_price is not null and not (d.id = any (demo_held(p_pharmacy_id)))');
    if n = d then raise exception 'demo_restock_low: patch did not apply'; end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.demo_post_sale(uuid,numeric,timestamptz)'::regprocedure);
  if d not like '%demo_held%' then
    n := replace(d, 'and not (d.id = any (v_used))',
                    'and not (d.id = any (v_used)) and not (d.id = any (demo_held(p_pharmacy_id)))');
    if n = d then raise exception 'demo_post_sale: patch did not apply'; end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.demo_tick()'::regprocedure);
  if d not like '%demo_showcase%' then
    n := replace(d, 'perform demo_ensure_expiring(c.pharmacy_id);', 'perform demo_showcase(c.pharmacy_id);');
    if n = d then raise exception 'demo_tick: patch did not apply'; end if;
    execute n;
  end if;
end
$$;

-- Batches expiring soon: at least 2 within 30 days and 5 within 90 days, on slow-moving, non-held drugs.
create or replace function public.demo_ensure_expiring(p_pharmacy_id uuid, p_at timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_batch uuid;
  v_have30 integer;
  v_have90 integer;
  v_need integer;
  v_tier integer;
  v_n integer := 0;
  v_held uuid[];
begin
  perform demo_act_as(p_pharmacy_id);
  v_held := demo_held(p_pharmacy_id);
  select count(*) filter (where expiry_date <= current_date + 30), count(*)
    into v_have30, v_have90
    from batches
   where pharmacy_id = p_pharmacy_id and quantity_remaining > 0
     and expiry_date between current_date and current_date + 90;

  for v_tier in 1..2 loop
    v_need := case v_tier when 1 then 2 - v_have30 else 5 - v_have90 - v_n end;
    continue when v_need <= 0;
    for r in
      select id, default_price, reorder_level from drugs
       where pharmacy_id = p_pharmacy_id and active and default_price is not null and reorder_level <= 30
         and not (id = any (v_held))
       order by random() limit v_need
    loop
      v_batch := record_restock(p_pharmacy_id, r.id, greatest(3, r.reorder_level / 2),
        round(r.default_price * 0.68, 2), r.default_price,
        current_date + (case v_tier when 1 then 10 + floor(random() * 18) else 35 + floor(random() * 50) end)::int,
        'B' || lpad(floor(random() * 99999)::int::text, 5, '0'), 'MediSupply Distributors',
        (select id from suppliers where pharmacy_id = p_pharmacy_id order by created_at limit 1), false);
      if p_at is not null then
        update batches set created_at = p_at, received_at = (p_at at time zone 'Africa/Nairobi')::date where id = v_batch;
        update stock_adjustments set created_at = p_at where batch_id = v_batch and type = 'restock';
      end if;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$$;

-- Once a day: hold the out-of-stock and low drugs, clear old expired stock,
-- keep a few freshly expired batches, and keep the expiring-soon list filled.
create or replace function public.demo_showcase(p_pharmacy_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out uuid[];
  v_low uuid[];
  r record;
  b record;
  v_n integer := 0;
  v_total integer;
  v_target integer;
  v_first boolean;
  v_have integer;
  v_batch uuid;
  v_supplier uuid;
begin
  perform demo_act_as(p_pharmacy_id);
  select hold_out, hold_low into v_out, v_low from demo_config where pharmacy_id = p_pharmacy_id;
  select id into v_supplier from suppliers where pharmacy_id = p_pharmacy_id order by created_at limit 1;

  if cardinality(v_out) = 0 then
    select coalesce(array_agg(id), '{}') into v_out from drugs where pharmacy_id = p_pharmacy_id
       and name in ('Salbutamol inhaler 100mcg', 'Gentamicin injection', 'Combined pill (1 cycle)');
  end if;
  if cardinality(v_low) = 0 then
    select coalesce(array_agg(id), '{}') into v_low from drugs where pharmacy_id = p_pharmacy_id
       and name in ('Azithromycin 500mg', 'Hydrocortisone cream 1%', 'Digital thermometer', 'Loratadine 10mg');
  end if;
  update demo_config set hold_out = v_out, hold_low = v_low where pharmacy_id = p_pharmacy_id;

  -- out of stock: nothing left on the shelf
  for b in select id from batches
            where pharmacy_id = p_pharmacy_id and drug_id = any (v_out) and quantity_remaining > 0 and expiry_date >= current_date
  loop
    perform record_correction(p_pharmacy_id, b.id, 0, 'Stock count: none left on the shelf');
    v_n := v_n + 1;
  end loop;

  -- low: a few units left, below the reorder level
  for r in select id, default_price, reorder_level from drugs where pharmacy_id = p_pharmacy_id and id = any (v_low) loop
    select coalesce(sum(quantity_remaining), 0) into v_total from batches
     where drug_id = r.id and expiry_date >= current_date;
    if v_total > r.reorder_level or v_total = 0 then
      v_target := greatest(1, floor(r.reorder_level * 0.4)::int);
      v_first := true;
      for b in select id from batches where drug_id = r.id and expiry_date >= current_date and quantity_remaining > 0
                order by expiry_date, created_at, id
      loop
        perform record_correction(p_pharmacy_id, b.id, case when v_first then v_target else 0 end, 'Stock count adjustment');
        v_first := false;
        v_n := v_n + 1;
      end loop;
      if v_total = 0 then
        perform record_restock(p_pharmacy_id, r.id, v_target, round(r.default_price * 0.68, 2), r.default_price,
                               current_date + 300, 'B' || lpad(floor(random() * 99999)::int::text, 5, '0'),
                               'MediSupply Distributors', v_supplier, false);
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  -- expired stock: remove what has sat expired for over 60 days, keep at least 3 batches on the shelf
  for b in select id, quantity_remaining as q from batches
            where pharmacy_id = p_pharmacy_id and quantity_remaining > 0 and expiry_date < current_date - 60
  loop
    perform record_write_off(p_pharmacy_id, b.id, b.q, 'Expired stock removed from the shelf', 'expired_disposal');
    v_n := v_n + 1;
  end loop;
  select count(*) into v_have from batches
   where pharmacy_id = p_pharmacy_id and quantity_remaining > 0 and expiry_date < current_date;
  if v_have < 3 then
    for r in
      select d.id, d.default_price, d.reorder_level from drugs d
       where d.pharmacy_id = p_pharmacy_id and d.active and d.default_price is not null and d.reorder_level <= 60
         and not (d.id = any (v_out || v_low))
         and not exists (select 1 from batches x where x.drug_id = d.id and x.quantity_remaining > 0 and x.expiry_date < current_date)
       order by random() limit 3 - v_have
    loop
      v_batch := record_restock(p_pharmacy_id, r.id, greatest(2, r.reorder_level / 3),
        round(r.default_price * 0.68, 2), r.default_price,
        current_date - (5 + floor(random() * 50))::int,
        'B' || lpad(floor(random() * 99999)::int::text, 5, '0'), 'MediSupply Distributors', v_supplier, false);
      update batches set created_at = now() - interval '85 days', received_at = current_date - 85 where id = v_batch;
      update stock_adjustments set created_at = now() - interval '85 days' where batch_id = v_batch and type = 'restock';
      v_n := v_n + 1;
    end loop;
  end if;

  v_n := v_n + demo_ensure_expiring(p_pharmacy_id);
  return v_n;
end;
$$;

revoke all on function public.demo_held(uuid) from public, anon, authenticated;
revoke all on function public.demo_ensure_expiring(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.demo_showcase(uuid) from public, anon, authenticated;
