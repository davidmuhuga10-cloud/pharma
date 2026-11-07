// Automated tests for Hodhi's money/stock-critical SQL functions — the
// logic identified in the code review as having zero test coverage, running
// entirely inside `schema.sql`'s SQL functions. This runs against a fresh,
// local, throwaway Postgres database loaded with the exact same schema.sql
// used in production — never against the real Supabase project.
//
// Setup (see README.md in this folder): a local Postgres with an `auth`
// schema stub (00_auth_stub.sql) standing in for Supabase's real auth, so
// `auth.uid()` and the FK on `profiles` are satisfied without needing a real
// Supabase project. `test_set_user(uuid)` (defined in the stub) is the
// harness's way of saying "the following queries are from this signed-in
// user" — exactly what a real JWT does in production.
//
// Run with: node run_tests.js

const { Client } = require('pg');

const CONN = process.env.HODHI_TEST_DB || 'postgresql://postgres@localhost/hodhi_test';

let pass = 0, fail = 0;
const failures = [];

async function withClient(fn) {
  const client = new Client({ connectionString: CONN });
  await client.connect();
  try { await fn(client); } finally { await client.end(); }
}

function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ✗ ' + msg); }
}

async function assertThrows(promise, msgIfThrew, msgIfDidNot) {
  try {
    await promise;
    fail++; failures.push(msgIfDidNot); console.log('  ✗ ' + msgIfDidNot);
  } catch (e) {
    pass++; console.log('  ✓ ' + msgIfThrew + ' (' + e.message.split('\n')[0] + ')');
  }
}

async function asUser(client, userId) {
  await client.query('select test_set_user($1)', [userId]);
}

