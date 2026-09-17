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
