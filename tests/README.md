# Hodhi SQL tests

Automated tests for the money/stock-critical SQL functions in `../schema.sql`
(FEFO batch draining, split payments, void/return double-credit protection,
staff invites, the privilege-escalation trigger). They run against a fresh,
local, throwaway Postgres database loaded with the exact same `schema.sql`
used in production — **never against the real Supabase project**.

## One-time setup

You need a local PostgreSQL server (any recent version) and Node.js.

```bash
# From this tests/ folder:
npm install

# Create a throwaway database (drop and recreate any time you want a clean slate):
createdb hodhi_test          # or: psql -c "create database hodhi_test;"

# Load the auth stub, then the real schema, into it:
psql hodhi_test -f 00_auth_stub.sql
psql hodhi_test -f ../schema.sql
```

`00_auth_stub.sql` is a ~20-line stand-in for the small slice of Supabase's
real `auth` schema that `schema.sql` depends on: an `auth.users` table (so
the foreign key on `profiles` is satisfied) and an `auth.uid()` function
that reads back whatever the test harness sets as "the current user" for
that connection — exactly mirroring how Supabase's real `auth.uid()` derives
from the caller's JWT, except the test harness sets it directly instead of
signing a token. It also defines `test_set_user(uuid)`, a convenience used
only by the tests, never by the app itself.

## Running the tests

```bash
node run_tests.js
```

By default it connects to `postgresql://postgres@localhost/hodhi_test`. If
your local Postgres needs a password or a different user, override it:

```bash
HODHI_TEST_DB="postgresql://postgres:yourpassword@127.0.0.1:5432/hodhi_test" node run_tests.js
```

A passing run ends with `N passed, 0 failed` and exits 0. Any failure prints
which specific check failed and exits 1 — wire this into CI (or just run it
by hand) before shipping any change to `schema.sql`.

## Re-running after a schema change

Any time `schema.sql` changes, drop and recreate the test database so you're
testing against a truly clean copy of the new schema:

```bash
dropdb hodhi_test
createdb hodhi_test
psql hodhi_test -f 00_auth_stub.sql
psql hodhi_test -f ../schema.sql
node run_tests.js
```

## What's covered

- `bootstrap_pharmacy` creates a pharmacy, seeds the 16 starter drug
  categories, and makes the signup account the `owner`.
- **FEFO selling**: with a near-expiry batch and a far-expiry batch of the
  same drug, a sale drains the near-expiry batch first and only dips into
  the far batch for the shortfall.
- **Split payments**: a sale is rejected if the payment lines don't add up
  to the total; a correctly balanced split records `payment_method='split'`.
- **Overselling** beyond available stock is rejected.
- **Void/return double-credit protection**: `void_sale` refuses to void a
  sale that already has a return recorded against it (which would otherwise
  credit stock back twice). A clean void with no prior return does restore
  the full sold quantity, and voiding an already-voided sale is rejected.
- **Staff invites**: `create_staff_invite` codes are single-use and assign
  the exact role the owner picked; a used code can't be redeemed twice.
- **Privilege escalation**: a non-owner cannot promote themselves to
  `owner` by updating their own profile row directly.
- **Role enforcement on restock/correction/write-off/void/return**: an
  attendant is rejected by all five (matching `app.js`'s own
  `ATTENDANT_ACTIONS` allow-list); a pharmacist can do all five; selling
  remains open to every role, unaffected.
- **`record_restock` has exactly one overload**: a regression guard against
  a real bug this project hit — a second overload was briefly added (to
  support an optional/unknown expiry) instead of extending the original
  function, which made every restock call from the app ambiguous
  ("function record_restock(...) is not unique", since Supabase/PostgREST
  calls RPCs with named parameters). Fixed by keeping one function with a
  defaulted `p_expiry_unknown` argument; this test just makes sure it stays
  that way.
- **`sync_master_drugs`** (the "Sync common drugs" fast-onboarding flow):
  owner/pharmacist only, same as restock; a synced item with no expiry
  given gets a placeholder date 3 years out flagged `expiry_unknown`, never
  a fabricated real date; syncing a drug the pharmacy already has by name
  reuses that drug and adds a batch instead of creating a duplicate, and
  never overwrites its reorder level (only refreshes the price, like any
  restock); missing quantity/price or an empty selection is rejected.

## What this does *not* cover

This is SQL-function-level coverage, not end-to-end UI testing. It doesn't
touch `app.js`, RLS policy behavior under the real `authenticated` Postgres
role (the stub runs as the Postgres superuser, so RLS itself isn't
exercised — only the SQL functions' own business-logic checks, which is
where the money/stock risk actually lives), or anything in the browser.
