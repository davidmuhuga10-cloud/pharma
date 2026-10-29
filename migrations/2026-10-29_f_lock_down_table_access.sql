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
