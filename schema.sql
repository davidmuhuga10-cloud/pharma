-- ============================================================================
-- PHARMA — Pharmacy stock & sales system (v2, renamed from "Hodhi")
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

-- Shared, read-only reference catalog (not tenant-scoped — no pharmacy_id)
-- of the most commonly sold items in a Kenyan chemist/pharmacy, grouped by
-- the same 16 categories bootstrap_pharmacy() seeds for every new signup.
-- Powers the "Sync common drugs" fast-onboarding flow (see
-- sync_master_drugs below): a pharmacy browses/searches this list and picks
-- the ones it actually stocks, entering its own quantity/price/reorder
-- level/expiry per item — this table only supplies the name/form/unit/
-- category/prescription-status starting point, never a price or quantity.
-- Content sourced from a real pharmacy's stock-take sheet; form/unit are a
-- best-effort default a pharmacy can freely override once the drug exists
-- in their own `drugs` table. Read-only for tenants by design: RLS is
-- enabled with a SELECT-only policy below, so only a migration (running as
-- the table owner) can add to or change it.
create table master_drugs (
  id              uuid primary key default gen_random_uuid(),
  category_name   text not null,     -- matches drug_categories.name for the 16 seeded categories
  name            text not null,
  form            drug_form not null default 'other',
  unit            text not null default 'unit',
  is_prescription boolean not null default false,
  sort_order      integer not null default 0,   -- display order within its category
  created_at      timestamptz not null default now()
);

create index master_drugs_category_idx on master_drugs (category_name, sort_order);

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
  expiry_unknown      boolean not null default false,  -- true = expiry_date is a placeholder (see sync_master_drugs), not a real date; display "unknown", never the placeholder date itself
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
  coalesce(sum(b.quantity_remaining::numeric * b.sell_price) filter (where b.expiry_date >= current_date), 0::numeric) as stock_value_retail,
  -- Added this session (item 26): true when this drug has stock sitting in
  -- a batch whose expiry is a placeholder, not a real date (expiry_unknown
  -- — set by "Sync common drugs", a supplier LPO marked unknown, or now an
  -- Excel import row with no expiry column filled in). Backs the Inventory
  -- "no expiry date set" notice so a pharmacist can find and fix these
  -- without opening every drug one by one.
  coalesce(bool_or(b.expiry_unknown) filter (where b.quantity_remaining > 0), false) as has_unknown_expiry
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
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a return';
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
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can void a sale';
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
-- A single function, not an overload: p_expiry_unknown was briefly added as
-- a *second*, separate overload of record_restock instead of extending this
-- one, which made every normal call from the app ambiguous (Supabase/
-- PostgREST calls RPCs with named parameters, and Postgres could not choose
-- between "the 9-arg version, matched exactly" and "the 10-arg version,
-- with p_expiry_unknown filled from its default" — it raised "function
-- record_restock(...) is not unique" and refused the call, almost
-- certainly the real cause of the RAFIKI PHARMACY stalled import earlier
-- this session). That overload was also missing the role check below
-- entirely. Both are fixed by keeping exactly one function with a
-- defaulted last arg.
create or replace function record_restock(
  p_pharmacy_id uuid,
  p_drug_id uuid,
  p_quantity integer,
  p_cost_price numeric,
  p_sell_price numeric,
  p_expiry_date date,
  p_batch_no text default null,
  p_supplier text default null,
  p_supplier_id uuid default null,
  p_expiry_unknown boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_expiry date;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can restock';
  end if;

  if p_expiry_unknown then
    v_expiry := (current_date + interval '3 years')::date;
  else
    if p_expiry_date is null then
      raise exception 'Expiry date is required unless expiry is marked unknown';
    end if;
    v_expiry := p_expiry_date;
  end if;

  insert into batches (pharmacy_id, drug_id, batch_no, supplier, supplier_id, quantity_received,
                        quantity_remaining, cost_price, sell_price, expiry_date, expiry_unknown, created_by)
  values (p_pharmacy_id, p_drug_id, p_batch_no, p_supplier, p_supplier_id, p_quantity,
          p_quantity, p_cost_price, p_sell_price, v_expiry, p_expiry_unknown, auth.uid())
  returning id into v_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, created_by)
  values (p_pharmacy_id, p_drug_id, v_batch_id, 'restock', p_quantity, auth.uid());

  update drugs set default_price = p_sell_price where id = p_drug_id;

  return v_batch_id;
end;
$$;

