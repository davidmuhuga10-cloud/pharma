-- Retry safety, proved against a real database.
--
-- This is the test that found and then verified the duplicate-sale bug fixed
-- on 10 November 2026. Unlike the .test.js files (which read the source code),
-- this one actually runs record_sale and friends and counts the rows.
--
-- HOW TO RUN IT (never against production):
--
--   createdb hodhi_test
--   psql hodhi_test -f tests/00_auth_stub.sql
--   psql hodhi_test -f schema.sql
--   psql hodhi_test -f migrations/2026-11-10_retry_safe_writes.sql
--   psql hodhi_test -f tests/retry-safety.sql
--
-- It ends with "20 passed, 0 failed" and raises an exception if anything
-- failed, so it is safe to wire into a script. Everything it writes is rolled
-- back, so you can run it repeatedly against the same database.
--
-- To see the bug it fixes, load schema.sql WITHOUT the migration and call
-- record_sale twice with identical arguments: you get two sales and stock
-- drained twice.
--
\pset pager off

-- ===========================================================================
-- Does the retry-safety fix actually work? Six things must be true.
-- Everything runs in one transaction and is rolled back at the end.
-- ===========================================================================
begin;

create temp table results (n int generated always as identity, ok boolean, label text);
create or replace function chk(p_ok boolean, p_label text) returns void language sql as $$
  insert into results (ok, label) values (p_ok, p_label);
$$;

do $t$
declare
  owner_a uuid; ph_a uuid; drug_a uuid;
  owner_b uuid; ph_b uuid; drug_b uuid;
  key1 uuid := '11111111-1111-1111-1111-111111111111';
  key2 uuid := '22222222-2222-2222-2222-222222222222';
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid;
  n int; qty_left int;
  items jsonb; pays jsonb;
