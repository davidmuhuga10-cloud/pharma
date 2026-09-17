-- ============================================================================
-- HODHI — Pharmacy stock & sales system (v2)
-- Multi-tenant schema: every pharmacy's data is isolated by pharmacy_id +
-- Row Level Security, same pattern used in Kodi and Shule.
-- Run this once, in order, against a fresh Supabase project.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CORE TENANT TABLES
-- ----------------------------------------------------------------------------

create table pharmacies (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone             text,
  town              text,
  address           text,       -- full postal/physical address, printed on reports & receipts
  email             text,
  kra_pin           text,       -- for eTIMS-ready invoices later
  currency          text not null default 'KES',
  low_stock_default integer not null default 5,        -- default reorder threshold for new drugs
  expiry_warn_days  integer not null default 90,        -- "expiring soon" window, configurable
  vat_rate          numeric(5,2) not null default 16.00,
  next_invoice_no   integer not null default 1,          -- atomically incremented per sale -> INV-000001, ...
  created_at        timestamptz not null default now()
);

create type user_role as enum ('owner', 'pharmacist', 'attendant');

-- One row per auth.users id — extends Supabase auth with pharmacy + role.
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  full_name     text,
  phone         text,
  role          user_role not null default 'attendant',
  language      text not null default 'en',              -- 'en' | 'sw' — UI language
  active        boolean not null default true,            -- owner can deactivate a staff account without deleting it
  created_at    timestamptz not null default now()
);

create index on profiles (pharmacy_id);

-- Helper used by every RLS policy below: the caller's own pharmacy_id.
create or replace function my_pharmacy_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select pharmacy_id from profiles where id = auth.uid();
$$;

create or replace function my_role()
returns user_role
language sql stable security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- 2. CATALOGUE: categories, drugs, suppliers, batches
-- ----------------------------------------------------------------------------

create type drug_form as enum (
  'tablet', 'capsule', 'syrup', 'injection', 'cream_ointment',
  'drops', 'suppository', 'inhaler', 'iv_fluid', 'other'
);

create table drug_categories (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  name          text not null,          -- e.g. "Antibiotics/Antifungals/Amoebicides"
  created_at    timestamptz not null default now(),
  unique (pharmacy_id, name)
);

create table drugs (
  id              uuid primary key default gen_random_uuid(),
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  category_id     uuid references drug_categories(id) on delete set null,
  name            text not null,               -- e.g. "Amoxiclav 228 susp"
  form            drug_form not null default 'other',
  unit            text not null default 'unit', -- "tablet", "bottle", "vial", "tube"
  reorder_level   integer not null default 5,    -- below this = "low stock"
  default_price   numeric(10,2),                 -- current retail price (latest batch overrides per-sale)
  is_prescription boolean not null default false,
  pack_size       integer,                       -- e.g. 100 tablets per box, for restock convenience
  pack_label      text,                          -- e.g. "box of 100"
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (pharmacy_id, name)
);

create index on drugs (pharmacy_id);
create index on drugs (pharmacy_id, active);
create index drugs_category_id_idx on drugs (category_id);

-- Suppliers a pharmacy restocks from — used for the supplier autocomplete on
-- restock and the "reorder list" export/print.
create table suppliers (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  name          text not null,
  phone         text,
  email         text,
  address       text,
  created_at    timestamptz not null default now()
);