-- Fast onboarding: sync a batch of drugs picked from the shared master
-- catalog (see `master_drugs` above) in one call, instead of adding and
-- restocking each one by hand. Same authorization tier as record_restock
-- (owner/pharmacist), and functionally *is* a restock per item — it just
-- also creates the `drugs` row first when the pharmacy doesn't already
-- have one by that name.
--
-- p_items: jsonb array of
--   { master_drug_id, quantity, sell_price, reorder_level?, cost_price?, expiry_date? }
-- reorder_level defaults to the pharmacy's low_stock_default; expiry_date is
-- optional — when omitted the batch gets a placeholder date 3 years out
-- with expiry_unknown = true, so it never appears in "expiring soon" and
-- never wins a FEFO draw against a batch with a real, nearer expiry. The
-- app displays that as "no expiry recorded", never the placeholder date.
--
-- If the pharmacy already has a drug with this exact name (e.g. added by
-- hand, or synced before), reuses that drug and just adds a new batch —
-- never overwrites its category/form/unit/reorder level, only refreshes
-- default_price the same way any restock does.
create or replace function sync_master_drugs(
  p_pharmacy_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_master record;
  v_drug_id uuid;
  v_category_id uuid;
  v_batch_id uuid;
  v_quantity integer;
  v_sell_price numeric(10,2);
  v_cost_price numeric(10,2);
  v_reorder_level integer;
  v_expiry_date date;
  v_expiry_unknown boolean;
  v_default_reorder integer;
  v_results jsonb := '[]'::jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can sync drugs';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one drug to sync';
  end if;

  select low_stock_default into v_default_reorder from pharmacies where id = p_pharmacy_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_master from master_drugs where id = (v_item->>'master_drug_id')::uuid;
    if v_master is null then
      raise exception 'Unknown master drug: %', v_item->>'master_drug_id';
    end if;

    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Enter a valid quantity for %', v_master.name;
    end if;

    v_sell_price := nullif(v_item->>'sell_price', '')::numeric;
    if v_sell_price is null or v_sell_price <= 0 then
      raise exception 'Enter a selling price for %', v_master.name;
    end if;

    v_cost_price := nullif(v_item->>'cost_price', '')::numeric;
    v_reorder_level := coalesce(nullif(v_item->>'reorder_level', '')::integer, v_default_reorder, 5);

    if coalesce(v_item->>'expiry_date', '') <> '' then
      v_expiry_date := (v_item->>'expiry_date')::date;
      v_expiry_unknown := false;
    else
      v_expiry_date := (current_date + interval '3 years')::date;
      v_expiry_unknown := true;
    end if;

    select id into v_drug_id from drugs where pharmacy_id = p_pharmacy_id and name = v_master.name;

    if v_drug_id is null then
      select id into v_category_id from drug_categories
      where pharmacy_id = p_pharmacy_id and name = v_master.category_name;
      if v_category_id is null then
        insert into drug_categories (pharmacy_id, name) values (p_pharmacy_id, v_master.category_name)
        returning id into v_category_id;
      end if;

      insert into drugs (pharmacy_id, category_id, name, form, unit, reorder_level, default_price, is_prescription)
      values (p_pharmacy_id, v_category_id, v_master.name, v_master.form, v_master.unit, v_reorder_level, v_sell_price, v_master.is_prescription)
      returning id into v_drug_id;
    else
      update drugs set default_price = v_sell_price where id = v_drug_id;
    end if;

    insert into batches (pharmacy_id, drug_id, quantity_received, quantity_remaining, cost_price, sell_price,
                          expiry_date, expiry_unknown, received_at, created_by)
    values (p_pharmacy_id, v_drug_id, v_quantity, v_quantity, v_cost_price, v_sell_price,
            v_expiry_date, v_expiry_unknown, current_date, auth.uid())
    returning id into v_batch_id;

    insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
    values (p_pharmacy_id, v_drug_id, v_batch_id, 'restock', v_quantity, 'Synced from master catalog', auth.uid());

    v_results := v_results || jsonb_build_object('master_drug_id', v_master.id, 'drug_id', v_drug_id, 'batch_id', v_batch_id);
  end loop;

  return v_results;
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
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can correct stock';
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
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can write off stock';
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
-- Enabled with only a SELECT policy (no insert/update/delete policy at
-- all), same pattern as password_reset_attempts: every authenticated user
-- can read the shared catalog, but no tenant can write to it however the
-- blanket grants below are phrased — only a migration (running as the
-- table owner, which bypasses RLS) can add to or change it.
alter table master_drugs enable row level security;

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
create policy "read master_drugs" on master_drugs for select using (true);

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

-- ----------------------------------------------------------------------------
-- 10. SEED DATA — shared master drug catalog (see master_drugs above)
-- ----------------------------------------------------------------------------
-- 287 items across the 16 categories bootstrap_pharmacy() seeds for every
-- pharmacy, curated from a real Kenyan chemist's stock-take sheet (the same
-- one referenced throughout this project's docs). form/unit are a
-- best-effort default from the item's name/category, not a clinical
-- classification — a pharmacy can freely edit either once the drug lands in
-- their own drugs table via sync_master_drugs.

insert into master_drugs (category_name, name, form, unit, is_prescription, sort_order) values
  ('Analgesics/Antipyretics', 'Brufen 60mls', 'syrup', 'bottle', false, 0),
  ('Analgesics/Antipyretics', 'Brufen 100mls', 'syrup', 'bottle', false, 1),
  ('Analgesics/Antipyretics', 'PCM 60mls', 'syrup', 'bottle', false, 2),
  ('Analgesics/Antipyretics', 'Curamol 100mls', 'syrup', 'bottle', false, 3),
  ('Analgesics/Antipyretics', 'Curamol 60mls', 'syrup', 'bottle', false, 4),
  ('Analgesics/Antipyretics', 'Calpol 60mls', 'syrup', 'bottle', false, 5),
  ('Analgesics/Antipyretics', 'Calpol 100mls', 'syrup', 'bottle', false, 6),
  ('Analgesics/Antipyretics', 'Brustan 100mls', 'syrup', 'bottle', false, 7),
  ('Analgesics/Antipyretics', 'Mara moja', 'tablet', 'tablet', false, 8),
  ('Analgesics/Antipyretics', 'Kaluma strong tab', 'tablet', 'tablet', false, 9),
  ('Analgesics/Antipyretics', 'Action pair tabs', 'tablet', 'tablet', false, 10),
  ('Analgesics/Antipyretics', 'Hedex', 'tablet', 'tablet', false, 11),
  ('Analgesics/Antipyretics', 'Panadol extra', 'tablet', 'tablet', false, 12),
  ('Analgesics/Antipyretics', 'Meloxicam 7.5mg', 'tablet', 'tablet', false, 13),
  ('Analgesics/Antipyretics', 'Relief MR', 'tablet', 'tablet', false, 14),
  ('Analgesics/Antipyretics', 'PCM 500mg', 'tablet', 'tablet', false, 15),
  ('Analgesics/Antipyretics', 'tamepyn', 'tablet', 'tablet', false, 16),
  ('Analgesics/Antipyretics', 'Diclofenac 100mg', 'tablet', 'tablet', false, 17),
  ('Analgesics/Antipyretics', 'Piroxicam 20mg', 'tablet', 'tablet', false, 18),
  ('Analgesics/Antipyretics', 'Aceclofenac', 'tablet', 'tablet', false, 19),
  ('Analgesics/Antipyretics', 'Brufen 200mg', 'tablet', 'tablet', false, 20),
  ('Analgesics/Antipyretics', 'Brufen 400mg', 'tablet', 'tablet', false, 21),
  ('Analgesics/Antipyretics', 'Zuru Mr', 'tablet', 'tablet', false, 22),
  ('Analgesics/Antipyretics', 'Buscopan', 'tablet', 'tablet', false, 23),
  ('Analgesics/Antipyretics', 'Myospaz', 'tablet', 'tablet', false, 24),
  ('Analgesics/Antipyretics', 'Acetal MR', 'tablet', 'tablet', false, 25),
  ('Analgesics/Antipyretics', 'Tramadol caps', 'capsule', 'tablet', true, 26),
  ('Analgesics/Antipyretics', 'Celecoxib 200mg', 'tablet', 'tablet', false, 27),
  ('Analgesics/Antipyretics', 'Diclofenac suppositories', 'suppository', 'unit', false, 28),
  ('Analgesics/Antipyretics', 'Surepyn', 'tablet', 'tablet', false, 29),
  ('Analgesics/Antipyretics', 'Mefenamic acid 250mg', 'tablet', 'tablet', false, 30),
  ('Analgesics/Antipyretics', 'Mefenamin acid 500mg', 'tablet', 'tablet', false, 31),
  ('Analgesics/Antipyretics', 'Lobak', 'tablet', 'tablet', false, 32),
  ('Analgesics/Antipyretics', 'Indomethacin 25mg caps', 'capsule', 'tablet', false, 33),
  ('Analgesics/Antipyretics', 'Subsyde CR caps', 'capsule', 'tablet', false, 34),
  ('Analgesics/Antipyretics', 'A.P.C tabs', 'tablet', 'tablet', false, 35),
  ('Antibiotics/Antifungals/Amoebicides', 'Flucloxacillin 100mls', 'syrup', 'bottle', false, 0),
  ('Antibiotics/Antifungals/Amoebicides', 'Azithromycin 15mls', 'syrup', 'bottle', false, 1),
  ('Antibiotics/Antifungals/Amoebicides', 'Peerdine 100mls', 'syrup', 'bottle', false, 2),
  ('Antibiotics/Antifungals/Amoebicides', 'Posdine 100mls', 'syrup', 'bottle', false, 3),
  ('Antibiotics/Antifungals/Amoebicides', 'Eflaron plus 100mls', 'syrup', 'bottle', false, 4),
  ('Antibiotics/Antifungals/Amoebicides', 'Entamaxin 100mls', 'syrup', 'bottle', false, 5),
  ('Antibiotics/Antifungals/Amoebicides', 'Metronidazole 60mls', 'syrup', 'bottle', false, 6),
  ('Antibiotics/Antifungals/Amoebicides', 'Metronidazole 100mls', 'syrup', 'bottle', false, 7),
  ('Antibiotics/Antifungals/Amoebicides', 'Metronidazole IV', 'other', 'unit', false, 8),
  ('Antibiotics/Antifungals/Amoebicides', 'Zefcolin 100mls', 'syrup', 'bottle', false, 9),
  ('Antibiotics/Antifungals/Amoebicides', 'Cefixime 60mls', 'syrup', 'bottle', false, 10),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxiclav 228 susp', 'syrup', 'bottle', false, 11),
  ('Antibiotics/Antifungals/Amoebicides', 'Cefuroxime 50mls susp', 'syrup', 'bottle', false, 12),
  ('Antibiotics/Antifungals/Amoebicides', 'Cephalexin 60mls', 'syrup', 'bottle', false, 13),
  ('Antibiotics/Antifungals/Amoebicides', 'Neonatal ampiclox 15mls', 'syrup', 'bottle', false, 14),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxicillin 60mls susp', 'syrup', 'bottle', false, 15),
  ('Antibiotics/Antifungals/Amoebicides', 'Septrin (co-trimoxazole 60mls', 'syrup', 'bottle', false, 16),
  ('Antibiotics/Antifungals/Amoebicides', 'Septrin (co-trimoxazole) 100mls', 'syrup', 'bottle', false, 17),
  ('Antibiotics/Antifungals/Amoebicides', 'Bulkot mouth paint', 'other', 'unit', false, 18),
  ('Antibiotics/Antifungals/Amoebicides', 'Nystatin 12mls', 'syrup', 'bottle', false, 19),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxicillin 100mls susp', 'syrup', 'bottle', false, 20),
  ('Antibiotics/Antifungals/Amoebicides', 'Ampiclox 100mls susp', 'syrup', 'bottle', false, 21),
  ('Antibiotics/Antifungals/Amoebicides', 'Fluconazole 200mg', 'tablet', 'tablet', false, 22),
  ('Antibiotics/Antifungals/Amoebicides', 'Diracip MDS', 'tablet', 'tablet', false, 23),
  ('Antibiotics/Antifungals/Amoebicides', 'Diracip M', 'tablet', 'tablet', false, 24),
  ('Antibiotics/Antifungals/Amoebicides', 'Griseofulvin 125mg', 'tablet', 'tablet', false, 25),
  ('Antibiotics/Antifungals/Amoebicides', 'Griseofulvin 250mg', 'tablet', 'tablet', false, 26),
  ('Antibiotics/Antifungals/Amoebicides', 'Griseofulvin 500mg', 'tablet', 'tablet', false, 27),
  ('Antibiotics/Antifungals/Amoebicides', 'Ketoconazole', 'tablet', 'tablet', false, 28),
  ('Antibiotics/Antifungals/Amoebicides', 'Metronidazole 200mg', 'tablet', 'tablet', false, 29),
  ('Antibiotics/Antifungals/Amoebicides', 'Metronidazole 400mg', 'tablet', 'tablet', false, 30),
  ('Antibiotics/Antifungals/Amoebicides', 'Entamaxin caps', 'capsule', 'tablet', false, 31),
  ('Antibiotics/Antifungals/Amoebicides', 'Fluconazole 150mg', 'tablet', 'tablet', false, 32),
  ('Antibiotics/Antifungals/Amoebicides', 'Ofloxacin &Ornidazole tabs', 'tablet', 'tablet', false, 33),
  ('Antibiotics/Antifungals/Amoebicides', 'Co trimoxazole 480mg', 'tablet', 'tablet', false, 34),
  ('Antibiotics/Antifungals/Amoebicides', 'Co trimoxazole 960mg', 'tablet', 'tablet', false, 35),
  ('Antibiotics/Antifungals/Amoebicides', 'clotrimazole pessaries', 'suppository', 'unit', false, 36),
  ('Antibiotics/Antifungals/Amoebicides', 'Levofloxacin 50mg', 'tablet', 'tablet', false, 37),
  ('Antibiotics/Antifungals/Amoebicides', 'Ciprofloxacin 500mg', 'tablet', 'tablet', false, 38),
  ('Antibiotics/Antifungals/Amoebicides', 'Eflaron plus tabs', 'tablet', 'tablet', false, 39),
  ('Antibiotics/Antifungals/Amoebicides', 'Flucloxacillin 250mg', 'tablet', 'tablet', false, 40),
  ('Antibiotics/Antifungals/Amoebicides', 'Flucloxacillin 500mg', 'tablet', 'tablet', false, 41),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxicillin 250mg', 'tablet', 'tablet', false, 42),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxicillin 500mg', 'tablet', 'tablet', false, 43),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxiclav DT', 'tablet', 'tablet', false, 44),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxicillin DT tabs', 'tablet', 'tablet', false, 45),
  ('Antibiotics/Antifungals/Amoebicides', 'Doxycycline 100mg', 'tablet', 'tablet', false, 46),
  ('Antibiotics/Antifungals/Amoebicides', 'Cephalexin 250mg', 'tablet', 'tablet', false, 47),
  ('Antibiotics/Antifungals/Amoebicides', 'Cephalexin 500mg', 'tablet', 'tablet', false, 48),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxiclav 625mg', 'tablet', 'tablet', false, 49),
  ('Antibiotics/Antifungals/Amoebicides', 'Amoxiclav 1000mg', 'tablet', 'tablet', false, 50),
  ('Antibiotics/Antifungals/Amoebicides', 'Cefuroxime 250mg', 'tablet', 'tablet', false, 51),
  ('Antibiotics/Antifungals/Amoebicides', 'Cefuroxime 500mg', 'tablet', 'tablet', false, 52),
  ('Antibiotics/Antifungals/Amoebicides', 'Cefixime 400mg', 'tablet', 'tablet', false, 53),
  ('Antibiotics/Antifungals/Amoebicides', 'Azithromycin 250mg', 'tablet', 'tablet', false, 54),
  ('Antibiotics/Antifungals/Amoebicides', 'Azitrhromycin 500mg', 'tablet', 'tablet', false, 55),
  ('Antibiotics/Antifungals/Amoebicides', 'Clindamycin 500mg', 'tablet', 'tablet', false, 56),
  ('Antibiotics/Antifungals/Amoebicides', 'Nitrafurantoin 100mg', 'tablet', 'tablet', false, 57),
  ('Antibiotics/Antifungals/Amoebicides', 'Natoa(mebendazole) 100mg', 'tablet', 'tablet', false, 58),
  ('Antibiotics/Antifungals/Amoebicides', 'Natoa (mebendazole) 30mls', 'syrup', 'bottle', false, 59),
  ('Antibiotics/Antifungals/Amoebicides', 'ABZ [olworm ] susp', 'syrup', 'bottle', false, 60),
  ('Antibiotics/Antifungals/Amoebicides', 'ABZ [olworm ] tabs', 'tablet', 'tablet', false, 61),
  ('Antibiotics/Antifungals/Amoebicides', 'Tinidazole 500mg', 'tablet', 'tablet', false, 62),
  ('Antibiotics/Antifungals/Amoebicides', 'Secnidazole 1gm', 'tablet', 'tablet', false, 63),
  ('Antibiotics/Antifungals/Amoebicides', 'Tegraforte', 'tablet', 'tablet', false, 64),
  ('Antibiotics/Antifungals/Amoebicides', 'Lethal 30', 'tablet', 'tablet', false, 65),
  ('Antibiotics/Antifungals/Amoebicides', 'Diamisole', 'tablet', 'tablet', false, 66),
  ('Antibiotics/Antifungals/Amoebicides', 'Tumbocid', 'tablet', 'tablet', false, 67),
  ('Antibiotics/Antifungals/Amoebicides', 'Benaworm', 'tablet', 'tablet', false, 68),
  ('Antibiotics/Antifungals/Amoebicides', 'Loperamide 2mg', 'tablet', 'tablet', false, 69),
  ('Antibiotics/Antifungals/Amoebicides', 'ABZ tabs', 'tablet', 'tablet', false, 70),
  ('Antibiotics/Antifungals/Amoebicides', 'ABZ suspension', 'syrup', 'bottle', false, 71),
  ('Antibiotics/Antifungals/Amoebicides', 'Ampiclox 250mg', 'tablet', 'tablet', false, 72),
  ('Antibiotics/Antifungals/Amoebicides', 'Ampiclox 500mg', 'tablet', 'tablet', false, 73),
  ('Bronchodilators/Anti-Allergy', 'Tricoff 50mls', 'syrup', 'bottle', false, 0),
  ('Bronchodilators/Anti-Allergy', 'Tricohist 60mls', 'syrup', 'bottle', false, 1),
  ('Bronchodilators/Anti-Allergy', 'Tricohist 100mls', 'syrup', 'bottle', false, 2),
  ('Bronchodilators/Anti-Allergy', 'Ascoril 100mls', 'syrup', 'bottle', false, 3),
  ('Bronchodilators/Anti-Allergy', 'Cophydrex 60mls', 'syrup', 'bottle', false, 4),
  ('Bronchodilators/Anti-Allergy', 'Cold cap 100mls', 'syrup', 'bottle', false, 5),
  ('Bronchodilators/Anti-Allergy', 'Upacof dry 100mls', 'syrup', 'bottle', false, 6),
  ('Bronchodilators/Anti-Allergy', 'upacof expect 100mls', 'syrup', 'bottle', false, 7),
  ('Bronchodilators/Anti-Allergy', 'Good morning 50mls', 'syrup', 'bottle', false, 8),
  ('Bronchodilators/Anti-Allergy', 'Tridex 60mls', 'syrup', 'bottle', false, 9),
  ('Bronchodilators/Anti-Allergy', 'Tridex 100mls', 'syrup', 'bottle', false, 10),
  ('Bronchodilators/Anti-Allergy', 'Salbutamol 100mls', 'syrup', 'bottle', false, 11),
  ('Bronchodilators/Anti-Allergy', 'Piriton 50mls', 'syrup', 'bottle', false, 12),
  ('Bronchodilators/Anti-Allergy', 'Prednisolone 60mls', 'syrup', 'bottle', false, 13),
  ('Bronchodilators/Anti-Allergy', 'Salbutamol 60mls', 'syrup', 'bottle', false, 14),
  ('Bronchodilators/Anti-Allergy', 'Flugone 60mls', 'syrup', 'bottle', false, 15),
  ('Bronchodilators/Anti-Allergy', 'cetirizine 60mls', 'syrup', 'bottle', false, 16),
  ('Bronchodilators/Anti-Allergy', 'Franol(theophylline)', 'tablet', 'tablet', false, 17),
  ('Bronchodilators/Anti-Allergy', 'Prednisolone 5mg', 'tablet', 'tablet', false, 18),
  ('Bronchodilators/Anti-Allergy', 'Salbutamol 4mg', 'tablet', 'tablet', false, 19),
  ('Bronchodilators/Anti-Allergy', 'Montellukast 5mg', 'tablet', 'tablet', false, 20),
  ('Bronchodilators/Anti-Allergy', 'Montellukast 5mg Dt', 'tablet', 'tablet', false, 21),
  ('Bronchodilators/Anti-Allergy', 'Piriton tabs', 'tablet', 'tablet', false, 22),
  ('Bronchodilators/Anti-Allergy', 'Celestamine tabs', 'tablet', 'tablet', false, 23),
  ('Bronchodilators/Anti-Allergy', 'Cold cap caps', 'capsule', 'tablet', false, 24),
  ('Bronchodilators/Anti-Allergy', 'Flugone caps', 'capsule', 'tablet', false, 25),
  ('Bronchodilators/Anti-Allergy', 'Cetrizine 10mg', 'tablet', 'tablet', false, 26),
  ('Bronchodilators/Anti-Allergy', 'Ibucap', 'tablet', 'tablet', false, 27),
  ('Antacids/Anti-H-Pylori', 'Recergel 180mls', 'syrup', 'bottle', false, 0),
  ('Antacids/Anti-H-Pylori', 'Recergel 100mls', 'syrup', 'bottle', false, 1),
  ('Antacids/Anti-H-Pylori', 'Allugel 100mls', 'syrup', 'bottle', false, 2),
  ('Antacids/Anti-H-Pylori', 'Gastrogel 100mls', 'syrup', 'bottle', false, 3),
  ('Antacids/Anti-H-Pylori', 'Omeprazole 20mg', 'tablet', 'tablet', false, 4),
  ('Antacids/Anti-H-Pylori', 'Esomeprazole 20mg', 'tablet', 'tablet', false, 5),
  ('Antacids/Anti-H-Pylori', 'Esomeprazole 40mg', 'tablet', 'tablet', false, 6),
  ('Antacids/Anti-H-Pylori', 'Eno sachets', 'other', 'unit', false, 7),
  ('Antacids/Anti-H-Pylori', 'Sodamint 300mg tabs', 'tablet', 'tablet', false, 8),
  ('Antacids/Anti-H-Pylori', 'Eno tabs', 'tablet', 'tablet', false, 9),
  ('Antacids/Anti-H-Pylori', 'Surekit', 'other', 'unit', false, 10),
  ('Antacids/Anti-H-Pylori', 'Pylotrip', 'tablet', 'tablet', false, 11),
  ('Antacids/Anti-H-Pylori', 'Kit pylo', 'other', 'unit', false, 12),
  ('Antimalarials', 'Al tabs', 'tablet', 'tablet', false, 0),
  ('Antimalarials', 'Remoxe caps', 'capsule', 'tablet', false, 1),
  ('Antimalarials', 'Fanlar dose', 'tablet', 'tablet', false, 2),
  ('Antimalarials', 'P alaxin dose', 'tablet', 'tablet', false, 3),
  ('Antimalarials', 'AL 60mls susp', 'syrup', 'bottle', false, 4),
  ('Anti-DM', 'Glucomet 7 day', 'tablet', 'tablet', false, 0),
  ('Anti-DM', 'Glucomet 14 day', 'tablet', 'tablet', false, 1),
  ('Anti-DM', 'Nogluc', 'tablet', 'tablet', false, 2),
  ('Hypertensives/Convulsants', 'HCTZ 25mg', 'tablet', 'tablet', false, 0),
  ('Hypertensives/Convulsants', 'HCTZ 50mg', 'tablet', 'tablet', false, 1),
  ('Hypertensives/Convulsants', 'Phenytoin 100mg', 'tablet', 'tablet', true, 2),
  ('Hypertensives/Convulsants', 'Furosemide', 'tablet', 'tablet', false, 3),
  ('Hypertensives/Convulsants', 'Nifedipine 20mg', 'tablet', 'tablet', false, 4),
  ('Hypertensives/Convulsants', 'Enalapril 5mg', 'tablet', 'tablet', false, 5),
  ('Hypertensives/Convulsants', 'Amlodipine 10mg', 'tablet', 'tablet', false, 6),
  ('Hypertensives/Convulsants', 'Carbamazepine', 'tablet', 'tablet', true, 7),
  ('Hypertensives/Convulsants', 'Phenobarbitone', 'tablet', 'tablet', true, 8),
  ('Hypertensives/Convulsants', 'Diazepam', 'tablet', 'tablet', true, 9),
  ('Hypertensives/Convulsants', 'Amitryptyle', 'tablet', 'tablet', false, 10),
  ('Hypertensives/Convulsants', 'Benzexhol (Artane)', 'tablet', 'tablet', false, 11),
  ('Hypertensives/Convulsants', 'Carditan H', 'tablet', 'tablet', false, 12),
  ('Hypertensives/Convulsants', 'Carvedilol 6.25mg', 'tablet', 'tablet', false, 13),
  ('Hypertensives/Convulsants', 'Losartan', 'tablet', 'tablet', false, 14),
  ('Antiemetics/Laxatives', 'Promethazine 25mg', 'tablet', 'tablet', false, 0),
  ('Antiemetics/Laxatives', 'Promethazine 60mls', 'syrup', 'bottle', false, 1),
  ('Antiemetics/Laxatives', 'Lactulose 100mls', 'syrup', 'bottle', false, 2),
  ('Antiemetics/Laxatives', 'Bisacodyl 5mg', 'tablet', 'tablet', false, 3),
  ('Antiemetics/Laxatives', 'Domperidone 10mg', 'tablet', 'tablet', false, 4),
  ('Antiemetics/Laxatives', 'Nosic', 'tablet', 'tablet', false, 5),
  ('Antiemetics/Laxatives', 'Ondasentron', 'tablet', 'tablet', false, 6),
  ('Contraceptives', 'Postinor 2', 'tablet', 'tablet', false, 0),
  ('Contraceptives', 'P2 generic', 'tablet', 'tablet', false, 1),
  ('Contraceptives', 'Depo provera inj', 'injection', 'vial', true, 2),
  ('Contraceptives', 'Trust classic', 'tablet', 'tablet', false, 3),
  ('Contraceptives', 'Kiss classic', 'tablet', 'tablet', false, 4),
  ('Contraceptives', 'Kiss strawberry', 'tablet', 'tablet', false, 5),
  ('Contraceptives', 'Femiplan', 'tablet', 'tablet', false, 6),
  ('Supplements', 'Multivitamin 100mls', 'syrup', 'bottle', false, 0),
  ('Supplements', 'Scotts emulsion 100mls', 'syrup', 'bottle', false, 1),
  ('Supplements', 'Seven seas multivitamin 100mls', 'syrup', 'bottle', false, 2),
  ('Supplements', 'Seven seas codliver oil 100mls', 'syrup', 'bottle', false, 3),
  ('Supplements', 'Ranferon blood builder 200mls', 'syrup', 'bottle', false, 4),
  ('Supplements', 'Bonnisan 120mls', 'syrup', 'bottle', false, 5),
  ('Supplements', 'Cypon 100mls', 'syrup', 'bottle', false, 6),
  ('Supplements', 'Junior zinc', 'tablet', 'tablet', false, 7),
  ('Supplements', 'Folic acid', 'tablet', 'tablet', false, 8),
  ('Supplements', 'Ifas', 'tablet', 'tablet', false, 9),
  ('Supplements', 'Omega 3 caps', 'capsule', 'tablet', false, 10),
  ('Supplements', 'Sera fe caps', 'capsule', 'tablet', false, 11),
  ('Supplements', 'Becoactin tabs', 'tablet', 'tablet', false, 12),
  ('Supplements', 'Cypro b plus', 'tablet', 'tablet', false, 13),
  ('Supplements', 'Byofer 12', 'tablet', 'tablet', false, 14),
  ('Supplements', 'Neuroforte', 'tablet', 'tablet', false, 15),
  ('Supplements', 'Neurobion', 'tablet', 'tablet', false, 16),
  ('Supplements', 'Pregabalin', 'tablet', 'tablet', true, 17),
  ('Supplements', 'Cartil forte', 'tablet', 'tablet', false, 18),
  ('Supplements', 'Gabapentin', 'tablet', 'tablet', true, 19),
  ('Eye/Ear Drops', 'Gentamicin drops', 'drops', 'bottle', false, 0),
  ('Eye/Ear Drops', 'Lub tears', 'drops', 'bottle', false, 1),
  ('Eye/Ear Drops', 'Floral', 'drops', 'bottle', false, 2),
  ('Eye/Ear Drops', 'Flarex', 'drops', 'bottle', false, 3),
  ('Eye/Ear Drops', 'Olopatadine', 'drops', 'bottle', false, 4),
  ('Eye/Ear Drops', 'Probeta N 7.5ml', 'drops', 'bottle', false, 5),
  ('Eye/Ear Drops', 'T.E.O', 'drops', 'bottle', false, 6),
  ('ORS', 'ORS sachets', 'other', 'sachet', false, 0),
  ('ORS', 'Zinc + ORS combo pack', 'other', 'unit', false, 1),
  ('Injectables', 'Ceftrixone inj', 'injection', 'vial', true, 0),
  ('Injectables', 'Ondasentron inj', 'injection', 'vial', true, 1),
  ('Injectables', 'K cort inj', 'injection', 'vial', true, 2),
  ('Injectables', 'AL inj', 'injection', 'vial', true, 3),
  ('Injectables', 'Gentamicin inj', 'injection', 'vial', true, 4),
  ('Injectables', 'Tramadol', 'injection', 'vial', true, 5),
  ('Injectables', 'Pcm inj', 'injection', 'vial', true, 6),
  ('Powders/Creams', 'Grabacin powder', 'other', 'sachet', false, 0),
  ('Powders/Creams', 'Nebanol powder 5gm', 'other', 'sachet', false, 1),
  ('Powders/Creams', 'Clotrimazole cream', 'cream_ointment', 'tube', false, 2),
  ('Powders/Creams', 'Norash', 'tablet', 'tablet', false, 3),
  ('Powders/Creams', 'Betason', 'tablet', 'tablet', false, 4),
  ('Powders/Creams', 'Miconazole', 'tablet', 'tablet', false, 5),
  ('Powders/Creams', 'Mediven cream', 'cream_ointment', 'tube', false, 6),
  ('Powders/Creams', 'Hydrocort', 'tablet', 'tablet', false, 7),
  ('Powders/Creams', 'Ketoconazole cream', 'cream_ointment', 'tube', false, 8),
  ('Powders/Creams', 'Funbact cream', 'cream_ointment', 'tube', false, 9),
  ('Powders/Creams', 'Fastum gel', 'cream_ointment', 'tube', false, 10),
  ('Powders/Creams', 'Fustil 15mg', 'tablet', 'tablet', false, 11),
  ('Powders/Creams', 'Mupirocin cream', 'cream_ointment', 'tube', false, 12),
  ('Powders/Creams', 'Clob b', 'tablet', 'tablet', false, 13),
  ('Powders/Creams', 'Epiderm cream', 'cream_ointment', 'tube', false, 14),
  ('Powders/Creams', 'Elyvate cream', 'cream_ointment', 'tube', false, 15),
  ('Powders/Creams', 'Clozole b', 'tablet', 'tablet', false, 16),
  ('Powders/Creams', 'Clozole', 'tablet', 'tablet', false, 17),
  ('Powders/Creams', 'Terbinafine cream', 'cream_ointment', 'tube', false, 18),
  ('Powders/Creams', 'Xtraderm cream', 'cream_ointment', 'tube', false, 19),
  ('Powders/Creams', 'Silver diazine cream', 'cream_ointment', 'tube', false, 20),
  ('Powders/Creams', 'Diclofenac gel', 'cream_ointment', 'tube', false, 21),
  ('Powders/Creams', 'Pharmasal ointment', 'cream_ointment', 'tube', false, 22),
  ('Powders/Creams', 'Burnmed', 'tablet', 'tablet', false, 23),
  ('Powders/Creams', 'Sulphur ointment', 'cream_ointment', 'tube', false, 24),
  ('Powders/Creams', 'Mephylamine (antihistamine)', 'tablet', 'tablet', false, 25),
  ('Non-Pharmaceuticals', 'Ns 500mls', 'iv_fluid', 'bottle', false, 0),
  ('Non-Pharmaceuticals', 'Elastoplast', 'other', 'unit', false, 1),
  ('Non-Pharmaceuticals', 'Pharmasal spray 150mls', 'other', 'bottle', false, 2),
  ('Non-Pharmaceuticals', 'Normal saline drops', 'drops', 'bottle', false, 3),
  ('Non-Pharmaceuticals', 'Ashton powder', 'other', 'sachet', false, 4),
  ('Non-Pharmaceuticals', 'Glycerine 100mls', 'other', 'bottle', false, 5),
  ('Non-Pharmaceuticals', 'HIV kits', 'other', 'unit', false, 6),
  ('Non-Pharmaceuticals', 'HCG strips', 'other', 'unit', false, 7),
  ('Non-Pharmaceuticals', 'Waterguard', 'other', 'unit', false, 8),
  ('Non-Pharmaceuticals', 'Hydrogen peroxide 200mls', 'other', 'bottle', false, 9),
  ('Non-Pharmaceuticals', 'Methylated spirit 500mls', 'other', 'bottle', false, 10),
  ('Non-Pharmaceuticals', '2cc syringes', 'other', 'unit', false, 11),
  ('Non-Pharmaceuticals', '5cc syringes', 'other', 'unit', false, 12),
  ('Non-Pharmaceuticals', '10cc syringes', 'other', 'unit', false, 13),
  ('Non-Pharmaceuticals', 'Lifeguard', 'other', 'unit', false, 14),
  ('Non-Pharmaceuticals', 'Sensodyne', 'other', 'unit', false, 15),
  ('Non-Pharmaceuticals', 'Deepheat spray', 'other', 'unit', false, 16),
  ('Non-Pharmaceuticals', 'Deepheat ointment', 'cream_ointment', 'tube', false, 17),
  ('Non-Pharmaceuticals', 'Iodine 50mls', 'other', 'bottle', false, 18),
  ('Non-Pharmaceuticals', 'Iodine 100mls', 'other', 'bottle', false, 19),
  ('Non-Pharmaceuticals', 'Liquid paraffin 100mls', 'other', 'bottle', false, 20),
  ('Non-Pharmaceuticals', 'Surgical blade', 'other', 'unit', false, 21),
  ('Non-Pharmaceuticals', 'Surgical spirit 50ml', 'other', 'bottle', false, 22),
  ('Non-Pharmaceuticals', 'Cotton wool 50g', 'other', 'unit', false, 23),
  ('Non-Pharmaceuticals', 'Cotton wool 100g', 'other', 'unit', false, 24),
  ('Non-Pharmaceuticals', 'Cotton wool 200g', 'other', 'unit', false, 25),
  ('Non-Pharmaceuticals', 'Sonapen', 'tablet', 'tablet', false, 26),
  ('Non-Pharmaceuticals', 'Kaluma pain balm', 'cream_ointment', 'tube', false, 27),
  ('Non-Pharmaceuticals', 'Gloves', 'other', 'unit', false, 28),
  ('Others', 'Sildenafil citrate 50mg', 'tablet', 'tablet', true, 0),
  ('Others', 'Sildenafil citrate 100mg', 'tablet', 'tablet', true, 1),
  ('Others', 'Antirabies vaccine', 'injection', 'vial', true, 2),
  ('Others', 'Calamine lotion', 'other', 'unit', false, 3),
  ('Others', 'Gripe water 60ml', 'syrup', 'bottle', false, 4),
  ('Others', 'Gripe water 100mls', 'syrup', 'bottle', false, 5),
  ('Others', 'Neopeptine 15mls', 'syrup', 'bottle', false, 6),
  ('Others', 'Steron', 'tablet', 'tablet', false, 7);

