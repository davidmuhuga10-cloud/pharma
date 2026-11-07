-- 2026-11-07: a demo pharmacy that keeps itself busy.
--
-- Why: prospects open the demo login and need to see a shop that looks alive,
-- with sales on the graph every day. It also gives the database a little real
-- activity each day.
--
-- How it stays safe:
--   * Everything here is for ONE pharmacy, the one listed in demo_config.
--     No row in demo_config = every function below does nothing.
--   * Nothing here can be called from the app or the public API. Only the
--     database's own scheduler (pg_cron) and the project owner (SQL editor).
--   * Sales, restocks, expenses and customer payments go through the same
--     checked functions the app uses (record_sale, record_restock, ...), so
--     stock, invoice numbers and balances always add up.
--   * Customers are created with sms_ok = false: no text is ever sent.
--
-- How much it costs: about 3 to 10 sales a day (daily total KES 2,000 to
-- 8,000), about 60 small rows a day, one light run an hour between 08:00 and
-- 20:00 Nairobi. Roughly 22,000 rows a year, which is tiny.
--
-- Turning it on for a pharmacy (SQL editor, as project owner):
--   select demo_enable('<pharmacy id>');                          -- catalogue, customers, opening stock
--   select demo_backfill('<pharmacy id>', current_date - 90, current_date - 1);  -- last 3 months
-- Turning it off:  delete from demo_config where pharmacy_id = '<pharmacy id>';