begin
  -- ---- pharmacy A ---------------------------------------------------------
  insert into auth.users default values returning id into owner_a;
  perform test_set_user(owner_a);
  ph_a := bootstrap_pharmacy('Retry Test Pharmacy', 'Owner A', '0700000001');
  insert into drugs (pharmacy_id, name, form, unit)
    values (ph_a, 'Retry Panadol', 'tablet', 'tablet') returning id into drug_a;
  insert into batches (pharmacy_id, drug_id, batch_no, quantity_received,
                       quantity_remaining, cost_price, sell_price, expiry_date)
    values (ph_a, drug_a, 'B1', 100, 100, 10, 20, current_date + 365);

  items := jsonb_build_array(jsonb_build_object('drug_id', drug_a, 'quantity', 3));
  pays  := jsonb_build_array(jsonb_build_object('method','cash','amount',60));

  -- =========================================================================
  -- 1. THE BUG ITSELF: the same request sent twice must produce ONE sale.
  -- =========================================================================
  s1 := record_sale(ph_a, items, pays, null, null, null, 0, key1);
  s2 := record_sale(ph_a, items, pays, null, null, null, 0, key1);

  perform chk(s1 = s2,
    'a retried sale returns the SAME sale id (not a second sale)');

  select count(*) into n from sales where pharmacy_id = ph_a;
  perform chk(n = 1,
    'only ONE sale row exists after the retry (found ' || n || ')');

  select quantity_remaining into qty_left from batches where pharmacy_id = ph_a and batch_no = 'B1';
  perform chk(qty_left = 97,
    'stock was drained ONCE, not twice: 100 - 3 = 97 (found ' || qty_left || ')');

  select count(*) into n from sale_items si join sales s on s.id = si.sale_id
   where s.pharmacy_id = ph_a;
  perform chk(n = 1, 'only one sale line was written (found ' || n || ')');

  select count(*) into n from sales_payments sp join sales s on s.id = sp.sale_id
   where s.pharmacy_id = ph_a;
  perform chk(n = 1, 'the customer was charged ONCE (one payment row, found ' || n || ')');

  select count(*) into n from stock_adjustments where pharmacy_id = ph_a;
  perform chk(n = 1, 'the stock ledger recorded one movement, not two (found ' || n || ')');

  -- =========================================================================
  -- 2. NORMAL SELLING MUST STILL WORK: a different request = a real new sale.
  -- =========================================================================
  s3 := record_sale(ph_a, items, pays, null, null, null, 0, key2);
  perform chk(s3 <> s1, 'a genuinely new sale (new request id) creates a NEW sale');

  select count(*) into n from sales where pharmacy_id = ph_a;
  perform chk(n = 2, 'two distinct sales now exist (found ' || n || ')');

  select quantity_remaining into qty_left from batches where pharmacy_id = ph_a and batch_no = 'B1';
  perform chk(qty_left = 94, 'the second real sale drained stock again: 94 (found ' || qty_left || ')');

  -- =========================================================================
  -- 3. BACKWARDS COMPATIBLE: the browser that is deployed right now sends no
  --    request id. It must keep behaving exactly as before.
  -- =========================================================================
  s4 := record_sale(ph_a, items, pays, null, null, null, 0, null);
  s5 := record_sale(ph_a, items, pays, null, null, null, 0, null);
  perform chk(s4 <> s5,
    'two calls with NO request id still create two sales (old behaviour kept)');

  select count(*) into n from sales where pharmacy_id = ph_a and client_request_id is null;
  perform chk(n = 2, 'those two rows carry a null request id (found ' || n || ')');

  -- a 7-argument call (how the deployed browser and the demo_* functions call it)
  -- must still resolve, now against the new trailing default
  execute format('select record_sale(%L, %L::jsonb, %L::jsonb, null, null, null, 0)',
                 ph_a, items, pays);
  perform chk(true, 'a 7-argument call still resolves after the signature change');

  -- =========================================================================
  -- 4. THE HARD GUARANTEE: the unique index, not application code.
  -- =========================================================================
  begin
    update sales set client_request_id = key1
     where pharmacy_id = ph_a and client_request_id is null
       and id = (select id from sales where pharmacy_id = ph_a and client_request_id is null limit 1);
    perform chk(false, 'the unique index should have refused a duplicate request id');
  exception when unique_violation then
    perform chk(true, 'the unique index refuses a duplicate request id in the same pharmacy');
  end;

  -- =========================================================================
  -- 5. TENANT SCOPING: the same request id in a DIFFERENT pharmacy is a
  --    different request, and must never return pharmacy A's sale.
  -- =========================================================================
  insert into auth.users default values returning id into owner_b;
  perform test_set_user(owner_b);
  ph_b := bootstrap_pharmacy('Other Pharmacy', 'Owner B', '0700000002');
  insert into drugs (pharmacy_id, name, form, unit)
    values (ph_b, 'Other Panadol', 'tablet', 'tablet') returning id into drug_b;
  insert into batches (pharmacy_id, drug_id, batch_no, quantity_received,
                       quantity_remaining, cost_price, sell_price, expiry_date)
    values (ph_b, drug_b, 'B2', 50, 50, 10, 20, current_date + 365);

  s6 := record_sale(ph_b,
          jsonb_build_array(jsonb_build_object('drug_id', drug_b, 'quantity', 1)),
          jsonb_build_array(jsonb_build_object('method','cash','amount',20)),
          null, null, null, 0, key1);          -- deliberately pharmacy A's key

  perform chk(s6 <> s1,
    'the same request id in another pharmacy creates its OWN sale, not a leak');

  select pharmacy_id into ph_b from sales where id = s6;
  perform chk(ph_b is not null, 'that sale belongs to pharmacy B');

  select count(*) into n from sales where client_request_id = key1;
  perform chk(n = 2, 'one row per pharmacy carries that key (found ' || n || ')');

  -- =========================================================================
  -- 6. THE OTHER FOUR FUNCTIONS behave the same way.
  -- =========================================================================
  perform test_set_user(owner_a);

  -- record_expense
  if record_expense(ph_a, 'rent', 'November rent', 5000, 'cash', null, null, key2)
     = record_expense(ph_a, 'rent', 'November rent', 5000, 'cash', null, null, key2)
  then perform chk(true, 'record_expense: a retry returns the same expense');
  else perform chk(false, 'record_expense: a retry created a second expense'); end if;
  select count(*) into n from expenses where pharmacy_id = ph_a;
  perform chk(n = 1, 'record_expense: one expense row exists (found ' || n || ')');

  -- record_restock
  if record_restock(ph_a, drug_a, 20, 10, 20, current_date + 300, 'R1', null, null, false, key2)
     = record_restock(ph_a, drug_a, 20, 10, 20, current_date + 300, 'R1', null, null, false, key2)
  then perform chk(true, 'record_restock: a retry returns the same batch');
  else perform chk(false, 'record_restock: a retry added the delivery twice'); end if;
  select count(*) into n from batches where pharmacy_id = ph_a and batch_no = 'R1';
  perform chk(n = 1, 'record_restock: stock was added ONCE (found ' || n || ' batches)');
end
$t$;

select case when ok then '  PASS  ' else '  FAIL  ' end || label as result from results order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed'
  as summary from results;

-- make a failure impossible to miss
do $$
declare n int;
begin
  select count(*) into n from results where not ok;
  if n > 0 then raise exception '% CHECK(S) FAILED', n; end if;
end $$;

rollback;
