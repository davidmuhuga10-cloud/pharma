-- 2026-10-29 (e) Fast bulk import, old-log cleanup, faster admin portal
--
-- Safe to run more than once. Run it in the Supabase SQL editor BEFORE
-- deploying the matching code. It changes no existing pharmacy data.
--
-- 1. import_stock_rows(): imports a block of up to 500 stock-sheet rows in ONE
--    request instead of two requests per row. Every row still goes through
--    record_restock(), so every rule (who may restock, price and expiry
--    checks, the stock and controlled-drug ledgers) is exactly the same.
--    A bad row is skipped and reported; it does not stop the rest.
-- 2. Nightly cleanup also removes old sign-in records (older than 13 months)
--    and old SMS log rows (older than 2 years). Stock adjustments and the
--    controlled-drugs ledger are legal/audit records and are NEVER deleted.
-- 3. Three indexes that let the admin portal read "the last 30 days across all
--    pharmacies" without scanning every sale ever made.

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
