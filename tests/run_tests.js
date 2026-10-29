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
    assert(/^[0-9A-F]{6}$/.test(code), 'create_staff_invite returns a 6-character code');

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
    const q1 = (await c.query("select sms_queue($1,$2::jsonb) as r", [pharmacyId, J([{ customer_id: jane, body: 'Hello Jane, your refill is due.', kind: 'refill', ref_id: planB }])])).rows[0].r;
    assert(q1.queued.length === 1 && q1.queued[0].to === '254712345678', 'a pharmacist queues a refill reminder to the customer\'s number');
    assert((await c.query("select status from sms_log where id = $1", [q1.queued[0].id])).rows[0].status === 'queued', 'the log row starts as queued');
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
    console.log('\n== Privilege escalation: a staff member cannot promote themselves ==');
    await asUser(c, staffId);
    await assertThrows(
      c.query("update profiles set role = 'owner' where id = $1", [staffId]),
      'a non-owner updating their own role is blocked by the privilege-escalation trigger',
      'a staff member should NOT have been able to set their own role to owner, but the update succeeded'
    );
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
