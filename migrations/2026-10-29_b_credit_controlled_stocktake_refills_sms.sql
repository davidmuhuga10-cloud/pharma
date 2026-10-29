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