-- ============================================================================
-- 11. PHONE OTP VERIFICATION (added this session — PHARMA_PROJECT_STATUS.md
-- item 18, closing roadmap A.1(b): a real SMS OTP was the actual fix for
-- reset-password-by-phone, the rate limit alone only slowed brute-forcing.
-- Ported from Shule Web's proven phone_otps design. Both tables are
-- server-only (RLS enabled, zero policies) — reachable only via the
-- service-role key inside the send-otp/verify-otp/reset-password-by-phone
-- Edge Functions, never a browser session directly, same pattern this
-- project already uses for password_reset_attempts.
-- ============================================================================

create table phone_otps (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  purpose text not null check (purpose in ('password_reset')),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- send-otp's rate-limit check and verify-otp's "latest live code for this
-- phone+purpose" lookup are both `where phone = ? and purpose = ? order by
-- created_at desc` — this index serves both directly.
create index idx_phone_otps_lookup on phone_otps (phone, purpose, created_at desc);

alter table phone_otps enable row level security;

-- SMS provider credentials, kept in the database (not an Edge Function
-- secret) so they aren't tied to any one deploy mechanism — same reasoning
-- as Shule Web's own sms_platform_config, which this project's row was
-- seeded from (reusing Shule Web's Africa's Talking account/sender ID, at
-- the user's explicit direction, rather than a separate Pharma-specific
-- account).
create table sms_platform_config (
  id integer primary key default 1,
  provider text not null default 'africas_talking',
  username text,
  api_key text,
  sender_id text,
  updated_at timestamptz not null default now(),
  constraint sms_platform_config_singleton check (id = 1)
);

alter table sms_platform_config enable row level security;

-- ============================================================================
-- 12. SUPPLIERS MODULE (added this session — PHARMA_PROJECT_STATUS.md item
-- 21) — opening balances, LPOs (Local Purchase Orders) that record a
-- delivery AND restock inventory in one step (integrated, per the owner's
-- choice — one entry records both the debt and the stock received), payments
-- against a supplier's running balance, and a full running-ledger statement
-- per supplier. See record_supplier_lpo/record_supplier_payment below and
-- app.js's Suppliers tab.
-- ============================================================================

alter table pharmacies add column if not exists next_lpo_no integer not null default 1;  -- atomically incremented per LPO -> LPO-000001, ...

alter table suppliers add column if not exists opening_balance numeric(10,2) not null default 0;       -- debt owed to this supplier before Pharma started tracking it
alter table suppliers add column if not exists opening_balance_date date;                                -- as-of date for the opening balance, shown as the ledger's first line

-- One row per delivery. Creating an LPO also creates the batches (see
-- record_supplier_lpo below) — a single entry records both the debt and the
-- stock received, avoiding double data entry between Suppliers and Stock.
create table supplier_lpos (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  supplier_id   uuid not null references suppliers(id) on delete cascade,
  lpo_number    text not null,                        -- "LPO-000001", sequential per pharmacy via next_lpo_no
  delivered_at  date not null default current_date,
  total_amount  numeric(10,2) not null default 0,      -- sum of line item totals, set by record_supplier_lpo
  notes         text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

create index on supplier_lpos (pharmacy_id);
create index on supplier_lpos (pharmacy_id, supplier_id, delivered_at desc);
create index supplier_lpos_created_by_idx on supplier_lpos (created_by);

-- Line items — one per drug on the delivery. batch_id points at the batch
-- this line created, so a ledger entry can be traced straight to the stock
-- it added (and, later, to what was sold from it).
create table supplier_lpo_items (
  id            uuid primary key default gen_random_uuid(),
  lpo_id        uuid not null references supplier_lpos(id) on delete cascade,
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  drug_id       uuid not null references drugs(id),
  batch_id      uuid references batches(id) on delete set null,
  quantity      integer not null check (quantity > 0),
  cost_price    numeric(10,2) not null,
  line_total    numeric(10,2) not null,
  created_at    timestamptz not null default now()
);

create index on supplier_lpo_items (lpo_id);
create index on supplier_lpo_items (pharmacy_id);
create index supplier_lpo_items_batch_id_idx on supplier_lpo_items (batch_id);

create type supplier_payment_method as enum ('cash', 'mpesa', 'bank', 'cheque', 'other');

-- Money paid against a supplier's running balance, as it comes in.
create table supplier_payments (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  supplier_id   uuid not null references suppliers(id) on delete cascade,
  amount        numeric(10,2) not null check (amount > 0),
  method        supplier_payment_method not null default 'cash',
  reference     text,
  paid_at       date not null default current_date,
  notes         text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

create index on supplier_payments (pharmacy_id);
create index on supplier_payments (pharmacy_id, supplier_id, paid_at desc);
create index supplier_payments_created_by_idx on supplier_payments (created_by);

alter table supplier_lpos enable row level security;
alter table supplier_lpo_items enable row level security;
alter table supplier_payments enable row level security;

create policy "tenant all supplier_lpos" on supplier_lpos for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all supplier_lpo_items" on supplier_lpo_items for all using (pharmacy_id = my_pharmacy_id());
create policy "tenant all supplier_payments" on supplier_payments for all using (pharmacy_id = my_pharmacy_id());

grant select, insert, update, delete on supplier_lpos to authenticated;
grant select, insert, update, delete on supplier_lpo_items to authenticated;
grant select, insert, update, delete on supplier_payments to authenticated;

-- Records one delivery: an LPO header, its line items, AND one `batches` row
-- per item (same insert record_restock does) — integrated by design so the
-- pharmacist enters a delivery once and both the debt and the stock update
-- together. Same authorization tier as record_restock (owner/pharmacist).
create or replace function record_supplier_lpo(
  p_pharmacy_id uuid,
  p_supplier_id uuid,
  p_items jsonb,
  p_delivered_at date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lpo_id uuid;
  v_lpo_seq integer;
  v_supplier_name text;
  v_item jsonb;
  v_drug_id uuid;
  v_quantity integer;
  v_cost_price numeric(10,2);
  v_sell_price numeric(10,2);
  v_expiry_unknown boolean;
  v_batch_no text;
  v_batch_id uuid;
  v_expiry date;
  v_line_total numeric(10,2);
  v_total numeric(10,2) := 0;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a supplier delivery';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'An LPO needs at least one item';
  end if;

  select name into v_supplier_name from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id;
  if v_supplier_name is null then
    raise exception 'Supplier not found';
  end if;

  update pharmacies set next_lpo_no = next_lpo_no + 1
  where id = p_pharmacy_id
  returning next_lpo_no - 1 into v_lpo_seq;

  insert into supplier_lpos (pharmacy_id, supplier_id, lpo_number, delivered_at, notes, created_by)
  values (p_pharmacy_id, p_supplier_id, 'LPO-' || lpad(v_lpo_seq::text, 6, '0'), coalesce(p_delivered_at, current_date), p_notes, auth.uid())
  returning id into v_lpo_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_cost_price := (v_item->>'cost_price')::numeric;
    v_sell_price := coalesce(nullif(v_item->>'sell_price', '')::numeric, v_cost_price);
    v_batch_no := v_item->>'batch_no';
    v_expiry_unknown := coalesce((v_item->>'expiry_unknown')::boolean, false);

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Each line item needs a quantity greater than zero';
    end if;
    if v_cost_price is null then
      raise exception 'Each line item needs a cost price';
    end if;

    if v_expiry_unknown then
      v_expiry := (current_date + interval '3 years')::date;
    else
      v_expiry := nullif(v_item->>'expiry_date', '')::date;
      if v_expiry is null then
        raise exception 'Expiry date is required unless expiry is marked unknown';
      end if;
    end if;

    insert into batches (pharmacy_id, drug_id, batch_no, supplier, supplier_id, quantity_received,
                          quantity_remaining, cost_price, sell_price, expiry_date, expiry_unknown, created_by)
    values (p_pharmacy_id, v_drug_id, v_batch_no, v_supplier_name, p_supplier_id, v_quantity,
            v_quantity, v_cost_price, v_sell_price, v_expiry, v_expiry_unknown, auth.uid())
    returning id into v_batch_id;

    insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, created_by)
    values (p_pharmacy_id, v_drug_id, v_batch_id, 'restock', v_quantity, auth.uid());

    update drugs set default_price = v_sell_price where id = v_drug_id;

    v_line_total := round(v_quantity * v_cost_price, 2);
    v_total := v_total + v_line_total;

    insert into supplier_lpo_items (lpo_id, pharmacy_id, drug_id, batch_id, quantity, cost_price, line_total)
    values (v_lpo_id, p_pharmacy_id, v_drug_id, v_batch_id, v_quantity, v_cost_price, v_line_total);
  end loop;

  update supplier_lpos set total_amount = v_total where id = v_lpo_id;

  return v_lpo_id;
end;
$$;

-- Records a payment against a supplier's running balance.
create or replace function record_supplier_payment(
  p_pharmacy_id uuid,
  p_supplier_id uuid,
  p_amount numeric,
  p_method text default 'cash',
  p_reference text default null,
  p_paid_at date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a supplier payment';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Supplier not found';
  end if;

  insert into supplier_payments (pharmacy_id, supplier_id, amount, method, reference, paid_at, notes, created_by)
  values (p_pharmacy_id, p_supplier_id, p_amount, p_method::supplier_payment_method, p_reference, coalesce(p_paid_at, current_date), p_notes, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

grant execute on function record_supplier_lpo(uuid, uuid, jsonb, date, text) to authenticated;
grant execute on function record_supplier_payment(uuid, uuid, numeric, text, text, date, text) to authenticated;

-- ============================================================================
-- 13. DASHBOARD DATA (added this session — PHARMA_PROJECT_STATUS.md item 22)
-- — one round-trip RPC backing the redesigned dashboard's Today/Week/Month/
-- Year filter: the sales trend chart, the rush-hour chart (sales grouped
-- into 3-hour-of-day buckets, across every day in the selected range — this
-- is what lets a busy pharmacy see when its rush hours actually are), the
-- top-sellers leaderboard (top 50 returned so the dashboard tile can show 4
-- and the "view all" sheet can show the rest with no second round-trip),
-- and profit (sales minus cost of goods sold, where COGS is computed from
-- the exact batch each sale_item drew from via sale_items.batch_id ->
-- batches.cost_price — the true cost consumed, not a guess). Everything is
-- computed for the selected range AND the equivalent previous period, so
-- the app can show a real "+N% vs last week"-style delta instead of a
-- fabricated one. Stock value / stock health / expiring-soon are NOT part
-- of this function — those are point-in-time snapshots, not date-range
-- dependent, and stay on the existing v_drug_stock / v_out_of_stock /
-- v_low_stock / v_expiring_batches views app.js already queries directly.
-- ============================================================================

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
      -- Sunday-start week, matching the app's existing client-side reports logic.
      v_start := date_trunc('day', now()) - (extract(dow from now())::int * interval '1 day');
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

  select coalesce(jsonb_agg(jsonb_build_object('bucket_start', bucket_start, 'total', total) order by bucket_start), '[]'::jsonb)
    into v_trend
  from (
    select date_trunc(v_bucket, sold_at) as bucket_start, sum(total_amount) as total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
    group by 1
  ) t;

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

-- Item 33 (mobile dashboard redesign): a custom date-range variant of
-- dashboard_data, added as a SEPARATE function (not an overload of the
-- existing one) so the original today/week/month/year path is completely
-- untouched — this is purely additive. Powers the calendar-picker on the
-- dashboard's range control. Bucket granularity is chosen from the span
-- itself (a single day buckets by hour, up to a month by day, up to a year
-- by week, anything longer by month), and the "vs previous period" comparison
-- uses an equal-length window immediately before the chosen range.
create or replace function dashboard_data_custom(p_pharmacy_id uuid, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_prev_start timestamptz;
  v_prev_end timestamptz;
  v_span_days numeric;
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
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Invalid date range';
  end if;

  v_start := p_start::timestamptz;
  v_end := (p_end + 1)::timestamptz; -- exclusive, so the end date's whole day is included
  v_span_days := extract(epoch from (v_end - v_start)) / 86400;
  v_prev_start := v_start - (v_end - v_start);
  v_prev_end := v_start;

  v_bucket := case
    when v_span_days <= 1 then 'hour'
    when v_span_days <= 31 then 'day'
    when v_span_days <= 366 then 'week'
    else 'month'
  end;

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

  select coalesce(jsonb_agg(jsonb_build_object('bucket_start', bucket_start, 'total', total) order by bucket_start), '[]'::jsonb)
    into v_trend
  from (
    select date_trunc(v_bucket, sold_at) as bucket_start, sum(total_amount) as total
    from sales
    where pharmacy_id = p_pharmacy_id and voided = false and sold_at >= v_start and sold_at < v_end
    group by 1
  ) t;

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
    'range', 'custom',
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

grant execute on function dashboard_data_custom(uuid, date, date) to authenticated;

-- ============================================================================
-- 14. EXPENSES (added this session — PHARMA_PROJECT_STATUS.md item 23)
-- — a general pharmacy-expenses ledger (rent, utilities, salaries, transport,
-- licenses, marketing, maintenance, supplies, other as a starting preset),
-- separate from Suppliers (which is specifically about drug-stock deliveries
-- and supplier debt). Same soft-void pattern as sales (voided/voided_at/
-- void_reason — the UI calls this action "Reverse," item 25) rather than a
-- hard delete, so a mistaken entry stays in the audit trail. Same
-- authorization tier as Suppliers: owner/pharmacist only, not attendants —
-- see app.js's Expenses tab and record_expense/void_expense below.
--
-- category is free text, not an enum (changed in item 25) — a pharmacy can
-- type its own category beyond the 9-item preset (e.g. "PPB license fee"),
-- and since a Postgres enum's values are shared across every pharmacy on
-- this project, letting one pharmacy add a custom value to a shared enum
-- would leak into every other pharmacy's dropdown. Free text with a small
-- app.js-side preset list (as suggestions, not a constraint) avoids that.
-- ============================================================================

create table expenses (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  category       text not null default 'other' check (char_length(category) between 1 and 60),
  description    text not null,
  amount         numeric(10,2) not null check (amount > 0),
  method         supplier_payment_method not null default 'cash',   -- reuses the same cash/mpesa/bank/cheque/other type Suppliers already uses
  expense_date   date not null default current_date,
  notes          text,
  voided         boolean not null default false,
  voided_at      timestamptz,
  void_reason    text,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);

create index on expenses (pharmacy_id);
create index on expenses (pharmacy_id, expense_date desc);
create index on expenses (pharmacy_id, category);
create index expenses_created_by_idx on expenses (created_by);

alter table expenses enable row level security;
create policy "tenant all expenses" on expenses for all using (pharmacy_id = my_pharmacy_id());
grant select, insert, update, delete on expenses to authenticated;

create or replace function record_expense(
  p_pharmacy_id uuid,
  p_category text,
  p_description text,
  p_amount numeric,
  p_method text default 'cash',
  p_expense_date date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record an expense';
  end if;
  if p_description is null or trim(p_description) = '' then
    raise exception 'Give the expense a short description';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Expense amount must be greater than zero';
  end if;

  insert into expenses (pharmacy_id, category, description, amount, method, expense_date, notes, created_by)
  values (p_pharmacy_id, coalesce(nullif(trim(p_category), ''), 'other'), trim(p_description), p_amount,
          coalesce(nullif(p_method, '')::supplier_payment_method, 'cash'), coalesce(p_expense_date, current_date), p_notes, auth.uid())
  returning id into v_expense_id;

  return v_expense_id;
end;
$$;

-- Same soft-void pattern as void_sale: marks the row voided rather than
-- deleting it, so a mistaken entry never silently disappears from the books.
create or replace function void_expense(p_pharmacy_id uuid, p_expense_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_voided boolean;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can void an expense';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  select voided into v_already_voided from expenses where id = p_expense_id and pharmacy_id = p_pharmacy_id;
  if v_already_voided is null then
    raise exception 'Expense not found';
  end if;
  if v_already_voided then
    raise exception 'This expense is already voided';
  end if;

  update expenses set voided = true, voided_at = now(), void_reason = trim(p_reason) where id = p_expense_id;
end;
$$;

grant execute on function record_expense(uuid, text, text, numeric, text, date, text) to authenticated;
grant execute on function void_expense(uuid, uuid, text) to authenticated;

-- ============================================================================
-- 15. BATCH EXPIRY FOLLOW-UP (added this session — PHARMA_PROJECT_STATUS.md
-- item 26) — lets a pharmacist go back and fill in a real expiry date on a
-- batch that was created with expiry_unknown (most commonly now: an Excel
-- import row that had no expiry column filled in — see item 26's relaxed
-- import validation). Same authorization tier as record_restock, since this
-- is functionally correcting restock data.
-- ============================================================================

create or replace function set_batch_expiry(p_pharmacy_id uuid, p_batch_id uuid, p_expiry_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can set a batch''s expiry date';
  end if;
  if p_expiry_date is null then
    raise exception 'Enter an expiry date';
  end if;
  if not exists (select 1 from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Batch not found';
  end if;

  update batches set expiry_date = p_expiry_date, expiry_unknown = false where id = p_batch_id;
end;
$$;

grant execute on function set_batch_expiry(uuid, uuid, date) to authenticated;
