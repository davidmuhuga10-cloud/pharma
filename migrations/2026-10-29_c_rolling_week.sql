-- 2026-10-29 (c): the dashboard's "Week" view is now a rolling last 7 days.
--
-- It used to be "this week so far", which restarted every Sunday night and
-- left the graph as a single dot at the start of each week. Now it is today
-- plus the 6 days before it (Nairobi days), compared with the 7 days before
-- that, and the graph always has 7 points (a day with no sales is 0).
-- Only the 'week' range changes; today / month / year are as before.
-- Safe to re-run.

create or replace function dashboard_data(p_pharmacy_id uuid, p_range text)
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

grant execute on function dashboard_data(uuid, text) to authenticated;