-- Every restock creates a new batch. Stock lives here, never as one running
-- number on `drugs` — this is what makes FEFO and per-batch expiry possible.
create table batches (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  drug_id             uuid not null references drugs(id) on delete cascade,
  batch_no            text,
  supplier            text,                                       -- free-text fallback if no supplier_id
  supplier_id         uuid references suppliers(id) on delete set null,
  quantity_received   integer not null check (quantity_received >= 0),
  quantity_remaining  integer not null check (quantity_remaining >= 0),
  cost_price          numeric(10,2),
  sell_price          numeric(10,2) not null,
  discount_percent    numeric(5,2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  expiry_date         date not null,
  received_at         date not null default current_date,
  created_by          uuid references profiles(id),
  created_at          timestamptz not null default now()
);

create index on batches (pharmacy_id);
create index on batches (drug_id, expiry_date);          -- FEFO ordering
create index on batches (pharmacy_id, expiry_date) where quantity_remaining > 0;
create index batches_created_by_idx on batches (created_by);
create index batches_supplier_id_idx on batches (supplier_id);

-- ----------------------------------------------------------------------------
-- 3. SALES — split payments, held sales, returns/voids, insurance claims
-- ----------------------------------------------------------------------------

create type payment_method as enum ('cash', 'mpesa', 'insurance', 'bank', 'other', 'split');

create table sales (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references pharmacies(id) on delete cascade,
  sale_no          bigint generated always as identity,   -- human-friendly running number
  sold_at          timestamptz not null default now(),
  payment_method   payment_method not null default 'cash', -- single method, or 'split' when sales_payments has >1 row
  customer_name    text,
  mpesa_code       text,                                    -- legacy single-reference column; sales_payments.reference is now the source of truth
  insurance_scheme text,                                     -- e.g. "SHA", or a private scheme name
  invoice_number   text,                                     -- "INV-000001", sequential per pharmacy via next_invoice_no
  subtotal         numeric(10,2) not null default 0,
  vat_amount       numeric(10,2) not null default 0,
  total_amount     numeric(10,2) not null default 0,
  etims_status     text not null default 'not_submitted',    -- placeholder for future KRA eTIMS integration
  voided           boolean not null default false,
  voided_at        timestamptz,
  void_reason      text,
  created_by       uuid references profiles(id),
  created_at       timestamptz not null default now()
);

create index on sales (pharmacy_id, sold_at desc);
create index sales_created_by_idx on sales (created_by);

create table sale_items (
  id              uuid primary key default gen_random_uuid(),
  sale_id         uuid not null references sales(id) on delete cascade,
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  drug_id         uuid not null references drugs(id),
  batch_id        uuid not null references batches(id),
  quantity        integer not null check (quantity > 0),
  unit_price      numeric(10,2) not null,
  line_total      numeric(10,2) not null,
  patient_name    text,      -- captured for prescription-only drugs
  prescriber_name text
);

create index sale_items_sale_id_idx on sale_items (sale_id);
create index on sale_items (pharmacy_id, drug_id);
create index sale_items_batch_id_idx on sale_items (batch_id);
create index sale_items_drug_id_idx on sale_items (drug_id);

-- One or more payment lines per sale — supports splitting a single sale
-- across cash + M-Pesa + insurance, each with its own reference/amount.
create table sales_payments (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references sales(id) on delete cascade,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  method      payment_method not null,
  amount      numeric(10,2) not null check (amount > 0),
  reference   text            -- M-Pesa code, insurance member/scheme note, bank slip no., etc.
);

create index sales_payments_sale_id_idx on sales_payments (sale_id);

-- Held/parked sales — a cart saved mid-transaction (customer stepped away,
-- waiting on cash) and resumed later, without touching stock until checkout.
create table held_sales (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  label       text,
  cart        jsonb not null,          -- the STATE.cart array as-is
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create index held_sales_created_by_idx on held_sales (created_by);

-- Item-level returns against a completed sale — restores stock and records
-- a refund amount without needing to void the whole sale.
create table returns (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  sale_item_id  uuid not null references sale_items(id),
  drug_id       uuid not null references drugs(id),
  batch_id      uuid not null references batches(id),
  quantity      integer not null check (quantity > 0),
  reason        text,
  refund_amount numeric(10,2) not null default 0,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

create index returns_batch_id_idx on returns (batch_id);
create index returns_created_by_idx on returns (created_by);
create index returns_drug_id_idx on returns (drug_id);
create index returns_sale_item_id_idx on returns (sale_item_id);

-- Insurance claims — created client-side at checkout whenever a payment
-- line uses method = 'insurance'; tracked here through submitted/paid/rejected.
create table insurance_claims (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  sale_id      uuid not null references sales(id),
  scheme       text not null,
  claim_number text,
  amount       numeric(10,2) not null,
  status       text not null default 'pending',   -- pending | submitted | paid | rejected
  notes        text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index insurance_claims_created_by_idx on insurance_claims (created_by);
create index insurance_claims_sale_id_idx on insurance_claims (sale_id);

-- Staff invites — an owner generates a short code for a role; the invitee
-- signs up and calls join_pharmacy_with_code() instead of bootstrap_pharmacy().
create table staff_invites (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  code        text not null unique,
  role        user_role not null default 'attendant',
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  used_by     uuid references profiles(id),
  used_at     timestamptz
);

create index staff_invites_created_by_idx on staff_invites (created_by);
create index staff_invites_used_by_idx on staff_invites (used_by);

-- ----------------------------------------------------------------------------
-- 4. STOCK MOVEMENTS (the audit trail PPB's GSDP inspections want to see)
-- ----------------------------------------------------------------------------

create type adjustment_type as enum (
  'restock', 'correction', 'write_off', 'expired_disposal', 'sale', 'return', 'void'
);

create table stock_adjustments (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  drug_id        uuid not null references drugs(id),
  batch_id       uuid references batches(id),
  type           adjustment_type not null,
  quantity_delta integer not null,       -- positive for restock/return/void, negative for sale/write-off
  reason         text,
  ref_sale_id    uuid references sales(id),
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);

create index on stock_adjustments (pharmacy_id, created_at desc);
create index on stock_adjustments (drug_id);
create index stock_adjustments_batch_id_idx on stock_adjustments (batch_id);
create index stock_adjustments_created_by_idx on stock_adjustments (created_by);
create index stock_adjustments_ref_sale_id_idx on stock_adjustments (ref_sale_id);

-- ----------------------------------------------------------------------------
-- 5. VIEWS — the "distinguish" asks (out of stock, low stock, expiring soon)
-- ----------------------------------------------------------------------------

-- Live stock per drug: total remaining across all non-expired batches.
create view v_drug_stock with (security_invoker = true) as
select
  d.id as drug_id,
  d.pharmacy_id,
  d.name,
  d.unit,
  d.reorder_level,
  d.default_price,
  d.is_prescription,
  d.pack_size,
  d.pack_label,
  coalesce(sum(b.quantity_remaining) filter (where b.expiry_date >= current_date), 0::bigint) as qty_in_stock,
  coalesce(sum(b.quantity_remaining) filter (where b.expiry_date < current_date), 0::bigint) as qty_expired,
  min(b.expiry_date) filter (where b.quantity_remaining > 0 and b.expiry_date >= current_date) as soonest_expiry,
  coalesce(sum(b.quantity_remaining::numeric * b.cost_price) filter (where b.expiry_date >= current_date), 0::numeric) as stock_value_cost,
  coalesce(sum(b.quantity_remaining::numeric * b.sell_price) filter (where b.expiry_date >= current_date), 0::numeric) as stock_value_retail
from drugs d
left join batches b on b.drug_id = d.id
where d.active
group by d.id;

-- Batches expiring within each pharmacy's configured warning window.
create view v_expiring_batches with (security_invoker = true) as
select
  b.*,
  d.name as drug_name,
  d.unit,
  p.expiry_warn_days,
  (b.expiry_date - current_date) as days_to_expiry
from batches b
join drugs d on d.id = b.drug_id
join pharmacies p on p.id = b.pharmacy_id
where b.quantity_remaining > 0
  and b.expiry_date >= current_date
  and b.expiry_date <= current_date + (p.expiry_warn_days || ' days')::interval;

-- Out-of-stock drugs (zero live stock, still active).
create view v_out_of_stock with (security_invoker = true) as
select drug_id, pharmacy_id, name, unit, reorder_level, default_price, is_prescription, pack_size, pack_label,
       qty_in_stock, qty_expired, soonest_expiry, stock_value_cost, stock_value_retail
from v_drug_stock
where qty_in_stock = 0;

-- Low-stock drugs (below reorder level, but not zero).
create view v_low_stock with (security_invoker = true) as
select drug_id, pharmacy_id, name, unit, reorder_level, default_price, is_prescription, pack_size, pack_label,
       qty_in_stock, qty_expired, soonest_expiry, stock_value_cost, stock_value_retail
from v_drug_stock
where qty_in_stock > 0 and qty_in_stock <= reorder_level;

-- Slow movers: active drugs with stock but no sale in the last 60 days.
create view v_slow_movers with (security_invoker = true) as
select drug_id, pharmacy_id, name, unit, reorder_level, default_price, is_prescription, pack_size, pack_label,
       qty_in_stock, qty_expired, soonest_expiry, stock_value_cost, stock_value_retail
from v_drug_stock s
where qty_in_stock > 0
  and not exists (
    select 1 from sale_items si join sales sa on sa.id = si.sale_id
    where si.drug_id = s.drug_id and sa.sold_at >= now() - interval '60 days'
  );

-- ----------------------------------------------------------------------------
-- 6. RECORD A SALE ATOMICALLY, FEFO (first-expiry-first-out)
-- ----------------------------------------------------------------------------
-- p_items: jsonb array of {drug_id, quantity, patient_name?, prescriber_name?}
-- p_payments: jsonb array of {method, amount, reference?} — one or more lines
--   that must sum exactly to the sale subtotal (split payments supported).
-- Deducts from whichever batch of that drug expires soonest first, splitting
-- across batches if one batch doesn't have enough left, and applies any
-- per-batch markdown (batches.discount_percent) automatically. Raises an
-- exception (and rolls back the whole sale) if stock is short or payments
-- don't add up.

create or replace function record_sale(
  p_pharmacy_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_insurance_scheme text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_drug_id uuid;
  v_qty_needed integer;
  v_qty_remaining_to_fill integer;
  v_batch record;
  v_take integer;
  v_effective_price numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_line_total numeric(10,2);
  v_vat_rate numeric(5,2);
  v_payments_total numeric(10,2) := 0;
  v_method_count integer;
  v_first_method payment_method;
  v_invoice_seq integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if jsonb_array_length(p_payments) = 0 then
    raise exception 'A sale needs at least one payment';
  end if;

  select vat_rate into v_vat_rate from pharmacies where id = p_pharmacy_id;

  update pharmacies set next_invoice_no = next_invoice_no + 1
  where id = p_pharmacy_id
  returning next_invoice_no - 1 into v_invoice_seq;

  insert into sales (pharmacy_id, payment_method, customer_name, insurance_scheme, invoice_number, created_by)
  values (p_pharmacy_id, 'cash', p_customer_name, p_insurance_scheme, 'INV-' || lpad(v_invoice_seq::text, 6, '0'), auth.uid())
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty_needed := (v_item->>'quantity')::integer;
    v_qty_remaining_to_fill := v_qty_needed;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc
      for update
    loop
      exit when v_qty_remaining_to_fill <= 0;
      v_take := least(v_batch.quantity_remaining, v_qty_remaining_to_fill);
      v_effective_price := round(v_batch.sell_price * (1 - v_batch.discount_percent / 100.0), 2);

      update batches set quantity_remaining = quantity_remaining - v_take where id = v_batch.id;

      v_line_total := round(v_take * v_effective_price, 2);
      v_subtotal := v_subtotal + v_line_total;

      insert into sale_items (sale_id, pharmacy_id, drug_id, batch_id, quantity, unit_price, line_total, patient_name, prescriber_name)
      values (v_sale_id, p_pharmacy_id, v_drug_id, v_batch.id, v_take, v_effective_price, v_line_total,
              v_item->>'patient_name', v_item->>'prescriber_name');

      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, ref_sale_id, created_by)
      values (p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take, v_sale_id, auth.uid());

      v_qty_remaining_to_fill := v_qty_remaining_to_fill - v_take;
    end loop;

    if v_qty_remaining_to_fill > 0 then
      raise exception 'Not enough stock for drug %: short by %', v_drug_id, v_qty_remaining_to_fill;
    end if;
  end loop;

  if abs(v_subtotal) < 0.01 then
    raise exception 'Sale total is zero';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_payments_total := v_payments_total + (v_payment->>'amount')::numeric;
    insert into sales_payments (sale_id, pharmacy_id, method, amount, reference)
    values (v_sale_id, p_pharmacy_id, (v_payment->>'method')::payment_method, (v_payment->>'amount')::numeric, v_payment->>'reference');
  end loop;

  if abs(v_payments_total - v_subtotal) > 0.01 then
    raise exception 'Payments (%) do not add up to the sale total (%)', v_payments_total, v_subtotal;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id limit 1;

  update sales
  set subtotal = v_subtotal,
      vat_amount = round(v_subtotal * v_vat_rate / (100 + v_vat_rate), 2),  -- VAT-inclusive pricing assumed
      total_amount = v_subtotal,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end
  where id = v_sale_id;

  return v_sale_id;
end;
$$;

-- Return part (or all) of one sale line — restores stock to its original
-- batch and logs a refund amount. Does not touch the rest of the sale.
create or replace function record_return(
  p_pharmacy_id uuid,
  p_sale_item_id uuid,
  p_quantity integer,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_refund numeric(10,2);
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;

  select * into v_item from sale_items where id = p_sale_item_id and pharmacy_id = p_pharmacy_id;
  if v_item is null then
    raise exception 'Sale item not found';
  end if;
  if p_quantity > v_item.quantity then
    raise exception 'Cannot return more than was sold (%).', v_item.quantity;
  end if;

  v_refund := round(p_quantity * v_item.unit_price, 2);

  update batches set quantity_remaining = quantity_remaining + p_quantity where id = v_item.batch_id;

  insert into returns (pharmacy_id, sale_item_id, drug_id, batch_id, quantity, reason, refund_amount, created_by)
  values (p_pharmacy_id, p_sale_item_id, v_item.drug_id, v_item.batch_id, p_quantity, p_reason, v_refund, auth.uid());

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'return', p_quantity, p_reason, auth.uid());
end;
$$;

-- Void an entire sale — restores all sold stock. Refused once any return
-- has been recorded against the sale (return the remaining items instead),
-- to prevent double-crediting stock that was already returned.
create or replace function void_sale(
  p_pharmacy_id uuid,
  p_sale_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_already_voided boolean;
  v_has_returns boolean;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;

  select voided into v_already_voided from sales where id = p_sale_id and pharmacy_id = p_pharmacy_id;
  if v_already_voided is null then
    raise exception 'Sale not found';
  end if;
  if v_already_voided then
    raise exception 'This sale is already voided';
  end if;

  select exists (
    select 1 from returns r join sale_items si on si.id = r.sale_item_id
    where si.sale_id = p_sale_id
  ) into v_has_returns;
  if v_has_returns then
    raise exception 'This sale already has a return recorded against it — void the remaining items individually via returns instead of voiding the whole sale';
  end if;

  for v_item in select * from sale_items where sale_id = p_sale_id loop
    update batches set quantity_remaining = quantity_remaining + v_item.quantity where id = v_item.batch_id;
    insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, ref_sale_id, created_by)
    values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'void', v_item.quantity, p_reason, p_sale_id, auth.uid());
  end loop;

  update sales set voided = true, voided_at = now(), void_reason = p_reason where id = p_sale_id;
end;
$$;

-- Restock: adds a new batch and logs the movement in one call.
create or replace function record_restock(
  p_pharmacy_id uuid,
  p_drug_id uuid,
  p_quantity integer,
  p_cost_price numeric,
  p_sell_price numeric,
  p_expiry_date date,
  p_batch_no text default null,
  p_supplier text default null,
  p_supplier_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;

  insert into batches (pharmacy_id, drug_id, batch_no, supplier, supplier_id, quantity_received,
                        quantity_remaining, cost_price, sell_price, expiry_date, created_by)
  values (p_pharmacy_id, p_drug_id, p_batch_no, p_supplier, p_supplier_id, p_quantity,
          p_quantity, p_cost_price, p_sell_price, p_expiry_date, auth.uid())
  returning id into v_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, created_by)
  values (p_pharmacy_id, p_drug_id, v_batch_id, 'restock', p_quantity, auth.uid());

  update drugs set default_price = p_sell_price where id = p_drug_id;

  return v_batch_id;
end;
$$;

-- Correct a batch's counted quantity to a known value (stock-take reconciliation).
create or replace function record_correction(
  p_pharmacy_id uuid,
  p_batch_id uuid,
  p_new_quantity integer,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug_id uuid;
  v_old_qty integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if p_new_quantity < 0 then
    raise exception 'Quantity cannot be negative';
  end if;

  select drug_id, quantity_remaining into v_drug_id, v_old_qty
  from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id
  for update;

  if v_drug_id is null then
    raise exception 'Batch not found';
  end if;

  update batches set quantity_remaining = p_new_quantity where id = p_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_drug_id, p_batch_id, 'correction', p_new_quantity - v_old_qty, p_reason, auth.uid());
end;
$$;

-- Write off stock (damaged/expired) — reduces a batch, never fabricates loss.
create or replace function record_write_off(
  p_pharmacy_id uuid,
  p_batch_id uuid,
  p_quantity integer,
  p_reason text,
  p_type adjustment_type default 'write_off'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug_id uuid;
  v_remaining integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if p_type not in ('write_off', 'expired_disposal') then
    raise exception 'Invalid write-off type';
  end if;

  select drug_id, quantity_remaining into v_drug_id, v_remaining
  from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id
  for update;

  if v_drug_id is null then
    raise exception 'Batch not found';
  end if;
  if p_quantity > v_remaining then
    raise exception 'Only % left in this batch', v_remaining;
  end if;

  update batches set quantity_remaining = quantity_remaining - p_quantity where id = p_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_drug_id, p_batch_id, p_type, -p_quantity, p_reason, auth.uid());
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. PHARMACY SIGNUP & STAFF ACCESS CONTROL
-- ----------------------------------------------------------------------------
-- Called right after a new auth user signs up: creates their pharmacy, makes
-- them the owner, and seeds the therapeutic categories seen in real
-- stock-take sheets so a new pharmacy isn't starting from a blank list.

create or replace function bootstrap_pharmacy(p_name text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pharmacy_id uuid;
  v_cat text;
begin
  insert into pharmacies (name, phone) values (p_name, p_phone) returning id into v_pharmacy_id;

  insert into profiles (id, pharmacy_id, full_name, phone, role)
  values (auth.uid(), v_pharmacy_id, p_full_name, p_phone, 'owner');

  foreach v_cat in array array[
    'Analgesics/Antipyretics', 'Antibiotics/Antifungals/Amoebicides',
    'Bronchodilators/Anti-Allergy', 'Antacids/Anti-H-Pylori', 'Antimalarials',
    'Anti-DM', 'Hypertensives/Convulsants', 'Antiemetics/Laxatives',
    'Contraceptives', 'Supplements', 'Eye/Ear Drops', 'ORS',
    'Injectables', 'Powders/Creams', 'Non-Pharmaceuticals', 'Others'
  ] loop
    insert into drug_categories (pharmacy_id, name) values (v_pharmacy_id, v_cat);
  end loop;

  return v_pharmacy_id;
end;
$$;

-- In-app access control instead of a separate admin system: the owner
-- generates a short-lived invite code for a role, and the staff member
-- signs up and redeems it themselves — no separate admin UI needed.
create or replace function create_staff_invite(p_pharmacy_id uuid, p_role user_role)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() or my_role() <> 'owner' then
    raise exception 'Only the pharmacy owner can invite staff';
  end if;
  if p_role = 'owner' then
    raise exception 'Cannot invite another owner';
  end if;

  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));

  insert into staff_invites (pharmacy_id, code, role, created_by)
  values (p_pharmacy_id, v_code, p_role, auth.uid());

  return v_code;
end;
$$;

create or replace function join_pharmacy_with_code(p_code text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
begin
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;

  select * into v_invite from staff_invites
  where code = upper(p_code) and used_at is null and expires_at > now()
  for update;

  if v_invite is null then
    raise exception 'Invalid or expired invite code';
  end if;

  insert into profiles (id, pharmacy_id, full_name, phone, role)
  values (auth.uid(), v_invite.pharmacy_id, p_full_name, p_phone, v_invite.role);

  update staff_invites set used_by = auth.uid(), used_at = now() where id = v_invite.id;

  return v_invite.pharmacy_id;
end;
$$;

-- RLS row policies cannot restrict which COLUMNS a user changes on a row
-- they're allowed to update — without this trigger, a staff member (even one
-- just deactivated by the owner) could run `update profiles set role='owner'`
-- on their own row and fully escalate themselves. This closes that gap.
create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.pharmacy_id is distinct from old.pharmacy_id) then
    if my_role() is distinct from 'owner' then
      raise exception 'Only the pharmacy owner can change role or active status';
    end if;
    if new.pharmacy_id is distinct from old.pharmacy_id then
      raise exception 'A profile cannot be moved to a different pharmacy';
    end if;
    if new.role = 'owner' and old.role is distinct from 'owner' then
      raise exception 'Cannot promote a staff member to owner';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_guard_privileged_fields
  before update on profiles
  for each row execute function prevent_profile_privilege_escalation();

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table pharmacies enable row level security;
alter table profiles enable row level security;
alter table drug_categories enable row level security;
alter table drugs enable row level security;
alter table suppliers enable row level security;
alter table batches enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table sales_payments enable row level security;
alter table held_sales enable row level security;
alter table returns enable row level security;
alter table insurance_claims enable row level security;
alter table staff_invites enable row level security;
alter table stock_adjustments enable row level security;

create policy "own pharmacy read" on pharmacies for select using (id = my_pharmacy_id());
create policy "owner updates own pharmacy" on pharmacies for update using (id = my_pharmacy_id() and my_role() = 'owner');

create policy "read colleagues in same pharmacy" on profiles for select using (pharmacy_id = my_pharmacy_id());
-- A user can always update their own row (e.g. language preference), and an
-- owner can update any staff row in their pharmacy (role/active/etc) — the
-- trigger above still stops both paths from touching role/active/pharmacy_id
-- unless the caller really is the owner.
create policy "update own profile or staff as owner" on profiles
  for update
  using (id = (select auth.uid()) or (pharmacy_id = my_pharmacy_id() and my_role() = 'owner'));

create policy "tenant read categories" on drug_categories for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant read drugs" on drugs for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all suppliers" on suppliers for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant read batches" on batches for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant read sales" on sales for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant read sale_items" on sale_items for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all sales_payments" on sales_payments for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all held_sales" on held_sales for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all returns" on returns for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all insurance_claims" on insurance_claims for all using (pharmacy_id = my_pharmacy_id());
create policy "owner manage invites" on staff_invites for all using (pharmacy_id = my_pharmacy_id() and my_role() = 'owner');
create policy "tenant read stock_adjustments" on stock_adjustments for all using (pharmacy_id = my_pharmacy_id());

-- Every view above is created with security_invoker = true, so it enforces
-- RLS as the querying user rather than as the view's (privileged) owner.

-- ----------------------------------------------------------------------------
-- 9. GRANTS
-- ----------------------------------------------------------------------------
-- RLS policies only restrict which ROWS are visible — Postgres also requires
-- a base table/view GRANT before the `authenticated` role can touch a table
-- at all. Missing this would make every request fail outright regardless of
-- how correct the RLS policies above are.

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on sequences to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;