create table if not exists public.demo_config (
  pharmacy_id  uuid primary key references public.pharmacies(id) on delete cascade,
  plan_day     date,                          -- the day the plan below is for
  plan_target  numeric not null default 0,    -- today's sales total we are aiming for
  plan_sales   integer not null default 0,    -- how many sales today
  plan_done    integer not null default 0,    -- how many are posted so far
  plan_sum     numeric not null default 0,    -- total posted so far today
  last_tick    timestamptz
);
alter table public.demo_config enable row level security;
revoke all on public.demo_config from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Act as the demo pharmacy's owner for the rest of this transaction, so the
-- normal checked functions accept our calls. Refuses any other pharmacy.
-- (app.current_user_id is only read by the local test stand-in for auth.uid(),
-- the real one reads the request.jwt settings.)
-- ---------------------------------------------------------------------------
create or replace function public.demo_act_as(p_pharmacy_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  if not exists (select 1 from demo_config where pharmacy_id = p_pharmacy_id) then
    raise exception 'Not a demo pharmacy';
  end if;
  select id into v_uid from profiles
   where pharmacy_id = p_pharmacy_id and role = 'owner'
   order by created_at limit 1;
  if v_uid is null then
    raise exception 'The demo pharmacy has no owner account';
  end if;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('app.current_user_id', v_uid::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Restock anything at or below its reorder level. p_at back-dates the new
-- stock (used when building history); null means "now".
-- ---------------------------------------------------------------------------
create or replace function public.demo_restock_low(p_pharmacy_id uuid, p_at timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_supplier uuid;
  v_n integer := 0;
  v_short boolean;

  v_batch uuid;
begin
  perform demo_act_as(p_pharmacy_id);
  select id into v_supplier from suppliers where pharmacy_id = p_pharmacy_id order by created_at limit 1;

  for r in
    select d.id, d.default_price, d.reorder_level
      from drugs d
     where d.pharmacy_id = p_pharmacy_id and d.active and d.default_price is not null
       and (select coalesce(sum(b.quantity_remaining), 0) from batches b
             where b.drug_id = d.id and b.expiry_date >= current_date) <= d.reorder_level
  loop
    -- now and then a small short-dated batch, so the "expiring soon" list is never empty
    v_short := random() < 0.12;
    if v_short then
      v_batch := record_restock(p_pharmacy_id, r.id, greatest(2, r.reorder_level / 2),
        round(r.default_price * 0.68, 2), r.default_price,
        current_date + 35 + floor(random() * 50)::int,
        'B' || lpad(floor(random() * 99999)::int::text, 5, '0'), 'MediSupply Distributors', v_supplier, false);
      if p_at is not null then
        update batches set created_at = p_at, received_at = (p_at at time zone 'Africa/Nairobi')::date where id = v_batch;
        update stock_adjustments set created_at = p_at where batch_id = v_batch and type = 'restock';
      end if;
    end if;
    v_batch := record_restock(p_pharmacy_id, r.id, greatest(4, r.reorder_level * (case when v_short then 4 else 6 end)),
      round(r.default_price * 0.68, 2), r.default_price,
      current_date + 240 + floor(random() * 600)::int,
      'B' || lpad(floor(random() * 99999)::int::text, 5, '0'), 'MediSupply Distributors', v_supplier, false);
    if p_at is not null then
      update batches set created_at = p_at, received_at = (p_at at time zone 'Africa/Nairobi')::date where id = v_batch;
      update stock_adjustments set created_at = p_at where batch_id = v_batch and type = 'restock';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Keeps the "expiring soon" list from ever being empty: when fewer than two
-- batches expire within 60 days, a small short-dated batch of two slow-moving
-- items arrives. Runs once a day.
-- ---------------------------------------------------------------------------
create or replace function public.demo_ensure_expiring(p_pharmacy_id uuid, p_at timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_batch uuid;
  v_have integer;
  v_n integer := 0;
begin
  perform demo_act_as(p_pharmacy_id);
  select count(*) into v_have from batches
   where pharmacy_id = p_pharmacy_id and quantity_remaining > 0
     and expiry_date >= current_date and expiry_date <= current_date + 60;
  if v_have >= 2 then
    return 0;
  end if;
  for r in
    select id, default_price, reorder_level from drugs
     where pharmacy_id = p_pharmacy_id and active and default_price is not null and reorder_level <= 30
     order by random() limit 2 - v_have
  loop
    v_batch := record_restock(p_pharmacy_id, r.id, greatest(3, r.reorder_level / 2),
      round(r.default_price * 0.68, 2), r.default_price,
      current_date + 25 + floor(random() * 30)::int,
      'B' || lpad(floor(random() * 99999)::int::text, 5, '0'), 'MediSupply Distributors',
      (select id from suppliers where pharmacy_id = p_pharmacy_id order by created_at limit 1), false);
    if p_at is not null then
      update batches set created_at = p_at, received_at = (p_at at time zone 'Africa/Nairobi')::date where id = v_batch;
      update stock_adjustments set created_at = p_at where batch_id = v_batch and type = 'restock';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- One sale of roughly p_budget shillings (never more). Returns the amount
-- posted, or 0 if nothing could be sold. A failure undoes only this sale.
-- p_at back-dates it; null means "now".
-- ---------------------------------------------------------------------------
create or replace function public.demo_post_sale(p_pharmacy_id uuid, p_budget numeric, p_at timestamptz default null)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_items jsonb := '[]'::jsonb;
  v_used uuid[] := '{}';
  v_left numeric := p_budget;
  v_total numeric := 0;
  v_qty integer;
  v_cap integer;
  v_roll numeric := random();
  v_pay jsonb;
  v_cash numeric;
  v_cust uuid;
  v_sale uuid;
  v_ref text := 'S' || upper(substr(md5(random()::text), 1, 9));
  v_patients text[] := array['Grace Wanjiru', 'Peter Otieno', 'Mary Achieng', 'John Kamau', 'Faith Mutua', 'Brian Kiprop'];
  v_schemes text[] := array['Jubilee', 'Britam', 'AAR', 'Resolution', 'Madison'];
begin
  perform demo_act_as(p_pharmacy_id);
  if p_budget is null or p_budget < 20 then
    return 0;
  end if;

  -- pick up to 8 different items that still fit the budget; popular ones come up more often
  for i in 1..8 loop
    exit when v_left < 5;
    select d.id, d.default_price as price, d.is_prescription as rx, d.reorder_level as reorder,
           (select coalesce(sum(b.quantity_remaining), 0) from batches b
             where b.drug_id = d.id and b.quantity_remaining > 0 and b.expiry_date >= current_date) as stock
      into r
      from drugs d
     where d.pharmacy_id = p_pharmacy_id and d.active and d.default_price > 0
       and d.default_price <= v_left and not (d.id = any (v_used))
       and exists (select 1 from batches b where b.drug_id = d.id and b.quantity_remaining > 0 and b.expiry_date >= current_date)
     order by -ln(1 - random()) / sqrt(d.reorder_level)
     limit 1;
    exit when not found;

    v_cap := least(r.stock::int, greatest(2, ceil(r.reorder / 4.0))::int, floor(v_left / r.price)::int);
    exit when v_cap < 1;
    v_qty := greatest(1, floor(v_cap * (0.5 + random() * 0.5))::int);
    v_items := v_items || jsonb_build_object('drug_id', r.id, 'quantity', v_qty,
      'patient_name', case when r.rx then v_patients[1 + floor(random() * array_length(v_patients, 1))::int] else null end);
    v_used := v_used || r.id;
    v_total := v_total + v_qty * r.price;
    v_left := v_left - v_qty * r.price;
  end loop;

  if jsonb_array_length(v_items) = 0 or v_total < 1 then
    return 0;
  end if;

  -- how it is paid: cash 41%, M-Pesa 38%, account (credit) 9%, split 7%, insurance 5%
  v_pay := jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_total));
  if v_roll >= 0.41 and v_roll < 0.79 then
    v_pay := jsonb_build_array(jsonb_build_object('method', 'mpesa', 'amount', v_total, 'reference', v_ref));
  elsif v_roll >= 0.79 and v_roll < 0.88 then
    select id into v_cust from customers where pharmacy_id = p_pharmacy_id and active order by random() limit 1;
    if v_cust is not null then
      v_pay := jsonb_build_array(jsonb_build_object('method', 'credit', 'amount', v_total));
    end if;
  elsif v_roll >= 0.88 and v_roll < 0.95 and v_total >= 100 then
    v_cash := round(v_total * (0.3 + random() * 0.4));
    v_pay := jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_cash),
                               jsonb_build_object('method', 'mpesa', 'amount', v_total - v_cash, 'reference', v_ref));
  elsif v_roll >= 0.95 then
    v_pay := jsonb_build_array(jsonb_build_object('method', 'insurance', 'amount', v_total,
                               'reference', v_schemes[1 + floor(random() * array_length(v_schemes, 1))::int]));
  end if;

  begin
    v_sale := record_sale(p_pharmacy_id, v_items, v_pay, null, null,
                          case when v_pay @> '[{"method":"credit"}]'::jsonb then v_cust else null end);
  exception when others then
    -- e.g. a customer over their credit limit: sell it for cash instead of skipping the sale
    begin
      v_sale := record_sale(p_pharmacy_id, v_items, jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_total)), null, null, null);
    exception when others then
      return 0;
    end;
  end;

  if p_at is not null then
    update sales set sold_at = p_at, created_at = p_at where id = v_sale;
    update stock_adjustments set created_at = p_at where ref_sale_id = v_sale;
    update insurance_claims set created_at = p_at, updated_at = p_at where sale_id = v_sale;
  end if;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Today's plan: how much to sell and in how many sales. Weekends and Mondays