async function main() {
  await withClient(async (c) => {
    console.log('\n== Setup: two auth users, one pharmacy ==');
    const ownerRes = await c.query("insert into auth.users default values returning id");
    const ownerId = ownerRes.rows[0].id;
    const staffRes = await c.query("insert into auth.users default values returning id");
    const staffId = staffRes.rows[0].id;

    await asUser(c, ownerId);
    const pharmacyRes = await c.query(
      "select bootstrap_pharmacy('Test Pharmacy', 'Test Owner', '0700000000') as id"
    );
    const pharmacyId = pharmacyRes.rows[0].id;
    assert(!!pharmacyId, 'bootstrap_pharmacy creates a pharmacy and returns its id');

    const catCount = await c.query('select count(*) from drug_categories where pharmacy_id = $1', [pharmacyId]);
    assert(Number(catCount.rows[0].count) === 16, 'bootstrap_pharmacy seeds the 16 starter drug categories');

    const ownerProfile = await c.query('select role from profiles where id = $1', [ownerId]);
    assert(ownerProfile.rows[0].role === 'owner', 'the signup account is created with role=owner');

    // --------------------------------------------------------------
    console.log('\n== FEFO: selling deducts from the soonest-expiring batch first ==');
    const drugRes = await c.query(
      "insert into drugs (pharmacy_id, name, form, unit) values ($1, 'Panadol Extra', 'tablet', 'tablet') returning id",
      [pharmacyId]
    );
    const drugId = drugRes.rows[0].id;

    // Two batches: one expiring soon (10 units), one expiring later (50 units).
    const nearBatch = await c.query(
      "select record_restock($1,$2,10,5,10,(current_date + interval '10 days')::date,'NEAR','SupplierA') as id",
      [pharmacyId, drugId]
    );
    const farBatch = await c.query(
      "select record_restock($1,$2,50,5,10,(current_date + interval '365 days')::date,'FAR','SupplierA') as id",
      [pharmacyId, drugId]
    );

    // Sell 15 — should take all 10 from the near batch, then 5 from the far batch.
    await c.query(
      `select record_sale($1,
         jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 15)),
         jsonb_build_array(jsonb_build_object('method','cash','amount',150))
       ) as id`,
      [pharmacyId, drugId]
    );
    const near = await c.query('select quantity_remaining from batches where id = $1', [nearBatch.rows[0].id]);
    const far = await c.query('select quantity_remaining from batches where id = $1', [farBatch.rows[0].id]);
    assert(Number(near.rows[0].quantity_remaining) === 0, 'the near-expiry batch is fully drained first (0 left)');
    assert(Number(far.rows[0].quantity_remaining) === 45, 'only the shortfall (5) is taken from the far-expiry batch (45 left)');

    // --------------------------------------------------------------
    console.log('\n== Split payments must add up to the sale total ==');
    await assertThrows(
      c.query(
        `select record_sale($1,
           jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 5)),
           jsonb_build_array(jsonb_build_object('method','cash','amount',30), jsonb_build_object('method','mpesa','amount',10))
         )`,
        [pharmacyId, drugId]
      ),
      'a sale is rejected when split payments do not add up to the total',
      'a sale with mismatched split payments should have been rejected but succeeded'
    );

    const validSplit = await c.query(
      `select record_sale($1,
         jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 5)),
         jsonb_build_array(jsonb_build_object('method','cash','amount',25), jsonb_build_object('method','mpesa','amount',25))
       ) as id`,
      [pharmacyId, drugId]
    );
    const splitSaleId = validSplit.rows[0].id;
    const splitSale = await c.query('select payment_method, total_amount from sales where id = $1', [splitSaleId]);
    assert(splitSale.rows[0].payment_method === 'split', 'a correctly balanced two-method payment records as payment_method=split');
    assert(Number(splitSale.rows[0].total_amount) === 50, 'the sale total matches the summed line totals (50)');

    await assertThrows(
      c.query(
        `select record_sale($1, jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 10000)),
           jsonb_build_array(jsonb_build_object('method','cash','amount',100000)))`,
        [pharmacyId, drugId]
      ),
      'selling more than is in stock is rejected',
      'overselling beyond available stock should have been rejected but succeeded'
    );

    // --------------------------------------------------------------
    console.log('\n== Void protection: cannot void a sale that already has a return ==');
    const returnableSale = await c.query(
      `select record_sale($1,
         jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 4)),
         jsonb_build_array(jsonb_build_object('method','cash','amount',40))
       ) as id`,
      [pharmacyId, drugId]
    );
    const saleId = returnableSale.rows[0].id;
    const saleItem = await c.query('select id, batch_id from sale_items where sale_id = $1', [saleId]);
    const batchBefore = await c.query('select quantity_remaining from batches where id = $1', [saleItem.rows[0].batch_id]);

    await c.query("select record_return($1, $2, 2, 'customer changed mind')", [pharmacyId, saleItem.rows[0].id]);
    const batchAfterReturn = await c.query('select quantity_remaining from batches where id = $1', [saleItem.rows[0].batch_id]);
    assert(
      Number(batchAfterReturn.rows[0].quantity_remaining) === Number(batchBefore.rows[0].quantity_remaining) + 2,
      'record_return restores the returned quantity to its original batch'
    );

    await assertThrows(
      c.query("select void_sale($1, $2, 'trying to void after a return')", [pharmacyId, saleId]),
      'voiding a sale that already has a return recorded against it is refused',
      'voiding a sale with an existing return should have been rejected but succeeded (double-credit risk!)'
    );

    console.log('\n== Void: a clean sale (no returns) restores all stock and cannot be voided twice ==');
    const cleanSale = await c.query(
      `select record_sale($1,
         jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 3)),
         jsonb_build_array(jsonb_build_object('method','cash','amount',30))
       ) as id`,
      [pharmacyId, drugId]
    );
    const cleanSaleId = cleanSale.rows[0].id;
    const cleanItem = await c.query('select batch_id from sale_items where sale_id = $1', [cleanSaleId]);
    const beforeVoid = await c.query('select quantity_remaining from batches where id = $1', [cleanItem.rows[0].batch_id]);
    await c.query("select void_sale($1, $2, 'customer walked out')", [pharmacyId, cleanSaleId]);
    const afterVoid = await c.query('select quantity_remaining from batches where id = $1', [cleanItem.rows[0].batch_id]);
    assert(
      Number(afterVoid.rows[0].quantity_remaining) === Number(beforeVoid.rows[0].quantity_remaining) + 3,
      'void_sale restores the full sold quantity back to its batch'
    );
    await assertThrows(
      c.query("select void_sale($1, $2, 'trying again')", [pharmacyId, cleanSaleId]),
      'voiding an already-voided sale is refused',
      'voiding an already-voided sale should have been rejected but succeeded'
    );

    // --------------------------------------------------------------
    console.log('\n== Staff invites: single-use, role-scoped ==');
    const inviteRes = await c.query("select create_staff_invite($1, 'attendant') as code", [pharmacyId]);
    const code = inviteRes.rows[0].code;
    assert(/^[0-9A-F]{10}$/.test(code), 'create_staff_invite returns a 10-character code (about a trillion possibilities, secure random)');

    await asUser(c, staffId);
    await c.query("select join_pharmacy_with_code($1, 'Test Attendant', '0711111111')", [code]);
    const staffProfile = await c.query('select role, pharmacy_id from profiles where id = $1', [staffId]);
    assert(staffProfile.rows[0].role === 'attendant', 'joining with the code assigns the exact role the owner picked');
    assert(staffProfile.rows[0].pharmacy_id === pharmacyId, 'the joining staff member lands in the correct pharmacy');

    const secondStaffRes = await c.query("insert into auth.users default values returning id");
    await asUser(c, secondStaffRes.rows[0].id);
    await assertThrows(
      c.query("select join_pharmacy_with_code($1, 'Second Person', '0722222222')", [code]),
      'a used invite code cannot be redeemed a second time',
      'reusing an already-used invite code should have been rejected but succeeded'
    );

    // --------------------------------------------------------------
    console.log('\n== Role enforcement: restock/correction/write-off/void/return require owner or pharmacist ==');
    await asUser(c, ownerId); // the previous block left the session as a non-owner staff member
    const pharmacistCodeRes = await c.query("select create_staff_invite($1, 'pharmacist') as code", [pharmacyId]);
    const pharmacistCode = pharmacistCodeRes.rows[0].code;
    const pharmacistRes = await c.query("insert into auth.users default values returning id");
    const pharmacistId = pharmacistRes.rows[0].id;
    await asUser(c, pharmacistId);
    await c.query("select join_pharmacy_with_code($1, 'Test Pharmacist', '0733333333')", [pharmacistCode]);

    // staffId is already an 'attendant' from the invite redeemed above.
    await asUser(c, staffId);
    await assertThrows(
      c.query(
        "select record_restock($1,$2,10,5,10,(current_date + interval '30 days')::date,'RB1','Sup')",
        [pharmacyId, drugId]
      ),
      'an attendant cannot restock',
      'an attendant should NOT have been able to restock, but the call succeeded'
    );

    await asUser(c, pharmacistId);
    const roleBatchRes = await c.query(
      "select record_restock($1,$2,10,5,10,(current_date + interval '30 days')::date,'RB1','Sup') as id",
      [pharmacyId, drugId]
    );
    const roleBatchId = roleBatchRes.rows[0].id;
    assert(!!roleBatchId, 'a pharmacist can restock');

    await asUser(c, staffId);
    await assertThrows(
      c.query("select record_correction($1,$2,8,'recount')", [pharmacyId, roleBatchId]),
      'an attendant cannot correct stock',
      'an attendant should NOT have been able to correct stock, but the call succeeded'
    );
    await assertThrows(
      c.query("select record_write_off($1,$2,1,'damaged','write_off')", [pharmacyId, roleBatchId]),
      'an attendant cannot write off stock',
      'an attendant should NOT have been able to write off stock, but the call succeeded'
    );

    const attendantSaleRes = await c.query(
      `select record_sale($1,
         jsonb_build_array(jsonb_build_object('drug_id', $2::text, 'quantity', 1)),
         jsonb_build_array(jsonb_build_object('method','cash','amount',10))
       ) as id`,
      [pharmacyId, drugId]
    );
    assert(!!attendantSaleRes.rows[0].id, 'an attendant can still record a sale (unrestricted by design)');
    const attendantSaleId = attendantSaleRes.rows[0].id;

    await assertThrows(
      c.query("select void_sale($1,$2,'attendant trying to void')", [pharmacyId, attendantSaleId]),
      'an attendant cannot void a sale',
      'an attendant should NOT have been able to void a sale, but the call succeeded'
    );
    const attendantSaleItemRes = await c.query('select id from sale_items where sale_id = $1 limit 1', [attendantSaleId]);
    await assertThrows(
      c.query("select record_return($1,$2,1,'wrong item')", [pharmacyId, attendantSaleItemRes.rows[0].id]),
      'an attendant cannot record a return',
      'an attendant should NOT have been able to record a return, but the call succeeded'
    );

    await asUser(c, pharmacistId);
    await c.query("select void_sale($1,$2,'pharmacist voiding')", [pharmacyId, attendantSaleId]);
    const voidedRoleSale = await c.query('select voided from sales where id = $1', [attendantSaleId]);
    assert(voidedRoleSale.rows[0].voided === true, 'a pharmacist can void a sale');

    // --------------------------------------------------------------
    console.log('\n== record_restock has exactly one overload (regression guard) ==');
    // Two overloads once existed live (the original, and a second one added
    // to support p_expiry_unknown instead of extending the first) and broke
    // every restock call from the app: Supabase/PostgREST calls RPCs with
    // named parameters, and Postgres couldn't choose a unique candidate
    // between them — "function record_restock(...) is not unique". This
    // guards against that regressing silently again.
    const restockOverloads = await c.query("select count(*) from pg_proc where proname = 'record_restock'");
    assert(Number(restockOverloads.rows[0].count) === 1, 'record_restock exists as exactly one function, not multiple overloads');

    // --------------------------------------------------------------
    console.log('\n== sync_master_drugs: fast onboarding from the shared catalog ==');
    const masterAmoxRes = await c.query("select id, name from master_drugs where name = 'Amoxicillin 500mg'");
    const masterAmox = masterAmoxRes.rows[0];
    const masterDropsRes = await c.query("select id from master_drugs where name = 'Gentamicin drops'");
    const masterDrops = masterDropsRes.rows[0];

    await asUser(c, ownerId);
    const syncRes1 = await c.query(
      "select sync_master_drugs($1, $2::jsonb) as result",
      [pharmacyId, JSON.stringify([
        { master_drug_id: masterAmox.id, quantity: 20, sell_price: 50, reorder_level: 8 },
        { master_drug_id: masterDrops.id, quantity: 5, sell_price: 300 }
      ])]
    );
    assert(Array.isArray(syncRes1.rows[0].result) && syncRes1.rows[0].result.length === 2, 'owner can sync two drugs from the master catalog in one call');

    const syncedAmox = await c.query(
      "select d.reorder_level, d.default_price, b.quantity_remaining, b.expiry_unknown, (b.expiry_date = (current_date + interval '3 years')::date) as is_placeholder " +
      "from drugs d join batches b on b.drug_id = d.id where d.pharmacy_id = $1 and d.name = 'Amoxicillin 500mg'",
      [pharmacyId]
    );
    assert(syncedAmox.rows[0].is_placeholder === true && syncedAmox.rows[0].expiry_unknown === true,
      'a synced item with no expiry given gets a placeholder date flagged expiry_unknown, never a fake real date');
    assert(Number(syncedAmox.rows[0].quantity_remaining) === 20, 'the synced batch has the quantity entered');

    await asUser(c, ownerId);
    const syncedAgainRes = await c.query(
      "select sync_master_drugs($1, $2::jsonb) as result",
      [pharmacyId, JSON.stringify([{ master_drug_id: masterAmox.id, quantity: 10, sell_price: 55 }])]
    );
    assert(!!syncedAgainRes.rows[0].result, 'syncing the same catalog item again succeeds (adds a batch, does not error)');
    const amoxDrugCount = await c.query("select count(*) from drugs where pharmacy_id = $1 and name = 'Amoxicillin 500mg'", [pharmacyId]);
    assert(Number(amoxDrugCount.rows[0].count) === 1, 'syncing an already-synced drug again reuses the same drug row, never duplicates it');
    const amoxAfterResync = await c.query("select reorder_level, default_price from drugs where pharmacy_id = $1 and name = 'Amoxicillin 500mg'", [pharmacyId]);
    assert(Number(amoxAfterResync.rows[0].reorder_level) === 8, 're-syncing an existing drug never overwrites its reorder level (still 8 from the first sync)');
    assert(Number(amoxAfterResync.rows[0].default_price) === 55, 're-syncing an existing drug does refresh its default price, same as any restock');

    await assertThrows(
      c.query("select sync_master_drugs($1, $2::jsonb)", [pharmacyId, JSON.stringify([{ master_drug_id: masterAmox.id, quantity: 5 }])]),
      'syncing without a sell price is rejected',
      'syncing without a sell price should have been rejected but succeeded'
    );
    await assertThrows(
      c.query("select sync_master_drugs($1, $2::jsonb)", [pharmacyId, '[]']),
      'syncing an empty selection is rejected',
      'syncing an empty selection should have been rejected but succeeded'
    );

    await asUser(c, staffId); // attendant
    await assertThrows(
      c.query("select sync_master_drugs($1, $2::jsonb)", [pharmacyId, JSON.stringify([{ master_drug_id: masterAmox.id, quantity: 1, sell_price: 10 }])]),
      'an attendant cannot sync drugs',
      'an attendant should NOT have been able to sync drugs, but the call succeeded'
    );
    await asUser(c, pharmacistId);
    const pharmacistSyncRes = await c.query(
      "select sync_master_drugs($1, $2::jsonb) as result",
      [pharmacyId, JSON.stringify([{ master_drug_id: masterAmox.id, quantity: 1, sell_price: 60 }])]
    );
    assert(!!pharmacistSyncRes.rows[0].result, 'a pharmacist can sync drugs');

    // --------------------------------------------------------------
    console.log('\n== Dashboard: supplier_owed_summary matches the old browser-side sum ==');
    await asUser(c, ownerId);
    // Own supplier rows so the numbers are known: A owes 1000+500-200=1300, B is settled,
    // C is under the 0.5 threshold, D is overpaid. Only A counts.
    const sA = (await c.query("insert into suppliers (pharmacy_id, name, opening_balance) values ($1,'Sum A',1000) returning id", [pharmacyId])).rows[0].id;
    const sB = (await c.query("insert into suppliers (pharmacy_id, name, opening_balance) values ($1,'Sum B',0) returning id", [pharmacyId])).rows[0].id;
    const sC = (await c.query("insert into suppliers (pharmacy_id, name, opening_balance) values ($1,'Sum C',0) returning id", [pharmacyId])).rows[0].id;
    const sD = (await c.query("insert into suppliers (pharmacy_id, name, opening_balance) values ($1,'Sum D',0) returning id", [pharmacyId])).rows[0].id;
    await c.query("insert into supplier_lpos (pharmacy_id, supplier_id, lpo_number, total_amount) values ($1,$2,'T-A',500),($1,$3,'T-B',300),($1,$4,'T-C',0.4) returning 1", [pharmacyId, sA, sB, sC]);
    await c.query("insert into supplier_payments (pharmacy_id, supplier_id, amount) values ($1,$2,200),($1,$3,300),($1,$4,50) returning 1", [pharmacyId, sA, sB, sD]);
    // what the old dashboard computed, supplier by supplier, in plain SQL
    const oldWay = await c.query(`select coalesce(sum(b) filter (where b > 0.5),0) as owed, count(*) filter (where b > 0.5) as n from (
        select s.opening_balance + coalesce((select sum(total_amount) from supplier_lpos where supplier_id = s.id),0)
               - coalesce((select sum(amount) from supplier_payments where supplier_id = s.id),0) as b
        from suppliers s where s.pharmacy_id = $1) x`, [pharmacyId]);
    const newWay = await c.query('select owed, owed_count from supplier_owed_summary($1)', [pharmacyId]);
    assert(Number(newWay.rows[0].owed) === Number(oldWay.rows[0].owed) && Number(newWay.rows[0].owed_count) === Number(oldWay.rows[0].n),
      'supplier_owed_summary equals the old sum (owed ' + newWay.rows[0].owed + ', suppliers ' + newWay.rows[0].owed_count + ')');
    const none = await c.query('select owed, owed_count from supplier_owed_summary(gen_random_uuid())');
    assert(Number(none.rows[0].owed) === 0 && Number(none.rows[0].owed_count) === 0, 'an unknown pharmacy id returns zeros');

    // --------------------------------------------------------------
    console.log('\n== Nightly housekeeping removes only old short-lived rows ==');
    await c.query("insert into phone_otps (phone, purpose, code_hash, expires_at, created_at) values ('0700000001','password_reset','h',now(),now() - interval '3 days'),('0700000002','password_reset','h',now(),now() - interval '1 hour') returning 1");
    const hk = await c.query('select housekeeping_daily() as r');
    assert(hk.rows[0].r.otps_deleted === 1, 'housekeeping deleted exactly the 3-day-old one-time code');
    const left = await c.query("select phone from phone_otps where phone in ('0700000001','0700000002')");
    assert(left.rows.length === 1 && left.rows[0].phone === '0700000002', 'the 1-hour-old code is kept');
    const salesN = Number((await c.query('select count(*) n from sales')).rows[0].n);
    await c.query('select housekeeping_daily()');
    assert(Number((await c.query('select count(*) n from sales')).rows[0].n) === salesN, 'housekeeping does not touch sales');

    // ==============================================================
    // 2026-10-29: credit (kopa), controlled drugs, stock take, refills, SMS
    // ==============================================================
    const J = (v) => JSON.stringify(v);
    const money = (v) => Math.round(Number(v) * 100) / 100;
    const sellSql = 'select record_sale($1,$2::jsonb,$3::jsonb,$4,null,$5) as id';
    async function sell(items, payments, customerId, name) {
      const r = await c.query(sellSql, [pharmacyId, J(items), J(payments), name || null, customerId || null]);
      return r.rows[0].id;
    }
    async function balanceOf(customerId) {
      const r = await c.query('select balance from v_customer_balances where customer_id = $1', [customerId]);
      return money(r.rows[0].balance);
    }
    async function shelf(drug) {
      const r = await c.query('select coalesce(sum(quantity_remaining),0)::int as n from batches where drug_id = $1', [drug]);
      return Number(r.rows[0].n);
    }
    async function addDrug(name, qty, cost, price, days) {
      const d = (await c.query("insert into drugs (pharmacy_id, name, form, unit) values ($1,$2,'tablet','tablet') returning id", [pharmacyId, name])).rows[0].id;
      let b = null;
      if (qty > 0) b = (await c.query("select record_restock($1,$2,$3,$4,$5,(current_date + ($6 || ' days')::interval)::date,$7,'Sup') as id", [pharmacyId, d, qty, cost, price, String(days || 365), name + '-B1'])).rows[0].id;
      return { id: d, batch: b };
    }
    async function asRole(role, fn) {
      await c.query('set role ' + role);
      try { return await fn(); } finally { await c.query('reset role'); }
    }
    // the ids of users in each role (owner / pharmacist / attendant exist already)
    await asUser(c, ownerId);
    const stockTakerCode = (await c.query("select create_staff_invite($1, 'stock_taker') as code", [pharmacyId])).rows[0].code;
    const stockTakerId = (await c.query('insert into auth.users default values returning id')).rows[0].id;
    await asUser(c, stockTakerId);
    await c.query("select join_pharmacy_with_code($1, 'Test Stock Taker', '0744444444')", [stockTakerCode]);

    // --------------------------------------------------------------
    console.log('\n== Phone numbers are stored in one format ==');
    await asUser(c, ownerId);
    assert((await c.query("select normalize_ke_phone('0712 345 678') as p")).rows[0].p === '254712345678', '0712 345 678 becomes 254712345678');
    assert((await c.query("select normalize_ke_phone('+254 712345678') as p")).rows[0].p === '254712345678', '+254 712345678 becomes 254712345678');
    assert((await c.query("select normalize_ke_phone('112345678') as p")).rows[0].p === '254112345678', 'a 01xx number works too');
    assert((await c.query("select normalize_ke_phone('') as p")).rows[0].p === null, 'an empty phone is allowed (null)');
    await assertThrows(c.query("select normalize_ke_phone('12345')"), 'a bad phone number is rejected', 'a bad phone number should have been rejected');

    // --------------------------------------------------------------
    console.log('\n== Customers: who may add them, limits, duplicate phones ==');
    const jane = (await c.query("select save_customer($1,'Jane Wanjiru','0712345678',1000,'Neighbour') as id", [pharmacyId])).rows[0].id;
    assert(!!jane, 'the owner can add a customer with a credit limit');
    assert((await c.query('select phone from customers where id = $1', [jane])).rows[0].phone === '254712345678', 'the phone is saved in the normalised format');
    await assertThrows(c.query("select save_customer($1,'Someone Else','0712 345 678')", [pharmacyId]), 'a second customer cannot reuse a phone number', 'a duplicate phone number should have been rejected');
    await asUser(c, staffId); // attendant
    const peter = (await c.query("select save_customer($1,'Peter Kamau','0722000111') as id", [pharmacyId])).rows[0].id;
    assert(!!peter, 'a seller can add a customer at the till');
    await assertThrows(c.query("select save_customer($1,'Limit Try','0722000222',5000)", [pharmacyId]), 'a seller cannot set a credit limit', 'a seller should not be able to set a credit limit');
    await assertThrows(c.query("select save_customer($1,'Peter Kamau','0722000111',5000,null,$2)", [pharmacyId, peter]), 'a seller cannot change a credit limit later either', 'a seller should not be able to change a credit limit');

    // --------------------------------------------------------------
    console.log('\n== Credit sales (kopa): balance, limit, split ==');
    await asUser(c, ownerId);
    const dCredit = await addDrug('Credit Drug', 100, 60, 100);
    await asUser(c, staffId);
    const sale1 = await sell([{ drug_id: dCredit.id, quantity: 5 }], [{ method: 'credit', amount: 500 }], jane);
    assert(await balanceOf(jane) === 500, 'a sale of 500 on credit puts 500 on Jane\'s account');
    assert(await shelf(dCredit.id) === 95, 'stock still comes off the shelf for a credit sale');
    assert((await c.query('select customer_id, customer_name from sales where id = $1', [sale1])).rows[0].customer_name === 'Jane Wanjiru', 'the sale is linked to the customer');
    await assertThrows(sell([{ drug_id: dCredit.id, quantity: 6 }], [{ method: 'credit', amount: 600 }], jane),
      'a credit sale over the customer\'s limit is refused', 'a credit sale over the limit should have been refused');
    assert(await balanceOf(jane) === 500 && await shelf(dCredit.id) === 95, 'a refused credit sale changes nothing (no stock taken, no debt added)');
    await assertThrows(sell([{ drug_id: dCredit.id, quantity: 1 }], [{ method: 'credit', amount: 100 }], null),
      'credit with no customer chosen is refused', 'credit without a customer should have been refused');
    const sale2 = await sell([{ drug_id: dCredit.id, quantity: 3 }], [{ method: 'cash', amount: 100 }, { method: 'credit', amount: 200 }], jane);
    assert(await balanceOf(jane) === 700, 'cash 100 + credit 200 on a 300 sale adds only the 200 to the balance');
    const peterSale = await sell([{ drug_id: dCredit.id, quantity: 2 }], [{ method: 'credit', amount: 200 }], peter);
    assert(await balanceOf(peter) === 200, 'a customer with no limit set can take credit');
    await assertThrows(sell([{ drug_id: dCredit.id, quantity: 1 }], [{ method: 'credit', amount: 100 }], '00000000-0000-0000-0000-000000000000'),
      'an unknown customer is refused', 'an unknown customer should have been refused');
    const cashSale = await sell([{ drug_id: dCredit.id, quantity: 1 }], [{ method: 'cash', amount: 100 }], jane);
    assert(await balanceOf(jane) === 700, 'a cash sale linked to a customer does not change what they owe');

    // --------------------------------------------------------------
    console.log('\n== Customer payments ==');
    await asUser(c, ownerId);
    const pay1 = (await c.query("select record_customer_payment($1,$2,300,'mpesa','QWE123') as id", [pharmacyId, jane])).rows[0].id;
    assert(await balanceOf(jane) === 400, 'a 300 payment brings 700 down to 400');
    await assertThrows(c.query("select record_customer_payment($1,$2,500,'cash')", [pharmacyId, jane]), 'paying more than is owed is refused', 'overpaying should have been refused');
    await assertThrows(c.query("select record_customer_payment($1,$2,0,'cash')", [pharmacyId, jane]), 'a zero payment is refused', 'a zero payment should have been refused');
    await asUser(c, staffId);
    const pay2 = (await c.query("select record_customer_payment($1,$2,100,'cash') as id", [pharmacyId, jane])).rows[0].id;
    assert(await balanceOf(jane) === 300, 'a seller can take a payment at the counter');
    await assertThrows(c.query("select void_customer_payment($1,$2,'mistake')", [pharmacyId, pay2]), 'a seller cannot reverse a payment', 'a seller should not be able to reverse a payment');
    const pharmacistUser = pharmacistId;
    await asUser(c, pharmacistUser);
    await assertThrows(c.query("select void_customer_payment($1,$2,'')", [pharmacyId, pay2]), 'reversing a payment needs a reason', 'a payment reversal without a reason should have been refused');
    await c.query("select void_customer_payment($1,$2,'entered twice')", [pharmacyId, pay2]);
    assert(await balanceOf(jane) === 400, 'reversing a payment puts the debt back');
    await assertThrows(c.query("select void_customer_payment($1,$2,'again')", [pharmacyId, pay2]), 'a payment cannot be reversed twice', 'double reversal should have been refused');
    await assertThrows(c.query("select save_customer($1,'Jane Wanjiru','0712345678',1000,null,$2,true,false)", [pharmacyId, jane]),
      'an account with a balance cannot be closed', 'closing an account that owes money should have been refused');

    // --------------------------------------------------------------
    console.log('\n== Returns and voids on credit sales ==');
    const itemOf = async (saleId) => (await c.query('select id from sale_items where sale_id = $1 order by id limit 1', [saleId])).rows[0].id;
    await c.query('select record_return($1,$2,2,$3)', [pharmacyId, await itemOf(sale1), 'wrong pack']);
    assert(await balanceOf(jane) === 200, 'returning 2 of 5 (200) from a credit sale reduces the debt by 200');
    // sale2 was 300: 100 cash + 200 credit. Returning everything refunds 300 but only 200 was owed.
    const item2 = await itemOf(sale2);
    await c.query('select record_return($1,$2,3,$3)', [pharmacyId, item2, 'not needed']);
    assert(await balanceOf(jane) === 0, 'a return never reduces the debt by more than the credit that sale carried (200, not 300)');
    const sale3 = await sell([{ drug_id: dCredit.id, quantity: 1 }], [{ method: 'credit', amount: 100 }], jane);
    assert(await balanceOf(jane) === 100, 'one more credit sale of 100');
    await c.query("select void_sale($1,$2,'wrong customer')", [pharmacyId, sale3]);
    assert(await balanceOf(jane) === 0, 'voiding a credit sale removes it from what the customer owes');
    const st = await c.query('select * from customer_statement($1,$2)', [pharmacyId, jane]);
    assert(st.rows.length >= 6, 'the statement lists credit sales, payments and credit notes (' + st.rows.length + ' lines)');
    assert(money(st.rows[st.rows.length - 1].running) === 0, 'the statement\'s running balance ends at the same figure (0)');
    assert(st.rows.filter(r => r.kind === 'credit').every(r => r.sale_id), 'every credit line on the statement points at its sale (sale_id)');
    assert(st.rows.filter(r => r.kind === 'payment').every(r => r.pay_id), 'every payment line carries its pay_id so it can be reversed');

    // --------------------------------------------------------------
    console.log('\n== Credit tables cannot be written to directly ==');
    await asUser(c, staffId);
    await asRole('authenticated', async () => {
      await assertThrows(c.query("insert into customer_payments (pharmacy_id, customer_id, amount) values ($1,$2,50) returning 1", [pharmacyId, peter]),
        'a seller cannot insert a customer payment by hand', 'a direct insert into customer_payments should have been refused');
      await assertThrows(c.query("update customers set credit_limit = 999999 where id = $1 returning 1", [peter]),
        'a seller cannot raise a credit limit by hand', 'a direct update of customers should have been refused');
      const seen = await c.query('select count(*) n from customers');
      assert(Number(seen.rows[0].n) >= 2, 'but customers can still be read by the pharmacy\'s own staff');
    });

    // --------------------------------------------------------------
    console.log('\n== Controlled drugs: marking, protection, prescription rules ==');
    await asUser(c, ownerId);
    const dMor = await addDrug('Morphine Test 10mg', 20, 100, 200);
    await c.query("update drugs set is_prescription = true where id = $1 returning 1", [dMor.id]);
    await asUser(c, staffId);
    await assertThrows(c.query("select set_drug_control($1,$2,'dda')", [pharmacyId, dMor.id]), 'a seller cannot mark a drug as controlled', 'a seller should not be able to mark a controlled drug');
    await asUser(c, pharmacistId);
    await c.query("select set_drug_control($1,$2,'dda')", [pharmacyId, dMor.id]);
    const led0 = await c.query('select kind, quantity_delta, balance_after from controlled_ledger where drug_id = $1 order by seq', [dMor.id]);
    assert(led0.rows.length === 1 && led0.rows[0].kind === 'opening' && Number(led0.rows[0].quantity_delta) === 20 && Number(led0.rows[0].balance_after) === 20,
      'marking a drug controlled writes an opening row with what is on the shelf (20)');
    await assertThrows(c.query("update drugs set control_class = 'none' where id = $1 returning 1", [dMor.id]),
      'control status cannot be switched off by editing the drug row', 'switching off control by a direct update should have been refused');
    await assertThrows(c.query("insert into drugs (pharmacy_id, name, control_class) values ($1,'Sneaky','dda') returning 1", [pharmacyId]),
      'a drug cannot be created as controlled by a direct insert', 'a direct insert with control_class should have been refused');
    await assertThrows(c.query("select set_drug_control($1,$2,'weird')", [pharmacyId, dMor.id]), 'an unknown control class is refused', 'an unknown class should have been refused');
    await asUser(c, staffId);
    await assertThrows(sell([{ drug_id: dMor.id, quantity: 2, patient_name: 'A Patient' }], [{ method: 'cash', amount: 400 }]),
      'a controlled sale without prescriber and Rx number is refused', 'a controlled sale without a prescriber should have been refused');
    assert(await shelf(dMor.id) === 20, 'the refused controlled sale took no stock');
    const morSale = await sell([{ drug_id: dMor.id, quantity: 2, patient_name: 'A Patient', prescriber_name: 'Dr Otieno', rx_number: 'RX-5521' }], [{ method: 'cash', amount: 400 }]);
    const ledSale = (await c.query("select * from controlled_ledger where drug_id = $1 and kind = 'sale'", [dMor.id])).rows;
    assert(ledSale.length === 1 && Number(ledSale[0].quantity_delta) === -2 && Number(ledSale[0].balance_after) === 18 &&
           ledSale[0].patient_name === 'A Patient' && ledSale[0].prescriber_name === 'Dr Otieno' && ledSale[0].rx_number === 'RX-5521' &&
           ledSale[0].ref_sale_id === morSale,
      'a controlled sale writes patient, prescriber, Rx number and the new balance (18) to the ledger');
    assert((await c.query('select rx_number from sale_items where sale_id = $1', [morSale])).rows[0].rx_number === 'RX-5521', 'the Rx number is kept on the sale line too');

    console.log('\n== Controlled drugs: every other stock movement lands in the ledger ==');
    await asUser(c, pharmacistId);
    const morItem = (await c.query('select id from sale_items where sale_id = $1', [morSale])).rows[0].id;
    await c.query("select record_return($1,$2,1,'patient returned one')", [pharmacyId, morItem]);
    await c.query("select record_correction($1,$2,17,'recount')", [pharmacyId, dMor.batch]);
    await c.query("select record_write_off($1,$2,1,'broken ampoule')", [pharmacyId, dMor.batch]);
    await c.query("select record_restock($1,$2,10,100,200,(current_date + interval '200 days')::date,'MOR-2','Sup')", [pharmacyId, dMor.id]);
    const kinds = (await c.query('select kind from controlled_ledger where drug_id = $1 order by seq', [dMor.id])).rows.map((r) => r.kind);
    assert(J(kinds) === J(['opening', 'sale', 'return', 'correction', 'write_off', 'restock']), 'the ledger shows opening, sale, return, correction, write-off and restock in order (' + kinds.join(',') + ')');
    const retRow = (await c.query("select ref_sale_id, note from controlled_ledger where drug_id = $1 and kind = 'return'", [dMor.id])).rows[0];
    assert(retRow.ref_sale_id === morSale && retRow.note === 'patient returned one', 'a return in the ledger points at its sale and keeps the reason');
    const reg = (await c.query('select shelf_qty, ledger_qty from v_controlled_register where drug_id = $1', [dMor.id])).rows[0];
    assert(Number(reg.shelf_qty) === Number(reg.ledger_qty) && Number(reg.shelf_qty) === 26, 'after all that, the ledger balance equals the shelf (26)');
    const ex0 = (await c.query('select dashboard_extras($1) as x', [pharmacyId])).rows[0].x;
    assert(Number(ex0.controlled_mismatch) === 0, 'the dashboard reports no controlled-drug mismatch');
    await c.query("update batches set quantity_remaining = quantity_remaining - 3 where id = $1 returning 1", [dMor.batch]);
    const reg2 = (await c.query('select shelf_qty, ledger_qty from v_controlled_register where drug_id = $1', [dMor.id])).rows[0];
    assert(Number(reg2.shelf_qty) === 23 && Number(reg2.ledger_qty) === 26, 'a batch changed behind the register\'s back shows as a mismatch (23 vs 26)');
    assert(Number((await c.query('select dashboard_extras($1) as x', [pharmacyId])).rows[0].x.controlled_mismatch) === 1, 'and the dashboard counts it');
    await c.query("update batches set quantity_remaining = quantity_remaining + 3 where id = $1 returning 1", [dMor.batch]);
    const morVoidSale = await sell([{ drug_id: dMor.id, quantity: 1, patient_name: 'P2', prescriber_name: 'Dr X', rx_number: 'RX-1' }], [{ method: 'cash', amount: 200 }]);
    await c.query("select void_sale($1,$2,'entered wrongly')", [pharmacyId, morVoidSale]);
    assert((await c.query("select count(*) n from controlled_ledger where drug_id = $1 and kind = 'void'", [dMor.id])).rows[0].n == 1, 'a voided controlled sale is reversed in the ledger');
    assert((await c.query('select count(*) n from controlled_ledger where drug_id = $1', [dCredit.id])).rows[0].n == 0, 'a normal drug never gets ledger rows');

    console.log('\n== Controlled ledger cannot be edited ==');
    await asUser(c, ownerId);
    await asRole('authenticated', async () => {
      await assertThrows(c.query("update controlled_ledger set quantity_delta = 0 returning 1"), 'nobody can edit a ledger row', 'a ledger update should have been refused');
      await assertThrows(c.query("delete from controlled_ledger returning 1"), 'nobody can delete a ledger row', 'a ledger delete should have been refused');
      await assertThrows(c.query("insert into controlled_ledger (pharmacy_id, drug_id, kind, quantity_delta, balance_after) values ($1,$2,'sale',-1,0) returning 1", [pharmacyId, dMor.id]),
        'nobody can insert a ledger row by hand', 'a ledger insert should have been refused');
    });
    await asUser(c, pharmacistId);
    await c.query("select set_drug_control($1,$2,'none')", [pharmacyId, dMor.id]);
    assert((await c.query('select count(*) n from controlled_ledger where drug_id = $1', [dMor.id])).rows[0].n >= 7, 'turning control off keeps the history');
    assert((await c.query('select control_class from v_drug_stock where drug_id = $1', [dMor.id])).rows[0].control_class === 'none', 'v_drug_stock shows the control class');

    // --------------------------------------------------------------
    console.log('\n== Stock take ==');
    await asUser(c, ownerId);
    const stA = await addDrug('Take A', 50, 10, 20);
    const stB = await addDrug('Take B', 30, 5, 9);
    const stC = await addDrug('Take C', 40, 2, 4);
    await asUser(c, stockTakerId);
    const take1 = (await c.query("select start_stock_take($1,'Shelf A') as id", [pharmacyId])).rows[0].id;
    assert(!!take1, 'a stock taker can start a stock take');
    await assertThrows(c.query("select start_stock_take($1,'Second')", [pharmacyId]), 'only one stock take can be open at a time', 'a second open stock take should have been refused');
    const cA = (await c.query('select stock_take_count($1,$2,$3,47) as r', [pharmacyId, take1, stA.id])).rows[0].r;
    assert(cA.system_qty === 50 && cA.difference === -3, 'counting 47 against 50 on the system shows a difference of -3');
    await c.query('select stock_take_count($1,$2,$3,33)', [pharmacyId, take1, stB.id]);
    await c.query('select stock_take_count($1,$2,$3,40)', [pharmacyId, take1, stC.id]);
    await assertThrows(c.query('select stock_take_count($1,$2,$3,-1)', [pharmacyId, take1, stC.id]), 'a negative count is refused', 'a negative count should have been refused');
    await assertThrows(c.query("select approve_stock_take($1,$2,'{}'::jsonb)", [pharmacyId, take1]), 'a stock taker cannot approve their own count', 'a stock taker should not be able to approve');
    // a sale between counting A and approving must not be mistaken for a loss
    await asUser(c, staffId);
    await sell([{ drug_id: stA.id, quantity: 4 }], [{ method: 'cash', amount: 80 }]);
    await asUser(c, pharmacistId);
    await assertThrows(c.query("select approve_stock_take($1,$2,'{}'::jsonb)", [pharmacyId, take1]), 'every difference needs a reason', 'approving without reasons should have been refused');
    await assertThrows(c.query('select approve_stock_take($1,$2,$3::jsonb)', [pharmacyId, take1, J({ [stA.id]: 'found', [stB.id]: 'found' })]),
      'a shortage cannot be called "found"', 'a shortage marked found should have been refused');
    await assertThrows(c.query('select approve_stock_take($1,$2,$3::jsonb)', [pharmacyId, take1, J({ [stA.id]: 'damaged', [stB.id]: 'damaged' })]),
      'extra stock cannot be called "damaged"', 'extra stock marked damaged should have been refused');
    assert(await shelf(stA.id) === 46 && await shelf(stB.id) === 30, 'a refused approval changes no stock');
    const ap = (await c.query('select approve_stock_take($1,$2,$3::jsonb) as r', [pharmacyId, take1, J({ [stA.id]: 'damaged', [stB.id]: 'found' })])).rows[0].r;
    assert(ap.adjusted === 2, 'two drugs were adjusted (the matching one was left alone)');
    assert(await shelf(stA.id) === 43, 'A: 50 on the system when counted, 47 counted = -3, applied on top of the 4 sold since (46 - 3 = 43)');
    assert(await shelf(stB.id) === 33, 'B: 3 extra found, so 30 becomes 33');
    assert(await shelf(stC.id) === 40, 'C matched, so it is untouched');
    assert(money(ap.total_cost_variance) === money(-3 * 10 + 3 * 5), 'cost variance = 3 lost at 10 and 3 found at 5 = -15');
    const adj = (await c.query("select type, quantity_delta, reason from stock_adjustments where drug_id = $1 and type::text = 'stock_take'", [stA.id])).rows;
    assert(adj.length === 1 && Number(adj[0].quantity_delta) === -3 && /damaged/.test(adj[0].reason), 'the shortage is on the stock audit trail with its reason');
    assert((await c.query('select status from stock_takes where id = $1', [take1])).rows[0].status === 'approved', 'the stock take is closed');
    await assertThrows(c.query("select approve_stock_take($1,$2,'{}'::jsonb)", [pharmacyId, take1]), 'an approved stock take cannot be approved again', 'double approval should have been refused');
    await assertThrows(c.query('select stock_take_count($1,$2,$3,10)', [pharmacyId, take1, stC.id]), 'a closed stock take cannot be counted into', 'counting into a closed stock take should have been refused');

    console.log('\n== Stock take: edge cases ==');
    const stD = await addDrug('Take D', 5, 10, 20);
    const take2 = (await c.query("select start_stock_take($1,'Edge') as id", [pharmacyId])).rows[0].id;
    await c.query('select stock_take_count($1,$2,$3,0)', [pharmacyId, take2, stD.id]);
    await asUser(c, staffId);
    await sell([{ drug_id: stD.id, quantity: 5 }], [{ method: 'cash', amount: 100 }]);
    await asUser(c, pharmacistId);
    await assertThrows(c.query('select approve_stock_take($1,$2,$3::jsonb)', [pharmacyId, take2, J({ [stD.id]: 'missing' })]),
      'if the stock changed since it was counted the approval asks for a recount', 'approval after the stock changed should have been refused');
    // FEFO order for a shortage, and found stock going to the latest in-date batch
    const stE = await addDrug('Take E', 10, 10, 20, 30);
    await c.query("select record_restock($1,$2,10,10,20,(current_date + interval '400 days')::date,'E-LATE','Sup')", [pharmacyId, stE.id]);
    await c.query('select stock_take_count($1,$2,$3,16)', [pharmacyId, take2, stE.id]);
    await c.query('select stock_take_remove_count($1,$2,$3)', [pharmacyId, take2, stD.id]);
    await c.query('select approve_stock_take($1,$2,$3::jsonb)', [pharmacyId, take2, J({ [stE.id]: 'missing' })]);
    const eb = (await c.query("select batch_no, quantity_remaining from batches where drug_id = $1 order by expiry_date", [stE.id])).rows;
    assert(Number(eb[0].quantity_remaining) === 6 && Number(eb[1].quantity_remaining) === 10, 'a shortage of 4 comes off the soonest-expiring batch first (10 -> 6, the later batch untouched)');
    const stF = await addDrug('Take F', 0, 1, 2);
    await c.query("insert into batches (pharmacy_id, drug_id, batch_no, quantity_received, quantity_remaining, cost_price, sell_price, expiry_date) values ($1,$2,'OLD',5,0,1,2,current_date - 10) returning 1", [pharmacyId, stF.id]);
    const take3 = (await c.query("select start_stock_take($1,'Surplus') as id", [pharmacyId])).rows[0].id;
    await c.query('select stock_take_count($1,$2,$3,2)', [pharmacyId, take3, stF.id]);
    await assertThrows(c.query('select approve_stock_take($1,$2,$3::jsonb)', [pharmacyId, take3, J({ [stF.id]: 'found' })]),
      'found stock with no in-date batch to hold it is refused', 'surplus with no in-date batch should have been refused');
    await c.query('select cancel_stock_take($1,$2)', [pharmacyId, take3]);
    assert((await c.query('select status from stock_takes where id = $1', [take3])).rows[0].status === 'cancelled', 'a stock take can be cancelled');
    await assertThrows(c.query('select cancel_stock_take($1,$2)', [pharmacyId, take3]), 'a cancelled stock take cannot be cancelled again', 'double cancel should have been refused');

    // --------------------------------------------------------------
    console.log('\n== Edit, stop selling and delete a drug ==');
    await asUser(c, pharmacistId);
    const eA = await addDrug('Amoxcilin 500', 20, 5, 10);          // mistyped on purpose
    const eB = await addDrug('Amoxicillin 250', 0, 5, 10);         // no stock, never restocked
    const sold0 = (await c.query('select count(*)::int n from sale_items')).rows[0].n;
    await c.query("select edit_drug($1,$2,'Amoxicillin 500',null,'capsule','capsule',12,false,10,'strip')", [pharmacyId, eA.id]);
    const eaRow = (await c.query('select name, form::text, unit, reorder_level, is_prescription, pack_size, pack_label from drugs where id = $1', [eA.id])).rows[0];
    assert(eaRow.name === 'Amoxicillin 500' && eaRow.form === 'capsule' && eaRow.unit === 'capsule' && eaRow.reorder_level === 12 && eaRow.is_prescription === false && eaRow.pack_size === 10 && eaRow.pack_label === 'strip', 'edit_drug fixes the name and the other details');
    assert(await shelf(eA.id) === 20, 'editing a drug leaves its stock alone');
    await asUser(c, staffId);
    await sell([{ drug_id: eA.id, quantity: 2 }], [{ method: 'cash', amount: 20 }]);
    await asUser(c, pharmacistId);
    const soldName = (await c.query("select d.name from sale_items si join drugs d on d.id = si.drug_id where si.drug_id = $1", [eA.id])).rows[0].name;
    assert(soldName === 'Amoxicillin 500', 'a past sale shows the corrected name');
    await assertThrows(c.query("select edit_drug($1,$2,'amoxicillin 250',null,'tablet','tablet',5,false,null,null)", [pharmacyId, eA.id]), 'a name already used by another drug is refused (any capitals)', 'a duplicate name should have been refused');
    await assertThrows(c.query("select edit_drug($1,$2,'   ',null,'tablet','tablet',5,false,null,null)", [pharmacyId, eA.id]), 'an empty name is refused', 'an empty name should have been refused');
    await assertThrows(c.query("select edit_drug($1,$2,'X',null,'tablet','tablet',-1,false,null,null)", [pharmacyId, eA.id]), 'a negative reorder level is refused', 'a negative reorder level should have been refused');
    await assertThrows(c.query("select edit_drug($1,$2,'X',gen_random_uuid(),'tablet','tablet',5,false,null,null)", [pharmacyId, eA.id]), 'a category from nowhere is refused', 'an unknown category should have been refused');
    await c.query("select edit_drug($1,$2,'Amoxicillin 500',null,'capsule','capsule',12,false,10,'strip')", [pharmacyId, eA.id]);
    assert(true, 'saving a drug under its own name is fine');
    await assertThrows(c.query('select set_drug_active($1,$2,false)', [pharmacyId, eA.id]), 'a drug with stock cannot be hidden', 'hiding a drug that still has stock should have been refused');
    await c.query("update batches set quantity_remaining = 0 where drug_id = $1", [eA.id]);
    await c.query("update batches set expiry_date = current_date - 5, quantity_remaining = 3 where drug_id = $1", [eA.id]);
    await assertThrows(c.query('select set_drug_active($1,$2,false)', [pharmacyId, eA.id]), 'expired stock still counts, so the drug cannot be hidden', 'hiding a drug with expired stock should have been refused');
    await c.query("update batches set quantity_remaining = 0 where drug_id = $1", [eA.id]);
    await c.query('select set_drug_active($1,$2,false)', [pharmacyId, eA.id]);
    assert((await c.query('select count(*)::int n from v_drug_stock where drug_id = $1', [eA.id])).rows[0].n === 0, 'a hidden drug leaves the stock list and Sell');
    assert((await c.query('select count(*)::int n from sale_items where drug_id = $1', [eA.id])).rows[0].n >= 1, 'its sales history is still there');
    await assertThrows(c.query("select edit_drug($1,$2,'Amoxicillin 500',null,'tablet','tablet',5,false,null,null)", [pharmacyId, eB.id]), 'a name used by a hidden drug is refused too', 'a hidden drug name should have been refused');
    await c.query('select set_drug_active($1,$2,true)', [pharmacyId, eA.id]);
    assert((await c.query('select count(*)::int n from v_drug_stock where drug_id = $1', [eA.id])).rows[0].n === 1, 'bringing a drug back puts it on the list again');
    await assertThrows(c.query('select delete_drug($1,$2)', [pharmacyId, eA.id]), 'a drug that ever had stock cannot be deleted', 'deleting a drug with stock history should have been refused');
    const eC = await addDrug('Typo drug', 0, 1, 2);
    await asUser(c, staffId);
    await assertThrows(c.query("select edit_drug($1,$2,'Hacked',null,'tablet','tablet',5,false,null,null)", [pharmacyId, eC.id]), 'an attendant cannot edit a drug', 'an attendant should not be able to edit a drug');
    await assertThrows(c.query('select set_drug_active($1,$2,false)', [pharmacyId, eC.id]), 'an attendant cannot hide a drug', 'an attendant should not be able to hide a drug');
    await assertThrows(c.query('select delete_drug($1,$2)', [pharmacyId, eC.id]), 'an attendant cannot delete a drug', 'an attendant should not be able to delete a drug');
    await asUser(c, pharmacistId);
    await c.query('select delete_drug($1,$2)', [pharmacyId, eC.id]);
    assert((await c.query('select count(*)::int n from drugs where id = $1', [eC.id])).rows[0].n === 0, 'a drug added by mistake can be deleted');
    await assertThrows(c.query('select delete_drug($1,$2)', [pharmacyId, eC.id]), 'deleting it twice says not found', 'a second delete should have been refused');
    // a drug that has been on a stock take or the controlled ledger is protected by its own records
    const eD = await addDrug('Counted once', 0, 1, 2);
    const takeX = (await c.query("select start_stock_take($1,'Del') as id", [pharmacyId])).rows[0].id;
    await c.query('select stock_take_count($1,$2,$3,0)', [pharmacyId, takeX, eD.id]);
    await assertThrows(c.query('select delete_drug($1,$2)', [pharmacyId, eD.id]), 'a drug on a stock take cannot be deleted', 'deleting a drug on a stock take should have been refused');
    await c.query('select cancel_stock_take($1,$2)', [pharmacyId, takeX]);
    // another pharmacy cannot touch it
    const drugOtherOwner = (await c.query('insert into auth.users default values returning id')).rows[0].id;
    await asUser(c, drugOtherOwner);
    const drugOtherPh = (await c.query("select bootstrap_pharmacy('Other Pharmacy', 'Other Owner', '0799999999') as id")).rows[0].id;
    await assertThrows(c.query("select edit_drug($1,$2,'Stolen',null,'tablet','tablet',5,false,null,null)", [drugOtherPh, eA.id]), 'another pharmacy cannot edit this drug', 'a drug of another pharmacy should not be editable');
    await assertThrows(c.query('select set_drug_active($1,$2,false)', [pharmacyId, eA.id]), 'another pharmacy cannot use this pharmacy id', 'wrong pharmacy id should have been refused');
    await asUser(c, pharmacistId);

    // --------------------------------------------------------------
    console.log('\n== Refills ==');
    await asUser(c, staffId);
    const plan = (await c.query("select save_refill_plan($1,$2,'Credit Drug',30,$3,(current_date - 40),30) as id", [pharmacyId, jane, dCredit.id])).rows[0].id;
    const rv = (await c.query('select days_overdue, drug_name from v_refills where plan_id = $1', [plan])).rows[0];
    assert(Number(rv.days_overdue) >= 9 && Number(rv.days_overdue) <= 11, 'a plan last filled 40 days ago on a 30 day cycle is about 10 days overdue (' + rv.days_overdue + ')');
    await assertThrows(c.query("select save_refill_plan($1,$2,'X',0)", [pharmacyId, jane]), 'a 0-day refill cycle is refused', 'a 0 day interval should have been refused');
    await assertThrows(c.query("select save_refill_plan($1,$2,'X',30,null,(current_date + 3))", [pharmacyId, jane]), 'a fill date in the future is refused', 'a future fill date should have been refused');
    await assertThrows(c.query("select save_refill_plan($1,$2,'',30)", [pharmacyId, jane]), 'a refill needs a medicine name', 'a nameless refill should have been refused');
    assert(Number((await c.query('select dashboard_extras($1) as x', [pharmacyId])).rows[0].x.refills_due) === 1, 'the dashboard counts the refill as due');
    await sell([{ drug_id: dCredit.id, quantity: 1 }], [{ method: 'cash', amount: 100 }], jane);
    const rv2 = (await c.query('select days_overdue from v_refills where plan_id = $1', [plan])).rows[0];
    assert(Number(rv2.days_overdue) === -30, 'selling that drug to that customer moves the plan on (next due in 30 days)');
    await c.query("select mark_refilled($1,$2,(current_date - 5))", [pharmacyId, plan]);
    assert(Number((await c.query('select days_overdue from v_refills where plan_id = $1', [plan])).rows[0].days_overdue) === -25, 'mark as refilled on an earlier date sets the cycle from that date');
    await c.query('select stop_refill_plan($1,$2)', [pharmacyId, plan]);
    assert((await c.query('select count(*) n from v_refills where plan_id = $1', [plan])).rows[0].n == 0, 'a stopped refill leaves the list');
    await assertThrows(c.query('select stop_refill_plan($1,$2)', [pharmacyId, plan]), 'a stopped refill cannot be stopped again', 'double stop should have been refused');

    // --------------------------------------------------------------
    console.log('\n== SMS: who can send, the daily limit, opt-out ==');
    await asUser(c, ownerId);
    const planB = (await c.query("select save_refill_plan($1,$2,'Amlodipine 5mg',30,null,(current_date - 35)) as id", [pharmacyId, jane])).rows[0].id;
    const noPhone = (await c.query("select save_customer($1,'No Phone Person') as id", [pharmacyId])).rows[0].id;
    const optOut = (await c.query("select save_customer($1,'Opt Out','0733111222',null,null,null,false) as id", [pharmacyId])).rows[0].id;
    await asUser(c, staffId);
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'hi', kind: 'custom' }])]), 'a seller cannot send SMS', 'a seller should not be able to send SMS');
    await asUser(c, pharmacistId);
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'hi', kind: 'custom' }])]), 'with no SMS credit nothing is queued', 'a pharmacy with no SMS credit should not be able to queue a message');
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query("insert into sms_wallets (pharmacy_id, balance) values ($1, 100) on conflict (pharmacy_id) do update set balance = 100", [pharmacyId]);
    await asUser(c, pharmacistId);
    const q1 = (await c.query("select sms_queue($1,$2::jsonb) as r", [pharmacyId, J([{ customer_id: jane, body: 'Hello Jane, your refill is due.', kind: 'refill', ref_id: planB }])])).rows[0].r;
    assert(q1.queued.length === 1 && q1.queued[0].to === '254712345678', 'a pharmacist queues a refill reminder to the customer\'s number');
    assert((await c.query("select status from sms_log where id = $1", [q1.queued[0].id])).rows[0].status === 'queued', 'the log row starts as queued');
    assert(Number((await c.query('select balance from sms_wallets where pharmacy_id = $1', [pharmacyId])).rows[0].balance) === 99, 'a short SMS costs KES 1 from the wallet');
    assert((await c.query('select last_reminded_on from refill_plans where id = $1', [planB])).rows[0].last_reminded_on !== null, 'the refill is marked as reminded today');
    const q2 = (await c.query("select sms_queue($1,$2::jsonb) as r", [pharmacyId, J([{ customer_id: jane, body: 'again', kind: 'refill', ref_id: planB }])])).rows[0].r;
    assert(q2.queued.length === 0 && q2.skipped[0].reason === 'already_reminded_today', 'the same refill is not texted twice in one day');
    const q3 = (await c.query("select sms_queue($1,$2::jsonb) as r", [pharmacyId, J([{ customer_id: noPhone, body: 'x', kind: 'custom' }, { customer_id: optOut, body: 'x', kind: 'custom' }])])).rows[0].r;
    assert(q3.queued.length === 0 && q3.skipped.length === 2, 'a customer with no phone, or who opted out, is skipped');
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'x'.repeat(460), kind: 'custom' }])]), 'a message over 459 characters is refused', 'an over-long message should have been refused');
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: '  ', kind: 'custom' }])]), 'an empty message is refused', 'an empty message should have been refused');
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: '00000000-0000-0000-0000-000000000000', body: 'x', kind: 'custom' }])]), 'an unknown customer is refused', 'an unknown customer should have been refused');
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J(new Array(51).fill({ customer_id: jane, body: 'x', kind: 'custom' }))]), 'more than 50 at once is refused', 'a batch over 50 should have been refused');
    // daily limit: platform sets it; the pharmacy cannot raise it
    await asUser(c, ownerId);
    await assertThrows(c.query('update pharmacies set sms_daily_cap = 5000 where id = $1 returning 1', [pharmacyId]), 'an owner cannot raise their own daily SMS limit', 'raising the SMS cap as a user should have been refused');
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query('update pharmacies set sms_daily_cap = 2 where id = $1 returning 1', [pharmacyId]);
    await asUser(c, pharmacistId);
    await c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'second', kind: 'custom' }])]);
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'third', kind: 'custom' }])]), 'the daily limit stops the third message', 'the daily limit should have stopped a third message');
    await c.query("update sms_log set status = 'failed' where pharmacy_id = $1 and body = 'second' returning 1", [pharmacyId]);
    await c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'retry', kind: 'custom' }])]);
    assert(true, 'a failed message does not use up the daily allowance');
    const refunds = (await c.query("select count(*)::int n from sms_wallet_transactions where pharmacy_id = $1 and kind = 'refund'", [pharmacyId])).rows[0].n;
    assert(refunds === 1, 'a message that failed to send is refunded once');
    await c.query("update sms_log set status = 'failed' where pharmacy_id = $1 and body = 'second' returning 1", [pharmacyId]);
    assert((await c.query("select count(*)::int n from sms_wallet_transactions where pharmacy_id = $1 and kind = 'refund'", [pharmacyId])).rows[0].n === 1, 'marking it failed again does not refund twice');
    await asUser(c, pharmacistId);
    await assertThrows(c.query('select set_sms_enabled($1,false)', [pharmacyId]), 'a pharmacist cannot switch SMS off', 'only the owner should be able to switch SMS off');
    await asUser(c, ownerId);
    await c.query('select set_sms_enabled($1,false)', [pharmacyId]);
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query('update pharmacies set sms_daily_cap = 30 where id = $1 returning 1', [pharmacyId]);
    await asUser(c, pharmacistId);
    await assertThrows(c.query("select sms_queue($1,$2::jsonb)", [pharmacyId, J([{ customer_id: jane, body: 'x', kind: 'custom' }])]), 'with SMS switched off nothing is queued', 'SMS should be refused while switched off');
    await asUser(c, ownerId);
    await c.query('select set_sms_enabled($1,true)', [pharmacyId]);
    await asRole('authenticated', async () => {
      await assertThrows(c.query("update sms_log set status = 'sent' returning 1"), 'a user cannot mark an SMS as sent by hand', 'a direct update of sms_log should have been refused');
    });

    // --------------------------------------------------------------
    console.log('\n== Other pharmacies cannot see or touch any of this ==');
    const otherOwner = (await c.query('insert into auth.users default values returning id')).rows[0].id;
    await asUser(c, otherOwner);
    const otherPharmacy = (await c.query("select bootstrap_pharmacy('Other Pharmacy','Other Owner','0799000000') as id")).rows[0].id;
    await asRole('authenticated', async () => {
      assert(Number((await c.query('select count(*) n from customers')).rows[0].n) === 0, 'another pharmacy sees none of these customers');
      assert(Number((await c.query('select count(*) n from controlled_ledger')).rows[0].n) === 0, 'nor the controlled-drug ledger');
      assert(Number((await c.query('select count(*) n from sms_log')).rows[0].n) === 0, 'nor the SMS log');
      assert(Number((await c.query('select count(*) n from stock_takes')).rows[0].n) === 0, 'nor the stock takes');
    });
    await assertThrows(c.query("select record_customer_payment($1,$2,10,'cash')", [pharmacyId, jane]), 'another pharmacy cannot take a payment for these customers', 'a cross-pharmacy payment should have been refused');
    await assertThrows(c.query("select record_customer_payment($1,$2,10,'cash')", [otherPharmacy, jane]), 'nor by pointing at the customer from its own pharmacy', 'a cross-pharmacy customer id should have been refused');
    await assertThrows(c.query("select start_stock_take($1,'x')", [pharmacyId]), 'nor start a stock take here', 'a cross-pharmacy stock take should have been refused');

    console.log('\n== record_sale has exactly one definition (regression guard) ==');
    const rsCount = (await c.query("select count(*) n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_sale'")).rows[0].n;
    assert(Number(rsCount) === 1, 'there is one record_sale, so calls cannot become ambiguous');
    await asUser(c, ownerId);
    const oldStyle = await c.query("select record_sale($1,$2::jsonb,$3::jsonb) as id", [pharmacyId, J([{ drug_id: dCredit.id, quantity: 1 }]), J([{ method: 'cash', amount: 100 }])]);
    assert(!!oldStyle.rows[0].id, 'the old three-argument call still works');

    // --------------------------------------------------------------
    console.log('\n== Dashboard "week" is a rolling last 7 days, never a single dot ==');
    await asUser(c, ownerId);
    const dWeek = await addDrug('Week Drug', 1000, 60, 100);
    const before = (await c.query("select dashboard_data($1,'week') as d", [pharmacyId])).rows[0].d; // earlier tests made sales too
    const daysAgo = [0, 3, 6, 7, 8, 15];           // today, in the 7 days, in the 7 days, previous x2, outside both
    const weekSaleIds = [];
    for (let i = 0; i < daysAgo.length; i++) {
      const r = await c.query("select record_sale($1,$2::jsonb,$3::jsonb) as id", [pharmacyId, J([{ drug_id: dWeek.id, quantity: i + 1 }]), J([{ method: 'cash', amount: (i + 1) * 100 }])]);
      weekSaleIds.push(r.rows[0].id);
    }
    // put each sale at 00:30 Nairobi time on its day (the hour UTC would call the day before)
    for (let i = 0; i < daysAgo.length; i++) {
      await c.query("update sales set sold_at = ((today_ke() - $2::int)::timestamp + interval '30 minutes') at time zone 'Africa/Nairobi' where id = $1 returning id", [weekSaleIds[i], daysAgo[i]]);
    }
    // The 'today' sale at 00:30 may be in the future relative to now() early in the day; keep it valid
    await c.query("update sales set sold_at = least(sold_at, now()) where id = $1 returning id", [weekSaleIds[0]]);
    const wk = (await c.query("select dashboard_data($1,'week') as d", [pharmacyId])).rows[0].d;
    const trend = wk.trend;
    assert(trend.length === 7, 'the week graph always has 7 points (got ' + trend.length + ')');
    const days7 = (await c.query("select to_char(g, 'YYYY-MM-DD\"T\"HH24:MI:SS') d from generate_series((today_ke()-6)::timestamp, today_ke()::timestamp, interval '1 day') g order by 1")).rows.map((r) => r.d);
    assert(JSON.stringify(trend.map((t) => t.bucket_start)) === JSON.stringify(days7), 'the 7 points are the last 7 Nairobi days in order, ending today');
    const tot = (n) => Number(trend[6 - n].total) - Number(before.trend[6 - n].total);
    assert(tot(3) === 200 && tot(6) === 300, 'a sale at 00:30 Nairobi time counts on its own Nairobi day, not the day before');
    assert(tot(1) === 0 && tot(2) === 0 && tot(4) === 0 && tot(5) === 0, 'days with no sales show as 0, so the line still spans the week');
    assert(Number(wk.sales_total) === Number(trend.reduce((a, t) => a + Number(t.total), 0)), 'the sales total equals the sum of the 7 points');
    assert(tot(0) === 100 && Number(wk.sales_total) - Number(before.sales_total) === 600, 'today counts, and sales older than 7 days are not in the total (added ' + (Number(wk.sales_total) - Number(before.sales_total)) + ')');
    assert(Number(wk.sales_prev_total) - Number(before.sales_prev_total) === 900, 'the comparison is the 7 days before (7 and 8 days ago = 400 + 500)');
    const todayR = (await c.query("select dashboard_data($1,'today') as d", [pharmacyId])).rows[0].d;
    assert(todayR.bucket === 'hour' && wk.bucket === 'day', 'other ranges keep their own buckets');
    const brandNew = (await c.query("select dashboard_data($1,'week') as d", [pharmacyId])).rows[0].d;
    assert(brandNew.trend.length === 7, 'still 7 points on every call');
    await assertThrows(c.query("select dashboard_data($1,'fortnight')", [pharmacyId]), 'an unknown range is still refused', 'an unknown range should be refused');

    // --------------------------------------------------------------
    console.log('\n== Sales report: the database adds up the period, the list comes a page at a time ==');
    await asUser(c, ownerId);
    const dRep = await addDrug('Report Drug', 1000, 60, 100);
    const repIds = [];
    for (let i = 0; i < 5; i++) {
      const method = i === 4 ? 'mpesa' : 'cash';
      const r = await c.query("select record_sale($1,$2::jsonb,$3::jsonb) as id", [pharmacyId, J([{ drug_id: dRep.id, quantity: i + 1 }]), J([{ method, amount: (i + 1) * 100 }])]);
      repIds.push(r.rows[0].id);
    }
    // park them in a quiet window (January 2020) so earlier tests cannot affect the numbers
    for (let i = 0; i < repIds.length; i++) {
      await c.query("update sales set sold_at = $2::timestamptz where id = $1 returning id", [repIds[i], '2020-01-1' + i + 'T09:00:00+03:00']);
    }
    await c.query("select void_sale($1,$2,'test void')", [pharmacyId, repIds[3]]);   // 400 voided
    const rep = (await c.query("select sales_report($1,'2020-01-01T00:00:00+03:00','2020-02-01T00:00:00+03:00') as r", [pharmacyId])).rows[0].r;
    assert(Number(rep.total) === 100 + 200 + 300 + 500, 'total adds the sales and leaves out the voided one (got ' + rep.total + ')');
    assert(Number(rep.count) === 5, 'the transaction count includes the voided sale');
    assert(Number(rep.by_method.cash) === 600 && Number(rep.by_method.mpesa) === 500, 'by-method totals skip the voided sale');
    assert(rep.top_drugs.length === 1 && rep.top_drugs[0].name === 'Report Drug' && Number(rep.top_drugs[0].qty) === 1 + 2 + 3 + 5, 'top drugs count units from non-voided sales only');
    const pg1 = (await c.query("select sales_report_page($1,'2020-01-01T00:00:00+03:00','2020-02-01T00:00:00+03:00',2,0) as r", [pharmacyId])).rows[0].r;
    const pg3 = (await c.query("select sales_report_page($1,'2020-01-01T00:00:00+03:00','2020-02-01T00:00:00+03:00',2,4) as r", [pharmacyId])).rows[0].r;
    assert(pg1.length === 2 && pg1[0].id === repIds[4] && pg1[1].id === repIds[3], 'page 1 is the 2 newest sales, newest first');
    assert(pg3.length === 1 && pg3[0].id === repIds[0], 'the last page holds the remaining oldest sale');
    assert(pg1[0].payments.length === 1 && pg1[0].payments[0].method === 'mpesa' && pg1[1].voided === true, 'each sale carries its payment lines and its voided flag');
    const emptyRep = (await c.query("select sales_report($1,'2019-01-01T00:00:00+03:00','2019-02-01T00:00:00+03:00') as r", [pharmacyId])).rows[0].r;
    assert(Number(emptyRep.total) === 0 && Number(emptyRep.count) === 0 && emptyRep.top_drugs.length === 0, 'an empty period returns zeros, not an error');
    const openRep = (await c.query("select sales_report($1,'2020-01-01T00:00:00+03:00') as r", [pharmacyId])).rows[0].r;
    assert(Number(openRep.count) >= 5, 'leaving the end date out means "from the start date onward"');
    const hugeRep = (await c.query("select sales_report_page($1,'2020-01-01T00:00:00+03:00','2020-02-01T00:00:00+03:00',999999,0) as r", [pharmacyId])).rows[0].r;
    assert(hugeRep.length === 5, 'a huge page size is capped but still works');

    // --------------------------------------------------------------
    console.log('\n== Bulk import: a block of rows in one request, bad rows skipped, same rules as restock ==');
    await asUser(c, ownerId);
    const impExisting = await addDrug('Import Existing', 5, 10, 20);
    const impRows = [
      { name: 'Import New A', form: 'tablet', unit: 'tablet', qty: 10, cost_price: 5, sell_price: 9, expiry: '2031-01-31', batch_no: 'IB1', supplier: 'Sup' },
      { name: 'import existing', unit: 'tablet', qty: 7, cost_price: 11, sell_price: 22, expiry: null },          // same drug, other letter case
      { name: 'Import New A', unit: 'tablet', qty: 3, cost_price: 5, sell_price: 9, expiry: '2031-06-30' },       // second batch of a drug created earlier in this same block
      { name: 'Import Bad Qty', unit: 'tablet', qty: 0, cost_price: 5, sell_price: 9, expiry: '2031-01-31' },     // refused by record_restock
      { name: '   ', unit: 'tablet', qty: 1, cost_price: 1, sell_price: 1, expiry: '2031-01-31' },                // empty name
      { name: 'Import Bad Price', unit: 'tablet', qty: 4, cost_price: 5, sell_price: null, expiry: '2031-01-31' },
      { name: 'Import Weird Form', form: 'hoverboard', unit: 'unit', qty: 2, cost_price: 1, sell_price: 2, expiry: '2031-01-31' }
    ];
    const impRes = (await c.query('select import_stock_rows($1,$2::jsonb) as r', [pharmacyId, J(impRows)])).rows[0].r;
    assert(impRes.imported === 4 && impRes.failed === 3, 'import reports 4 imported, 3 failed (got ' + impRes.imported + '/' + impRes.failed + ')');
    assert(impRes.errors.length === 3 && impRes.errors[0].row === 4, 'each problem names its row number');
    const impNewA = await c.query("select count(*)::int n, sum(quantity_remaining)::int q from batches b join drugs d on d.id = b.drug_id where d.pharmacy_id = $1 and d.name = 'Import New A'", [pharmacyId]);
    assert(impNewA.rows[0].n === 2 && impNewA.rows[0].q === 13, 'a new drug gets one batch per row (2 batches, 13 units)');
    const impDup = await c.query("select count(*)::int n from drugs where pharmacy_id = $1 and lower(name) = 'import existing'", [pharmacyId]);
    assert(impDup.rows[0].n === 1, 'a name that differs only by letter case reuses the drug instead of duplicating it');
    const impExQty = await c.query("select sum(quantity_remaining)::int q from batches where drug_id = $1", [impExisting.id]);
    assert(impExQty.rows[0].q === 12, 'the existing drug received the extra 7 units (5 + 7)');
    const impForm = await c.query("select form from drugs where pharmacy_id = $1 and name = 'Import Weird Form'", [pharmacyId]);
    assert(impForm.rows[0].form === 'other', 'an unknown form becomes "other"');
    const impBadDrug = await c.query("select count(*)::int n from drugs where pharmacy_id = $1 and name in ('Import Bad Qty','Import Bad Price')", [pharmacyId]);
    assert(impBadDrug.rows[0].n === 0, 'a failed row leaves nothing behind (no half-created drug)');
    const impAdj = await c.query("select count(*)::int n from stock_adjustments a join drugs d on d.id = a.drug_id where d.pharmacy_id = $1 and d.name like 'Import New A' and a.type = 'restock'", [pharmacyId]);
    assert(impAdj.rows[0].n === 2, 'every imported batch writes its stock-movement record');
    await asUser(c, staffId); // attendant
    await assertThrows(c.query('select import_stock_rows($1,$2::jsonb)', [pharmacyId, J([impRows[0]])]), 'an attendant cannot import stock', 'an attendant must not be able to import stock');
    await asUser(c, ownerId);
    await assertThrows(c.query('select import_stock_rows($1,$2::jsonb)', [pharmacyId, J(Array.from({ length: 501 }, () => impRows[0]))]), 'more than 500 rows in one go is refused', 'a block of 501 rows must be refused');
    await assertThrows(c.query('select import_stock_rows(gen_random_uuid(),$1::jsonb)', [J([impRows[0]])]), 'another pharmacy id is refused', 'importing into another pharmacy must be refused');

    // --------------------------------------------------------------
    console.log('\n== Nightly cleanup: old sign-in and SMS logs go, audit records stay ==');
    const oldUser = (await c.query('select id from auth.users limit 1')).rows[0].id;
    await c.query("insert into sign_in_log (user_id, signed_in_at) values ($1, now() - interval '14 months'), ($1, now() - interval '2 months') returning 1", [oldUser]);
    await c.query("insert into sms_log (pharmacy_id, to_phone, body, kind, created_at) values ($1,'0700000009','old','custom', now() - interval '3 years'), ($1,'0700000009','recent','custom', now() - interval '1 month') returning 1", [pharmacyId]);
    const adjBefore = Number((await c.query('select count(*) n from stock_adjustments')).rows[0].n);
    const ledgerBefore = Number((await c.query('select count(*) n from controlled_ledger')).rows[0].n);
    const hk2 = (await c.query('select housekeeping_daily() as r')).rows[0].r;
    assert(hk2.sign_ins_deleted >= 1 && Number((await c.query("select count(*) n from sign_in_log where signed_in_at < now() - interval '13 months'")).rows[0].n) === 0, 'sign-in records older than 13 months are removed');
    assert(Number((await c.query("select count(*) n from sign_in_log where signed_in_at > now() - interval '3 months'")).rows[0].n) >= 1, 'recent sign-in records are kept');
    assert(hk2.sms_deleted === 1 && Number((await c.query("select count(*) n from sms_log where body = 'recent'")).rows[0].n) === 1, 'SMS rows older than 2 years are removed, recent ones kept');
    assert(Number((await c.query('select count(*) n from stock_adjustments')).rows[0].n) === adjBefore, 'stock adjustments (audit trail) are never deleted');
    assert(Number((await c.query('select count(*) n from controlled_ledger')).rows[0].n) === ledgerBefore, 'the controlled-drugs ledger is never deleted');

    // --------------------------------------------------------------
    console.log('\n== Row-level security on every table, and least privilege for the API roles ==');
    const noRls = await c.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity");
    assert(noRls.rows.length === 0, 'every table in the public schema has row-level security ON' + (noRls.rows.length ? ' (missing: ' + noRls.rows.map((r) => r.relname).join(', ') + ')' : ''));
    const anonAny = await c.query("select distinct table_name from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'");
    assert(anonAny.rows.length === 0, 'signed-out visitors (anon) hold no privilege on any table' + (anonAny.rows.length ? ' (found: ' + anonAny.rows.map((r) => r.table_name).join(', ') + ')' : ''));
    const badPriv = await c.query("select distinct table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')");
    assert(badPriv.rows.length === 0, 'signed-in users hold no TRUNCATE / REFERENCES / TRIGGER (RLS does not cover TRUNCATE)');
    const serverOnly = await c.query("select distinct table_name from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and table_name in ('phone_otps','password_reset_attempts','sms_platform_config','platform_admins','sign_in_log')");
    assert(serverOnly.rows.length === 0, 'server-only tables are closed to signed-in users');
    const readOnlyTables = ['sales', 'sale_items', 'sales_payments', 'stock_adjustments', 'returns', 'supplier_lpos', 'supplier_lpo_items', 'supplier_payments', 'expenses', 'master_drugs', 'drug_categories', 'staff_invites'];
    const writable = await c.query("select distinct table_name from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('INSERT','UPDATE','DELETE') and table_name = any($1)", [readOnlyTables]);
    assert(writable.rows.length === 0, 'tables changed only through checked functions are read-only for signed-in users' + (writable.rows.length ? ' (writable: ' + writable.rows.map((r) => r.table_name).join(', ') + ')' : ''));

    // Functions that run with the database owner's rights and are only for the server: nobody may call them through the API.
    const internalFns = await c.query("select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_x, has_function_privilege('authenticated', p.oid, 'execute') as auth_x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('admin_pharmacy_stats','log_sign_in','rls_auto_enable')");
    const openInternal = internalFns.rows.filter((r) => r.anon_x || r.auth_x).map((r) => r.proname);
    assert(openInternal.length === 0, 'internal-only functions (admin_pharmacy_stats, log_sign_in, rls_auto_enable) cannot be called by signed-out or signed-in users' + (openInternal.length ? ' (callable: ' + openInternal.join(', ') + ')' : ''));
    const anonDefiner = await c.query("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') and p.prorettype <> 'trigger'::regtype and p.proname not in ('keep_alive')");
    assert(anonDefiner.rows.length === 0, 'signed-out visitors can call no owner-rights function except keep_alive()' + (anonDefiner.rows.length ? ' (callable: ' + anonDefiner.rows.map((r) => r.proname).join(', ') + ')' : ''));

    // What an attendant can still do, and what they can no longer do by calling the table API directly
    await asUser(c, staffId); // attendant
    const lockSale = await c.query("select s.id from sales s limit 1");
    const lockBatch = (await c.query("select id from batches limit 1")).rows[0].id;
    await asRole('authenticated', async () => {
      assert(Number((await c.query('select count(*) n from sales')).rows[0].n) > 0, 'an attendant can still read the pharmacy\'s sales');
      await assertThrows(c.query("update sales set total_amount = 1 where id = $1", [lockSale.rows[0].id]), 'an attendant cannot rewrite a sale directly', 'an attendant must not be able to edit a sale through the table');
      await assertThrows(c.query("delete from stock_adjustments"), 'an attendant cannot delete the stock-movement audit trail', 'an attendant must not be able to delete stock adjustments');
      await assertThrows(c.query("update batches set quantity_remaining = 9999 where id = $1", [lockBatch]), 'an attendant cannot edit a batch quantity directly', 'an attendant must not be able to change batch quantities');
      await assertThrows(c.query("insert into sales_payments (sale_id, pharmacy_id, method, amount) values ($1, $2, 'cash', 5)", [lockSale.rows[0].id, pharmacyId]), 'an attendant cannot add a payment line directly', 'an attendant must not be able to insert payments');
      await assertThrows(c.query("update insurance_claims set amount = 1"), 'an insurance claim amount cannot be edited directly', 'claim amounts must not be editable');
      await assertThrows(c.query("truncate sales cascade"), 'TRUNCATE is refused', 'TRUNCATE must be refused');
      await assertThrows(c.query("select * from phone_otps"), 'one-time codes are unreadable from the app', 'phone_otps must be unreadable');
      const disc = await c.query("update batches set discount_percent = 5 where id = $1 returning id", [lockBatch]);
      assert(disc.rowCount === 1, 'the mark-down % of a batch can still be changed (the one thing the app edits directly)');
      await c.query("update batches set discount_percent = 0 where id = $1", [lockBatch]);
      const lockDrug = await c.query("select id from drugs where pharmacy_id = $1 limit 1", [pharmacyId]);
      await assertThrows(c.query("delete from drugs where id = $1", [lockDrug.rows[0].id]), 'drugs cannot be deleted directly', 'drugs must not be deletable through the table');
    });
    await asUser(c, ownerId);
    const lockSellDrug = await addDrug('Lock Down Drug', 5, 1, 2);
    await asRole('authenticated', async () => {
      const okSale = await c.query("select record_sale($1,$2::jsonb,$3::jsonb) as id", [pharmacyId, J([{ drug_id: lockSellDrug.id, quantity: 1 }]), J([{ method: 'cash', amount: 2 }])]);
      assert(!!okSale.rows[0].id, 'selling through the checked function still works for a signed-in user');
    });

    // --------------------------------------------------------------
    console.log('\n== Trials, paid plans and lock-out ==');
    await asUser(c, ownerId);
    const trialRow = (await c.query('select subscription_status, subscription_expires_at > now() + interval \'89 days\' as ninety from pharmacies where id = $1', [pharmacyId])).rows[0];
    assert(trialRow.subscription_status === 'trial' && trialRow.ninety, 'a new pharmacy starts a 90-day trial');
    await assertThrows(c.query('select admin_extend_trial($1, 10)', [pharmacyId]), 'only the platform admin can change trial days', 'an owner should not be able to extend their own trial');
    await assertThrows(c.query('select admin_delete_pharmacy($1, $2)', [pharmacyId, 'Test Pharmacy']), 'only the platform admin can delete a pharmacy', 'an owner should not be able to delete a pharmacy');
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query("update pharmacies set subscription_expires_at = now() - interval '1 day' where id = $1", [pharmacyId]);
    await asUser(c, ownerId);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === null, 'when the trial has ended the owner is locked out of the pharmacy');
    assert((await c.query('select my_subscription() as s')).rows[0].s.locked === true, 'my_subscription tells the app the pharmacy is locked');
    await c.query("select set_config('app.current_user_id', '', false)");
    const adminRes = await c.query("insert into auth.users default values returning id");
    await c.query('insert into platform_admins (user_id) values ($1)', [adminRes.rows[0].id]);
    const secondAdmin = await c.query("insert into auth.users default values returning id");
    await assertThrows(c.query('insert into platform_admins (user_id) values ($1)', [secondAdmin.rows[0].id]), 'a second platform admin cannot be added', 'the database should refuse a second platform admin');
    assert((await c.query('select count(*) n from platform_admins')).rows[0].n === '1', 'there is exactly one platform admin');
    await asUser(c, adminRes.rows[0].id);
    await c.query("select admin_activate_pharmacy($1, 30)", [pharmacyId]);
    await asUser(c, ownerId);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === pharmacyId, 'marking the pharmacy as paid lifts the lock');
    await asUser(c, adminRes.rows[0].id);
    await assertThrows(c.query('select admin_delete_pharmacy($1, $2)', [pharmacyId, 'Test Pharmacy']), 'a pharmacy that is still paid up cannot be deleted', 'deleting a pharmacy before its plan has ended should have been refused');

    // --------------------------------------------------------------
    console.log('\n== Privilege escalation: a staff member cannot promote themselves ==');
    await asUser(c, staffId);
    await assertThrows(
      c.query("update profiles set role = 'owner' where id = $1", [staffId]),
      'a non-owner updating their own role is blocked by the privilege-escalation trigger',
      'a staff member should NOT have been able to set their own role to owner, but the update succeeded'
    );

    // --------------------------------------------------------------
    console.log('\n== Senior review fixes 7 Nov ==');

    // A. A pharmacy cannot edit its own plan or counters
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query("update pharmacies set subscription_expires_at = now() + interval '30 days', subscription_status = 'active' where id = $1", [pharmacyId]);
    const planBefore = (await c.query('select subscription_expires_at::text e, subscription_status s, next_invoice_no n from pharmacies where id = $1', [pharmacyId])).rows[0];
    await asUser(c, ownerId);
    await asRole('authenticated', async () => {
      await assertThrows(c.query("update pharmacies set subscription_expires_at = now() + interval '100 years' where id = $1", [pharmacyId]),
        'an owner cannot give their own pharmacy a longer subscription', 'an owner must NOT be able to extend their own subscription');
      await assertThrows(c.query("update pharmacies set subscription_status = 'active' where id = $1", [pharmacyId]),
        'an owner cannot mark their own pharmacy as paid', 'an owner must NOT be able to mark their pharmacy active');
      await assertThrows(c.query("update pharmacies set activated_at = now() where id = $1", [pharmacyId]),
        'an owner cannot change the activation date', 'activated_at must not be editable by the app');
      await assertThrows(c.query("update pharmacies set next_invoice_no = 1 where id = $1", [pharmacyId]),
        'an owner cannot reset the invoice counter (duplicate invoice numbers)', 'next_invoice_no must not be editable by the app');
      await assertThrows(c.query("update pharmacies set sms_enabled = not sms_enabled where id = $1", [pharmacyId]),
        'SMS on/off cannot be flipped around the checked function', 'sms_enabled must only change through set_sms_enabled');
      const ok = await c.query("update pharmacies set name = name, town = 'Chuka', vat_rate = 16 where id = $1 returning id", [pharmacyId]);
      assert(ok.rowCount === 1, 'an owner can still save the Settings screen fields (name, town, VAT ...)');
    });
    // belt and braces: even if UPDATE were re-granted on the whole table, the trigger still refuses
    await c.query('grant update on pharmacies to authenticated');
    await asRole('authenticated', async () => {
      await assertThrows(c.query("update pharmacies set subscription_expires_at = now() + interval '100 years' where id = $1", [pharmacyId]),
        'the billing trigger refuses the change even if the table-wide right came back', 'the trigger must block billing edits on its own');
    });
    await c.query('revoke update on pharmacies from authenticated');
    await c.query('grant update (name, address, town, phone, email, kra_pin, low_stock_default, expiry_warn_days, vat_rate, low_stock_days) on pharmacies to authenticated');
    const planAfter = (await c.query('select subscription_expires_at::text e, subscription_status s, next_invoice_no n from pharmacies where id = $1', [pharmacyId])).rows[0];
    assert(planAfter.e === planBefore.e && planAfter.s === planBefore.s && planAfter.n === planBefore.n, 'the plan and invoice counter are exactly as they were after all those attempts');
    await asUser(c, adminRes.rows[0].id);
    await asRole('authenticated', async () => {
      await c.query('select admin_extend_trial($1, 5)', [pharmacyId]);
    });
    assert((await c.query('select subscription_expires_at::text e from pharmacies where id = $1', [pharmacyId])).rows[0].e !== planBefore.e, 'the platform admin can still change a pharmacy\'s plan through the admin function');

    // B. invite codes are unique and secure-random
    await asUser(c, ownerId);
    const codeA = (await c.query("select create_staff_invite($1, 'attendant') as code", [pharmacyId])).rows[0].code;
    const codeB = (await c.query("select create_staff_invite($1, 'attendant') as code", [pharmacyId])).rows[0].code;
    assert(codeA !== codeB && /^[0-9A-F]{10}$/.test(codeA) && /^[0-9A-F]{10}$/.test(codeB), 'two invite codes are different and both 10 characters');

    // C. one-time codes: limits and checking are atomic and server-only
    await c.query("select set_config('app.current_user_id', '', false)");
    await asRole('authenticated', async () => {
      await assertThrows(c.query("select otp_check('254700000001','signup','x')"), 'signed-in users cannot call otp_check', 'otp_check must be server-only');
      await assertThrows(c.query("select otp_issue('254700000001','signup','x')"), 'signed-in users cannot call otp_issue', 'otp_issue must be server-only');
      await assertThrows(c.query("select auth_user_id_for_email('a@b.c')"), 'signed-in users cannot look up accounts by email', 'auth_user_id_for_email must be server-only');
      await assertThrows(c.query('select * from password_reset_attempts'), 'password_reset_attempts is unreadable from the app', 'password_reset_attempts must be server-only');
    });
    await asRole('anon', async () => {
      await assertThrows(c.query("select otp_check('254700000001','signup','x')"), 'signed-out visitors cannot call otp_check', 'otp_check must be server-only (anon)');
    });
    await asRole('service_role', async () => {
      const i1 = (await c.query("select otp_issue('254711000001','signup','hash1','10.0.0.1') as r")).rows[0].r;
      assert(i1.ok === true, 'the server can issue a first code');
      const i2 = (await c.query("select otp_issue('254711000001','signup','hash1','10.0.0.1') as r")).rows[0].r;
      assert(i2.ok === false && i2.reason === 'cooldown' && i2.wait_seconds > 0, 'an immediate second code is refused (resend cooldown)');
      // per-number cap of 5 with the cooldown switched off
      let last;
      for (let k = 0; k < 6; k++) last = (await c.query("select otp_issue('254711000002','signup','h','10.0.0.2', 300, 0) as r")).rows[0].r;
      assert(last.ok === false && last.reason === 'phone_limit', 'a 6th code for the same number inside the window is refused');
      // per-IP cap
      await c.query("select otp_issue('254711000003','signup','h','10.9.9.9', 300, 30, 5, 900, 2, 300)");
      await c.query("select otp_issue('254711000004','signup','h','10.9.9.9', 300, 30, 5, 900, 2, 300)");
      const ip3 = (await c.query("select otp_issue('254711000005','signup','h','10.9.9.9', 300, 30, 5, 900, 2, 300) as r")).rows[0].r;
      assert(ip3.ok === false && ip3.reason === 'ip_limit', 'one address cannot request codes for many different numbers');
      const gl = (await c.query("select otp_issue('254711000006','signup','h','10.8.8.8', 300, 30, 5, 900, 10, 0) as r")).rows[0].r;
      assert(gl.ok === false && gl.reason === 'global_limit', 'the platform-wide hourly ceiling stops mass SMS requests');
    });
    // checking: right code works once, wrong guesses are counted, 5 max
    await c.query("select otp_issue('254722000001','password_reset','right-hash')");
    let otpSt = (await c.query("select otp_check('254722000001','password_reset','nope') as r")).rows[0].r;
    assert(otpSt.status === 'wrong' && otpSt.left === 4, 'a wrong code is counted (4 left)');
    otpSt = (await c.query("select otp_check('254722000001','password_reset','right-hash') as r")).rows[0].r;
    assert(otpSt.status === 'ok', 'the right code is accepted');
    otpSt = (await c.query("select otp_check('254722000001','password_reset','right-hash') as r")).rows[0].r;
    assert(otpSt.status === 'none', 'the same code cannot be used twice');
    // 20 guesses fired at the same instant must still count as only 5
    await c.query("select otp_issue('254722000002','password_reset','right-hash')");
    const racers = await Promise.all(Array.from({ length: 20 }, async () => {
      const cl = new Client({ connectionString: CONN }); await cl.connect();
      try { return (await cl.query("select otp_check('254722000002','password_reset','guess') as r")).rows[0].r.status; } finally { await cl.end(); }
    }));
    assert(racers.filter((s) => s === 'wrong').length === 5, '20 simultaneous wrong guesses count as exactly 5');
    otpSt = (await c.query("select otp_check('254722000002','password_reset','right-hash') as r")).rows[0].r;
    assert(otpSt.status !== 'ok', 'after 5 misses even the right code is refused');
    // expired code
    await c.query("select otp_issue('254722000003','signup','right-hash', null, 1)");
    await c.query("update phone_otps set expires_at = now() - interval '1 minute' where phone = '254722000003'");
    otpSt = (await c.query("select otp_check('254722000003','signup','right-hash') as r")).rows[0].r;
    assert(otpSt.status === 'expired', 'an expired code is refused');

    // G. account lookup by login address
    const luId = (await c.query("insert into auth.users (email) values ('p254799000111@hodhi.local') returning id")).rows[0].id;
    await asRole('service_role', async () => {
      assert((await c.query("select auth_user_id_for_email('P254799000111@HODHI.local') as id")).rows[0].id === luId, 'the server finds an account by its login address (any letter case)');
      assert((await c.query("select auth_user_id_for_email('p254000000000@hodhi.local') as id")).rows[0].id === null, 'an unknown login address gives nothing');
    });

    // D. the faster stock view gives the same numbers as adding the batches up by hand
    const viewCheck = await c.query(`
      select count(*) n from v_drug_stock v
      where v.pharmacy_id = $1 and (
            v.qty_in_stock <> coalesce((select sum(quantity_remaining) from batches b where b.drug_id = v.drug_id and b.expiry_date >= current_date), 0)
         or v.qty_expired  <> coalesce((select sum(quantity_remaining) from batches b where b.drug_id = v.drug_id and b.expiry_date <  current_date), 0)
         or v.stock_value_cost <> coalesce((select sum(quantity_remaining * cost_price) from batches b where b.drug_id = v.drug_id and b.expiry_date >= current_date), 0))`, [pharmacyId]);
    assert(Number(viewCheck.rows[0].n) === 0, 'v_drug_stock totals equal the batch totals for every drug');
    const viewRows = await c.query('select (select count(*) from v_drug_stock where pharmacy_id = $1) v, (select count(*) from drugs where pharmacy_id = $1 and active) d', [pharmacyId]);
    assert(viewRows.rows[0].v === viewRows.rows[0].d, 'every active drug still appears in the stock list, including ones with no stock');
    assert((await c.query("select reloptions::text r from pg_class where relname = 'v_drug_stock'")).rows[0].r.indexOf('security_invoker=true') !== -1, 'v_drug_stock still runs with the caller\'s own rights (row-level security applies)');

    // F. duplicate indexes are gone, but every table keeps an index that starts with pharmacy_id
    const dupIdx = await c.query("select indexname from pg_indexes where schemaname = 'public' and indexname in ('drugs_pharmacy_id_idx','expenses_pharmacy_id_idx','supplier_payments_pharmacy_id_idx','supplier_payments_pharmacy_supplier_idx','supplier_lpos_pharmacy_id_idx','sale_items_drug_id_idx')");
    assert(dupIdx.rows.length === 0, 'the 6 duplicate indexes are gone');
    const noLead = await c.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'pharmacy_id' and not a.attisdropped)
        and not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0] where i.indrelid = c.oid and a.attname = 'pharmacy_id')`);
    assert(noLead.rows.length === 0, 'every pharmacy table still has an index starting with pharmacy_id' + (noLead.rows.length ? ' (missing: ' + noLead.rows.map((r) => r.relname).join(', ') + ')' : ''));

    // --------------------------------------------------------------
    console.log('\n== Demo pharmacy: self-running sales, restocks and payments ==');
    const demoOwner = (await c.query('insert into auth.users default values returning id')).rows[0].id;
    await asUser(c, demoOwner);
    const demoPh = (await c.query("select bootstrap_pharmacy('Demo Test', 'Demo Owner', '0700000001') as id")).rows[0].id;
    await asUser(c, ownerId);
    const salesBefore = Number((await c.query('select count(*) n from sales where pharmacy_id = $1', [pharmacyId])).rows[0].n);

    // nothing runs for a pharmacy that is not switched on as the demo
    await assertThrows(c.query('select demo_backfill($1, current_date - 3, current_date - 1)', [pharmacyId]), 'the demo tools refuse a pharmacy that is not the demo', 'a real pharmacy must not be touched by the demo tools');
    assert((await c.query('select demo_tick() n')).rows[0].n === 0, 'demo_tick does nothing while no pharmacy is switched on');

    const ready = (await c.query('select demo_enable($1) r', [demoPh])).rows[0].r;
    assert(/Demo ready: \d+ drugs, 12 customers/.test(ready), 'demo_enable sets up the catalogue and 12 customers (' + ready + ')');
    assert(Number((await c.query('select count(*) n from customers where pharmacy_id = $1 and sms_ok', [demoPh])).rows[0].n) === 0, 'demo customers can never be texted');
    assert(Number((await c.query("select count(*) n from v_drug_stock where pharmacy_id = $1 and qty_in_stock = 0", [demoPh])).rows[0].n) === 0, 'every demo drug has opening stock');
    const drugsAfterFirst = Number((await c.query('select count(*) n from drugs where pharmacy_id = $1', [demoPh])).rows[0].n);
    await c.query('select demo_enable($1)', [demoPh]);
    assert(Number((await c.query('select count(*) n from drugs where pharmacy_id = $1', [demoPh])).rows[0].n) === drugsAfterFirst, 'demo_enable can be run twice without duplicating anything');

    await assertThrows(c.query('select demo_backfill($1, current_date - 3, current_date)', [demoPh]), 'back-fill refuses today and the future', 'back-fill must stop at yesterday');
    const filled = (await c.query('select demo_backfill($1, current_date - 12, current_date - 1) n', [demoPh])).rows[0].n;
    assert(filled === 12, 'back-fill writes 12 days of history (' + filled + ')');

    const days = (await c.query(`select (sold_at at time zone 'Africa/Nairobi')::date d, sum(total_amount) t, count(*)::int n
      from sales where pharmacy_id = $1 group by 1 order by 1`, [demoPh])).rows;
    assert(days.length === 12, 'one trading day per day asked for');
    assert(days.every((r) => Number(r.t) >= 2000 && Number(r.t) <= 8000), 'every day sells between KES 2,000 and 8,000 (' + days.map((r) => Math.round(r.t)).join(', ') + ')');
    assert(days.every((r) => r.n >= 3 && r.n <= 11), 'every day has 3 to 10 sales (plus at most one top-up)');
    assert(new Set(days.map((r) => Math.round(r.t / 100))).size > 6, 'daily totals vary, so the graph does not look flat');
    assert(Number((await c.query("select count(*) n from sales where pharmacy_id = $1 and sold_at > now()", [demoPh])).rows[0].n) === 0, 'no demo sale is dated in the future');
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining < 0", [demoPh])).rows[0].n) === 0, 'stock never goes negative');
    assert(Number((await c.query("select count(*) n from sales where pharmacy_id = $1 and (total_amount is null or total_amount <= 0)", [demoPh])).rows[0].n) === 0, 'every demo sale has a real total');
    assert(Number((await c.query("select count(*) n from (select invoice_number from sales where pharmacy_id = $1 group by 1 having count(*) > 1) x", [demoPh])).rows[0].n) === 0, 'invoice numbers stay unique');
    assert(Number((await c.query("select count(*) n from v_customer_balances where pharmacy_id = $1 and balance < 0", [demoPh])).rows[0].n) === 0, 'no customer ends up with a negative balance');
    assert(Number((await c.query("select count(*) n from customer_payments where pharmacy_id = $1", [demoPh])).rows[0].n) > 0, 'customers on account pay some of it back');
    assert(Number((await c.query("select count(distinct payment_method) n from sales where pharmacy_id = $1", [demoPh])).rows[0].n) >= 3, 'sales are paid in a mix of ways');
    assert(Number((await c.query("select count(*) n from expenses where pharmacy_id = $1", [demoPh])).rows[0].n) > 0, 'small expenses are posted');

    const again = (await c.query('select demo_backfill($1, current_date - 12, current_date - 1) n', [demoPh])).rows[0].n;
    assert(again === 0, 'running the back-fill again adds nothing');

    // restocking: run one drug down, the next run tops it up
    const lowDrug = (await c.query('select id, reorder_level from drugs where pharmacy_id = $1 order by name limit 1', [demoPh])).rows[0];
    await c.query('update batches set quantity_remaining = 1 where drug_id = $1', [lowDrug.id]);
    const restocked = (await c.query('select demo_restock_low($1) n', [demoPh])).rows[0].n;
    const nowQty = Number((await c.query("select coalesce(sum(quantity_remaining),0) q from batches where drug_id = $1 and expiry_date >= current_date", [lowDrug.id])).rows[0].q);
    assert(restocked >= 1 && nowQty > lowDrug.reorder_level, 'a drug that runs low is restocked');

    // the demo shows every stock state: out, low, expired, expiring soon, healthy
    await c.query('select demo_showcase($1)', [demoPh]);
    const stateOf = async (where) => Number((await c.query('select count(*) n from v_drug_stock where pharmacy_id = $1 and ' + where, [demoPh])).rows[0].n);
    assert(await stateOf('qty_in_stock = 0') >= 3, 'the demo always has drugs out of stock');
    assert(await stateOf('qty_in_stock > 0 and qty_in_stock <= reorder_level') >= 3, 'the demo always has drugs running low');
    assert(await stateOf('qty_in_stock > reorder_level') >= 20, 'most demo drugs are healthy');
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date < current_date", [demoPh])).rows[0].n) >= 3, 'the demo always has expired stock on the shelf');
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date between current_date and current_date + 30", [demoPh])).rows[0].n) >= 2, 'at least 2 batches expire within 30 days');
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date between current_date and current_date + 90", [demoPh])).rows[0].n) >= 5, 'at least 5 batches expire within 90 days');
    // held drugs stay held through sales and restocking
    const heldBefore = (await c.query("select coalesce(sum(qty_in_stock),0) q from v_drug_stock where drug_id = any (demo_held($1))", [demoPh])).rows[0].q;
    for (let i = 0; i < 25; i++) await c.query('select demo_post_sale($1, 3000, now() - interval \'20 days\')', [demoPh]);
    await c.query('select demo_restock_low($1)', [demoPh]);
    assert((await c.query("select coalesce(sum(qty_in_stock),0) q from v_drug_stock where drug_id = any (demo_held($1))", [demoPh])).rows[0].q === heldBefore, 'out-of-stock and low drugs are not sold or restocked');
    // old expired stock is written off and replaced
    await c.query("update batches set expiry_date = current_date - 90 where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date < current_date", [demoPh]);
    await c.query('select demo_showcase($1)', [demoPh]);
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date < current_date - 60", [demoPh])).rows[0].n) === 0, 'expired stock older than 60 days is written off');
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date < current_date", [demoPh])).rows[0].n) >= 3, 'and fresh expired batches take its place');
    assert(Number((await c.query("select count(*) n from stock_adjustments where pharmacy_id = $1 and type = 'expired_disposal'", [demoPh])).rows[0].n) > 0, 'the write-offs are on the stock audit trail');

    // the "expiring soon" shelf is never empty
    await c.query("update batches set expiry_date = current_date + 400 where pharmacy_id = $1 and expiry_date <= current_date + 60", [demoPh]);
    await c.query('select demo_ensure_expiring($1)', [demoPh]);
    assert(Number((await c.query("select count(*) n from batches where pharmacy_id = $1 and quantity_remaining > 0 and expiry_date between current_date and current_date + 60", [demoPh])).rows[0].n) >= 2, 'the expiring-soon list always has a couple of items');
    assert((await c.query("select demo_ensure_expiring($1) n", [demoPh])).rows[0].n === 0, 'and nothing more is added while it does');
    assert((await c.query("select proconfig::text c from pg_proc where proname = 'demo_new_plan'")).rows[0].c.indexOf('search_path') !== -1, 'demo_new_plan has a fixed search path');

    // the hourly run
    const hr = (await c.query("select extract(hour from now() at time zone 'Africa/Nairobi')::int h")).rows[0].h;
    const ticked = (await c.query('select demo_tick() n')).rows[0].n;
    const demoPlan = (await c.query('select * from demo_config where pharmacy_id = $1', [demoPh])).rows[0];
    const todaySum = Number((await c.query("select coalesce(sum(total_amount),0) t from sales where pharmacy_id = $1 and sold_at >= (today_ke()::timestamp at time zone 'Africa/Nairobi')", [demoPh])).rows[0].t);
    if (hr >= 8) {
      assert(demoPlan.plan_sales >= 3 && demoPlan.plan_sales <= 10 && Number(demoPlan.plan_target) >= 2300 && Number(demoPlan.plan_target) <= 7700, 'the hourly run makes a plan for today inside the limits');
      assert(todaySum <= 8000 && demoPlan.plan_done <= demoPlan.plan_sales + 1, 'today never goes over KES 8,000');
      const before = Number((await c.query('select count(*) n from sales where pharmacy_id = $1', [demoPh])).rows[0].n);
      await c.query('select demo_tick()');
      await c.query('update demo_config set plan_done = plan_sales where pharmacy_id = $1', [demoPh]);
      const after = Number((await c.query('select count(*) n from sales where pharmacy_id = $1', [demoPh])).rows[0].n);
      assert(after - before <= 1, 'a repeat run in the same hour posts at most a catch-up sale');
    } else {
      assert(ticked === 0, 'before 08:00 Nairobi the hourly run posts nothing');
    }
    assert(Number((await c.query('select count(*) n from sales where pharmacy_id = $1', [pharmacyId])).rows[0].n) === salesBefore, 'the real test pharmacy was not touched by any of this');

    // a missed stretch is caught up, and an expired subscription is skipped
    await c.query("delete from sales_payments where sale_id in (select id from sales where pharmacy_id = $1 and sold_at >= now() - interval '3 days')", [demoPh]).catch(() => {});
    await c.query('update pharmacies set subscription_expires_at = now() - interval \'1 day\' where id = $1', [demoPh]);
    await c.query('update demo_config set plan_day = null where pharmacy_id = $1', [demoPh]);
    const beforeExpired = Number((await c.query('select count(*) n from sales where pharmacy_id = $1', [demoPh])).rows[0].n);
    await c.query('select demo_tick()');
    assert(Number((await c.query('select count(*) n from sales where pharmacy_id = $1', [demoPh])).rows[0].n) === beforeExpired, 'an expired demo pharmacy is left alone');
    await c.query("update pharmacies set subscription_expires_at = now() + interval '400 days' where id = $1", [demoPh]);

    // locked down
    const demoFns = await c.query("select p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'demo\\_%'");
    assert(demoFns.rows.length >= 13, 'all the demo functions exist (' + demoFns.rows.length + ')');
    assert(demoFns.rows.every((r) => !r.a && !r.u), 'no demo function can be called by the app or the public API');
    assert((await c.query("select count(*) n from information_schema.role_table_grants where table_name = 'demo_config' and grantee in ('anon','authenticated')")).rows[0].n === '0', 'demo_config is closed to the app and the public API');
    assert((await c.query("select count(*) n from pg_policies where tablename = 'demo_config'")).rows[0].n === '0', 'demo_config has no policy, so only the server can read it');

    // switched off: the tools stop working
    await c.query('delete from demo_config where pharmacy_id = $1', [demoPh]);
    await assertThrows(c.query('select demo_post_sale($1, 500)', [demoPh]), 'once switched off, the demo tools refuse the pharmacy', 'switching off should stop the demo tools');
  });

  await withClient(async (c) => {
    console.log('\n== Get support: a pharmacy lets the Pharma admin in for a few hours ==');
    // Row-level security only applies to the app's own database role, so reads that test it run as that role.
    const asApp = async (sql, params) => { await c.query('set role authenticated'); try { return await c.query(sql, params); } finally { await c.query('reset role'); } };
    const mkUser = async () => (await c.query('insert into auth.users default values returning id')).rows[0].id;
    const sOwner = await mkUser(), sOwnerB = await mkUser(), sAdmin = await mkUser(), sAttendant = await mkUser();
    await asUser(c, sOwner);
    const phA = (await c.query("select bootstrap_pharmacy('Support Test A', 'Owner A', '0711000001') as id")).rows[0].id;
    await asUser(c, sOwnerB);
    const phB = (await c.query("select bootstrap_pharmacy('Support Test B', 'Owner B', '0711000002') as id")).rows[0].id;
    // the admin's own "home" profile (needed so records the admin saves have an author)
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query("insert into platform_admins (user_id) select $1 where not exists (select 1 from platform_admins)", [sAdmin]);
    const adminId = (await c.query('select user_id from platform_admins')).rows[0].user_id;
    const adminHasProfile = (await c.query('select 1 from profiles where id = $1', [adminId])).rowCount > 0;
    if (!adminHasProfile) await c.query("insert into profiles (id, pharmacy_id, full_name, role) values ($1, $2, 'Pharma Admin', 'co_owner')", [adminId, phB]);
    await c.query("insert into profiles (id, pharmacy_id, full_name, role) values ($1, $2, 'Att', 'attendant')", [sAttendant, phA]);
    await c.query("insert into drugs (pharmacy_id, name, form, unit) values ($1, 'Support Drug', 'tablet', 'tablet')", [phA]);

    // before any grant: the admin can open any pharmacy directly (like Login as School in Shule Web)
    await asUser(c, adminId);
    assert((await asApp('select count(*) n from drugs where pharmacy_id = $1', [phA])).rows[0].n === '0', 'before opening, the admin sees none of that pharmacy\'s drugs');
    assert((await c.query('select support_context() as x')).rows[0].x === null, 'support_context is empty when nothing is open');
    await assertThrows(c.query('select admin_open_support($1)', ['00000000-0000-0000-0000-000000000000']), 'the admin cannot open a pharmacy that does not exist', 'unknown pharmacy should be refused');
    const dr = (await c.query('select admin_open_support($1) as r', [phA])).rows[0].r;
    assert(dr.granted_by_owner === false, 'with no grant, the open is reported as direct');
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === phA, 'the admin works inside the pharmacy with no grant');
    assert((await c.query('select my_role() as r')).rows[0].r === 'co_owner', 'as a co-owner there');
    assert((await asApp('select count(*) n from drugs where pharmacy_id = $1', [phA])).rows[0].n === '1', 'and can read its drugs');
    assert((await c.query("select count(*) n from support_access_events where pharmacy_id = $1 and kind = 'opened_direct' and access_id is null", [phA])).rows[0].n === '1', 'a direct open is logged');
    await asUser(c, sOwnerB);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === phB, 'another pharmacy\'s owner is unaffected by the admin being inside pharmacy A');
    await asUser(c, sOwner);
    assert((await c.query('select my_support_access() as a')).rows[0].a.history.length === 0, 'a direct open does not appear as a grant in the owner\'s history');
    await asUser(c, adminId);
    // it ends by itself after 8 hours
    await c.query("select set_config('app.current_user_id', '', false)");
    await c.query("update support_session set opened_at = now() - interval '9 hours' where user_id = $1", [adminId]);
    await asUser(c, adminId);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p !== phA, 'a direct session ends by itself after 8 hours');
    assert((await c.query('select support_context() as x')).rows[0].x === null, 'and support_context is empty again');
    await c.query('select admin_close_support()');
    // an owner and an attendant cannot do this
    await asUser(c, sOwner);
    await assertThrows(c.query('select admin_open_support($1)', [phA]), 'a pharmacy owner cannot open a pharmacy as the admin', 'owner should not open directly');
    await asUser(c, sAttendant);
    await assertThrows(c.query('select admin_open_support($1)', [phA]), 'an attendant cannot open a pharmacy as the admin', 'attendant should not open directly');
    await asUser(c, adminId);

    // who can grant
    await asUser(c, sAttendant);
    await assertThrows(c.query('select grant_support_access(2)'), 'an attendant cannot give support access', 'an attendant should not be able to grant support access');
    await asUser(c, adminId);
    await assertThrows(c.query('select grant_support_access(2)'), 'the admin cannot grant support access to itself', 'the admin should not be able to grant access');
    await asUser(c, sOwner);
    await assertThrows(c.query('select grant_support_access(3)'), 'only 1, 2, 4, 8 or 24 hours are allowed', 'a 3-hour grant should be refused');
    await assertThrows(c.query('select grant_support_access(null)'), 'a grant needs a number of hours', 'a null grant should be refused');
    const g = (await c.query('select grant_support_access(2) as g')).rows[0].g;
    const hrs = (new Date(g.expires_at) - new Date(g.granted_at)) / 36e5;
    assert(Math.abs(hrs - 2) < 0.01, 'a 2-hour grant ends 2 hours after it starts');
    assert((await c.query('select my_support_access() as a')).rows[0].a.active.id === g.id, 'the owner sees the live grant');

    // other pharmacies and other roles cannot see or use it
    await asUser(c, sOwnerB);
    const bView = (await c.query('select my_support_access() as a')).rows[0].a;
    assert(bView.active === null && bView.history.length === 0, 'another pharmacy sees nothing of this grant');
    await asUser(c, sAttendant);
    await assertThrows(c.query('select my_support_access()'), 'an attendant cannot read support access', 'attendant should not read support access');
    await assertThrows(asApp('select * from support_access'), 'the app cannot read the grants table directly', 'support_access should be closed to the app');

    // the admin opens it
    await asUser(c, adminId);
    assert(JSON.stringify((await c.query('select admin_support_status() as s')).rows[0].s.map(r => r.pharmacy_id)) === JSON.stringify([phA]), 'the admin sees which pharmacies gave access');
    await c.query('select admin_open_support($1)', [phA]);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === phA, 'once open, the admin acts inside the granting pharmacy');
    assert((await c.query('select my_role() as r')).rows[0].r === 'co_owner', 'and as a co-owner there');
    assert((await asApp('select count(*) n from drugs')).rows[0].n === '1', 'the admin can now read that pharmacy\'s drugs');
    assert((await c.query('select support_context() as x')).rows[0].x.pharmacy_id === phA, 'support_context names the open pharmacy');
    assert((await c.query('select my_subscription() as s')).rows[0].s.pharmacy_name === 'Support Test A', 'my_subscription describes the open pharmacy');
    // fixing: the admin can change stock in it, and the record is written to THAT pharmacy
    const drugA = (await c.query("select id from drugs where pharmacy_id = $1", [phA])).rows[0].id;
    const batch = (await c.query("select record_restock($1,$2,7,5,10,(current_date + interval '200 days')::date,'SUP1','SupplierX') as id", [phA, drugA])).rows[0].id;
    assert((await c.query('select pharmacy_id from batches where id = $1', [batch])).rows[0].pharmacy_id === phA, 'a restock done in support lands in the granting pharmacy');
    assert((await c.query('select created_by from stock_adjustments where batch_id = $1', [batch])).rows[0].created_by === adminId, 'and is recorded as made by the admin');
    // it never reaches a pharmacy that did not grant
    await assertThrows(c.query("select record_restock($1,$2,1,5,10,(current_date + interval '200 days')::date,'NO','X')", [phB, drugA]), 'support access does not reach another pharmacy', 'support access must not reach other pharmacies');

    // the owner sees it happened
    await asUser(c, sOwner);
    const hist = (await c.query('select my_support_access() as a')).rows[0].a.history;
    assert(hist.length === 1 && Number(hist[0].opened_count) === 1, 'the owner\'s history shows it was opened once');

    // stopping
    await c.query('select revoke_support_access()');
    await asUser(c, adminId);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p !== phA, 'after the owner stops it, the admin is out of the pharmacy');
    assert((await asApp('select count(*) n from drugs where pharmacy_id = $1', [phA])).rows[0].n === '0', 'and can no longer read its drugs');
    assert((await c.query('select support_context() as x')).rows[0].x === null, 'support_context is empty again');
    const re = (await c.query('select admin_open_support($1) as r', [phA])).rows[0].r;
    assert(re.granted_by_owner === false, 'after the owner stops, the admin can still open directly, and it is logged as direct');
    await c.query('select admin_close_support()');

    // an open with a live grant is logged as the owner's grant
    await asUser(c, sOwner);
    await c.query('select grant_support_access(1)');
    await asUser(c, adminId);
    const gr = (await c.query('select admin_open_support($1) as r', [phA])).rows[0].r;
    assert(gr.granted_by_owner === true, 'with a live grant, the open is reported as given by the owner');
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === phA, 'a new grant works');
    await asUser(c, sOwner);
    assert((await c.query('select my_support_access() as a')).rows[0].a.history[0].opened_count == 1, 'the owner sees that opening in their history');
    await asUser(c, adminId);
    await c.query('select admin_close_support()');

    // a normal owner is not affected by any of this
    await asUser(c, sOwner);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === phA, 'the pharmacy owner still works in their own pharmacy');
    assert((await c.query('select my_role() as r')).rows[0].r === 'owner', 'with their own role');
    await asUser(c, sOwnerB);
    assert((await c.query('select my_pharmacy_id() as p')).rows[0].p === phB, 'and a different pharmacy is unaffected');

    // the new tables and functions are closed to the public API
    const sup = await c.query("select count(*) n from information_schema.role_table_grants where table_name in ('support_access','support_session','support_access_events') and grantee in ('anon','authenticated')");
    assert(sup.rows[0].n === '0', 'support tables are closed to the app and the public API');
    const anonFns = await c.query("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('grant_support_access','revoke_support_access','my_support_access','admin_support_status','admin_open_support','admin_close_support','support_context') and has_function_privilege('anon', p.oid, 'execute')");
    assert(anonFns.rows.length === 0, 'signed-out visitors cannot call any support function');
    await asUser(c, sOwner);
    await assertThrows(c.query('select admin_support_status()'), 'a pharmacy owner cannot use the admin support functions', 'owner should not run admin_support_status');
    await assertThrows(c.query('select admin_open_support($1)', [phA]), 'a pharmacy owner cannot open support sessions', 'owner should not run admin_open_support');

    // --------------------------------------------------------------
    console.log('\n== Days-of-stock-left alert, next to the fixed reorder level ==');
    const dUser = (await c.query('insert into auth.users default values returning id')).rows[0].id;
    await asUser(c, dUser);
    const dPh = (await c.query("select bootstrap_pharmacy('Days Test', 'Days Owner', '0711000009') as id")).rows[0].id;
    const mkDrug = async (name, level, custom) => (await c.query(
      "insert into drugs (pharmacy_id, name, form, unit, reorder_level, reorder_custom, created_at) values ($1,$2,'tablet','tablet',$3,$4, now() - interval '40 days') returning id",
      [dPh, name, level, custom])).rows[0].id;
    const dFast = await mkDrug('Fast Drug', 5, false), dSlow = await mkDrug('Slow Drug', 5, false);
    const dPin = await mkDrug('Pinned Drug', 10, true), dNone = await mkDrug('No Sales Drug', 7, false), dVoid = await mkDrug('Voided Drug', 5, false);
    for (const id of [dFast, dSlow, dPin, dNone, dVoid]) {
      await c.query("select record_restock($1,$2,100,5,10,(current_date + interval '300 days')::date,'B1','S')", [dPh, id]);
    }
    const sellN = async (id, n) => (await c.query(
      "select record_sale($1, jsonb_build_array(jsonb_build_object('drug_id',$2::text,'quantity',$3::int)), jsonb_build_array(jsonb_build_object('method','cash','amount',$4::numeric))) as id",
      [dPh, id, n, n * 10])).rows[0].id;
    await sellN(dFast, 70); await sellN(dSlow, 3); await sellN(dPin, 60);
    const voidSale = await sellN(dVoid, 90);
    await c.query("select void_sale($1,$2,'test')", [dPh, voidSale]);
    const vds = async (id) => (await c.query('select * from v_drug_stock where drug_id = $1', [id])).rows[0];

    // off (the state of every pharmacy today): the number in force is the stored number, nothing else moves
    assert((await c.query('select low_stock_days from pharmacies where id = $1', [dPh])).rows[0].low_stock_days === null, 'the days alert is off for a pharmacy until its owner turns it on');
    assert((await vds(dFast)).reorder_level === 5 && (await vds(dPin)).reorder_level === 10 && (await vds(dNone)).reorder_level === 7, 'with the days alert off, every drug keeps its stored reorder level');
    assert((await vds(dFast)).days_left === null && (await vds(dFast)).daily_rate === null, 'with the days alert off, no sales speed is worked out');
    assert(Number((await c.query('select count(*) n from v_low_stock where pharmacy_id = $1', [dPh])).rows[0].n) === 0, 'and nothing is low yet (every drug is above its stored level)');

    // an owner can turn it on from the app's database role; nonsense values are refused
    await c.query('set role authenticated');
    await c.query('update pharmacies set low_stock_days = 5 where id = $1', [dPh]);
    await c.query('reset role');
    await assertThrows(c.query('update pharmacies set low_stock_days = 0 where id = $1', [dPh]), 'zero days is refused', 'zero days should be refused');
    await assertThrows(c.query('update pharmacies set low_stock_days = 91 where id = $1', [dPh]), 'more than 90 days is refused', 'more than 90 days should be refused');

    // on: 5 days. Fast sold 70 in 30 days = 2.333/day -> 12 ; Slow 3 -> 0.1/day -> 1
    const f = await vds(dFast), sl = await vds(dSlow);
    assert(f.reorder_level === 12, 'a drug that sells 70 in 30 days warns at 12 (5 days of sales), not at its stored 5');
    assert(sl.reorder_level === 1, 'a drug that sells 3 in 30 days warns at 1');
    assert(Number(f.daily_rate) === 2.333 && Number(f.days_left) === 12.9, 'days left = stock / daily sales (30 / 2.333 = 12.9)');
    assert(f.reorder_own === 5 && f.reorder_custom === false, 'the stored number is still available as reorder_own');
    assert((await vds(dPin)).reorder_level === 10, 'a drug with its own number keeps it, however fast it sells');
    assert((await vds(dNone)).reorder_level === 7 && (await vds(dNone)).days_left === null, 'a drug with no sales keeps its stored level and shows no days left');
    assert((await vds(dVoid)).reorder_level === 5, 'a voided sale does not count as sales');
    await sellN(dFast, 18);   // 12 left; rate now 88/30
    const f2 = await vds(dFast);
    assert(f2.reorder_level === 15 && Number(f2.qty_in_stock) === 12, 'selling more raises the number in force (88 in 30 days -> 15)');
    assert((await c.query('select count(*) n from v_low_stock where drug_id = $1', [dFast])).rows[0].n === '1', 'v_low_stock follows the number in force: 12 left is at or below 15');
    const fSale = (await c.query('select si.id from sale_items si where si.drug_id = $1 limit 1', [dFast])).rows[0].id;
    await c.query("select record_return($1,$2,10,'test')", [dPh, fSale]);
    assert(Number((await vds(dFast)).daily_rate) === 2.6 && (await vds(dFast)).reorder_level === 13, 'a return is taken off the sales speed (78 in 30 days -> 13)');

    // turning it off puts everything back exactly
    await c.query('update pharmacies set low_stock_days = null where id = $1', [dPh]);
    assert((await vds(dFast)).reorder_level === 5 && (await vds(dFast)).days_left === null, 'turning the days alert off restores the stored levels');
    await c.query('update pharmacies set low_stock_days = 5 where id = $1', [dPh]);

    // edit_drug: the old way of calling it still works and does not change the pin
    const eArgs = (custom, level) => [dPh, dPin, 'Pinned Drug', null, 'tablet', 'tablet', level, false, null, null].concat(custom === undefined ? [] : [custom]);
    await c.query('select edit_drug($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', eArgs(undefined, 12));
    assert((await vds(dPin)).reorder_level === 12 && (await vds(dPin)).reorder_custom === true, 'an older app calling edit_drug without the new argument still works and keeps the pin');
    await c.query('select edit_drug($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', eArgs(false, null));
    assert((await vds(dPin)).reorder_custom === false && (await vds(dPin)).reorder_own === 12 && (await vds(dPin)).reorder_level === 10, 'empty number + days: the drug switches to the days alert (60 sold in 30 days -> 10) and its stored number 12 is kept');
    await assertThrows(c.query('select edit_drug($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', eArgs(true, null)), 'pinning a drug without giving a number is refused', 'a pinned drug needs a number');
    await assertThrows(c.query('select edit_drug($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', eArgs(false, -1)), 'a negative number is refused', 'a negative number should be refused');
    await c.query('select edit_drug($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', eArgs(true, 3));
    assert((await vds(dPin)).reorder_level === 3 && (await vds(dPin)).reorder_custom === true, 'typing a number pins the drug to it');

    // another pharmacy is not affected by this pharmacy's setting
    const otherOwner = (await c.query('insert into auth.users default values returning id')).rows[0].id;
    await asUser(c, otherOwner);
    const oPh = (await c.query("select bootstrap_pharmacy('Days Other', 'Other Owner', '0711000010') as id")).rows[0].id;
    const oDrug = (await c.query("insert into drugs (pharmacy_id, name, form, unit, reorder_level) values ($1,'Other Drug','tablet','tablet',6) returning id", [oPh])).rows[0].id;
    assert((await vds(oDrug)).reorder_level === 6, 'a pharmacy that did not turn the days alert on is not affected by another one doing so');
  });

  console.log('\n' + '='.repeat(60));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\nFailed checks:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nTest run crashed:', e);
  process.exit(1);
});
