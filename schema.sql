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

-- Item 3 (Access Control module): co_owner (full equal access to owner,
-- see prevent_profile_privilege_escalation below for why the literal
-- 'owner' value itself stays reserved), stock_taker (view & count
-- inventory, restock, view reports), and accountant (financial-oversight
-- only, always a time-limited temporary account — see account_expires_at)
-- were added after initial launch. On a fresh install these ADD VALUEs
-- must run as their own statement/transaction, separate from anything
-- that references the new values (a Postgres enum-extension rule) — kept
-- immediately after the enum's own creation for that reason.
create type user_role as enum ('owner', 'pharmacist', 'attendant');
alter type user_role add value if not exists 'co_owner';
alter type user_role add value if not exists 'stock_taker';
alter type user_role add value if not exists 'accountant';

-- One row per auth.users id — extends Supabase auth with pharmacy + role.
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  full_name     text,
  phone         text,
  role          user_role not null default 'attendant',
  language      text not null default 'en',              -- 'en' | 'sw' — UI language
  active        boolean not null default true,            -- owner can deactivate a staff account without deleting it
  -- Item 3: when set, this is a temporary account (e.g. an accountant's
  -- time-limited code) — my_pharmacy_id()/my_role() below stop granting
  -- access the instant this passes, no cron job needed. Null = permanent.
  account_expires_at timestamptz,
  created_at    timestamptz not null default now()
);

create index on profiles (pharmacy_id);

-- Helper used by every RLS policy below: the caller's own pharmacy_id.
-- Item 3: also requires the profile to be active and, if it has an
-- expiry, not yet expired — previously neither was checked here at all,
-- so disabling a staff member (Settings → Staff → Disable) only ever hid
-- them in the UI; the RLS layer itself never actually cut off their
-- access. This one change is what makes both deactivation and temp-account
-- expiry a real, database-level lockout everywhere.
create or replace function my_pharmacy_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select pharmacy_id from profiles
  where id = auth.uid() and active and (account_expires_at is null or account_expires_at > now());
$$;

create or replace function my_role()
returns user_role
language sql stable security definer
set search_path = public
as $$
  select role from profiles
  where id = auth.uid() and active and (account_expires_at is null or account_expires_at > now());
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
  expires_at  timestamptz not null default (now() + interval '7 days'),  -- how long the CODE itself is redeemable
  -- Item 3: how long the ACCOUNT that redeems this code should last, once
  -- redeemed (distinct from expires_at above, which only governs the
  -- code). Null = permanent account. Mandatory for accountant invites,
  -- enforced in create_staff_invite.
  account_expires_hours integer,
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
  -- Item 3: record_sale had no role check at all before this — harmless
  -- while every existing role (owner/pharmacist/attendant) could sell
  -- anyway, but a real gap once stock_taker and accountant exist, since
  -- neither should be able to sell (per the pharmacy owner's answer) and
  -- nothing was stopping either from calling this RPC directly.
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a sale';
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can restock';
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can sync drugs';
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can correct stock';
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
-- Item 3: co_owner can invite too (full equal access); accepts an optional
-- expiry duration for the resulting account, and requires one when
-- inviting an accountant (their account must always be temporary).
create or replace function create_staff_invite(p_pharmacy_id uuid, p_role user_role, p_expires_hours integer default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() or my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the pharmacy owner can invite staff';
  end if;
  if p_role = 'owner' then
    raise exception 'Cannot invite another owner';
  end if;
  if p_role = 'accountant' and (p_expires_hours is null or p_expires_hours <= 0) then
    raise exception 'An accountant''s account must have a time limit';
  end if;
  if p_expires_hours is not null and p_expires_hours <= 0 then
    raise exception 'The time limit must be greater than zero hours';
  end if;

  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));

  insert into staff_invites (pharmacy_id, code, role, created_by, account_expires_hours)
  values (p_pharmacy_id, v_code, p_role, auth.uid(), p_expires_hours);

  return v_code;
end;
$$;

-- Item 3: carries the invite's account-expiry duration (if any) through to
-- the new profile.
create or replace function join_pharmacy_with_code(p_code text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
  v_expires_at timestamptz;
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

  if v_invite.account_expires_hours is not null then
    v_expires_at := now() + (v_invite.account_expires_hours || ' hours')::interval;
  else
    v_expires_at := null;
  end if;

  insert into profiles (id, pharmacy_id, full_name, phone, role, account_expires_at)
  values (auth.uid(), v_invite.pharmacy_id, p_full_name, p_phone, v_invite.role, v_expires_at);

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
  -- Item 3: also protects account_expires_at (so a user can't clear/extend
  -- their own temp-account expiry), and now lets co_owner (not just
  -- literal owner) make these privileged changes. Promotion to literal
  -- 'owner' stays blocked for everyone — only bootstrap_pharmacy() ever
  -- sets that, at pharmacy creation.
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
-- Item 3: co_owner gets the same access as owner on every owner-tier policy.
create policy "owner updates own pharmacy" on pharmacies for update using (id = my_pharmacy_id() and my_role() in ('owner', 'co_owner'));

-- Item 3: a user must still be able to read their OWN profile row even
-- once disabled/expired (so the app can show them a specific "why can't I
-- log in" message instead of a blank/generic screen) — my_pharmacy_id()
-- now returns null for them, so "pharmacy_id = my_pharmacy_id()" alone
-- would hide their own row too. Colleague visibility still requires being
-- an active, non-expired member.
-- auth.uid() wrapped in a scalar sub-select so it is evaluated once per
-- query, not once per row (migrations/2026-10-30_review_fk_indexes_and_profiles_policy.sql).
-- Same visibility rule: a member sees colleagues in their own pharmacy, plus their own row.
create policy "read colleagues in same pharmacy" on profiles for select using (pharmacy_id = my_pharmacy_id() or id = (select auth.uid()));
-- A user can always update their own row (e.g. language preference), and an
-- owner can update any staff row in their pharmacy (role/active/etc) — the
-- trigger above still stops both paths from touching role/active/pharmacy_id
-- unless the caller really is the owner (or co_owner).
create policy "update own profile or staff as owner" on profiles
  for update
  using (id = (select auth.uid()) or (pharmacy_id = my_pharmacy_id() and my_role() in ('owner', 'co_owner')));

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
create policy "owner manage invites" on staff_invites for all using (pharmacy_id = my_pharmacy_id() and my_role() in ('owner', 'co_owner'));
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
  purpose text not null check (purpose in ('password_reset', 'signup')),
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
-- Folded in from migrations/2026-10-30_review_fk_indexes_and_profiles_policy.sql
-- (covering index for the supplier_id foreign key).
create index supplier_lpos_supplier_id_idx on supplier_lpos (supplier_id);

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
-- Folded in from migrations/2026-10-30_review_fk_indexes_and_profiles_policy.sql
-- (covering index for the drug_id foreign key).
create index supplier_lpo_items_drug_id_idx on supplier_lpo_items (drug_id);

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
-- Folded in from migrations/2026-10-30_review_fk_indexes_and_profiles_policy.sql
-- (covering index for the supplier_id foreign key).
create index supplier_payments_supplier_id_idx on supplier_payments (supplier_id);

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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can set a batch''s expiry date';
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

-- Item 34: fixes a real bug report — a restock entered with an
-- already-past expiry date (e.g. picked yesterday by mistake instead of
-- the intended future date) makes that batch's stock silently stop
-- counting as "in stock" (v_drug_stock only counts unexpired batches),
-- with no way in the app to correct it — set_batch_expiry above only
-- covers batches marked expiry_unknown, not a batch that already has a
-- real-but-wrong date. Deliberately owner-only (stricter than
-- set_batch_expiry/record_restock's owner-or-pharmacist), since a wrong
-- expiry date silently changes whether stock counts as sellable without
-- changing the physical count on the shelf.
create or replace function correct_batch_expiry(p_pharmacy_id uuid, p_batch_id uuid, p_new_expiry_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the owner or co-owner can correct a batch''s expiry date';
  end if;
  if p_new_expiry_date is null then
    raise exception 'Enter an expiry date';
  end if;
  if not exists (select 1 from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Batch not found';
  end if;

  update batches set expiry_date = p_new_expiry_date, expiry_unknown = false where id = p_batch_id;
end;
$$;

grant execute on function correct_batch_expiry(uuid, uuid, date) to authenticated;


-- ============================================================================
-- 10. PLATFORM ADMIN PORTAL (/admin) — same pattern as Kodi's admin
-- ----------------------------------------------------------------------------
-- The admin portal (admin.html) uses the same Supabase project and the same
-- phone + password login as the main app. What makes an account an admin is
-- a row in platform_admins — a separate table, NOT a flag on profiles,
-- because profiles rows are user-editable (RLS lets a user update their own
-- row), whereas platform_admins has RLS on with zero policies, so nobody can
-- read or write it through the API at all. Rows are added by hand, from the
-- Supabase SQL editor or a migration.
--
-- Every pharmacy is otherwise RLS-limited to its own data, so the portal
-- never queries tables directly: it calls admin_overview() and
-- admin_pharmacy_detail(), SECURITY DEFINER functions that refuse to run
-- unless is_platform_admin() is true for the caller. Read-only by design —
-- nothing here changes a pharmacy's data.
--
-- Sign-in history: Supabase only keeps each user's LATEST sign-in
-- (auth.users.last_sign_in_at), so sign_in_log records every one going
-- forward, filled by a trigger on auth.users. No app.js change was needed.
-- The trigger swallows its own errors, so logging can never block a login.
-- ============================================================================

create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
revoke all on platform_admins from anon, authenticated;

create table if not exists sign_in_log (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  signed_in_at timestamptz not null default now(),
  source       text not null default 'login'   -- 'login' (trigger) | 'backfill' (one-off, from auth.sessions)
);
create index if not exists sign_in_log_user_time on sign_in_log (user_id, signed_in_at desc);
create index if not exists sign_in_log_time on sign_in_log (signed_in_at desc);
alter table sign_in_log enable row level security;
revoke all on sign_in_log from anon, authenticated;

create or replace function log_sign_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is not null
     and (tg_op = 'INSERT' or new.last_sign_in_at is distinct from old.last_sign_in_at) then
    begin
      insert into public.sign_in_log (user_id, signed_in_at) values (new.id, new.last_sign_in_at);
    exception when others then
      null;  -- never let sign-in logging get in the way of a real login
    end;
  end if;
  return new;
end;
$$;
revoke all on function log_sign_in() from public, anon, authenticated;

drop trigger if exists on_auth_user_sign_in on auth.users;
create trigger on_auth_user_sign_in
  after insert or update of last_sign_in_at on auth.users
  for each row execute function public.log_sign_in();

-- One-off backfill so history doesn't start empty: every session Supabase
-- still holds, plus each user's latest sign-in (skipped when a session
-- already covers it to within a minute). Only runs on an empty log.
insert into sign_in_log (user_id, signed_in_at, source)
select x.user_id, x.t, 'backfill' from (
  select s.user_id, s.created_at as t from auth.sessions s where s.user_id is not null and s.created_at is not null
  union all
  select u.id, u.last_sign_in_at from auth.users u
  where u.last_sign_in_at is not null
    and not exists (select 1 from auth.sessions s where s.user_id = u.id
                    and abs(extract(epoch from (s.created_at - u.last_sign_in_at))) < 60)
) x
where not exists (select 1 from sign_in_log);

create or replace function is_platform_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;
revoke all on function is_platform_admin() from public, anon;
grant execute on function is_platform_admin() to authenticated;

-- Internal: one row of usage stats per pharmacy. Not callable through the
-- API by anyone (execute revoked) — only from inside the two admin_*
-- functions below, which do the admin check first.
--
-- Status buckets ("is this pharmacy actually using Pharma?"):
--   setting_up   no drugs and no sales yet, but someone was active in the last 7 days
--   not_started  no drugs and no sales, and nobody active in the last 7 days
--   active_today last activity today (Nairobi time)
--   active_week  last activity within 7 days
--   quiet        last activity 8–30 days ago
--   dormant      no activity for over 30 days
-- "Activity" = the latest of: a staff sign-in, a staff session refresh
-- (app open), a sale, or any stock movement.
create or replace function admin_pharmacy_stats()
returns table (
  id uuid, name text, town text, phone text, created_at timestamptz,
  owner_name text, owner_phone text,
  staff_count integer, active_staff integer,
  last_sign_in_at timestamptz, last_seen_at timestamptz,
  sign_ins_7d integer, sign_ins_30d integer,
  last_sale_at timestamptz, sales_count integer, sales_30d integer, sales_value_30d numeric,
  drugs_count integer, last_stock_at timestamptz,
  last_active_at timestamptz, status text
)
language sql stable
security definer
set search_path = public
as $$
  with staff as (
    select pr.pharmacy_id, pr.id as user_id, pr.full_name, pr.phone, pr.role, pr.active, pr.account_expires_at,
           u.last_sign_in_at,
           (select max(s.updated_at) from auth.sessions s where s.user_id = pr.id) as last_seen_at
    from profiles pr
    left join auth.users u on u.id = pr.id
  ),
  base as (
    select p.id, p.name, p.town, p.phone, p.created_at,
      (select s.full_name from staff s where s.pharmacy_id = p.id and s.role = 'owner' limit 1) as owner_name,
      (select s.phone     from staff s where s.pharmacy_id = p.id and s.role = 'owner' limit 1) as owner_phone,
      (select count(*) from staff s where s.pharmacy_id = p.id)::int as staff_count,
      (select count(*) from staff s where s.pharmacy_id = p.id and s.active
         and (s.account_expires_at is null or s.account_expires_at > now()))::int as active_staff,
      (select max(s.last_sign_in_at) from staff s where s.pharmacy_id = p.id) as last_sign_in_at,
      (select max(s.last_seen_at) from staff s where s.pharmacy_id = p.id) as last_seen_at,
      (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
         where pr.pharmacy_id = p.id and l.signed_in_at > now() - interval '7 days')::int as sign_ins_7d,
      (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
         where pr.pharmacy_id = p.id and l.signed_in_at > now() - interval '30 days')::int as sign_ins_30d,
      (select max(sa.created_at) from sales sa where sa.pharmacy_id = p.id) as last_sale_at,
      (select count(*) from sales sa where sa.pharmacy_id = p.id and not sa.voided)::int as sales_count,
      (select count(*) from sales sa where sa.pharmacy_id = p.id and not sa.voided
         and sa.sold_at > now() - interval '30 days')::int as sales_30d,
      (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p.id and not sa.voided
         and sa.sold_at > now() - interval '30 days') as sales_value_30d,
      (select count(*) from drugs d where d.pharmacy_id = p.id and d.active)::int as drugs_count,
      (select max(a.created_at) from stock_adjustments a where a.pharmacy_id = p.id) as last_stock_at
    from pharmacies p
  ),
  withact as (
    select b.*, greatest(b.last_sign_in_at, b.last_seen_at, b.last_sale_at, b.last_stock_at) as last_active_at
    from base b
  )
  select w.id, w.name, w.town, w.phone, w.created_at, w.owner_name, w.owner_phone,
         w.staff_count, w.active_staff, w.last_sign_in_at, w.last_seen_at,
         w.sign_ins_7d, w.sign_ins_30d, w.last_sale_at, w.sales_count, w.sales_30d, w.sales_value_30d,
         w.drugs_count, w.last_stock_at, w.last_active_at,
         case
           when w.drugs_count = 0 and w.sales_count = 0 then
             case when w.last_active_at > now() - interval '7 days' then 'setting_up' else 'not_started' end
           when (w.last_active_at at time zone 'Africa/Nairobi')::date
                = (now() at time zone 'Africa/Nairobi')::date  then 'active_today'
           when w.last_active_at > now() - interval '7 days'  then 'active_week'
           when w.last_active_at > now() - interval '30 days' then 'quiet'
           else 'dormant'
         end as status
  from withact w;
$$;
revoke all on function admin_pharmacy_stats() from public, anon, authenticated;

-- Everything the portal's overview screen shows, in one call.
create or replace function admin_overview()
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not is_platform_admin() then
    raise exception 'Not authorized';
  end if;

  with st as (select * from admin_pharmacy_stats()),
  events as (
    -- one row per (pharmacy, Nairobi calendar day) with any activity, last 30 days
    select pr.pharmacy_id, (l.signed_in_at at time zone 'Africa/Nairobi')::date as day, 1 as sign_in, 0 as sale
      from sign_in_log l join profiles pr on pr.id = l.user_id
      where l.signed_in_at > now() - interval '31 days'
    union all
    select sa.pharmacy_id, (sa.sold_at at time zone 'Africa/Nairobi')::date, 0, 1
      from sales sa where not sa.voided and sa.sold_at > now() - interval '31 days'
    union all
    select a.pharmacy_id, (a.created_at at time zone 'Africa/Nairobi')::date, 0, 0
      from stock_adjustments a where a.created_at > now() - interval '31 days' and a.type <> 'sale'
  ),
  days as (
    select d::date as day
    from generate_series((now() at time zone 'Africa/Nairobi')::date - 29,
                         (now() at time zone 'Africa/Nairobi')::date, interval '1 day') d
  )
  select jsonb_build_object(
    'generated_at', now(),
    'summary', (select jsonb_build_object(
        'pharmacies',      count(*),
        'new_30d',         count(*) filter (where created_at > now() - interval '30 days'),
        'active_week',     count(*) filter (where status in ('active_today', 'active_week')),
        'active_today',    count(*) filter (where status = 'active_today'),
        'setting_up',      count(*) filter (where status = 'setting_up'),
        'quiet',           count(*) filter (where status = 'quiet'),
        'dormant',         count(*) filter (where status = 'dormant'),
        'not_started',     count(*) filter (where status = 'not_started'),
        'staff',           coalesce(sum(staff_count), 0),
        'sales_30d',       coalesce(sum(sales_30d), 0),
        'sales_value_30d', coalesce(sum(sales_value_30d), 0)
      ) from st),
    'sign_ins_7d',  (select count(*) from sign_in_log where signed_in_at > now() - interval '7 days'),
    'sign_ins_30d', (select count(*) from sign_in_log where signed_in_at > now() - interval '30 days'),
    'pharmacies', coalesce((select jsonb_agg(to_jsonb(st) order by st.last_active_at desc nulls last, st.created_at desc) from st), '[]'::jsonb),
    'recent_sign_ins', coalesce((select jsonb_agg(to_jsonb(x) order by x.signed_in_at desc) from (
        select l.signed_in_at, l.source, pr.full_name, pr.role, pr.phone, p.id as pharmacy_id, p.name as pharmacy_name,
               exists (select 1 from platform_admins pa where pa.user_id = l.user_id) as is_admin
        from sign_in_log l
        join profiles pr on pr.id = l.user_id
        join pharmacies p on p.id = pr.pharmacy_id
        order by l.signed_in_at desc
        limit 25) x), '[]'::jsonb),
    'daily', (select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'active_pharmacies', (select count(distinct e.pharmacy_id) from events e where e.day = d.day),
        'sign_ins', (select coalesce(sum(e.sign_in), 0) from events e where e.day = d.day),
        'sales',    (select coalesce(sum(e.sale), 0) from events e where e.day = d.day)
      ) order by d.day) from days d)
  ) into v;

  return v;
end;
$$;
revoke all on function admin_overview() from public, anon;
grant execute on function admin_overview() to authenticated;

-- One pharmacy's full picture for the portal's detail screen.
create or replace function admin_pharmacy_detail(p_pharmacy_id uuid)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not is_platform_admin() then
    raise exception 'Not authorized';
  end if;
  if not exists (select 1 from pharmacies where id = p_pharmacy_id) then
    raise exception 'Pharmacy not found';
  end if;

  with days as (
    select d::date as day
    from generate_series((now() at time zone 'Africa/Nairobi')::date - 29,
                         (now() at time zone 'Africa/Nairobi')::date, interval '1 day') d
  )
  select jsonb_build_object(
    'pharmacy', (select to_jsonb(st) || jsonb_build_object(
                    'address', p.address, 'email', p.email, 'kra_pin', p.kra_pin)
                 from admin_pharmacy_stats() st join pharmacies p on p.id = st.id
                 where st.id = p_pharmacy_id),
    'counts', jsonb_build_object(
      'batches_in_stock', (select count(*) from batches b where b.pharmacy_id = p_pharmacy_id and b.quantity_remaining > 0),
      'suppliers',        (select count(*) from suppliers s where s.pharmacy_id = p_pharmacy_id),
      'lpos',             (select count(*) from supplier_lpos l where l.pharmacy_id = p_pharmacy_id),
      'expenses',         (select count(*) from expenses e where e.pharmacy_id = p_pharmacy_id and not e.voided),
      'sales_value_all',  (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p_pharmacy_id and not sa.voided),
      'first_sale_at',    (select min(sa.sold_at) from sales sa where sa.pharmacy_id = p_pharmacy_id)
    ),
    'staff', coalesce((select jsonb_agg(to_jsonb(x) order by x.last_sign_in_at desc nulls last) from (
        select pr.id, pr.full_name, pr.phone, pr.role, pr.active, pr.account_expires_at, pr.created_at,
               u.last_sign_in_at,
               (select max(s.updated_at) from auth.sessions s where s.user_id = pr.id) as last_seen_at,
               (select count(*) from sign_in_log l where l.user_id = pr.id
                  and l.signed_in_at > now() - interval '30 days') as sign_ins_30d,
               exists (select 1 from platform_admins pa where pa.user_id = pr.id) as is_admin
        from profiles pr left join auth.users u on u.id = pr.id
        where pr.pharmacy_id = p_pharmacy_id) x), '[]'::jsonb),
    'sign_ins', coalesce((select jsonb_agg(to_jsonb(x) order by x.signed_in_at desc) from (
        select l.signed_in_at, l.source, pr.full_name, pr.role
        from sign_in_log l join profiles pr on pr.id = l.user_id
        where pr.pharmacy_id = p_pharmacy_id
        order by l.signed_in_at desc
        limit 50) x), '[]'::jsonb),
    'daily', (select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'sales', (select count(*) from sales sa where sa.pharmacy_id = p_pharmacy_id and not sa.voided
                    and (sa.sold_at at time zone 'Africa/Nairobi')::date = d.day),
        'sales_value', (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p_pharmacy_id and not sa.voided
                    and (sa.sold_at at time zone 'Africa/Nairobi')::date = d.day),
        'sign_ins', (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
                    where pr.pharmacy_id = p_pharmacy_id and (l.signed_in_at at time zone 'Africa/Nairobi')::date = d.day)
      ) order by d.day) from days d)
  ) into v;

  return v;