-- are busier, Sundays quieter, and the totals wobble so the graph looks real.
-- Always between 2,300 and 7,700 so the day finishes inside 2,000 to 8,000.
-- ---------------------------------------------------------------------------
create or replace function public.demo_new_plan(p_day date, out target numeric, out n integer)
language plpgsql
volatile
set search_path = public
as $$
declare
  v_progress numeric := greatest(0, least(1, 1 - (today_ke() - p_day) / 95.0));  -- shop slowly grows
begin
  target := 4800
    * (case extract(isodow from p_day)::int when 6 then 1.25 when 7 then 0.8 when 1 then 1.1 when 5 then 1.1 else 1.0 end)
    * (0.9 + 0.1 * v_progress)
    * (0.68 + random() * 0.5);
  target := round(least(7700, greatest(2300, target)), 0);
  n := greatest(3, least(10, round(3 + (target - 2000) / 6000.0 * 6 + (random() * 2 - 1))::int));
end;
$$;

-- Customers on account pay back some of what they owe (about 3 days in 10 per customer).
create or replace function public.demo_pay_customers(p_pharmacy_id uuid, p_at timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_bal numeric;
  v_amt numeric;
  v_id uuid;
  v_n integer := 0;
begin
  perform demo_act_as(p_pharmacy_id);
  for r in select id from customers where pharmacy_id = p_pharmacy_id and active loop
    v_bal := customer_balance(r.id);
    if v_bal > 0 and random() < 0.3 then
      v_amt := case when random() < 0.7 then v_bal else greatest(1, floor(v_bal / 2)) end;
      begin
        v_id := record_customer_payment(p_pharmacy_id, r.id, v_amt,
                  case when random() < 0.7 then 'mpesa' else 'cash' end,
                  case when random() < 0.7 then 'S' || upper(substr(md5(random()::text), 1, 9)) else null end,
                  'Payment on account');
        if p_at is not null then
          update customer_payments set paid_at = p_at, created_at = p_at where id = v_id;
        end if;
        v_n := v_n + 1;
      exception when others then
        null;
      end;
    end if;
  end loop;

  -- insurers pay their claims after a few weeks
  update insurance_claims
     set status = 'paid', updated_at = coalesce(p_at, now())
   where pharmacy_id = p_pharmacy_id and status = 'pending'
     and created_at < coalesce(p_at, now()) - interval '21 days';
  return v_n;
end;
$$;

-- Fixed monthly bills and small day-to-day costs. Sized so the shop shows a modest profit.
create or replace function public.demo_post_expenses(p_pharmacy_id uuid, p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
  v_dom integer := extract(day from p_day)::int;
begin
  perform demo_act_as(p_pharmacy_id);

  if v_dom = 1 and not exists (select 1 from expenses where pharmacy_id = p_pharmacy_id and expense_date = p_day and category = 'rent') then
    perform record_expense(p_pharmacy_id, 'rent', 'Shop rent', 10000, 'bank', p_day, null);
    v_n := v_n + 1;
  end if;
  if v_dom = 5 and not exists (select 1 from expenses where pharmacy_id = p_pharmacy_id and expense_date = p_day and category = 'utilities') then
    perform record_expense(p_pharmacy_id, 'utilities', 'Electricity and water', (2000 + floor(random() * 1000))::numeric, 'mpesa', p_day, null);
    v_n := v_n + 1;
  end if;
  if v_dom = 28 and not exists (select 1 from expenses where pharmacy_id = p_pharmacy_id and expense_date = p_day and category = 'salaries') then
    perform record_expense(p_pharmacy_id, 'salaries', 'Shop attendant salary', 12000, 'mpesa', p_day, null);
    v_n := v_n + 1;
  end if;
  if random() < 0.2 then
    perform record_expense(p_pharmacy_id, 'transport', 'Transport for deliveries', (150 + floor(random() * 350))::numeric, 'cash', p_day, null);
    v_n := v_n + 1;
  end if;
  if random() < 0.08 then
    perform record_expense(p_pharmacy_id, 'supplies', 'Cleaning and shop supplies', (300 + floor(random() * 600))::numeric, 'cash', p_day, null);
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- A whole past day in one go (used to build history and to catch up after a gap).
-- Returns the day's sales total. Skips a day that already has sales.
-- ---------------------------------------------------------------------------
create or replace function public.demo_post_day(p_pharmacy_id uuid, p_day date)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan record;
  v_mins integer[];
  v_sum numeric := 0;
  v_budget numeric;
  v_i integer;
  v_at timestamptz;
begin
  perform demo_act_as(p_pharmacy_id);
  if p_day >= today_ke() then
    raise exception 'demo_post_day only writes past days';
  end if;
  if exists (select 1 from sales where pharmacy_id = p_pharmacy_id
              and sold_at >= (p_day::timestamp at time zone 'Africa/Nairobi')
              and sold_at <  ((p_day + 1)::timestamp at time zone 'Africa/Nairobi')) then
    return 0;
  end if;

  perform demo_restock_low(p_pharmacy_id, (p_day + time '07:30') at time zone 'Africa/Nairobi');
  perform demo_pay_customers(p_pharmacy_id, (p_day + time '09:00') at time zone 'Africa/Nairobi');
  perform demo_post_expenses(p_pharmacy_id, p_day);

  select * into v_plan from demo_new_plan(p_day);
  -- sale times spread over the opening hours (08:15 to 19:45), oldest first
  select array_agg(m order by m) into v_mins
    from (select 495 + floor(random() * 690)::int as m from generate_series(1, v_plan.n)) s;

  for v_i in 1..v_plan.n loop
    v_at := (p_day + make_interval(mins => v_mins[v_i])) at time zone 'Africa/Nairobi';
    if v_i = v_plan.n then
      v_budget := v_plan.target - v_sum;
    else
      v_budget := least(v_plan.target / v_plan.n * (0.5 + random()), greatest(0, v_plan.target - v_sum));
    end if;
    v_sum := v_sum + demo_post_sale(p_pharmacy_id, v_budget, v_at);
    if v_i < v_plan.n and v_i % 3 = 0 then
      perform demo_restock_low(p_pharmacy_id, v_at);
    end if;
  end loop;

  if v_sum < 2050 then   -- stock ran short for part of the plan: one top-up sale keeps the day above 2,000
    v_sum := v_sum + demo_post_sale(p_pharmacy_id, 2150 - v_sum, (p_day + time '19:50') at time zone 'Africa/Nairobi');
  end if;
  return v_sum;
end;
$$;

-- Build history for a range of past days (run in chunks of about 15 days from the SQL editor).
create or replace function public.demo_backfill(p_pharmacy_id uuid, p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := p_from;
  v_days integer := 0;
begin
  perform demo_act_as(p_pharmacy_id);
  if p_to >= today_ke() then
    raise exception 'Back-fill stops at yesterday';
  end if;
  while d <= p_to loop
    if demo_post_day(p_pharmacy_id, d) > 0 then
      v_days := v_days + 1;
    end if;
    d := d + 1;
  end loop;
  perform demo_ensure_expiring(p_pharmacy_id);
  return v_days;
end;
$$;

-- ---------------------------------------------------------------------------
-- Set up a pharmacy as the demo: catalogue, customers, supplier, opening stock.
-- Safe to run twice (nothing is duplicated).
-- ---------------------------------------------------------------------------
create or replace function public.demo_enable(p_pharmacy_id uuid, p_start date default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := coalesce(p_start, today_ke() - 92);
  v_n integer;
begin
  if not exists (select 1 from pharmacies where id = p_pharmacy_id) then
    raise exception 'Pharmacy not found';
  end if;
  insert into demo_config (pharmacy_id) values (p_pharmacy_id) on conflict do nothing;
  perform demo_act_as(p_pharmacy_id);

  insert into drug_categories (pharmacy_id, name)
  select p_pharmacy_id, c from unnest(array['Analgesics/Antipyretics', 'Antacids/Anti-H-Pylori', 'Anti-DM',
    'Antibiotics/Antifungals/Amoebicides', 'Antiemetics/Laxatives', 'Antimalarials', 'Bronchodilators/Anti-Allergy',
    'Contraceptives', 'Eye/Ear Drops', 'Hypertensives/Convulsants', 'Injectables', 'Non-Pharmaceuticals', 'ORS',
    'Others', 'Powders/Creams', 'Supplements']) c
  on conflict (pharmacy_id, name) do nothing;

  insert into drugs (pharmacy_id, category_id, name, form, unit, reorder_level, default_price, is_prescription)
  select p_pharmacy_id, (select id from drug_categories where pharmacy_id = p_pharmacy_id and name = v.cat),
         v.name, v.form::drug_form, v.unit, v.reorder, v.price, v.rx
    from (values
      ('Paracetamol 500mg',              'tablet',         'tablet',  'Analgesics/Antipyretics',     200,   5, false),
      ('Panadol Extra',                  'tablet',         'tablet',  'Analgesics/Antipyretics',     150,  12, false),
      ('Ibuprofen 400mg',                'tablet',         'tablet',  'Analgesics/Antipyretics',     120,   8, false),
      ('Diclofenac 50mg',                'tablet',         'tablet',  'Analgesics/Antipyretics',     100,   8, false),
      ('Amoxicillin 500mg caps',         'capsule',        'capsule', 'Antibiotics/Antifungals/Amoebicides', 150, 25, true),
      ('Azithromycin 500mg',             'tablet',         'tablet',  'Antibiotics/Antifungals/Amoebicides',  24, 150, true),
      ('Ciprofloxacin 500mg',            'tablet',         'tablet',  'Antibiotics/Antifungals/Amoebicides',  60,  35, true),
      ('Metronidazole 400mg',            'tablet',         'tablet',  'Antibiotics/Antifungals/Amoebicides', 100,  10, false),
      ('Amoxicillin 125mg/5ml susp',     'syrup',          'bottle',  'Antibiotics/Antifungals/Amoebicides',  10, 350, true),
      ('Fluconazole 150mg',              'capsule',        'capsule', 'Antibiotics/Antifungals/Amoebicides',  20, 120, false),
      ('Coartem 80/480 (24 tabs)',       'tablet',         'pack',    'Antimalarials',                12, 350, false),
      ('Omeprazole 20mg',                'capsule',        'capsule', 'Antacids/Anti-H-Pylori',      100,  15, false),
      ('Magnesium trisilicate susp',     'syrup',          'bottle',  'Antacids/Anti-H-Pylori',       10, 180, false),
      ('Metformin 500mg',                'tablet',         'tablet',  'Anti-DM',                     150,   6, true),
      ('Amlodipine 5mg',                 'tablet',         'tablet',  'Hypertensives/Convulsants',   150,   8, true),
      ('Cetirizine 10mg',                'tablet',         'tablet',  'Bronchodilators/Anti-Allergy', 100, 10, false),
      ('Loratadine 10mg',                'tablet',         'tablet',  'Bronchodilators/Anti-Allergy',  60, 15, false),
      ('Salbutamol inhaler 100mcg',      'inhaler',        'inhaler', 'Bronchodilators/Anti-Allergy',   6, 450, false),
      ('Cough syrup 100ml',              'syrup',          'bottle',  'Bronchodilators/Anti-Allergy',   8, 450, false),
      ('ORS sachet',                     'other',          'sachet',  'ORS',                          60,  40, false),
      ('Zinc 20mg dispersible',          'tablet',         'tablet',  'ORS',                         100,  15, false),
      ('Vitamin C 500mg',                'tablet',         'tablet',  'Supplements',                 150,  10, false),
      ('Multivitamin',                   'tablet',         'tablet',  'Supplements',                 120,  15, false),
      ('Folic acid 5mg',                 'tablet',         'tablet',  'Supplements',                 150,   4, false),
      ('Hydrocortisone cream 1%',        'cream_ointment', 'tube',    'Powders/Creams',                8, 280, false),
      ('Clotrimazole cream 1%',          'cream_ointment', 'tube',    'Powders/Creams',               10, 220, false),
      ('Betadine solution 100ml',        'other',          'bottle',  'Others',                        8, 300, false),
      ('Chloramphenicol eye drops',      'drops',          'bottle',  'Eye/Ear Drops',                10, 180, false),
      ('Male condoms (3s)',              'other',          'pack',    'Contraceptives',               40, 100, false),
      ('Pregnancy test strip',           'other',          'piece',   'Contraceptives',               30, 100, false),
      ('Combined pill (1 cycle)',        'tablet',         'pack',    'Contraceptives',               20, 150, false),
      ('Digital thermometer',            'other',          'piece',   'Non-Pharmaceuticals',           5, 450, false),
      ('Surgical face mask',             'other',          'piece',   'Non-Pharmaceuticals',         100,  10, false),
      ('Hand sanitizer 100ml',           'other',          'bottle',  'Non-Pharmaceuticals',          10, 150, false),
      ('Plaster strip',                  'other',          'piece',   'Non-Pharmaceuticals',         100,  10, false),
      ('Gentamicin injection',           'injection',      'vial',    'Injectables',                  20,  80, true),
      ('Diclofenac injection 75mg',      'injection',      'ampoule', 'Injectables',                  20,  70, false),
      ('Loperamide 2mg',                 'capsule',        'capsule', 'Antiemetics/Laxatives',        60,  15, false),
      ('Promethazine 25mg',              'tablet',         'tablet',  'Antiemetics/Laxatives',        60,  12, false)
    ) as v(name, form, unit, cat, reorder, price, rx)
  on conflict (pharmacy_id, name) do nothing;

  insert into suppliers (pharmacy_id, name, phone)
  select p_pharmacy_id, 'MediSupply Distributors', '254722000111'
   where not exists (select 1 from suppliers where pharmacy_id = p_pharmacy_id and name = 'MediSupply Distributors');

  -- on-account customers; sms_ok = false so nothing is ever texted
  insert into customers (pharmacy_id, name, phone, credit_limit, sms_ok)
  select p_pharmacy_id, v.name, v.phone, v.lim, false
    from (values
      ('Wanjiku Kariuki',  '254712400101', 8000), ('James Odhiambo',   '254712400102', 10000),
      ('Amina Hassan',     '254712400103', 6000), ('Peter Mwangi',     '254712400104', 12000),
      ('Esther Chebet',    '254712400105', 5000), ('Joseph Kilonzo',   '254712400106', 8000),
      ('Lucy Njeri',       '254712400107', 6000), ('Samuel Kiptoo',    '254712400108', 15000),
      ('Rose Akinyi',      '254712400109', 7000), ('Hassan Abdi',      '254712400110', 9000),
      ('Catherine Wairimu','254712400111', 5000), ('Daniel Maina',     '254712400112', 10000)
    ) as v(name, phone, lim)
  on conflict do nothing;

  -- opening stock, dated at the start of the history
  select demo_restock_low(p_pharmacy_id, (v_start + time '07:00') at time zone 'Africa/Nairobi') into v_n;
  return 'Demo ready: ' || (select count(*) from drugs where pharmacy_id = p_pharmacy_id) || ' drugs, '
      || (select count(*) from customers where pharmacy_id = p_pharmacy_id) || ' customers, '
      || v_n || ' drugs stocked';
end;
$$;

-- ---------------------------------------------------------------------------
-- The hourly run. Does nothing before 08:00 Nairobi. Each run posts the sales
-- that "should have happened by now" in today's plan, restocks when something
-- runs low, and catches up (up to 14 days) if the project was ever asleep.
-- ---------------------------------------------------------------------------
create or replace function public.demo_tick()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  r record;
  v_today date := today_ke();
  v_hr numeric := extract(hour from now() at time zone 'Africa/Nairobi')
                + extract(minute from now() at time zone 'Africa/Nairobi') / 60.0;
  v_last date;
  d date;
  v_day date;
  v_target numeric;
  v_n integer;
  v_done integer;
  v_sum numeric;
  v_expected integer;
  v_budget numeric;
  v_posted integer := 0;
  v_total integer := 0;
begin
  if v_hr < 8 then
    return 0;
  end if;

  for c in
    select dc.pharmacy_id from demo_config dc
      join pharmacies p on p.id = dc.pharmacy_id
     where p.subscription_expires_at > now()
  loop
    begin   -- a problem with one demo pharmacy never stops the rest
      perform demo_act_as(c.pharmacy_id);
      select plan_day, plan_target, plan_sales, plan_done, plan_sum
        into v_day, v_target, v_n, v_done, v_sum
        from demo_config where pharmacy_id = c.pharmacy_id for update;

      if v_day is distinct from v_today then
        select max((sold_at at time zone 'Africa/Nairobi')::date) into v_last from sales where pharmacy_id = c.pharmacy_id;
        if v_last is not null then
          d := greatest(v_last + 1, v_today - 14);
          while d < v_today loop
            perform demo_post_day(c.pharmacy_id, d);
            d := d + 1;
          end loop;
        end if;
        select * into r from demo_new_plan(v_today);
        v_day := v_today; v_target := r.target; v_n := r.n; v_done := 0; v_sum := 0;
        perform demo_restock_low(c.pharmacy_id);
        perform demo_ensure_expiring(c.pharmacy_id);
        perform demo_pay_customers(c.pharmacy_id);
        perform demo_post_expenses(c.pharmacy_id, v_today);
      end if;

      v_expected := least(v_n, ceil(v_n * least(1, (v_hr - 8) / 11.5))::int);
      v_posted := 0;
      while v_done < v_expected loop
        v_done := v_done + 1;
        if v_done = v_n then
          v_budget := v_target - v_sum;
        else
          v_budget := least(v_target / v_n * (0.5 + random()), greatest(0, v_target - v_sum));
        end if;
        v_sum := v_sum + demo_post_sale(c.pharmacy_id, v_budget);
        v_posted := v_posted + 1;
      end loop;

      if v_done >= v_n and v_sum < 2050 then
        v_sum := v_sum + demo_post_sale(c.pharmacy_id, 2150 - v_sum);
        v_posted := v_posted + 1;
      end if;
      if v_posted > 0 then
        perform demo_restock_low(c.pharmacy_id);
      end if;

      update demo_config
         set plan_day = v_day, plan_target = v_target, plan_sales = v_n,
             plan_done = v_done, plan_sum = v_sum, last_tick = now()
       where pharmacy_id = c.pharmacy_id;
      v_total := v_total + v_posted;
    exception when others then
      raise warning 'demo_tick failed for %: %', c.pharmacy_id, sqlerrm;
    end;
  end loop;
  return v_total;
end;
$$;

-- Nobody signed in to the app (or the public API) may run these; only the
-- database's own scheduler and the project owner (SQL editor).
revoke all on function public.demo_act_as(uuid) from public, anon, authenticated;
revoke all on function public.demo_restock_low(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.demo_ensure_expiring(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.demo_post_sale(uuid, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.demo_new_plan(date) from public, anon, authenticated;
revoke all on function public.demo_pay_customers(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.demo_post_expenses(uuid, date) from public, anon, authenticated;
revoke all on function public.demo_post_day(uuid, date) from public, anon, authenticated;
revoke all on function public.demo_backfill(uuid, date, date) from public, anon, authenticated;
revoke all on function public.demo_enable(uuid, date) from public, anon, authenticated;
revoke all on function public.demo_tick() from public, anon, authenticated;

-- Hourly from 08:05 to 20:05 Nairobi (05 to 17 UTC), when pg_cron is available.
-- Wrapped so the same file also loads on a plain local Postgres (used by the tests).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'pharma-demo-tick';
    perform cron.schedule('pharma-demo-tick', '5 5-17 * * *', 'select public.demo_tick()');
  end if;
end
$$;