end;
$$;
revoke all on function admin_pharmacy_detail(uuid) from public, anon;
grant execute on function admin_pharmacy_detail(uuid) to authenticated;

-- To make an account a platform admin (run once in the Supabase SQL editor):
--   insert into platform_admins (user_id, note)
--   select id, 'Daudi' from profiles where phone = '0705041512';


-- ============================================================================
-- 16. REVIEW FIXES — 2026-10-28
-- ----------------------------------------------------------------------------
-- Applied to the live project as three migrations:
--   quote_sale_and_deterministic_fefo
--   fix_return_and_writeoff_stock_credit_holes
--   fix_cross_tenant_price_write_and_owner_row_guard
--
-- Kept at the end of this file rather than edited into sections 6/7 above, so
-- a fresh install still runs top-to-bottom in one pass and the original
-- definition stays readable next to the fix. Each statement below is a
-- CREATE OR REPLACE of a function defined earlier, so the last one wins.
--
--   1. quote_sale()            NEW — the authoritative price for a cart
--   2. record_sale()           deterministic FEFO order; reject qty <= 0
--   3. record_return()         stop over-returning, and returning a void
--   4. record_write_off()      stop a negative quantity fabricating stock
--   5. record_restock()        stop writing a price onto another tenant's drug
--   6. record_supplier_lpo()   same cross-tenant check, per line item
--   7. profiles guard trigger  protect the literal 'owner' row from a co_owner
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. quote_sale() — what the cart should actually charge
-- ----------------------------------------------------------------------------
-- The Sell screen prices a cart from drugs.default_price, but record_sale
-- prices every line from the batch FEFO lands on, including that batch's
-- markdown (batches.discount_percent). Those two numbers are only equal while
-- a drug has exactly one batch at the current price. The moment there is an
-- older batch left at a different price, or any batch is marked down, the
-- client asks for payments summing to the wrong total and record_sale rejects
-- the whole sale with "Payments do not add up to the sale total".
--
-- This runs record_sale's pricing loop read-only so the client can charge the
-- real number. Same FEFO order, same rounding, same markdown maths — kept
-- byte-for-byte in step with record_sale below.
create or replace function quote_sale(p_pharmacy_id uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_drug_id uuid;
  v_qty integer;
  v_fill integer;
  v_batch record;
  v_take integer;
  v_price numeric(10,2);
  v_line numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', true, 'total', 0, 'lines', '[]'::jsonb);
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;
    v_fill := v_qty;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
    loop
      exit when v_fill <= 0;
      v_take := least(v_batch.quantity_remaining, v_fill);
      v_price := round(v_batch.sell_price * (1 - v_batch.discount_percent / 100.0), 2);
      v_line := round(v_take * v_price, 2);
      v_subtotal := v_subtotal + v_line;
      v_lines := v_lines || jsonb_build_object(
        'drug_id', v_drug_id, 'batch_id', v_batch.id, 'quantity', v_take,
        'unit_price', v_price, 'line_total', v_line,
        'discount_percent', v_batch.discount_percent);
      v_fill := v_fill - v_take;
    end loop;

    if v_fill > 0 then
      return jsonb_build_object('ok', false, 'short_drug_id', v_drug_id,
                                'short_by', v_fill, 'total', v_subtotal, 'lines', v_lines);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'total', v_subtotal, 'lines', v_lines);
end;
$$;

grant execute on function quote_sale(uuid, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- 2. record_sale() — deterministic FEFO order, and reject a bad quantity
-- ----------------------------------------------------------------------------
-- Changes vs the previous version:
--   * `order by expiry_date` alone is ambiguous when two batches share an
--     expiry date, so quote_sale and record_sale could pick different batches
--     (and therefore different prices) for the same cart. Both now tie-break
--     on created_at then id.
--   * a quantity of 0 or less used to fall straight through the fill loop and
--     be silently dropped from the sale instead of being rejected.
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
  v_amount numeric(10,2);
  v_method_count integer;
  v_first_method payment_method;
  v_invoice_seq integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a sale';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
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
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;
    v_qty_remaining_to_fill := v_qty_needed;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
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
    v_amount := (v_payment->>'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every payment line needs an amount greater than zero';
    end if;
    v_payments_total := v_payments_total + v_amount;
    insert into sales_payments (sale_id, pharmacy_id, method, amount, reference)
    values (v_sale_id, p_pharmacy_id, (v_payment->>'method')::payment_method, v_amount, v_payment->>'reference');
  end loop;

  if abs(v_payments_total - v_subtotal) > 0.01 then
    raise exception 'Payments (%) do not add up to the sale total (%)', v_payments_total, v_subtotal;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id order by id limit 1;

  update sales
  set subtotal = v_subtotal,
      vat_amount = round(v_subtotal * v_vat_rate / (100 + v_vat_rate), 2),
      total_amount = v_subtotal,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end
  where id = v_sale_id;

  return v_sale_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. record_return() — the same line could be returned over and over
-- ----------------------------------------------------------------------------
-- The old version only checked p_quantity against sale_items.quantity, never
-- against what had already been returned off that line. Returning 5 of a
-- 5-unit line five times credited 25 units of stock and logged five refunds,
-- with nothing to stop it. It also had no idea whether the sale had since been
-- voided — void_sale refuses to run once a return exists, but not the reverse,
-- so void-then-return credited the same stock twice.
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
  v_already integer;
  v_voided boolean;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a return';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Return quantity must be greater than zero';
  end if;

  -- for update serializes two tills returning the same line at the same moment
  select * into v_item from sale_items
  where id = p_sale_item_id and pharmacy_id = p_pharmacy_id
  for update;
  if not found then
    raise exception 'Sale item not found';
  end if;

  select voided into v_voided from sales where id = v_item.sale_id;
  if coalesce(v_voided, false) then
    raise exception 'That sale was voided — its stock has already been put back, so it cannot be returned as well';
  end if;

  select coalesce(sum(quantity), 0) into v_already
  from returns where sale_item_id = p_sale_item_id;

  if p_quantity + v_already > v_item.quantity then
    raise exception 'Only % of this line can still be returned (% sold, % already returned)',
      v_item.quantity - v_already, v_item.quantity, v_already;
  end if;

  v_refund := round(p_quantity * v_item.unit_price, 2);

  update batches set quantity_remaining = quantity_remaining + p_quantity where id = v_item.batch_id;

  insert into returns (pharmacy_id, sale_item_id, drug_id, batch_id, quantity, reason, refund_amount, created_by)
  values (p_pharmacy_id, p_sale_item_id, v_item.drug_id, v_item.batch_id, p_quantity, p_reason, v_refund, auth.uid());

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'return', p_quantity, p_reason, auth.uid());
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. record_write_off() — a negative quantity added stock instead of removing it
-- ----------------------------------------------------------------------------
-- `quantity_remaining - p_quantity` with a negative p_quantity increases the
-- batch, and the audit row logs it as a positive 'write_off'. Nothing in the
-- old function or the table constraints rejected it, so any pharmacist could
-- invent stock from a write-off form.
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can write off stock';
  end if;
  if p_type not in ('write_off', 'expired_disposal') then
    raise exception 'Invalid write-off type';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Write-off quantity must be greater than zero';
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
-- 5. record_restock() — wrote a price onto a drug in a different pharmacy
-- ----------------------------------------------------------------------------
-- p_drug_id was never checked against p_pharmacy_id. The new batch got the
-- caller's own pharmacy_id (so RLS still hid it), but the function ends with
--   update drugs set default_price = p_sell_price where id = p_drug_id;
-- and runs SECURITY DEFINER, so a hand-made RPC call with another pharmacy's
-- drug id rewrote that pharmacy's shelf price. Validating ownership closes it
-- and turns a silent cross-tenant write into "Drug not found".
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can restock';
  end if;
  if not exists (select 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Drug not found';
  end if;
  if p_supplier_id is not null
     and not exists (select 1 from suppliers where id = p_supplier_id and pharmacy_id = p_pharmacy_id) then
    raise exception 'Supplier not found';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Restock quantity must be greater than zero';
  end if;
  if p_sell_price is null or p_sell_price < 0 then
    raise exception 'Enter a selling price';
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

  update drugs set default_price = p_sell_price where id = p_drug_id and pharmacy_id = p_pharmacy_id;

  return v_batch_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. record_supplier_lpo() — same cross-tenant write, one per line item
-- ----------------------------------------------------------------------------
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a supplier delivery';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
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

    if not exists (select 1 from drugs where id = v_drug_id and pharmacy_id = p_pharmacy_id) then
      raise exception 'Drug not found on this delivery';
    end if;
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

    update drugs set default_price = v_sell_price where id = v_drug_id and pharmacy_id = p_pharmacy_id;

    v_line_total := round(v_quantity * v_cost_price, 2);
    v_total := v_total + v_line_total;

    insert into supplier_lpo_items (lpo_id, pharmacy_id, drug_id, batch_id, quantity, cost_price, line_total)
    values (v_lpo_id, p_pharmacy_id, v_drug_id, v_batch_id, v_quantity, v_cost_price, v_line_total);
  end loop;

  update supplier_lpos set total_amount = v_total where id = v_lpo_id;

  return v_lpo_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. prevent_profile_privilege_escalation() — protect the owner's own row
-- ----------------------------------------------------------------------------
-- co_owner is "full equal access to owner", and the profiles UPDATE policy lets
-- a co_owner update any row in the pharmacy. The old trigger only blocked
-- promotion TO 'owner' — it never stopped a co_owner from demoting or
-- deactivating the literal owner. Since nothing can ever mint a new 'owner'
-- (bootstrap_pharmacy only runs at signup), that locked the real owner out of
-- their own pharmacy permanently, with no way back. The owner's role and
-- active flag are now immutable from the API; an owner can still edit their own
-- name, phone and language.
create or replace function prevent_profile_privilege_escalation()
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


-- ----------------------------------------------------------------------------
-- 17. GRANTS — revoke the default PUBLIC execute (migration
--    revoke_public_execute_and_guard_signup_rpcs + restore_authenticated_execute_grants)
-- ----------------------------------------------------------------------------
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and in
-- Supabase the `anon` role inherits PUBLIC. Section 9 above added a grant to
-- `authenticated` but never took the default one away, so every RPC in this
-- schema was reachable unauthenticated at /rest/v1/rpc/<name>. Section 10's
-- admin functions were the only ones that explicitly revoked it.
--
-- Most were still safe in practice (my_pharmacy_id() is null for a signed-out
-- caller, so "Not authorized for this pharmacy" fires first), but
-- join_pharmacy_with_code was not: SECURITY DEFINER means it reads
-- staff_invites with RLS bypassed, and its only guard asked whether the CALLER
-- already had a profile — false for anon. That made it an oracle an anonymous
-- visitor could use to brute-force 6-character invite codes.
--
-- Note the order: revoking from PUBLIC is not enough on its own, because
-- several functions had no explicit `authenticated` grant and were reaching
-- the app through PUBLIC too — including my_role(), which every RLS policy
-- calls. Revoke, then grant explicitly.
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      -- never callable through the API by design: admin_pharmacy_stats is
      -- internal to admin_overview/admin_pharmacy_detail, log_sign_in is an
      -- auth.users trigger, rls_auto_enable is Supabase's own.
      and p.proname not in ('admin_pharmacy_stats', 'log_sign_in', 'rls_auto_enable')
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- Both signup RPCs now state that they need a signed-in user rather than
-- relying on a null auth.uid() happening to break a later insert.
-- bootstrap_pharmacy also gains the "already in a pharmacy" check that
-- join_pharmacy_with_code already had.
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
  if auth.uid() is null then
    raise exception 'You must be signed in to create a pharmacy';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'Give the pharmacy a name';
  end if;

  insert into pharmacies (name, phone) values (trim(p_name), p_phone) returning id into v_pharmacy_id;

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

create or replace function join_pharmacy_with_code(p_code text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to redeem an invite code';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;

  select * into v_invite from staff_invites
  where code = upper(p_code) and used_at is null and expires_at > now()
  for update;

  if v_invite is null then
    raise exception 'Invalid or expired invite code';
  end if;

  if v_invite.account_expires_hours is not null then
    v_expires_at := now() + (v_invite.account_expires_hours || ' hours')::interval;
  else
    v_expires_at := null;
  end if;

  insert into profiles (id, pharmacy_id, full_name, phone, role, account_expires_at)
  values (auth.uid(), v_invite.pharmacy_id, p_full_name, p_phone, v_invite.role, v_expires_at);

  update staff_invites set used_by = auth.uid(), used_at = now() where id = v_invite.id;

  return v_invite.pharmacy_id;
end;
$$;

grant execute on function bootstrap_pharmacy(text, text, text) to authenticated;
grant execute on function join_pharmacy_with_code(text, text, text) to authenticated;


-- ============================================================================
-- 18. REVIEW FIXES PART 3 — 2026-10-28
-- Applied live as migration: rx_enforcement_atomic_claims_and_audit_reasons
-- (also kept standalone at migrations/2026-10-28_rx_claims_audit.sql).
--   * insurance_claims.status constrained to the four states the UI filters on
--   * record_correction / record_write_off require a reason (audit trail)
--   * record_sale enforces prescription capture server-side, and creates the
--     insurance claim inside the sale's own transaction
-- ============================================================================

-- insurance_claims.status was free text with a default of 'pending' and no
-- constraint, so a typo ('Paid', 'submited') silently created a status the
-- Reports filter would never match again.
alter table insurance_claims drop constraint if exists insurance_claims_status_check;
update insurance_claims set status = lower(trim(status))
where status is distinct from lower(trim(status));
update insurance_claims set status = 'pending'
where status not in ('pending', 'submitted', 'paid', 'rejected');
alter table insurance_claims
  add constraint insurance_claims_status_check
  check (status in ('pending', 'submitted', 'paid', 'rejected'));

-- record_correction(): a correction overwrites a counted quantity outright,
-- which is the easiest way in the whole app to make stock appear or vanish.
-- The reason was optional and the app sent null when the box was left blank,
-- so the stock_adjustments audit row — the thing a PPB GSDP inspection
-- actually reads — recorded the change with no explanation at all.
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can correct stock';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'Quantity cannot be negative';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Give a reason for the correction — it goes on the stock audit trail';
  end if;

  select drug_id, quantity_remaining into v_drug_id, v_old_qty
  from batches where id = p_batch_id and pharmacy_id = p_pharmacy_id
  for update;

  if v_drug_id is null then
    raise exception 'Batch not found';
  end if;

  update batches set quantity_remaining = p_new_quantity where id = p_batch_id;

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
  values (p_pharmacy_id, v_drug_id, p_batch_id, 'correction', p_new_quantity - v_old_qty, trim(p_reason), auth.uid());
end;
$$;

-- record_write_off(): same audit-trail argument — stock leaves the building
-- and the adjustment row is the only record of why.
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
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can write off stock';
  end if;
  if p_type not in ('write_off', 'expired_disposal') then
    raise exception 'Invalid write-off type';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Write-off quantity must be greater than zero';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Give a reason for the write-off — it goes on the stock audit trail';
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
  values (p_pharmacy_id, v_drug_id, p_batch_id, p_type, -p_quantity, trim(p_reason), auth.uid());
end;
$$;

-- record_sale(): two more gaps.
--
-- (a) Prescription capture was enforced only in the browser. openRxCapture()
--     demands a patient name before an Rx drug reaches the cart, but nothing
--     stopped a direct RPC call from recording an Rx sale with no patient at
--     all — and for a prescription-only medicine that record is a legal
--     requirement, not a nicety.
--
-- (b) The insurance claim was created by a SECOND statement from the browser
--     after record_sale returned. If that insert failed — connection dropped
--     at the till, tab closed — the sale was already committed and the claim
--     simply never existed, so the pharmacy silently lost the money it was
--     owed. It now happens inside the same transaction as the sale, and for
--     every insurance payment line rather than only the first one.
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
  v_drug record;
  v_patient text;
  v_qty_needed integer;
  v_qty_remaining_to_fill integer;
  v_batch record;
  v_take integer;
  v_effective_price numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_line_total numeric(10,2);
  v_vat_rate numeric(5,2);
  v_payments_total numeric(10,2) := 0;
  v_amount numeric(10,2);
  v_method payment_method;
  v_reference text;
  v_method_count integer;
  v_first_method payment_method;
  v_invoice_seq integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a sale';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
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
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;

    select id, name, is_prescription into v_drug
    from drugs where id = v_drug_id and pharmacy_id = p_pharmacy_id;
    if v_drug.id is null then
      raise exception 'Drug not found';
    end if;

    v_patient := nullif(trim(coalesce(v_item->>'patient_name', '')), '');
    if v_drug.is_prescription and v_patient is null then
      raise exception '% is a prescription-only medicine — record the patient''s name', v_drug.name;
    end if;

    v_qty_remaining_to_fill := v_qty_needed;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
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
              v_patient, nullif(trim(coalesce(v_item->>'prescriber_name', '')), ''));

      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, ref_sale_id, created_by)
      values (p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take, v_sale_id, auth.uid());

      v_qty_remaining_to_fill := v_qty_remaining_to_fill - v_take;
    end loop;

    if v_qty_remaining_to_fill > 0 then
      raise exception 'Not enough stock for %: short by %', v_drug.name, v_qty_remaining_to_fill;
    end if;
  end loop;

  if abs(v_subtotal) < 0.01 then
    raise exception 'Sale total is zero';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_amount := (v_payment->>'amount')::numeric;
    v_method := (v_payment->>'method')::payment_method;
    v_reference := nullif(trim(coalesce(v_payment->>'reference', '')), '');
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every payment line needs an amount greater than zero';
    end if;
    v_payments_total := v_payments_total + v_amount;

    insert into sales_payments (sale_id, pharmacy_id, method, amount, reference)
    values (v_sale_id, p_pharmacy_id, v_method, v_amount, v_reference);

    -- the claim is part of the sale, not a follow-up round trip
    if v_method = 'insurance' then
      insert into insurance_claims (pharmacy_id, sale_id, scheme, amount, status, created_by)
      values (p_pharmacy_id, v_sale_id,
              coalesce(v_reference, nullif(trim(coalesce(p_insurance_scheme, '')), ''), 'Unspecified'),
              v_amount, 'pending', auth.uid());
    end if;
  end loop;

  if abs(v_payments_total - v_subtotal) > 0.01 then
    raise exception 'Payments (%) do not add up to the sale total (%)', v_payments_total, v_subtotal;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id order by id limit 1;

  update sales
  set subtotal = v_subtotal,
      vat_amount = round(v_subtotal * v_vat_rate / (100 + v_vat_rate), 2),
      total_amount = v_subtotal,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end
  where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function record_sale(uuid, jsonb, jsonb, text, text) to authenticated;
grant execute on function record_correction(uuid, uuid, integer, text) to authenticated;
grant execute on function record_write_off(uuid, uuid, integer, text, adjustment_type) to authenticated;

-- ---------------------------------------------------------------------------
-- 2026-10-29 additions (also in migrations/): nightly housekeeping and the
-- dashboard's supplier-debt summary.
-- ---------------------------------------------------------------------------

-- 2026-10-29: nightly housekeeping, kept deliberately tiny.
--
-- Two short-lived tables only ever need their last day or two of rows:
--   phone_otps              one-time codes (expire in minutes)
--   password_reset_attempts rate-limit hits (the app only looks back about an hour)
-- Left alone they just grow. This function deletes rows older than two days.
-- It does NOT touch sign_in_log (the admin portal reports on it) or any
-- pharmacy data.
--
-- Cost: both deletes are range deletes on small tables; on a quiet project the
-- whole run is a few milliseconds. It runs once a day at 00:30 UTC (03:30 in
-- Nairobi), when nobody is selling.
--
-- Also counts as real database activity every night, which helps keep a
-- free-tier project from being paused for inactivity (the daily web ping from
-- netlify/functions/keep-alive.js is the main safeguard; this is a second one
-- that does not depend on Netlify).

create or replace function public.housekeeping_daily()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_otps int;
  n_attempts int;
begin
  delete from public.phone_otps
   where created_at < now() - interval '2 days';
  get diagnostics n_otps = row_count;

  -- password_reset_attempts exists on the live project but is not created by
  -- schema.sql, so check for it instead of assuming (a fresh test database
  -- would otherwise fail here).
  n_attempts := 0;
  if to_regclass('public.password_reset_attempts') is not null then
    execute 'delete from public.password_reset_attempts where attempted_at < now() - interval ''2 days''';
    get diagnostics n_attempts = row_count;
  end if;

  return jsonb_build_object('otps_deleted', n_otps, 'reset_attempts_deleted', n_attempts, 'ran_at', now());
end;
$$;

-- Nobody signed in to the app (or the public API) may run it; only the
-- database's own scheduler and the owner of the project (SQL editor).
revoke all on function public.housekeeping_daily() from public, anon, authenticated;

-- Schedule it with pg_cron when that extension is available. Wrapped so the
-- same file also loads on a plain local Postgres (used by the tests), where
-- pg_cron does not exist.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'pharma-housekeeping';
    perform cron.schedule('pharma-housekeeping', '30 0 * * *', 'select public.housekeeping_daily()');
  end if;
end
$$;

-- 2026-10-29: faster dashboard.
--
-- The dashboard used to download every supplier, every supplier delivery (LPO)
-- and every supplier payment, then add them up in the browser to find "Debt
-- owed". That is three requests whose size grows with every delivery and
-- payment ever recorded. This function does the same sum inside the database
-- and returns one small row: the total owed and how many suppliers are owed.
--
-- Same rule as before, supplier by supplier:
--   balance = opening_balance + all deliveries - all payments
-- and only balances above 0.5 count as owed.
--
-- security invoker: row level security still decides what the caller can see,
-- exactly as when the browser read the tables directly.

create or replace function public.supplier_owed_summary(p_pharmacy_id uuid)
returns table (owed numeric, owed_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  with bal as (
    select s.opening_balance
           + coalesce((select sum(l.total_amount) from supplier_lpos l
                        where l.supplier_id = s.id and l.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(p.amount) from supplier_payments p
                        where p.supplier_id = s.id and p.pharmacy_id = p_pharmacy_id), 0) as b
      from suppliers s
     where s.pharmacy_id = p_pharmacy_id
  )
  select coalesce(sum(b) filter (where b > 0.5), 0)::numeric,
         (count(*) filter (where b > 0.5))::integer
    from bal
$$;

revoke all on function public.supplier_owed_summary(uuid) from public, anon;
grant execute on function public.supplier_owed_summary(uuid) to authenticated;

create index if not exists supplier_payments_pharmacy_supplier_idx
  on supplier_payments (pharmacy_id, supplier_id);

-- ============================================================================
-- 2026-10-29 modules: customers & credit (kopa), controlled-drug register,
-- stock take, refills and SMS. Also in migrations/ as part A then part B (the
-- new enum values must be committed before part B can use them; here they
-- simply run first).
-- ============================================================================

-- 2026-10-29 (part A of 2): new enum values.
--
-- Run this on its own, BEFORE 2026-10-29_b_credit_controlled_stocktake_refills_sms.sql.
-- Postgres will not let a value added with ALTER TYPE be used in the same
-- transaction, so it has to be committed first.
--
--   payment_method 'credit'     a sale (or part of one) put on the customer's account (kopa)
--   adjustment_type 'stock_take' a stock adjustment made by approving a stock take
--
-- Safe to re-run.

alter type payment_method add value if not exists 'credit';
alter type adjustment_type add value if not exists 'stock_take';

-- ============================================================================
-- PHARMA — 2026-10-29 (part B of 2)
-- Credit customers (kopa), controlled-drug register, stock take, refills + SMS.
--
-- Run 2026-10-29_a_enum_values.sql FIRST (it adds payment_method 'credit' and
-- adjustment_type 'stock_take', which must be committed before they are used).
-- Safe to re-run.
--
-- Design rules used throughout:
--   * Every new table is READ by any member of the pharmacy (row level security)
--     but WRITTEN only through the functions below, which check the caller's
--     role. The API roles get no insert/update/delete on them.
--   * Money and stock movements are never edited, only reversed by a new row.
--   * "Today" means Nairobi's today (today_ke()), not the database's UTC date.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Small helpers
-- ----------------------------------------------------------------------------

create or replace function today_ke()
returns date
language sql
stable
as $$ select (now() at time zone 'Africa/Nairobi')::date $$;

-- 0712 345 678 / +254712345678 / 712345678  ->  254712345678. Raises on junk.
create or replace function normalize_ke_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d = '' then
    return null;
  elsif d ~ '^0[17][0-9]{8}$' then
    return '254' || substr(d, 2);
  elsif d ~ '^254[17][0-9]{8}$' then
    return d;
  elsif d ~ '^[17][0-9]{8}$' then
    return '254' || d;
  end if;
  raise exception 'Enter a valid Kenyan phone number, for example 0712 345 678';
end;
$$;

-- ----------------------------------------------------------------------------
-- 1. CUSTOMERS and CREDIT (kopa)
-- ----------------------------------------------------------------------------

create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  name          text not null check (char_length(trim(name)) between 1 and 120),
  phone         text,                                 -- stored as 2547XXXXXXXX
  credit_limit  numeric(10,2) check (credit_limit is null or credit_limit >= 0),  -- null = no limit set
  notes         text,
  sms_ok        boolean not null default true,        -- false = never text this person
  active        boolean not null default true,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);
create index if not exists customers_pharmacy_idx on customers (pharmacy_id, active, name);
create unique index if not exists customers_phone_uniq on customers (pharmacy_id, phone) where phone is not null;
create index if not exists customers_created_by_idx on customers (created_by);

alter table sales add column if not exists customer_id uuid references customers(id) on delete set null;
create index if not exists sales_customer_idx on sales (customer_id) where customer_id is not null;

-- Money a customer pays back against what they owe (balance is not per
-- invoice: it is simply credit given minus payments and credit notes).
create table if not exists customer_payments (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete restrict,
  kind         text not null default 'payment' check (kind in ('payment', 'credit_note')),
  amount       numeric(10,2) not null check (amount > 0),
  method       text check (method in ('cash', 'mpesa', 'bank', 'other')),
  reference    text,
  note         text,
  sale_id      uuid references sales(id) on delete set null,   -- set on a credit note (a return against a credit sale)
  paid_at      timestamptz not null default now(),
  voided       boolean not null default false,
  voided_at    timestamptz,
  void_reason  text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists customer_payments_customer_idx on customer_payments (customer_id, paid_at desc);
create index if not exists customer_payments_pharmacy_idx on customer_payments (pharmacy_id);
create index if not exists customer_payments_sale_idx on customer_payments (sale_id) where sale_id is not null;
create index if not exists customer_payments_created_by_idx on customer_payments (created_by);

-- What a customer owes right now (credit given on sales that were not voided,
-- minus payments and credit notes that were not voided). Negative = they have
-- paid more than they owe.
create or replace function customer_balance(p_customer_id uuid)
returns numeric
language sql
stable
as $$
  select coalesce((select sum(sp.amount)
                     from sales_payments sp
                     join sales s on s.id = sp.sale_id
                    where s.customer_id = p_customer_id
                      and sp.method = 'credit'
                      and not s.voided), 0)
       - coalesce((select sum(cp.amount)
                     from customer_payments cp
                    where cp.customer_id = p_customer_id
                      and not cp.voided), 0)
$$;

create or replace view v_customer_balances with (security_invoker = true) as
select c.id as customer_id, c.pharmacy_id, c.name, c.phone, c.credit_limit, c.notes,
       c.sms_ok, c.active, c.created_at,
       cr.credit_given, pa.paid, cr.credit_given - pa.paid as balance,
       cr.last_credit_at, pa.last_payment_at
  from customers c
  left join lateral (
    select coalesce(sum(sp.amount), 0) as credit_given, max(s.sold_at) as last_credit_at
      from sales_payments sp join sales s on s.id = sp.sale_id
     where s.customer_id = c.id and sp.method = 'credit' and not s.voided
  ) cr on true
  left join lateral (
    select coalesce(sum(cp.amount), 0) as paid, max(cp.paid_at) as last_payment_at
      from customer_payments cp
     where cp.customer_id = c.id and not cp.voided
  ) pa on true;

alter table customers enable row level security;
alter table customer_payments enable row level security;
drop policy if exists "tenant read customers" on customers;
create policy "tenant read customers" on customers for select using (pharmacy_id = my_pharmacy_id());
drop policy if exists "tenant read customer_payments" on customer_payments;
create policy "tenant read customer_payments" on customer_payments for select using (pharmacy_id = my_pharmacy_id());
revoke insert, update, delete on customers, customer_payments from authenticated, anon;
grant select on customers, customer_payments to authenticated;
grant select on v_customer_balances to authenticated;

-- Add or edit a customer. Sellers can add one at the till and fix a name or
-- phone; only the owner or a pharmacist can set or change a credit limit.
create or replace function save_customer(
  p_pharmacy_id uuid,
  p_name text,
  p_phone text default null,
  p_credit_limit numeric default null,
  p_notes text default null,
  p_id uuid default null,
  p_sms_ok boolean default true,
  p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_old customers%rowtype;
  v_id uuid;
  v_role user_role := my_role();
  v_dupe text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if v_role not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can add customers';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'Enter the customer''s name';
  end if;
  if p_credit_limit is not null and p_credit_limit < 0 then
    raise exception 'The credit limit cannot be negative';
  end if;
  v_phone := normalize_ke_phone(p_phone);
  if v_phone is not null then
    select name into v_dupe from customers
     where pharmacy_id = p_pharmacy_id and phone = v_phone and id is distinct from p_id;
    if v_dupe is not null then
      raise exception 'That phone number already belongs to % in your customer list', v_dupe;
    end if;
  end if;

  if p_id is null then
    if v_role = 'attendant' and p_credit_limit is not null then
      raise exception 'Only the owner or a pharmacist can set a credit limit';
    end if;
    insert into customers (pharmacy_id, name, phone, credit_limit, notes, sms_ok, created_by)
    values (p_pharmacy_id, trim(p_name), v_phone, p_credit_limit, nullif(trim(coalesce(p_notes, '')), ''),
            coalesce(p_sms_ok, true), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into v_old from customers where id = p_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Customer not found';
  end if;
  if v_role = 'attendant' and (p_credit_limit is distinct from v_old.credit_limit
                              or coalesce(p_active, true) is distinct from v_old.active) then
    raise exception 'Only the owner or a pharmacist can change a credit limit or close an account';
  end if;
  if coalesce(p_active, true) = false and customer_balance(p_id) > 0.5 then
    raise exception 'This customer still owes %. Collect or write it off before closing the account.',
      round(customer_balance(p_id), 2);
  end if;

  update customers
     set name = trim(p_name), phone = v_phone, credit_limit = p_credit_limit,
         notes = nullif(trim(coalesce(p_notes, '')), ''), sms_ok = coalesce(p_sms_ok, true),
         active = coalesce(p_active, true)
   where id = p_id;
  return p_id;
end;
$$;

-- Customer pays some of what they owe.
create or replace function record_customer_payment(
  p_pharmacy_id uuid,
  p_customer_id uuid,
  p_amount numeric,
  p_method text default 'cash',
  p_reference text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust customers%rowtype;
  v_bal numeric;
  v_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a customer payment';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero';
  end if;
  if coalesce(p_method, 'cash') not in ('cash', 'mpesa', 'bank', 'other') then
    raise exception 'Choose cash, M-Pesa, bank or other';
  end if;

  select * into v_cust from customers where id = p_customer_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Customer not found';
  end if;
  v_bal := customer_balance(p_customer_id);
  if p_amount > v_bal + 0.005 then
    raise exception '% owes only %. Enter that amount or less.', v_cust.name, greatest(round(v_bal, 2), 0);
  end if;

  insert into customer_payments (pharmacy_id, customer_id, kind, amount, method, reference, note, created_by)
  values (p_pharmacy_id, p_customer_id, 'payment', round(p_amount, 2), coalesce(p_method, 'cash'),
          nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Undo a payment entered by mistake. The row stays, marked voided.
create or replace function void_customer_payment(p_pharmacy_id uuid, p_payment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay customer_payments%rowtype;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can reverse a customer payment';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Give a reason for reversing this payment';
  end if;
  select * into v_pay from customer_payments where id = p_payment_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Payment not found';
  end if;
  if v_pay.kind <> 'payment' then
    raise exception 'This entry came from a return. Reverse the return instead.';
  end if;
  if v_pay.voided then
    raise exception 'This payment is already reversed';
  end if;
  update customer_payments
     set voided = true, voided_at = now(), void_reason = trim(p_reason)
   where id = p_payment_id;
end;
$$;

-- Statement for one customer: every credit sale and every payment, oldest
-- first, with a running balance. (Voided sales and payments are listed but do
-- not count.)
create or replace function customer_statement(p_pharmacy_id uuid, p_customer_id uuid)
returns table (
  entry_at timestamptz,
  kind text,
  ref text,
  amount numeric,
  note text,
  voided boolean,
  running numeric,
  pay_id uuid,
  sale_id uuid
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  return query
  with lines as (
    select s.sold_at as entry_at,
           'credit'::text as kind,
           coalesce(s.invoice_number, 'Sale') as ref,
           sp.amount as amount,
           null::text as note,
           s.voided as voided,
           sp.amount as delta_raw,
           null::uuid as pay_id,
           s.id as sale_id
      from sales_payments sp join sales s on s.id = sp.sale_id
     where s.customer_id = p_customer_id and s.pharmacy_id = p_pharmacy_id and sp.method = 'credit'
    union all
    select cp.paid_at, cp.kind, coalesce(cp.reference, initcap(coalesce(cp.method, ''))), cp.amount,
           coalesce(cp.note, cp.void_reason), cp.voided, -cp.amount, cp.id, cp.sale_id
      from customer_payments cp
     where cp.customer_id = p_customer_id and cp.pharmacy_id = p_pharmacy_id
  )
  select l.entry_at, l.kind, l.ref, l.amount, l.note, l.voided,
         sum(case when l.voided then 0 else l.delta_raw end) over (order by l.entry_at, l.kind, l.ref rows unbounded preceding),
         l.pay_id, l.sale_id
    from lines l
   order by l.entry_at, l.kind, l.ref;
end;
$$;

grant execute on function customer_balance(uuid) to authenticated;
revoke all on function save_customer(uuid, text, text, numeric, text, uuid, boolean, boolean) from public, anon;
grant execute on function save_customer(uuid, text, text, numeric, text, uuid, boolean, boolean) to authenticated;
revoke all on function record_customer_payment(uuid, uuid, numeric, text, text, text) from public, anon;
grant execute on function record_customer_payment(uuid, uuid, numeric, text, text, text) to authenticated;
revoke all on function void_customer_payment(uuid, uuid, text) from public, anon;
grant execute on function void_customer_payment(uuid, uuid, text) to authenticated;
revoke all on function customer_statement(uuid, uuid) from public, anon;
grant execute on function customer_statement(uuid, uuid) to authenticated;
revoke all on function today_ke() from public, anon;
grant execute on function today_ke() to authenticated;
revoke all on function normalize_ke_phone(text) from public, anon;
grant execute on function normalize_ke_phone(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. CONTROLLED DRUGS — classification, register and an unchangeable ledger
-- ----------------------------------------------------------------------------

alter table drugs add column if not exists control_class text not null default 'none'
  check (control_class in ('none', 'dda', 'psy'));       -- dda = Dangerous Drugs Act, psy = psychotropic
alter table sale_items add column if not exists rx_number text;

create table if not exists controlled_ledger (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,     -- strict order, even within one second
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  drug_id        uuid not null references drugs(id),
  batch_id       uuid references batches(id) on delete set null,
  entry_at       timestamptz not null default now(),
  kind           text not null check (kind in ('opening', 'restock', 'sale', 'return', 'void', 'correction',
                                               'write_off', 'expired_disposal', 'stock_take')),
  quantity_delta integer not null,
  balance_after  integer not null,                        -- total on the shelf, all batches, right after this entry
  patient_name   text,
  prescriber_name text,
  rx_number      text,
  ref_sale_id    uuid references sales(id) on delete set null,
  note           text,
  created_by     uuid references profiles(id)
);
create index if not exists controlled_ledger_drug_idx on controlled_ledger (drug_id, seq desc);
create index if not exists controlled_ledger_pharmacy_idx on controlled_ledger (pharmacy_id, entry_at desc);
create index if not exists controlled_ledger_batch_idx on controlled_ledger (batch_id) where batch_id is not null;
create index if not exists controlled_ledger_sale_idx on controlled_ledger (ref_sale_id) where ref_sale_id is not null;
create index if not exists controlled_ledger_created_by_idx on controlled_ledger (created_by);

alter table controlled_ledger enable row level security;
drop policy if exists "tenant read controlled_ledger" on controlled_ledger;
create policy "tenant read controlled_ledger" on controlled_ledger for select using (pharmacy_id = my_pharmacy_id());
revoke insert, update, delete on controlled_ledger from authenticated, anon;
grant select on controlled_ledger to authenticated;

-- Internal: append one ledger row. Called after the batch quantity has already
-- been changed, so balance_after is simply what is on the shelf now.
create or replace function controlled_ledger_add(
  p_pharmacy_id uuid, p_drug_id uuid, p_batch_id uuid, p_kind text, p_delta integer,
  p_patient text, p_prescriber text, p_rx text, p_sale_id uuid, p_note text, p_user uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into controlled_ledger (pharmacy_id, drug_id, batch_id, kind, quantity_delta, balance_after,
                                 patient_name, prescriber_name, rx_number, ref_sale_id, note, created_by)
  values (p_pharmacy_id, p_drug_id, p_batch_id, p_kind, p_delta,
          coalesce((select sum(quantity_remaining) from batches where drug_id = p_drug_id), 0)::integer,
          p_patient, p_prescriber, p_rx, p_sale_id, p_note, p_user);
end;
$$;
revoke all on function controlled_ledger_add(uuid, uuid, uuid, text, integer, text, text, text, uuid, text, uuid)
  from public, anon, authenticated;

-- Every stock movement except a sale (record_sale writes its own row, because
-- only it knows the patient and prescriber) is copied into the ledger for a
-- controlled drug, whichever screen or function caused it.
create or replace function controlled_ledger_from_adjustment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.type::text = 'sale' then
    return NEW;
  end if;
  if exists (select 1 from drugs where id = NEW.drug_id and control_class <> 'none') then
    perform controlled_ledger_add(NEW.pharmacy_id, NEW.drug_id, NEW.batch_id, NEW.type::text, NEW.quantity_delta,
                                  null, null, null, NEW.ref_sale_id, NEW.reason, NEW.created_by);
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_controlled_ledger_from_adjustment on stock_adjustments;
create trigger trg_controlled_ledger_from_adjustment
  after insert on stock_adjustments
  for each row execute function controlled_ledger_from_adjustment();

-- control_class can only be changed through set_drug_control() below. The
-- drugs table itself is writable by every member of the pharmacy, so without
-- this a seller could simply switch a drug to "not controlled" and sell it
-- off the books.
create or replace function protect_drug_control_class()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.control_class <> 'none' and coalesce(current_setting('pharma.control_change', true), '') <> 'on' then
      raise exception 'Mark a drug as controlled from its detail screen, not when it is created';
    end if;
  elsif NEW.control_class is distinct from OLD.control_class
        and coalesce(current_setting('pharma.control_change', true), '') <> 'on' then
    raise exception 'Only the owner or a pharmacist can change whether a drug is controlled';
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_protect_drug_control_class on drugs;
create trigger trg_protect_drug_control_class
  before insert or update of control_class on drugs
  for each row execute function protect_drug_control_class();

-- Mark a drug as controlled (or not). A controlled drug always needs a
-- prescription. Turning it on writes an opening row so the ledger starts from
-- what is really on the shelf.
create or replace function set_drug_control(p_pharmacy_id uuid, p_drug_id uuid, p_class text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug drugs%rowtype;
  v_cur integer;
  v_last integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can change whether a drug is controlled';
  end if;
  if p_class is null or p_class not in ('none', 'dda', 'psy') then
    raise exception 'Choose not controlled, dangerous drug (DDA) or psychotropic';
  end if;
  select * into v_drug from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Drug not found';
  end if;
  if v_drug.control_class = p_class then
    return;
  end if;

  perform set_config('pharma.control_change', 'on', true);
  update drugs
     set control_class = p_class,
         is_prescription = case when p_class <> 'none' then true else is_prescription end
   where id = p_drug_id;
  perform set_config('pharma.control_change', 'off', true);

  if p_class <> 'none' then
    select coalesce(sum(quantity_remaining), 0)::integer into v_cur from batches where drug_id = p_drug_id;
    select balance_after into v_last from controlled_ledger where drug_id = p_drug_id order by seq desc limit 1;
    if v_last is null or v_last <> v_cur then
      perform controlled_ledger_add(p_pharmacy_id, p_drug_id, null, 'opening', v_cur - coalesce(v_last, 0),
                                    null, null, null, null,
                                    case when v_last is null then 'Opening balance when marked controlled'
                                         else 'Balance re-checked when marked controlled again' end,
                                    auth.uid());
    end if;
  end if;
end;
$$;
revoke all on function set_drug_control(uuid, uuid, text) from public, anon;
grant execute on function set_drug_control(uuid, uuid, text) to authenticated;

-- Register: one line per controlled drug, with the ledger balance next to what
-- is physically recorded on the shelf. They only differ if someone changed a
-- batch outside the normal screens, which is exactly what an inspector asks.
create or replace view v_controlled_register with (security_invoker = true) as
select d.id as drug_id, d.pharmacy_id, d.name, d.unit, d.control_class,
       coalesce((select sum(b.quantity_remaining) from batches b where b.drug_id = d.id), 0)::bigint as shelf_qty,
       coalesce((select l.balance_after from controlled_ledger l where l.drug_id = d.id order by l.seq desc limit 1), 0)::bigint as ledger_qty,
       (select max(l.entry_at) from controlled_ledger l where l.drug_id = d.id) as last_movement
  from drugs d
 where d.control_class <> 'none' and d.active;
grant select on v_controlled_register to authenticated;

-- Show control_class to the screens that read v_drug_stock (appended last, as
-- CREATE OR REPLACE VIEW requires).
create or replace view v_drug_stock with (security_invoker = true) as
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
  coalesce(bool_or(b.expiry_unknown) filter (where b.quantity_remaining > 0), false) as has_unknown_expiry,
  d.control_class
from drugs d
left join batches b on b.drug_id = d.id
where d.active
group by d.id;
grant select on v_drug_stock to authenticated;

-- ----------------------------------------------------------------------------
-- 3. STOCK TAKE — count the shelf, compare, approve the differences
-- ----------------------------------------------------------------------------

create table if not exists stock_takes (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  label               text not null default 'Stock take',
  status              text not null default 'open' check (status in ('open', 'approved', 'cancelled')),
  created_by          uuid references profiles(id),
  created_at          timestamptz not null default now(),
  approved_by         uuid references profiles(id),
  approved_at         timestamptz,
  total_cost_variance numeric(12,2)                       -- negative = stock lost, valued at cost
);
create unique index if not exists stock_takes_one_open on stock_takes (pharmacy_id) where status = 'open';
create index if not exists stock_takes_pharmacy_idx on stock_takes (pharmacy_id, created_at desc);
create index if not exists stock_takes_created_by_idx on stock_takes (created_by);
create index if not exists stock_takes_approved_by_idx on stock_takes (approved_by);

create table if not exists stock_take_items (
  id             uuid primary key default gen_random_uuid(),
  take_id        uuid not null references stock_takes(id) on delete cascade,
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  drug_id        uuid not null references drugs(id),
  system_qty     integer not null,                         -- what the system said at the moment of counting
  counted_qty    integer not null check (counted_qty >= 0),
  reason         text check (reason in ('damaged', 'expired', 'missing', 'found', 'other')),
  applied_delta  integer,                                  -- set when the take is approved
  counted_by     uuid references profiles(id),
  counted_at     timestamptz not null default now(),
  unique (take_id, drug_id)
);
create index if not exists stock_take_items_pharmacy_idx on stock_take_items (pharmacy_id);
create index if not exists stock_take_items_drug_idx on stock_take_items (drug_id);
create index if not exists stock_take_items_counted_by_idx on stock_take_items (counted_by);

alter table stock_takes enable row level security;
alter table stock_take_items enable row level security;
drop policy if exists "tenant read stock_takes" on stock_takes;
create policy "tenant read stock_takes" on stock_takes for select using (pharmacy_id = my_pharmacy_id());
drop policy if exists "tenant read stock_take_items" on stock_take_items;
create policy "tenant read stock_take_items" on stock_take_items for select using (pharmacy_id = my_pharmacy_id());
revoke insert, update, delete on stock_takes, stock_take_items from authenticated, anon;
grant select on stock_takes, stock_take_items to authenticated;

create or replace function start_stock_take(p_pharmacy_id uuid, p_label text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can start a stock take';
  end if;
  if exists (select 1 from stock_takes where pharmacy_id = p_pharmacy_id and status = 'open') then
    raise exception 'A stock take is already open. Finish or cancel it first.';
  end if;
  insert into stock_takes (pharmacy_id, label, created_by)
  values (p_pharmacy_id, coalesce(nullif(trim(coalesce(p_label, '')), ''), 'Stock take ' || to_char(today_ke(), 'DD Mon YYYY')), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Record (or re-record) what was counted for one drug. The system figure is
-- read right now, so sales made while counting do not look like losses.
create or replace function stock_take_count(p_pharmacy_id uuid, p_take_id uuid, p_drug_id uuid, p_counted integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take stock_takes%rowtype;
  v_sys integer;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can count stock';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'The count cannot be negative';
  end if;
  select * into v_take from stock_takes where id = p_take_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Stock take not found';
  end if;
  if v_take.status <> 'open' then
    raise exception 'This stock take is already closed';
  end if;
  if not exists (select 1 from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id and active) then
    raise exception 'Drug not found';
  end if;

  select coalesce(sum(quantity_remaining), 0)::integer into v_sys from batches where drug_id = p_drug_id;

  insert into stock_take_items (take_id, pharmacy_id, drug_id, system_qty, counted_qty, counted_by)
  values (p_take_id, p_pharmacy_id, p_drug_id, v_sys, p_counted, auth.uid())
  on conflict (take_id, drug_id)
  do update set system_qty = excluded.system_qty, counted_qty = excluded.counted_qty,
                counted_by = excluded.counted_by, counted_at = now(), reason = null;
  return jsonb_build_object('system_qty', v_sys, 'counted_qty', p_counted, 'difference', p_counted - v_sys);
end;
$$;

create or replace function stock_take_remove_count(p_pharmacy_id uuid, p_take_id uuid, p_drug_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can count stock';
  end if;
  if not exists (select 1 from stock_takes where id = p_take_id and pharmacy_id = p_pharmacy_id and status = 'open') then
    raise exception 'This stock take is not open';
  end if;
  delete from stock_take_items where take_id = p_take_id and drug_id = p_drug_id and pharmacy_id = p_pharmacy_id;
end;
$$;

create or replace function cancel_stock_take(p_pharmacy_id uuid, p_take_id uuid)
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
    raise exception 'Only the owner or a pharmacist can cancel a stock take';
  end if;
  update stock_takes set status = 'cancelled'
   where id = p_take_id and pharmacy_id = p_pharmacy_id and status = 'open';
  if not found then
    raise exception 'This stock take is not open';
  end if;
end;
$$;

-- Approve: every difference needs a reason (p_reasons maps drug id -> reason),
-- then the shelf and the system are made to agree. A shortage comes off the
-- soonest-expiring batches first; found stock goes onto the latest in-date batch.
-- The change applied is (counted - system at the time of counting), so any
-- sale made after the count is left alone.
create or replace function approve_stock_take(p_pharmacy_id uuid, p_take_id uuid, p_reasons jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take stock_takes%rowtype;
  v_item record;
  v_delta integer;
  v_reason text;
  v_batch record;
  v_need integer;
  v_take_qty integer;
  v_avail integer;
  v_cost numeric(12,2) := 0;
  v_changed integer := 0;
  v_name text;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can approve a stock take';
  end if;
  select * into v_take from stock_takes where id = p_take_id and pharmacy_id = p_pharmacy_id for update;
  if not found then
    raise exception 'Stock take not found';
  end if;
  if v_take.status <> 'open' then
    raise exception 'This stock take is already closed';
  end if;
  if not exists (select 1 from stock_take_items where take_id = p_take_id) then
    raise exception 'Nothing has been counted yet';
  end if;

  -- 1. every difference needs a sensible reason, checked before anything moves
  for v_item in
    select i.*, d.name from stock_take_items i join drugs d on d.id = i.drug_id
     where i.take_id = p_take_id and i.counted_qty <> i.system_qty
  loop
    v_delta := v_item.counted_qty - v_item.system_qty;
    v_reason := nullif(trim(coalesce(p_reasons->>(v_item.drug_id::text), '')), '');
    if v_reason is null then
      raise exception 'Pick a reason for the difference on %', v_item.name;
    end if;
    if v_delta < 0 and v_reason not in ('damaged', 'expired', 'missing', 'other') then
      raise exception 'A shortage of % must be damaged, expired, missing or other', v_item.name;
    end if;
    if v_delta > 0 and v_reason not in ('found', 'other') then
      raise exception 'Extra stock of % must be marked found or other', v_item.name;
    end if;
  end loop;

  -- 2. apply
  for v_item in
    select i.*, d.name from stock_take_items i join drugs d on d.id = i.drug_id
     where i.take_id = p_take_id and i.counted_qty <> i.system_qty
     order by d.name
  loop
    v_delta := v_item.counted_qty - v_item.system_qty;
    v_reason := trim(p_reasons->>(v_item.drug_id::text));
    v_name := v_item.name;

    if v_delta < 0 then
      v_need := -v_delta;
      select coalesce(sum(quantity_remaining), 0) into v_avail from batches
       where drug_id = v_item.drug_id and pharmacy_id = p_pharmacy_id;
      if v_avail < v_need then
        raise exception 'Stock of % changed since it was counted (only % left). Count it again.', v_name, v_avail;
      end if;
      for v_batch in
        select * from batches
         where drug_id = v_item.drug_id and pharmacy_id = p_pharmacy_id and quantity_remaining > 0
         order by expiry_date asc, created_at asc, id asc
         for update
      loop
        exit when v_need <= 0;
        v_take_qty := least(v_batch.quantity_remaining, v_need);
        update batches set quantity_remaining = quantity_remaining - v_take_qty where id = v_batch.id;
        insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
        values (p_pharmacy_id, v_item.drug_id, v_batch.id, 'stock_take', -v_take_qty,
                'Stock take: ' || v_reason, auth.uid());
        v_cost := v_cost - v_take_qty * coalesce(v_batch.cost_price, 0);
        v_need := v_need - v_take_qty;
      end loop;
    else
      select * into v_batch from batches
       where drug_id = v_item.drug_id and pharmacy_id = p_pharmacy_id and expiry_date >= current_date
       order by expiry_date desc, created_at desc, id desc
       limit 1
       for update;
      if not found then
        raise exception '% has no in-date batch to put the extra stock on. Restock it instead.', v_name;
      end if;
      update batches set quantity_remaining = quantity_remaining + v_delta where id = v_batch.id;
      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, created_by)
      values (p_pharmacy_id, v_item.drug_id, v_batch.id, 'stock_take', v_delta,
              'Stock take: ' || v_reason, auth.uid());
      v_cost := v_cost + v_delta * coalesce(v_batch.cost_price, 0);
    end if;

    update stock_take_items set reason = v_reason, applied_delta = v_delta where id = v_item.id;
    v_changed := v_changed + 1;
  end loop;

  update stock_takes
     set status = 'approved', approved_by = auth.uid(), approved_at = now(), total_cost_variance = round(v_cost, 2)
   where id = p_take_id;

  return jsonb_build_object('adjusted', v_changed, 'total_cost_variance', round(v_cost, 2));
end;
$$;

revoke all on function start_stock_take(uuid, text) from public, anon;
grant execute on function start_stock_take(uuid, text) to authenticated;
revoke all on function stock_take_count(uuid, uuid, uuid, integer) from public, anon;
grant execute on function stock_take_count(uuid, uuid, uuid, integer) to authenticated;
revoke all on function stock_take_remove_count(uuid, uuid, uuid) from public, anon;
grant execute on function stock_take_remove_count(uuid, uuid, uuid) to authenticated;
revoke all on function cancel_stock_take(uuid, uuid) from public, anon;
grant execute on function cancel_stock_take(uuid, uuid) to authenticated;
revoke all on function approve_stock_take(uuid, uuid, jsonb) from public, anon;
grant execute on function approve_stock_take(uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. REFILLS — repeat customers (blood pressure, diabetes, family planning)
-- ----------------------------------------------------------------------------

create table if not exists refill_plans (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references pharmacies(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  drug_id          uuid references drugs(id) on delete set null,
  drug_name        text not null check (char_length(trim(drug_name)) between 1 and 120),
  qty              integer check (qty is null or qty > 0),
  interval_days    integer not null check (interval_days between 1 and 365),
  last_filled      date not null default current_date,
  next_due         date generated always as (last_filled + interval_days) stored,
  active           boolean not null default true,
  last_reminded_on date,
  notes            text,
  created_by       uuid references profiles(id),
  created_at       timestamptz not null default now()
);
create index if not exists refill_plans_pharmacy_due_idx on refill_plans (pharmacy_id, next_due) where active;
create index if not exists refill_plans_customer_idx on refill_plans (customer_id);
create index if not exists refill_plans_drug_idx on refill_plans (drug_id) where drug_id is not null;
create index if not exists refill_plans_created_by_idx on refill_plans (created_by);

alter table refill_plans enable row level security;
drop policy if exists "tenant read refill_plans" on refill_plans;
create policy "tenant read refill_plans" on refill_plans for select using (pharmacy_id = my_pharmacy_id());
revoke insert, update, delete on refill_plans from authenticated, anon;
grant select on refill_plans to authenticated;

create or replace view v_refills with (security_invoker = true) as
select r.id as plan_id, r.pharmacy_id, r.customer_id, c.name as customer_name, c.phone, c.sms_ok,
       r.drug_id, r.drug_name, r.qty, r.interval_days, r.last_filled, r.next_due,
       (today_ke() - r.next_due) as days_overdue,       -- negative = days still to go
       r.last_reminded_on, r.notes
  from refill_plans r
  join customers c on c.id = r.customer_id
 where r.active and c.active;
grant select on v_refills to authenticated;

create or replace function save_refill_plan(
  p_pharmacy_id uuid,
  p_customer_id uuid,
  p_drug_name text,
  p_interval_days integer,
  p_drug_id uuid default null,
  p_last_filled date default null,
  p_qty integer default null,
  p_notes text default null,
  p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_drug_name, '')), '');
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can set up a refill';
  end if;
  if not exists (select 1 from customers where id = p_customer_id and pharmacy_id = p_pharmacy_id and active) then
    raise exception 'Customer not found';
  end if;
  if p_drug_id is not null then
    select coalesce(v_name, name) into v_name from drugs where id = p_drug_id and pharmacy_id = p_pharmacy_id;
    if v_name is null then
      raise exception 'Drug not found';
    end if;
  end if;
  if v_name is null then
    raise exception 'Say which medicine this refill is for';
  end if;
  if p_interval_days is null or p_interval_days < 1 or p_interval_days > 365 then
    raise exception 'Refill every how many days? Enter 1 to 365.';
  end if;
  if p_qty is not null and p_qty <= 0 then
    raise exception 'The quantity must be more than zero';
  end if;
  if p_last_filled is not null and p_last_filled > today_ke() then
    raise exception 'The last fill date cannot be in the future';
  end if;

  if p_id is null then
    insert into refill_plans (pharmacy_id, customer_id, drug_id, drug_name, qty, interval_days, last_filled, notes, created_by)
    values (p_pharmacy_id, p_customer_id, p_drug_id, v_name, p_qty, p_interval_days,
            coalesce(p_last_filled, today_ke()), nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
    returning id into v_id;
  else
    update refill_plans
       set customer_id = p_customer_id, drug_id = p_drug_id, drug_name = v_name, qty = p_qty,
           interval_days = p_interval_days, last_filled = coalesce(p_last_filled, last_filled),
           notes = nullif(trim(coalesce(p_notes, '')), '')
     where id = p_id and pharmacy_id = p_pharmacy_id
     returning id into v_id;
    if v_id is null then
      raise exception 'Refill not found';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function mark_refilled(p_pharmacy_id uuid, p_plan_id uuid, p_filled_on date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can update a refill';
  end if;
  if p_filled_on is not null and p_filled_on > today_ke() then
    raise exception 'The fill date cannot be in the future';
  end if;
  update refill_plans
     set last_filled = coalesce(p_filled_on, today_ke()), last_reminded_on = null
   where id = p_plan_id and pharmacy_id = p_pharmacy_id and active;
  if not found then
    raise exception 'Refill not found';
  end if;
end;
$$;

create or replace function stop_refill_plan(p_pharmacy_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can stop a refill';
  end if;
  update refill_plans set active = false where id = p_plan_id and pharmacy_id = p_pharmacy_id and active;
  if not found then
    raise exception 'Refill not found';
  end if;
end;
$$;

revoke all on function save_refill_plan(uuid, uuid, text, integer, uuid, date, integer, text, uuid) from public, anon;
grant execute on function save_refill_plan(uuid, uuid, text, integer, uuid, date, integer, text, uuid) to authenticated;
revoke all on function mark_refilled(uuid, uuid, date) from public, anon;
grant execute on function mark_refilled(uuid, uuid, date) to authenticated;
revoke all on function stop_refill_plan(uuid, uuid) from public, anon;
grant execute on function stop_refill_plan(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. SMS — a log of every message, and the gate in front of the sender
-- ----------------------------------------------------------------------------
-- The actual sending is done by the send-sms Edge Function (it holds the
-- provider credentials). It first calls sms_queue() below AS THE SIGNED-IN
-- USER, which checks the role, the daily limit and the customer, and writes
-- the log rows; only then does it send and mark each row sent or failed.

alter table pharmacies add column if not exists sms_enabled boolean not null default true;
alter table pharmacies add column if not exists sms_daily_cap integer not null default 30
  check (sms_daily_cap between 0 and 2000);

create table if not exists sms_log (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  to_phone     text not null,
  body         text not null check (char_length(body) between 1 and 459),
  kind         text not null check (kind in ('refill', 'credit', 'custom')),
  ref_id       uuid,                                         -- refill plan id for a refill reminder
  status       text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  provider_id  text,
  error        text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists sms_log_pharmacy_idx on sms_log (pharmacy_id, created_at desc);
create index if not exists sms_log_customer_idx on sms_log (customer_id) where customer_id is not null;
create index if not exists sms_log_created_by_idx on sms_log (created_by);

alter table sms_log enable row level security;
drop policy if exists "tenant read sms_log" on sms_log;
create policy "tenant read sms_log" on sms_log for select using (pharmacy_id = my_pharmacy_id());
revoke insert, update, delete on sms_log from authenticated, anon;
grant select on sms_log to authenticated;

-- A pharmacy owner may switch SMS on or off, but not raise their own daily
-- limit (that is set by the platform, in the database).
create or replace function protect_sms_cap()
returns trigger
language plpgsql
as $$
begin
  if NEW.sms_daily_cap is distinct from OLD.sms_daily_cap and auth.uid() is not null then
    raise exception 'The daily SMS limit is set by Pharma support';
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_protect_sms_cap on pharmacies;
create trigger trg_protect_sms_cap
  before update of sms_daily_cap on pharmacies
  for each row execute function protect_sms_cap();

create or replace function sms_queue(p_pharmacy_id uuid, p_messages jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg jsonb;
  v_cust customers%rowtype;
  v_body text;
  v_kind text;
  v_ref uuid;
  v_enabled boolean;
  v_cap integer;
  v_used integer;
  v_queued jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_ok boolean;
  v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can send SMS';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) = 0 then
    raise exception 'There is nothing to send';
  end if;
  if jsonb_array_length(p_messages) > 50 then
    raise exception 'Send at most 50 messages at a time';
  end if;

  select sms_enabled, sms_daily_cap into v_enabled, v_cap from pharmacies where id = p_pharmacy_id for update;
  if not v_enabled then
    raise exception 'SMS is switched off for this pharmacy (Customers > Messages)';
  end if;
  select count(*) into v_used from sms_log
   where pharmacy_id = p_pharmacy_id and created_at >= v_since and status <> 'failed';

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_body := trim(coalesce(v_msg->>'body', ''));
    v_kind := coalesce(v_msg->>'kind', 'custom');
    v_ref := nullif(v_msg->>'ref_id', '')::uuid;
    if v_kind not in ('refill', 'credit', 'custom') then
      raise exception 'Unknown message type';
    end if;
    if v_body = '' or char_length(v_body) > 459 then
      raise exception 'A message must be between 1 and 459 characters';
    end if;

    select * into v_cust from customers
     where id = nullif(v_msg->>'customer_id', '')::uuid and pharmacy_id = p_pharmacy_id;
    if not found then
      raise exception 'Customer not found';
    end if;
    if not v_cust.sms_ok then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'opted_out');
      continue;
    end if;
    if v_cust.phone is null then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'no_phone');
      continue;
    end if;

    if v_kind = 'refill' then
      if v_ref is null or not exists (select 1 from refill_plans
                                       where id = v_ref and pharmacy_id = p_pharmacy_id and customer_id = v_cust.id) then
        raise exception 'That refill was not found for this customer';
      end if;
      if exists (select 1 from refill_plans where id = v_ref and last_reminded_on = today_ke()) then
        v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'already_reminded_today');
        continue;
      end if;
    end if;

    if v_used >= v_cap then
      raise exception 'Daily SMS limit reached (% a day). Try again tomorrow.', v_cap;
    end if;

    insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind, ref_id, created_by)
    values (p_pharmacy_id, v_cust.id, v_cust.phone, v_body, v_kind, v_ref, auth.uid())
    returning id into v_id;
    v_used := v_used + 1;
    v_queued := v_queued || jsonb_build_object('id', v_id, 'to', v_cust.phone, 'body', v_body);

    if v_kind = 'refill' then
      update refill_plans set last_reminded_on = today_ke() where id = v_ref;
    end if;
  end loop;

  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped,
                            'used_today', v_used, 'daily_cap', v_cap);
end;
$$;
revoke all on function sms_queue(uuid, jsonb) from public, anon;
grant execute on function sms_queue(uuid, jsonb) to authenticated;

-- Owner switches SMS on or off for the pharmacy.
create or replace function set_sms_enabled(p_pharmacy_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner') then
    raise exception 'Only the owner can switch SMS on or off';
  end if;
  update pharmacies set sms_enabled = coalesce(p_enabled, true) where id = p_pharmacy_id;
end;
$$;
revoke all on function set_sms_enabled(uuid, boolean) from public, anon;
grant execute on function set_sms_enabled(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. record_sale / record_return — credit, controlled drugs, refills
-- ----------------------------------------------------------------------------
-- record_sale gains p_customer_id. The old five-argument version is dropped
-- first: leaving both would make every call ambiguous (see the note above
-- record_restock about the same mistake once before).
--   * a payment with method 'credit' puts that amount on the customer's account
--     (needs p_customer_id, respects the customer's credit limit)
--   * a controlled drug needs patient, prescriber and Rx number, and the sale
--     is written to the controlled-drug ledger
--   * selling a drug a customer is on a refill plan for moves that plan on
-- ----------------------------------------------------------------------------

drop function if exists record_sale(uuid, jsonb, jsonb, text, text);

create or replace function record_sale(
  p_pharmacy_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_insurance_scheme text default null,
  p_customer_id uuid default null
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
  v_drug record;
  v_patient text;
  v_prescriber text;
  v_rx text;
  v_qty_needed integer;
  v_qty_remaining_to_fill integer;
  v_batch record;
  v_take integer;
  v_effective_price numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_line_total numeric(10,2);
  v_vat_rate numeric(5,2);
  v_payments_total numeric(10,2) := 0;
  v_amount numeric(10,2);
  v_method payment_method;
  v_reference text;
  v_method_count integer;
  v_first_method payment_method;
  v_invoice_seq integer;
  v_credit_total numeric(10,2) := 0;
  v_cust customers%rowtype;
  v_bal numeric;
  v_customer_name text := p_customer_name;
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'attendant') then
    raise exception 'Only the owner, a pharmacist, or a seller can record a sale';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'A sale needs at least one payment';
  end if;

  -- credit: who is it for, and can they carry it?
  select coalesce(sum((x->>'amount')::numeric), 0) into v_credit_total
    from jsonb_array_elements(p_payments) x where x->>'method' = 'credit';
  if v_credit_total > 0 and p_customer_id is null then
    raise exception 'Choose the customer this credit is for';
  end if;
  if p_customer_id is not null then
    select * into v_cust from customers where id = p_customer_id and pharmacy_id = p_pharmacy_id for update;
    if not found then
      raise exception 'Customer not found';
    end if;
    if v_credit_total > 0 then
      if not v_cust.active then
        raise exception '%''s account is closed', v_cust.name;
      end if;
      v_bal := customer_balance(p_customer_id);
      if v_cust.credit_limit is not null and v_bal + v_credit_total > v_cust.credit_limit + 0.005 then
        raise exception '% is over their credit limit: owes %, limit %, this sale adds %',
          v_cust.name, round(v_bal, 2), v_cust.credit_limit, round(v_credit_total, 2);
      end if;
    end if;
    v_customer_name := v_cust.name;
  end if;

  select vat_rate into v_vat_rate from pharmacies where id = p_pharmacy_id;

  update pharmacies set next_invoice_no = next_invoice_no + 1
  where id = p_pharmacy_id
  returning next_invoice_no - 1 into v_invoice_seq;

  insert into sales (pharmacy_id, payment_method, customer_name, customer_id, insurance_scheme, invoice_number, created_by)
  values (p_pharmacy_id, 'cash', v_customer_name, p_customer_id, p_insurance_scheme,
          'INV-' || lpad(v_invoice_seq::text, 6, '0'), auth.uid())
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_drug_id := (v_item->>'drug_id')::uuid;
    v_qty_needed := (v_item->>'quantity')::integer;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Each item needs a quantity greater than zero';
    end if;

    select id, name, is_prescription, control_class into v_drug
    from drugs where id = v_drug_id and pharmacy_id = p_pharmacy_id;
    if v_drug.id is null then
      raise exception 'Drug not found';
    end if;

    v_patient := nullif(trim(coalesce(v_item->>'patient_name', '')), '');
    v_prescriber := nullif(trim(coalesce(v_item->>'prescriber_name', '')), '');
    v_rx := nullif(trim(coalesce(v_item->>'rx_number', '')), '');
    if v_drug.is_prescription and v_patient is null then
      raise exception '% is a prescription-only medicine — record the patient''s name', v_drug.name;
    end if;
    if v_drug.control_class <> 'none' and (v_patient is null or v_prescriber is null or v_rx is null) then
      raise exception '% is a controlled drug — record the patient, the prescriber and the prescription number', v_drug.name;
    end if;

    v_qty_remaining_to_fill := v_qty_needed;

    for v_batch in
      select * from batches
      where drug_id = v_drug_id and pharmacy_id = p_pharmacy_id
        and quantity_remaining > 0 and expiry_date >= current_date
      order by expiry_date asc, created_at asc, id asc
      for update
    loop
      exit when v_qty_remaining_to_fill <= 0;
      v_take := least(v_batch.quantity_remaining, v_qty_remaining_to_fill);
      v_effective_price := round(v_batch.sell_price * (1 - v_batch.discount_percent / 100.0), 2);

      update batches set quantity_remaining = quantity_remaining - v_take where id = v_batch.id;

      v_line_total := round(v_take * v_effective_price, 2);
      v_subtotal := v_subtotal + v_line_total;

      insert into sale_items (sale_id, pharmacy_id, drug_id, batch_id, quantity, unit_price, line_total,
                              patient_name, prescriber_name, rx_number)
      values (v_sale_id, p_pharmacy_id, v_drug_id, v_batch.id, v_take, v_effective_price, v_line_total,
              v_patient, v_prescriber, v_rx);

      insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, ref_sale_id, created_by)
      values (p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take, v_sale_id, auth.uid());

      if v_drug.control_class <> 'none' then
        perform controlled_ledger_add(p_pharmacy_id, v_drug_id, v_batch.id, 'sale', -v_take,
                                      v_patient, v_prescriber, v_rx, v_sale_id, null, auth.uid());
      end if;

      v_qty_remaining_to_fill := v_qty_remaining_to_fill - v_take;
    end loop;

    if v_qty_remaining_to_fill > 0 then
      raise exception 'Not enough stock for %: short by %', v_drug.name, v_qty_remaining_to_fill;
    end if;
  end loop;

  if abs(v_subtotal) < 0.01 then
    raise exception 'Sale total is zero';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_amount := (v_payment->>'amount')::numeric;
    v_method := (v_payment->>'method')::payment_method;
    v_reference := nullif(trim(coalesce(v_payment->>'reference', '')), '');
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every payment line needs an amount greater than zero';
    end if;
    v_payments_total := v_payments_total + v_amount;

    insert into sales_payments (sale_id, pharmacy_id, method, amount, reference)
    values (v_sale_id, p_pharmacy_id, v_method, v_amount, v_reference);

    -- the claim is part of the sale, not a follow-up round trip
    if v_method = 'insurance' then
      insert into insurance_claims (pharmacy_id, sale_id, scheme, amount, status, created_by)
      values (p_pharmacy_id, v_sale_id,
              coalesce(v_reference, nullif(trim(coalesce(p_insurance_scheme, '')), ''), 'Unspecified'),
              v_amount, 'pending', auth.uid());
    end if;
  end loop;

  if abs(v_payments_total - v_subtotal) > 0.01 then
    raise exception 'Payments (%) do not add up to the sale total (%)', v_payments_total, v_subtotal;
  end if;

  select count(distinct method) into v_method_count from sales_payments where sale_id = v_sale_id;
  select method into v_first_method from sales_payments where sale_id = v_sale_id order by id limit 1;

  update sales
  set subtotal = v_subtotal,
      vat_amount = round(v_subtotal * v_vat_rate / (100 + v_vat_rate), 2),
      total_amount = v_subtotal,
      payment_method = case when v_method_count > 1 then 'split'::payment_method else v_first_method end
  where id = v_sale_id;

  -- a customer on a refill plan for something in this sale: the plan moves on
  if p_customer_id is not null then
    update refill_plans
       set last_filled = today_ke(), last_reminded_on = null
     where customer_id = p_customer_id and pharmacy_id = p_pharmacy_id and active
       and drug_id in (select (x->>'drug_id')::uuid from jsonb_array_elements(p_items) x);
  end if;

  return v_sale_id;
end;
$$;

revoke all on function record_sale(uuid, jsonb, jsonb, text, text, uuid) from public, anon;
grant execute on function record_sale(uuid, jsonb, jsonb, text, text, uuid) to authenticated;

-- record_return: same as before, plus
--   * the stock movement now points at the sale (so the controlled-drug ledger
--     can show which invoice a return belongs to), and
--   * a return against a sale that was (partly) on credit reduces what the
--     customer owes, never by more than the credit that sale carried.
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
  v_already integer;
  v_sale sales%rowtype;
  v_credit numeric(10,2);
  v_noted numeric(10,2);
  v_note numeric(10,2);
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can record a return';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Return quantity must be greater than zero';
  end if;

  -- for update serializes two tills returning the same line at the same moment
  select * into v_item from sale_items
  where id = p_sale_item_id and pharmacy_id = p_pharmacy_id
  for update;
  if not found then
    raise exception 'Sale item not found';
  end if;

  select * into v_sale from sales where id = v_item.sale_id;
  if coalesce(v_sale.voided, false) then
    raise exception 'That sale was voided — its stock has already been put back, so it cannot be returned as well';
  end if;

  select coalesce(sum(quantity), 0) into v_already
  from returns where sale_item_id = p_sale_item_id;

  if p_quantity + v_already > v_item.quantity then
    raise exception 'Only % of this line can still be returned (% sold, % already returned)',
      v_item.quantity - v_already, v_item.quantity, v_already;
  end if;

  v_refund := round(p_quantity * v_item.unit_price, 2);

  update batches set quantity_remaining = quantity_remaining + p_quantity where id = v_item.batch_id;

  insert into returns (pharmacy_id, sale_item_id, drug_id, batch_id, quantity, reason, refund_amount, created_by)
  values (p_pharmacy_id, p_sale_item_id, v_item.drug_id, v_item.batch_id, p_quantity, p_reason, v_refund, auth.uid());

  insert into stock_adjustments (pharmacy_id, drug_id, batch_id, type, quantity_delta, reason, ref_sale_id, created_by)
  values (p_pharmacy_id, v_item.drug_id, v_item.batch_id, 'return', p_quantity, p_reason, v_item.sale_id, auth.uid());

  if v_sale.customer_id is not null then
    select coalesce(sum(amount), 0) into v_credit from sales_payments
     where sale_id = v_sale.id and method = 'credit';
    if v_credit > 0 then
      select coalesce(sum(amount), 0) into v_noted from customer_payments
       where sale_id = v_sale.id and kind = 'credit_note' and not voided;
      v_note := least(v_refund, v_credit - v_noted);
      if v_note > 0 then
        insert into customer_payments (pharmacy_id, customer_id, kind, amount, note, sale_id, created_by)
        values (p_pharmacy_id, v_sale.customer_id, 'credit_note', v_note,
                'Return on ' || coalesce(v_sale.invoice_number, 'sale'), v_sale.id, auth.uid());
      end if;
    end if;
  end if;
end;
$$;

grant execute on function record_return(uuid, uuid, integer, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Dashboard: one small call for the new cards
-- ----------------------------------------------------------------------------

create or replace function dashboard_extras(p_pharmacy_id uuid)
returns jsonb
language sql
stable
security invoker
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
revoke all on function dashboard_extras(uuid) from public, anon;
grant execute on function dashboard_extras(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Hardening found by the Supabase security check after the first deploy
-- ----------------------------------------------------------------------------
-- New tables inherit broad default privileges on Supabase. RLS already keeps
-- anyone out of other pharmacies' rows, but the API roles should hold nothing
-- they do not need: no TRUNCATE / REFERENCES / TRIGGER, and nothing at all for
-- the signed-out role.
revoke truncate, references, trigger on
  customers, customer_payments, controlled_ledger, stock_takes, stock_take_items, refill_plans, sms_log
  from authenticated, anon;
revoke all on
  customers, customer_payments, controlled_ledger, stock_takes, stock_take_items, refill_plans, sms_log,
  v_customer_balances, v_refills, v_controlled_register
  from anon;
revoke truncate, references, trigger on v_customer_balances, v_refills, v_controlled_register from authenticated;

-- A trigger function is never meant to be called directly.
revoke all on function controlled_ledger_from_adjustment() from public, anon, authenticated;

-- Pin the search path of the small helpers.
alter function today_ke() set search_path = public;
alter function normalize_ke_phone(text) set search_path = public;
alter function customer_balance(uuid) set search_path = public;
alter function protect_drug_control_class() set search_path = public;
alter function protect_sms_cap() set search_path = public;

-- ============================================================================
-- Scalability (2026-10-29 d): indexes + server-side sales report
-- ============================================================================

-- ---------------------------------------------------------------- indexes
create index if not exists sales_payments_pharmacy_idx
  on public.sales_payments (pharmacy_id);

-- "Top sellers" and stock-movement style queries: which sales sold this drug.
create index if not exists sale_items_drug_sale_idx
  on public.sale_items (drug_id, sale_id);

-- Selling takes the oldest-expiry batch with stock first (FEFO).
create index if not exists batches_fefo_idx
  on public.batches (pharmacy_id, drug_id, expiry_date, created_at, id)
  where quantity_remaining > 0;

create index if not exists returns_pharmacy_created_idx
  on public.returns (pharmacy_id, created_at desc);

create index if not exists insurance_claims_pharmacy_status_idx
  on public.insurance_claims (pharmacy_id, status, created_at desc);

create index if not exists held_sales_pharmacy_idx
  on public.held_sales (pharmacy_id);

create index if not exists suppliers_pharmacy_name_idx
  on public.suppliers (pharmacy_id, name);

create index if not exists staff_invites_pharmacy_idx
  on public.staff_invites (pharmacy_id);

-- ------------------------------------------------------- sales_report()
-- Totals for the Reports screen. security invoker: row level security still
-- decides what the caller can see, exactly as when the browser read the
-- tables directly. Voided sales are counted as transactions but not in money.
create or replace function public.sales_report(
  p_pharmacy_id uuid,
  p_start       timestamptz,
  p_end         timestamptz default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with s as (
    select id, total_amount, voided
      from sales
     where pharmacy_id = p_pharmacy_id
       and sold_at >= p_start
       and (p_end is null or sold_at < p_end)
  ),
  by_method as (
    select p.method::text as method, sum(p.amount) as amount
      from sales_payments p
      join s on s.id = p.sale_id and not s.voided
     where p.pharmacy_id = p_pharmacy_id
     group by p.method
  ),
  top as (
    select d.name, sum(i.quantity)::bigint as qty, sum(i.line_total) as value
      from sale_items i
      join s on s.id = i.sale_id and not s.voided
      left join drugs d on d.id = i.drug_id
     where i.pharmacy_id = p_pharmacy_id
     group by d.name
     order by sum(i.quantity) desc
     limit 8
  )
  select jsonb_build_object(
    'total',    coalesce((select sum(total_amount) from s where not voided), 0),
    'count',    (select count(*) from s),
    'by_method', coalesce((select jsonb_object_agg(method, amount) from by_method), '{}'::jsonb),
    'top_drugs', coalesce((select jsonb_agg(jsonb_build_object(
                    'name', coalesce(name, 'Unknown'), 'qty', qty, 'value', value)
                    order by qty desc) from top), '[]'::jsonb)
  )
$$;

revoke all on function public.sales_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_report(uuid, timestamptz, timestamptz) to authenticated;

-- -------------------------------------------------- sales_report_page()
-- One page of the transaction list, newest first, each sale with its payment
-- lines attached (small: usually one). Items are NOT included - the app asks
-- for them only when someone opens a sale.
create or replace function public.sales_report_page(
  p_pharmacy_id uuid,
  p_start       timestamptz,
  p_end         timestamptz default null,
  p_limit       integer default 20,
  p_offset      integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sold_at desc, x.id), '[]'::jsonb)
    from (
      select s.id, s.invoice_number, s.sold_at, s.total_amount, s.payment_method,
             s.customer_name, s.insurance_scheme, s.voided, s.void_reason,
             coalesce((select jsonb_agg(jsonb_build_object(
                         'id', p.id, 'method', p.method, 'amount', p.amount, 'reference', p.reference))
                         from sales_payments p
                        where p.sale_id = s.id and p.pharmacy_id = p_pharmacy_id), '[]'::jsonb) as payments
        from sales s
       where s.pharmacy_id = p_pharmacy_id
         and s.sold_at >= p_start
         and (p_end is null or s.sold_at < p_end)
       order by s.sold_at desc, s.id
       limit greatest(1, least(coalesce(p_limit, 20), 1000))
      offset greatest(0, coalesce(p_offset, 0))
    ) x
$$;

revoke all on function public.sales_report_page(uuid, timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function public.sales_report_page(uuid, timestamptz, timestamptz, integer, integer) to authenticated;

-- ------------------------------------------------- supplier_balances()
-- What each supplier is owed, worked out in the database. The Suppliers list
-- used to download every delivery and every payment ever recorded just to add
-- them up in the browser. Same rule as supplier_owed_summary():
--   balance = opening_balance + all deliveries - all payments
create or replace function public.supplier_balances(p_pharmacy_id uuid)
returns table (supplier_id uuid, balance numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select s.id,
         s.opening_balance
           + coalesce((select sum(l.total_amount) from supplier_lpos l
                        where l.supplier_id = s.id and l.pharmacy_id = p_pharmacy_id), 0)
           - coalesce((select sum(p.amount) from supplier_payments p
                        where p.supplier_id = s.id and p.pharmacy_id = p_pharmacy_id), 0)
    from suppliers s
   where s.pharmacy_id = p_pharmacy_id
$$;

revoke all on function public.supplier_balances(uuid) from public, anon;
grant execute on function public.supplier_balances(uuid) to authenticated;

-- ============================================================================
-- Scalability (2026-10-29 e): fast bulk import, old-log cleanup, admin portal indexes
-- ============================================================================

-- ------------------------------------------------------ import_stock_rows()
create or replace function public.import_stock_rows(
  p_pharmacy_id uuid,
  p_rows        jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          jsonb;
  v_i        integer := 0;
  v_name     text;
  v_drug_id  uuid;
  v_form     text;
  v_cat      uuid;
  v_expiry   date;
  v_imported integer := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_valid_forms constant text[] := array['tablet','capsule','syrup','injection','cream_ointment','drops','suppository','inhaler','iv_fluid','other'];
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist', 'stock_taker') then
    raise exception 'Only the owner, a pharmacist, or a stock taker can import stock';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nothing to import';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'Import at most 500 rows at a time';
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_i := v_i + 1;
    begin   -- a bad row rolls back only itself
      v_name := btrim(coalesce(r->>'name', ''));
      if v_name = '' then
        raise exception 'The drug name is empty';
      end if;

      select id into v_drug_id from drugs
       where pharmacy_id = p_pharmacy_id and lower(name) = lower(v_name)
       limit 1;

      if v_drug_id is null then
        v_form := coalesce(r->>'form', 'other');
        if not (v_form = any (v_valid_forms)) then v_form := 'other'; end if;
        v_cat := null;
        if coalesce(r->>'category_id', '') <> '' then
          select id into v_cat from drug_categories
           where id = (r->>'category_id')::uuid and pharmacy_id = p_pharmacy_id;
        end if;
        insert into drugs (pharmacy_id, name, form, unit, category_id)
        values (p_pharmacy_id, v_name, v_form::drug_form, coalesce(nullif(r->>'unit', ''), 'unit'), v_cat)
        returning id into v_drug_id;
      end if;

      v_expiry := nullif(r->>'expiry', '')::date;

      perform record_restock(
        p_pharmacy_id,
        v_drug_id,
        nullif(r->>'qty', '')::integer,
        nullif(r->>'cost_price', '')::numeric,
        nullif(r->>'sell_price', '')::numeric,
        v_expiry,
        nullif(r->>'batch_no', ''),
        nullif(r->>'supplier', ''),
        null,
        v_expiry is null
      );
      v_imported := v_imported + 1;
    exception when others then
      -- keep the report short: the first 20 problems are enough to fix a sheet
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'row', v_i, 'name', left(coalesce(r->>'name', ''), 80), 'message', sqlerrm));
      end if;
    end;
    v_drug_id := null;
  end loop;

  return jsonb_build_object(
    'imported', v_imported,
    'failed',   v_i - v_imported,
    'errors',   v_errors
  );
end;
$$;

revoke all on function public.import_stock_rows(uuid, jsonb) from public, anon;
grant execute on function public.import_stock_rows(uuid, jsonb) to authenticated;

-- ------------------------------------------------- nightly cleanup, extended
create or replace function public.housekeeping_daily()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_otps int;
  n_attempts int;
  n_signins int;
  n_sms int;
begin
  delete from public.phone_otps
   where created_at < now() - interval '2 days';
  get diagnostics n_otps = row_count;

  -- password_reset_attempts exists on the live project but is not created by
  -- schema.sql, so check for it instead of assuming (a fresh test database
  -- would otherwise fail here).
  n_attempts := 0;
  if to_regclass('public.password_reset_attempts') is not null then
    execute 'delete from public.password_reset_attempts where attempted_at < now() - interval ''2 days''';
    get diagnostics n_attempts = row_count;
  end if;

  -- The admin portal only looks back 30 days; 13 months keeps a full year
  -- for comparison.
  delete from public.sign_in_log
   where signed_in_at < now() - interval '13 months';
  get diagnostics n_signins = row_count;

  -- The SMS log is only used for "sent today" and the daily limit; 2 years
  -- keeps a long history for any dispute with a customer.
  n_sms := 0;
  if to_regclass('public.sms_log') is not null then
    delete from public.sms_log where created_at < now() - interval '2 years';
    get diagnostics n_sms = row_count;
  end if;

  -- NOT cleaned, on purpose: stock_adjustments and controlled_ledger are the
  -- audit trail a pharmacy inspection reads. They are kept forever.

  return jsonb_build_object('otps_deleted', n_otps, 'reset_attempts_deleted', n_attempts,
                            'sign_ins_deleted', n_signins, 'sms_deleted', n_sms, 'ran_at', now());
end;
$$;

revoke all on function public.housekeeping_daily() from public, anon, authenticated;

-- ----------------------------------------------- admin portal: time indexes
-- The portal asks "what happened in the last 30 days, across all pharmacies".
-- The existing indexes start with pharmacy_id, which cannot answer that, so
-- it read every sale ever made. These can.
create index if not exists sales_active_sold_at_idx
  on public.sales (sold_at) where not voided;
create index if not exists sales_pharmacy_created_idx
  on public.sales (pharmacy_id, created_at desc);
create index if not exists stock_adjustments_created_idx
  on public.stock_adjustments (created_at);

-- ============================================================================
-- 2026-10-29 (f) Lock down table access: RLS everywhere + least privilege
--
-- Safe to run more than once. Changes no data and no row-level-security policy.
--
-- Where things stood: row-level security (RLS) was ON for every table, so no
-- pharmacy could see another pharmacy's rows. But RLS only decides WHICH ROWS
-- a signed-in person can reach. The older tables also let ANY signed-in
-- member (an attendant included) insert, edit and delete rows directly through
-- the public API, bypassing the checked functions (record_sale, void_sale,
-- record_return, ...): they could rewrite a sale's total, change a batch's
-- quantity, or delete the stock-movement audit trail. Newer tables (customers,
-- stock takes, SMS log...) were already read-only from the app. This brings
-- the older ones in line:
--
--   1. Signed-out visitors (anon) hold nothing on any table.
--   2. Nobody holds TRUNCATE / REFERENCES / TRIGGER (RLS does not cover
--      TRUNCATE at all).
--   3. Server-only tables (one-time codes, reset attempts, SMS platform
--      settings, platform admins, sign-in log) are closed to signed-in users.
--   4. Tables the app only changes through checked functions are read-only
--      from the app: sales, sale items, sale payments, stock adjustments,
--      returns, supplier deliveries / delivery items / payments, expenses,
--      the shared drug catalogue, categories, staff invites.
--   5. Tables the app does write directly keep only what it needs: a batch
--      can only have its mark-down % changed, an insurance claim only its
--      status, nobody can delete drugs / batches / suppliers / profiles /
--      pharmacies or add profiles / pharmacies directly.
--
-- The checked functions are SECURITY DEFINER (they run as the database owner),
-- so they are not affected by any of this.

-- 1. signed-out visitors
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 2. never needed by the app
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- New tables must start the same way.
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated, anon;
alter default privileges in schema public revoke all on tables from anon;

-- 3. server-only tables
do $$
declare t text;
begin
  foreach t in array array['phone_otps', 'password_reset_attempts', 'sms_platform_config', 'platform_admins', 'sign_in_log']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end $$;

-- 4. read-only from the app (changed only through checked functions)
revoke insert, update, delete on
  sales, sale_items, sales_payments, stock_adjustments, returns,
  supplier_lpos, supplier_lpo_items, supplier_payments, expenses,
  master_drugs, drug_categories, staff_invites
  from authenticated;

-- 5. written directly by the app, but only in these ways
revoke insert, update, delete on batches from authenticated;
grant update (discount_percent) on batches to authenticated;

revoke insert, delete on insurance_claims from authenticated;
revoke update on insurance_claims from authenticated;
grant update (status, updated_at) on insurance_claims to authenticated;

revoke delete on drugs, suppliers from authenticated;
revoke insert, delete on profiles, pharmacies from authenticated;

-- ------------------------------------------------------------- keep_alive()
-- The daily Netlify ping (netlify/functions/keep-alive.js) used to read one
-- row from `pharmacies` with the public key just to touch the database. The
-- signed-out role holds nothing now, so that read is refused. This gives the
-- ping something it is allowed to do: it returns the time and nothing else -
-- no pharmacy data of any kind.
create or replace function public.keep_alive()
returns timestamptz
language sql
volatile
security invoker
set search_path = public
as $$ select now() $$;

grant execute on function public.keep_alive() to anon, authenticated;


-- ===========================================================================
-- Folded in from migrations/2026-10-30_trials_and_admin_management.sql
-- Trials, activation, and admin pharmacy management. Every pharmacy gets a
-- 90-day free trial from sign-up and becomes 'active' on first payment. The
-- admin can show days left, extend/reduce trial, activate, and permanently
-- delete a pharmacy (only after its trial has ended). All management
-- functions are gated by is_platform_admin(). These statements override the
-- earlier bootstrap_pharmacy() and admin_pharmacy_stats() definitions above.
-- ===========================================================================
alter table public.pharmacies
  add column if not exists subscription_status text not null default 'trial',
  add column if not exists subscription_expires_at timestamptz,
  add column if not exists activated_at timestamptz;
alter table public.pharmacies drop constraint if exists pharmacies_subscription_status_check;
alter table public.pharmacies add constraint pharmacies_subscription_status_check
  check (subscription_status in ('trial', 'active'));

create or replace function public.bootstrap_pharmacy(p_name text, p_full_name text, p_phone text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pharmacy_id uuid;
  v_cat text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a pharmacy';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'Give the pharmacy a name';
  end if;

  insert into pharmacies (name, phone, subscription_status, subscription_expires_at)
  values (trim(p_name), p_phone, 'trial', now() + interval '90 days')
  returning id into v_pharmacy_id;

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
$function$;

drop function if exists public.admin_pharmacy_stats();
create function public.admin_pharmacy_stats()
 returns table(id uuid, name text, town text, phone text, created_at timestamptz,
   owner_name text, owner_phone text, staff_count integer, active_staff integer,
   last_sign_in_at timestamptz, last_seen_at timestamptz, sign_ins_7d integer, sign_ins_30d integer,
   last_sale_at timestamptz, sales_count integer, sales_30d integer, sales_value_30d numeric,
   drugs_count integer, last_stock_at timestamptz, last_active_at timestamptz, status text,
   subscription_status text, subscription_expires_at timestamptz, trial_days_left integer)
 language sql stable security definer set search_path to 'public'
as $function$
  with staff as (
    select pr.pharmacy_id, pr.id as user_id, pr.full_name, pr.phone, pr.role, pr.active, pr.account_expires_at,
           u.last_sign_in_at,
           (select max(s.updated_at) from auth.sessions s where s.user_id = pr.id) as last_seen_at
    from profiles pr
    left join auth.users u on u.id = pr.id
  ),
  base as (
    select p.id, p.name, p.town, p.phone, p.created_at,
      p.subscription_status, p.subscription_expires_at,
      (select s.full_name from staff s where s.pharmacy_id = p.id and s.role = 'owner' limit 1) as owner_name,
      (select s.phone     from staff s where s.pharmacy_id = p.id and s.role = 'owner' limit 1) as owner_phone,
      (select count(*) from staff s where s.pharmacy_id = p.id)::int as staff_count,
      (select count(*) from staff s where s.pharmacy_id = p.id and s.active
         and (s.account_expires_at is null or s.account_expires_at > now()))::int as active_staff,
      (select max(s.last_sign_in_at) from staff s where s.pharmacy_id = p.id) as last_sign_in_at,
      (select max(s.last_seen_at) from staff s where s.pharmacy_id = p.id) as last_seen_at,
      (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
         where pr.pharmacy_id = p.id and l.signed_in_at > now() - interval '7 days')::int as sign_ins_7d,
      (select count(*) from sign_in_log l join profiles pr on pr.id = l.user_id
         where pr.pharmacy_id = p.id and l.signed_in_at > now() - interval '30 days')::int as sign_ins_30d,
      (select max(sa.created_at) from sales sa where sa.pharmacy_id = p.id) as last_sale_at,
      (select count(*) from sales sa where sa.pharmacy_id = p.id and not sa.voided)::int as sales_count,
      (select count(*) from sales sa where sa.pharmacy_id = p.id and not sa.voided
         and sa.sold_at > now() - interval '30 days')::int as sales_30d,
      (select coalesce(sum(sa.total_amount), 0) from sales sa where sa.pharmacy_id = p.id and not sa.voided
         and sa.sold_at > now() - interval '30 days') as sales_value_30d,
      (select count(*) from drugs d where d.pharmacy_id = p.id and d.active)::int as drugs_count,
      (select max(a.created_at) from stock_adjustments a where a.pharmacy_id = p.id) as last_stock_at
    from pharmacies p
  ),
  withact as (
    select b.*, greatest(b.last_sign_in_at, b.last_seen_at, b.last_sale_at, b.last_stock_at) as last_active_at
    from base b
  )
  select w.id, w.name, w.town, w.phone, w.created_at, w.owner_name, w.owner_phone,
         w.staff_count, w.active_staff, w.last_sign_in_at, w.last_seen_at,
         w.sign_ins_7d, w.sign_ins_30d, w.last_sale_at, w.sales_count, w.sales_30d, w.sales_value_30d,
         w.drugs_count, w.last_stock_at, w.last_active_at,
         case
           when w.drugs_count = 0 and w.sales_count = 0 then
             case when w.last_active_at > now() - interval '7 days' then 'setting_up' else 'not_started' end
           when (w.last_active_at at time zone 'Africa/Nairobi')::date
                = (now() at time zone 'Africa/Nairobi')::date  then 'active_today'
           when w.last_active_at > now() - interval '7 days'  then 'active_week'
           when w.last_active_at > now() - interval '30 days' then 'quiet'
           else 'dormant'
         end as status,
         w.subscription_status,
         w.subscription_expires_at,
         case when w.subscription_expires_at is null then null
              else ceil(extract(epoch from (w.subscription_expires_at - now())) / 86400.0)::int
         end as trial_days_left
  from withact w;
$function$;

-- Internal helper for admin_overview() / admin_pharmacy_detail() only. Dropping and
-- re-creating a function makes it executable by everyone again, so lock it here
-- (migrations/2026-10-30_b_lock_admin_pharmacy_stats.sql).
revoke all on function public.admin_pharmacy_stats() from public, anon, authenticated;

create or replace function public.admin_extend_trial(p_pharmacy_id uuid, p_days integer)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_new timestamptz;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if p_days is null or p_days = 0 then raise exception 'Enter a number of days (negative to reduce)'; end if;
  update pharmacies
     set subscription_expires_at = greatest(now(), coalesce(subscription_expires_at, now())) + (p_days || ' days')::interval
   where id = p_pharmacy_id
   returning subscription_expires_at into v_new;
  if not found then raise exception 'Pharmacy not found'; end if;
  return jsonb_build_object('ok', true, 'expires_at', v_new);
end;
$function$;

create or replace function public.admin_activate_pharmacy(p_pharmacy_id uuid, p_days integer)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_new timestamptz;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if p_days is null or p_days <= 0 then raise exception 'Enter a number of days greater than 0'; end if;
  update pharmacies
     set subscription_status = 'active',
         activated_at = coalesce(activated_at, now()),
         subscription_expires_at = now() + (p_days || ' days')::interval
   where id = p_pharmacy_id
   returning subscription_expires_at into v_new;
  if not found then raise exception 'Pharmacy not found'; end if;
  return jsonb_build_object('ok', true, 'expires_at', v_new);
end;
$function$;

create or replace function public.admin_delete_pharmacy(p_pharmacy_id uuid, p_confirm_name text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_name text;
  v_expires timestamptz;
  v_user_ids uuid[];
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  select name, subscription_expires_at into v_name, v_expires from pharmacies where id = p_pharmacy_id;
  if v_name is null then raise exception 'Pharmacy not found'; end if;
  if trim(coalesce(p_confirm_name, '')) <> v_name then
    raise exception 'The name you typed does not match the pharmacy name';
  end if;
  if v_expires is null or v_expires > now() then
    raise exception 'This pharmacy''s trial has not ended yet — reduce its trial days to zero first if you really need to delete it';
  end if;
  if exists (select 1 from profiles pr join platform_admins pa on pa.user_id = pr.id
             where pr.pharmacy_id = p_pharmacy_id) then
    raise exception 'This pharmacy contains an admin account and cannot be deleted here';
  end if;

  select array_agg(id) into v_user_ids from profiles where pharmacy_id = p_pharmacy_id;
  delete from pharmacies where id = p_pharmacy_id;
  if v_user_ids is not null then
    delete from auth.users where id = any(v_user_ids);
  end if;
  return jsonb_build_object('ok', true, 'deleted', v_name);
end;
$function$;

revoke all on function public.admin_extend_trial(uuid, integer) from public, anon;
revoke all on function public.admin_activate_pharmacy(uuid, integer) from public, anon;
revoke all on function public.admin_delete_pharmacy(uuid, text) from public, anon;
grant execute on function public.admin_extend_trial(uuid, integer) to authenticated;
grant execute on function public.admin_activate_pharmacy(uuid, integer) to authenticated;
grant execute on function public.admin_delete_pharmacy(uuid, text) to authenticated;

-- Folded in from migrations/2026-10-30_trial_lockout.sql

create or replace function public.my_pharmacy_id()
returns uuid language sql stable security definer set search_path to 'public'
as $function$
  select p.pharmacy_id
  from profiles p
  join pharmacies ph on ph.id = p.pharmacy_id
  where p.id = auth.uid() and p.active
    and (p.account_expires_at is null or p.account_expires_at > now())
    and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
         or exists (select 1 from platform_admins pa where pa.user_id = p.id));
$function$;

create or replace function public.my_role()
returns user_role language sql stable security definer set search_path to 'public'
as $function$
  select p.role
  from profiles p
  join pharmacies ph on ph.id = p.pharmacy_id
  where p.id = auth.uid() and p.active
    and (p.account_expires_at is null or p.account_expires_at > now())
    and (ph.subscription_expires_at is null or ph.subscription_expires_at > now()
         or exists (select 1 from platform_admins pa where pa.user_id = p.id));
$function$;

-- Plan state for the signed-in user's own pharmacy (works while locked).
create or replace function public.my_subscription()
returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'pharmacy_name', ph.name,
    'status', ph.subscription_status,
    'expires_at', ph.subscription_expires_at,
    'days_left', case when ph.subscription_expires_at is null then null
                      else ceil(extract(epoch from (ph.subscription_expires_at - now())) / 86400.0)::int end,
    'locked', ph.subscription_expires_at is not null and ph.subscription_expires_at <= now()
              and not exists (select 1 from platform_admins pa where pa.user_id = p.id))
  from profiles p
  join pharmacies ph on ph.id = p.pharmacy_id
  where p.id = auth.uid();
$function$;

revoke all on function public.my_subscription() from public, anon;
grant execute on function public.my_subscription() to authenticated;

-- Folded in from migrations/2026-10-30_sms_wallet.sql

alter table public.sms_platform_config
  add column if not exists price_per_sms numeric(8,2) not null default 1;
alter table public.sms_platform_config drop constraint if exists sms_platform_config_price_check;
alter table public.sms_platform_config add constraint sms_platform_config_price_check check (price_per_sms > 0);

alter table public.sms_log
  add column if not exists cost numeric(8,2) not null default 0,
  add column if not exists refunded boolean not null default false;

-- 1. Tables ------------------------------------------------------------------
create table if not exists public.sms_wallets (
  pharmacy_id uuid primary key references public.pharmacies(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.sms_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  kind text not null check (kind in ('topup', 'sms', 'refund', 'adjust')),
  amount numeric(12,2) not null,            -- KES, negative when SMS are charged
  balance_after numeric(12,2) not null,
  reference text,
  description text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sms_wallet_txn_pharmacy_created
  on public.sms_wallet_transactions (pharmacy_id, created_at desc);

create table if not exists public.sms_topup_requests (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  created_by uuid,
  amount numeric(10,2) not null check (amount > 0),
  sms_count integer,
  phone text,
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'confirmed', 'failed')),
  checkout_request_id text,
  merchant_request_id text,
  mpesa_receipt text,
  result_code integer,
  result_desc text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists idx_sms_topup_pharmacy_created on public.sms_topup_requests (pharmacy_id, created_at desc);
create unique index if not exists uq_sms_topup_checkout on public.sms_topup_requests (checkout_request_id) where checkout_request_id is not null;
create unique index if not exists uq_sms_topup_receipt on public.sms_topup_requests (mpesa_receipt) where mpesa_receipt is not null;

-- 2. Access: read-only for the pharmacy's owner / co-owner / pharmacist --------
alter table public.sms_wallets enable row level security;
alter table public.sms_wallet_transactions enable row level security;
alter table public.sms_topup_requests enable row level security;

drop policy if exists sms_wallets_read on public.sms_wallets;
create policy sms_wallets_read on public.sms_wallets for select to authenticated
  using (pharmacy_id = (select my_pharmacy_id()) and (select my_role()) in ('owner', 'co_owner', 'pharmacist'));
drop policy if exists sms_wallet_txn_read on public.sms_wallet_transactions;
create policy sms_wallet_txn_read on public.sms_wallet_transactions for select to authenticated
  using (pharmacy_id = (select my_pharmacy_id()) and (select my_role()) in ('owner', 'co_owner', 'pharmacist'));
drop policy if exists sms_topup_read on public.sms_topup_requests;
create policy sms_topup_read on public.sms_topup_requests for select to authenticated
  using (pharmacy_id = (select my_pharmacy_id()) and (select my_role()) in ('owner', 'co_owner', 'pharmacist'));

revoke all on public.sms_wallets, public.sms_wallet_transactions, public.sms_topup_requests from public, anon, authenticated;
grant select on public.sms_wallets, public.sms_wallet_transactions, public.sms_topup_requests to authenticated;

-- 3. Credit a paid M-Pesa purchase (server only, exactly once) -----------------
create or replace function public.sms_topup_complete(
  p_checkout_request_id text,
  p_result_code integer,
  p_result_desc text,
  p_receipt text default null,
  p_amount numeric default null,
  p_phone text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_req sms_topup_requests%rowtype;
  v_balance numeric;
begin
  if coalesce(p_checkout_request_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_checkout_id');
  end if;
  select * into v_req from sms_topup_requests where checkout_request_id = p_checkout_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_checkout_id');
  end if;

  -- Already credited: only fill in the receipt if the first answer had none.
  if v_req.status = 'confirmed' then
    if v_req.mpesa_receipt is null and coalesce(p_receipt, '') <> ''
       and not exists (select 1 from sms_topup_requests where mpesa_receipt = p_receipt) then
      update sms_topup_requests set mpesa_receipt = p_receipt where id = v_req.id;
    end if;
    return jsonb_build_object('ok', true, 'already', true, 'status', 'confirmed', 'amount', v_req.amount);
  end if;

  if p_result_code = 0 then
    -- What Safaricom says was paid must cover what this purchase asked for.
    if p_amount is not null and p_amount < v_req.amount then
      update sms_topup_requests
         set status = 'failed', result_code = p_result_code,
             result_desc = 'Amount paid (KES ' || p_amount || ') is less than KES ' || v_req.amount || ' - contact Pharma.',
             mpesa_receipt = nullif(p_receipt, '')
       where id = v_req.id;
      return jsonb_build_object('ok', false, 'reason', 'amount_mismatch', 'status', 'failed');
    end if;
    if coalesce(p_receipt, '') <> '' and exists (select 1 from sms_topup_requests where mpesa_receipt = p_receipt and id <> v_req.id) then
      return jsonb_build_object('ok', false, 'reason', 'receipt_already_used');
    end if;

    update sms_topup_requests
       set status = 'confirmed', paid_at = now(), result_code = 0, result_desc = p_result_desc,
           mpesa_receipt = nullif(p_receipt, '')
     where id = v_req.id;

    insert into sms_wallets (pharmacy_id, balance) values (v_req.pharmacy_id, v_req.amount)
      on conflict (pharmacy_id) do update set balance = sms_wallets.balance + excluded.balance, updated_at = now()
      returning balance into v_balance;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (v_req.pharmacy_id, 'topup', v_req.amount, v_balance,
              coalesce(nullif(p_receipt, ''), v_req.checkout_request_id), 'SMS bought with M-Pesa');
    return jsonb_build_object('ok', true, 'status', 'confirmed', 'amount', v_req.amount, 'balance', v_balance);
  end if;

  -- Not paid (cancelled, wrong PIN, no money, timed out).
  update sms_topup_requests set status = 'failed', result_code = p_result_code, result_desc = p_result_desc
   where id = v_req.id and status <> 'confirmed';
  return jsonb_build_object('ok', true, 'status', 'failed', 'result_code', p_result_code, 'result_desc', p_result_desc);
end;
$function$;

revoke all on function public.sms_topup_complete(text, integer, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.sms_topup_complete(text, integer, text, text, numeric, text) to service_role;

-- 4. Charge for each SMS when it is queued -------------------------------------
-- Same as before, plus: the price comes from sms_platform_config, the wallet
-- is charged per 160-character part, and a message that cannot be paid for
-- stops the batch with a plain message.
create or replace function public.sms_queue(p_pharmacy_id uuid, p_messages jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_msg jsonb;
  v_cust customers%rowtype;
  v_body text;
  v_kind text;
  v_ref uuid;
  v_enabled boolean;
  v_cap integer;
  v_used integer;
  v_queued jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_price numeric;
  v_cost numeric;
  v_balance numeric;
  v_since timestamptz := (today_ke()::timestamp at time zone 'Africa/Nairobi');
begin
  if p_pharmacy_id is distinct from my_pharmacy_id() then
    raise exception 'Not authorized for this pharmacy';
  end if;
  if my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Only the owner or a pharmacist can send SMS';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) = 0 then
    raise exception 'There is nothing to send';
  end if;
  if jsonb_array_length(p_messages) > 50 then
    raise exception 'Send at most 50 messages at a time';
  end if;

  select sms_enabled, sms_daily_cap into v_enabled, v_cap from pharmacies where id = p_pharmacy_id for update;
  if not v_enabled then
    raise exception 'SMS is switched off for this pharmacy (Customers > Messages)';
  end if;
  select coalesce((select price_per_sms from sms_platform_config where id = 1), 1) into v_price;
  select balance into v_balance from sms_wallets where pharmacy_id = p_pharmacy_id for update;
  v_balance := coalesce(v_balance, 0);
  select count(*) into v_used from sms_log
   where pharmacy_id = p_pharmacy_id and created_at >= v_since and status <> 'failed';

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_body := trim(coalesce(v_msg->>'body', ''));
    v_kind := coalesce(v_msg->>'kind', 'custom');
    v_ref := nullif(v_msg->>'ref_id', '')::uuid;
    if v_kind not in ('refill', 'credit', 'custom') then
      raise exception 'Unknown message type';
    end if;
    if v_body = '' or char_length(v_body) > 459 then
      raise exception 'A message must be between 1 and 459 characters';
    end if;

    select * into v_cust from customers
     where id = nullif(v_msg->>'customer_id', '')::uuid and pharmacy_id = p_pharmacy_id;
    if not found then
      raise exception 'Customer not found';
    end if;
    if not v_cust.sms_ok then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'opted_out');
      continue;
    end if;
    if v_cust.phone is null then
      v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'no_phone');
      continue;
    end if;

    if v_kind = 'refill' then
      if v_ref is null or not exists (select 1 from refill_plans
                                       where id = v_ref and pharmacy_id = p_pharmacy_id and customer_id = v_cust.id) then
        raise exception 'That refill was not found for this customer';
      end if;
      if exists (select 1 from refill_plans where id = v_ref and last_reminded_on = today_ke()) then
        v_skipped := v_skipped || jsonb_build_object('customer_id', v_cust.id, 'reason', 'already_reminded_today');
        continue;
      end if;
    end if;

    if v_used >= v_cap then
      raise exception 'Daily SMS limit reached (% a day). Try again tomorrow.', v_cap;
    end if;

    -- one part up to 160 characters, then 153 per part
    v_cost := v_price * (case when char_length(v_body) <= 160 then 1 else ceil(char_length(v_body) / 153.0) end);
    if v_balance < v_cost then
      raise exception 'Not enough SMS credit (KES % left). Buy SMS first.', round(v_balance, 2);
    end if;

    insert into sms_log (pharmacy_id, customer_id, to_phone, body, kind, ref_id, created_by, cost)
    values (p_pharmacy_id, v_cust.id, v_cust.phone, v_body, v_kind, v_ref, auth.uid(), v_cost)
    returning id into v_id;
    v_used := v_used + 1;
    v_balance := v_balance - v_cost;
    update sms_wallets set balance = v_balance, updated_at = now() where pharmacy_id = p_pharmacy_id;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (p_pharmacy_id, 'sms', -v_cost, v_balance, v_id::text, 'SMS to ' || v_cust.phone);
    v_queued := v_queued || jsonb_build_object('id', v_id, 'to', v_cust.phone, 'body', v_body);

    if v_kind = 'refill' then
      update refill_plans set last_reminded_on = today_ke() where id = v_ref;
    end if;
  end loop;

  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped,
                            'used_today', v_used, 'daily_cap', v_cap, 'balance', v_balance);
end;
$function$;

-- 5. Refund an SMS that failed to send -----------------------------------------
create or replace function public.sms_refund_failed()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_balance numeric;
begin
  if new.status = 'failed' and old.status is distinct from 'failed' and new.cost > 0 and not new.refunded then
    insert into sms_wallets (pharmacy_id, balance) values (new.pharmacy_id, new.cost)
      on conflict (pharmacy_id) do update set balance = sms_wallets.balance + excluded.balance, updated_at = now()
      returning balance into v_balance;
    insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, reference, description)
      values (new.pharmacy_id, 'refund', new.cost, v_balance, new.id::text, 'SMS not delivered, refunded');
    new.refunded := true;
  end if;
  return new;
end;
$function$;
drop trigger if exists trg_sms_refund_failed on public.sms_log;
create trigger trg_sms_refund_failed before update of status on public.sms_log
  for each row execute function public.sms_refund_failed();
revoke all on function public.sms_refund_failed() from public, anon, authenticated;

-- 6. What the app shows: balance, price and usage ------------------------------
create or replace function public.my_sms_wallet()
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_pid uuid := my_pharmacy_id();
  v_price numeric := coalesce((select price_per_sms from sms_platform_config where id = 1), 1);
  v_balance numeric;
begin
  if v_pid is null or my_role() not in ('owner', 'co_owner', 'pharmacist') then
    raise exception 'Not authorized';
  end if;
  select coalesce((select balance from sms_wallets where pharmacy_id = v_pid), 0) into v_balance;
  return jsonb_build_object(
    'balance', v_balance,
    'price_per_sms', v_price,
    'available_sms', floor(v_balance / v_price),
    'sent_30d', (select count(*) from sms_log where pharmacy_id = v_pid and status <> 'failed' and created_at > now() - interval '30 days'),
    'spent_30d', (select coalesce(sum(cost), 0) from sms_log where pharmacy_id = v_pid and status <> 'failed' and created_at > now() - interval '30 days'),
    'bought_30d', (select coalesce(sum(amount), 0) from sms_wallet_transactions where pharmacy_id = v_pid and kind = 'topup' and created_at > now() - interval '30 days')
  );
end;
$function$;
revoke all on function public.my_sms_wallet() from public, anon;
grant execute on function public.my_sms_wallet() to authenticated;

-- 7. Admin: see and adjust a pharmacy's SMS credit -----------------------------
create or replace function public.admin_sms_wallet(p_pharmacy_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'balance', coalesce((select balance from sms_wallets where pharmacy_id = p_pharmacy_id), 0),
    'price_per_sms', coalesce((select price_per_sms from sms_platform_config where id = 1), 1),
    'sent_30d', (select count(*) from sms_log where pharmacy_id = p_pharmacy_id and status <> 'failed' and created_at > now() - interval '30 days'),
    'sent_all', (select count(*) from sms_log where pharmacy_id = p_pharmacy_id and status <> 'failed'),
    'bought_all', (select coalesce(sum(amount), 0) from sms_wallet_transactions where pharmacy_id = p_pharmacy_id and kind = 'topup'),
    'recent', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from (
        select kind, amount, balance_after, description, created_at
        from sms_wallet_transactions where pharmacy_id = p_pharmacy_id
        order by created_at desc limit 8) t), '[]'::jsonb)
  );
end;
$function$;

-- Add or remove KES credit by hand (positive adds, negative removes).
create or replace function public.admin_adjust_sms_credit(p_pharmacy_id uuid, p_amount numeric, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_balance numeric;
begin
  if not is_platform_admin() then raise exception 'Not authorized'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter an amount in KES (negative to remove)'; end if;
  if not exists (select 1 from pharmacies where id = p_pharmacy_id) then raise exception 'Pharmacy not found'; end if;
  insert into sms_wallets (pharmacy_id, balance) values (p_pharmacy_id, 0) on conflict (pharmacy_id) do nothing;
  update sms_wallets set balance = balance + p_amount, updated_at = now()
   where pharmacy_id = p_pharmacy_id returning balance into v_balance;
  insert into sms_wallet_transactions (pharmacy_id, kind, amount, balance_after, description)
    values (p_pharmacy_id, 'adjust', p_amount, v_balance, coalesce(nullif(trim(p_note), ''), 'Adjusted by Pharma'));
  return jsonb_build_object('ok', true, 'balance', v_balance);
exception when check_violation then
  raise exception 'That would take the balance below zero';
end;
$function$;

revoke all on function public.admin_sms_wallet(uuid) from public, anon;
revoke all on function public.admin_adjust_sms_credit(uuid, numeric, text) from public, anon;
grant execute on function public.admin_sms_wallet(uuid) to authenticated;
grant execute on function public.admin_adjust_sms_credit(uuid, numeric, text) to authenticated;

-- Folded in from migrations/2026-10-30_service_role_table_access.sql
-- The server-side account (service_role: Edge Functions and Netlify functions)
-- must be able to read and write the tables it works on. It had lost these,
-- which stopped password-reset codes and SMS sending.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

-- Folded in from migrations/2026-10-30_c_edit_hide_delete_drug.sql
-- Fix a mistyped drug (edit_drug), stop selling one (set_drug_active) or delete one
-- added by mistake (delete_drug, only if it never had stock or sales).
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
