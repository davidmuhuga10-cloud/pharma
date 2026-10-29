# Code review — 28 Oct 2026

Full pass over `schema.sql`, `app.js`, `admin.js`, `sw.js` and `tests/`.
Everything below is fixed in this repo and applied to the live Supabase
project (`PHARMA`, `ovegzdlrhlcpjfcsoumu`) as four migrations, also kept as
standalone files under `migrations/`.

**Verification:** `schema.sql` now loads into a clean Postgres 17 database
under `psql -v ON_ERROR_STOP=1` with zero errors, the project's own suite
passes 38/38 against it, and every changed function's `pg_get_functiondef`
hash matches the live project byte-for-byte — so this file is a true mirror
of production, not a drifting copy.

---

## 1. Checkout was broken for any drug with more than one price — blocker

The Sell screen priced the cart from `drugs.default_price`. `record_sale`
priced every line from whichever batch FEFO landed on, applying that batch's
`discount_percent`. Those two numbers agree only while a drug has exactly one
batch at the current price.

`record_restock` sets `drugs.default_price` to the **latest** restock price.
So the moment you restocked at a new price with old stock still on the shelf —
an ordinary Tuesday in a pharmacy — the client asked for payments summing to
the wrong total and `record_sale` rejected the entire sale:

```
Payments (400.00) do not add up to the sale total (360.00)
```

The same thing made the markdown feature unusable outright: mark a batch down
20% and every sale of that drug failed. Nothing in the UI explained why, and
no amount of retrying helped.

**Fix.** New `quote_sale(p_pharmacy_id, p_items)` RPC runs `record_sale`'s
exact FEFO loop read-only and returns the authoritative total and per-batch
lines. `openCheckout()` now calls it and collects money against that number,
with a line of explanation when it differs from the shelf price. The printed
receipt shows the prices actually charged rather than the cart's indicative
ones. Both functions tie-break the batch ordering on `created_at, id` so the
quote and the sale can never disagree when two batches share an expiry date.

Latent in your data today — all 13 drugs currently have a single batch — which
is why it hadn't bitten yet.

## 2. The same sale line could be returned over and over — stock and money

`record_return` checked `p_quantity` against `sale_items.quantity` but never
against what had already been returned off that line. Returning 5 of a 5-unit
line five times credited 25 units back to stock and logged five refunds.
Nothing stopped it.

It also never checked whether the sale had been voided. `void_sale` refuses to
run once a return exists, but not the reverse — so void-then-return credited
the same stock twice.

**Fix.** Returns are now capped at `sold − already returned`, voided sales
cannot be returned, and the sale line is locked `for update` so two tills
can't race.

## 3. A negative write-off created stock out of nothing

`quantity_remaining - p_quantity` with a negative `p_quantity` *increases* the
batch, and the audit row records it as a positive `write_off`. No check in the
function, no table constraint. Any pharmacist could invent inventory through
the write-off form.

**Fix.** Quantity must be greater than zero.

## 4. Two functions wrote prices into other pharmacies' data

`record_restock` never checked that `p_drug_id` belonged to `p_pharmacy_id`.
The new batch got the caller's own `pharmacy_id`, so RLS still hid it — but
the function ends with:

```sql
update drugs set default_price = p_sell_price where id = p_drug_id;
```

and runs `SECURITY DEFINER`. A hand-made RPC call carrying another pharmacy's
drug id silently rewrote that pharmacy's shelf price. `record_supplier_lpo`
had the identical hole, once per line item.

**Fix.** Both validate drug (and supplier) ownership first, and both `update`
statements are scoped by `pharmacy_id` as well.

## 5. Every RPC was reachable without signing in

Postgres grants `EXECUTE` on new functions to `PUBLIC`, and in Supabase `anon`
inherits `PUBLIC`. Section 9's `grant execute on all functions ... to
authenticated` **added** a grant but never took the default one away. Only the
admin functions explicitly revoked it.

Most functions were still safe in practice, because `my_pharmacy_id()` is null
for a signed-out caller and the "Not authorized for this pharmacy" check fires
first. `join_pharmacy_with_code` was not: it is `SECURITY DEFINER`, so it reads
`staff_invites` with RLS bypassed, and its only guard asked whether the
*caller* already had a profile — false for anon. That made it an oracle an
anonymous visitor could use to brute-force 6-character invite codes.

**Fix.** `EXECUTE` revoked from `PUBLIC`/`anon`, default privileges changed so
new functions don't get it either, and explicit grants to `authenticated`.

> Worth knowing: revoking from `PUBLIC` alone broke the app for about a
> minute, because several functions — including `my_role()`, which every RLS
> policy calls — had no explicit `authenticated` grant and were reaching the
> app through `PUBLIC` too. Caught and fixed in the same session; the final
> state is 0 functions callable by `anon`, 25 by `authenticated`, and exactly
> 3 internal-only (`admin_pharmacy_stats`, `log_sign_in`, `rls_auto_enable`).

Both signup RPCs now also state plainly that they need a signed-in user
instead of relying on a null `auth.uid()` happening to break a later insert.

## 6. A co-owner could lock the real owner out, permanently

`co_owner` is "full equal access", and the `profiles` UPDATE policy lets it
update any row in the pharmacy. The escalation trigger only blocked promotion
*to* `owner` — it never stopped a co-owner demoting or deactivating the
literal owner. Since nothing can ever mint a new `owner` (only
`bootstrap_pharmacy`, at signup), that was unrecoverable without SQL access.

**Fix.** The owner's `role` and `active` are immutable through the API. They
can still edit their own name, phone and language.

## 7. Prescription capture was browser-only

`openRxCapture()` demands a patient name before an Rx drug reaches the cart,
but nothing stopped a direct RPC call recording an Rx sale with no patient at
all. For a prescription-only medicine that record is a legal requirement.

**Fix.** `record_sale` refuses an `is_prescription` line without a patient
name.

## 8. Insurance claims could vanish

The claim was created by a **second** statement from the browser after
`record_sale` had already committed. Connection drops at the till, tab closes,
RLS hiccups — the sale stands, the claim never existed, and the pharmacy
quietly loses money it is owed. It also only ever created a claim for the
*first* insurance payment line.

**Fix.** Claims are created inside `record_sale`'s own transaction, one per
insurance line. The client-side insert is gone.

## 9. Stored XSS in three places

`listRow()` escapes its `name` argument but not `meta` or `right`. Three call
sites passed raw text through `meta`:

- the Excel import preview — `unit` straight out of an uploaded spreadsheet
- the reorder list, twice — `unit` from the drugs table
- the sale detail screen — the **payment reference**, free text typed at the
  till

and `printReceipt()` dropped the payment reference and method into the print
area unescaped.

**Fix.** All escaped. I swept both JS files for every `' + expr +` into HTML
and checked each remaining one; everything else was already escaped, numeric,
or a pre-built fragment. (Also fixed a double-escape that printed a customer's
apostrophe as `&#39;` on the on-screen receipt.)

## 10. Offline mode didn't work on a first offline open

`sw.js` precached the shell but left out `vendor-supabase.js` and
`vendor-xlsx.js`. Offline, `index.html` came from cache, the vendor scripts
went to the network, got nothing, and `app.js` died on
`supabase.createClient` — the exact single point of failure vendoring them was
meant to remove. They only reached the cache after a successful online load.

**Fix.** Both precached.

## 11. Deploys didn't reach returning users

The fetch handler was cache-first for *everything*, including `index.html` and
`app.js` — so a returning user kept running the old app until someone
remembered to bump `CACHE_NAME` by hand. Forget once and a fix shipped to
Netlify never reaches the pharmacy that needs it.

**Fix.** Network-first for HTML/JS/CSS and navigations, cache-first for icons,
fonts and the vendored libraries. The offline guarantee is unchanged — the
cached copy is served the moment the network fails — but correctness no longer
depends on remembering a constant.

## 12. The test suite was silently skipping the entire permissions layer

`tests/00_auth_stub.sql` never created the `anon`, `authenticated` or
`service_role` roles, so every `GRANT` and `REVOKE` in `schema.sql` failed with
`role "authenticated" does not exist`. Because `psql` keeps going after an
error unless `ON_ERROR_STOP` is set, the whole thing was skipped without a
word — which is exactly why issue #5 was invisible to 38 passing tests. The
stub was also missing `auth.sessions`, which section 10 reads.

**Fix.** The stub creates all three roles and `auth.sessions`. `schema.sql`
now loads under `ON_ERROR_STOP=1` with no errors, so the permissions layer is
actually exercised.

## 13. Smaller fixes

- **Cart "+" ignored stock.** `addToCart` capped at available stock; the
  cart's own `+` button didn't, so you could push a line past the shelf and
  only find out at Confirm. Now capped against the live figure, counting
  multiple lines of the same drug together.
- **`fmt()` hard-rounded to whole shillings.** A checkout 40 cents short
  showed "Balance KES 0" in red with Confirm disabled and no visible reason.
  Now shows cents when there are cents.
- **A session from another tab left you on the login screen.**
  `onAuthStateChange` updated `STATE.session` on `SIGNED_IN` and did nothing
  else — no profile load, no re-render.
- **Zero/negative quantities were silently dropped** from a sale instead of
  rejected (they fell straight through the fill loop).
- **`insurance_claims.status` was unconstrained free text,** so a typo
  (`Paid`, `submited`) created a status the Reports filter would never match
  again. Now constrained to the four real states.
- **Write-offs and corrections had optional reasons,** and the app sent `null`
  when the box was blank — so the `stock_adjustments` row, the thing a PPB
  GSDP inspection actually reads, recorded the change with no explanation.
  Now required at both layers.
- **Non-deterministic `payment_method`** on a single-method sale
  (`select method ... limit 1` with no `ORDER BY`).

---

## Not changed — worth a decision

- **Leaked-password protection is off** in Supabase Auth. One toggle:
  Authentication → Policies. Recommended, given these are pharmacy logins on
  shared counter devices.
- **`admin.html` ships with the static site**, so the portal URL is publicly
  reachable. The database enforces `platform_admins` properly, so this is not
  a vulnerability — but if you'd rather it not be discoverable at all, deploy
  it separately or put it behind a Netlify password.
- **`record_correction` lets a stock_taker set any quantity.** That is the
  design, and it is now at least always explained on the audit trail. If you
  want counts above a threshold to need an owner's sign-off, that is a product
  decision rather than a bug.
- **Swahili is wired up but disabled** (`t()` hard-returns English) because
  only nav labels are translated. Fine, just don't lose track of it.
- **The five `rls_enabled_no_policy` linter notices are intentional** —
  `platform_admins`, `sign_in_log`, `phone_otps`, `sms_platform_config` and
  `password_reset_attempts` are server-only by design (RLS on, zero policies).
  No action needed.

---

# Scalability review - 29 Oct 2026

The 28 Oct review above was about correctness and security. This one is about
speed and staying fast as the data grows. Findings, and what was done.

## Fixed

1. **Sales report failed at a few hundred sales and downloaded megabytes.**
   `loadReport` fetched every sale, then `sale_items` and `sales_payments`
   with `.in('sale_id', [every id])` (the ids go in the web address, which has
   a length limit), and summed them with nested `.find()` loops (quadratic).
   Now `sales_report()` totals in the database and `sales_report_page()`
   returns 20 at a time; items load only when a sale is opened.
2. **Suppliers list downloaded every delivery and payment** to compute
   balances. Now `supplier_balances()`.
3. **Expenses downloaded all history**; now this year only. (Also fixed a
   one-day-early date comparison caused by `toISOString()` in Nairobi.)
4. **Sell drew every product** on every redraw; now capped at 100 with search.
5. **Checkout reloaded every customer's balance before every sale**; now
   reused for a minute and refreshed after each sale.
6. **The 880 KB Excel library** was pre-cached on install and always warmed;
   now neither, except quietly on good connections.
7. **Missing indexes** on tables filtered by pharmacy (sales payments,
   returns, insurance claims, held sales, suppliers, staff invites) and for
   the oldest-expiry batch lookup. The tables that matter most (sales,
   sale items, batches, stock adjustments, expenses, customers) already had
   a leading `pharmacy_id` index.
8. **One 5,700-line `app.js`** (352 functions, about 95 globals, one file to
   merge-conflict in) is now 17 files in `js/`, byte-identical code.

## Not changed - worth a decision

- **Old rows grow forever** in `stock_adjustments`, `sign_in_log` and
  `sms_log`. Fine for years at one pharmacy, but decide a retention window
  (e.g. keep 2 years, archive the rest) before there are many pharmacies.
  The nightly cleanup (`daily_housekeeping`) is the place to add it.
- **Platform admin portal** (`admin_overview`, `admin_pharmacy_stats`) scans
  every pharmacy's rows on each open. Fine at tens of pharmacies; rewrite as
  per-pharmacy rollups before hundreds.
- **Bulk import** (`runImport`) makes one request per row. A batched database
  function would make a 2,000-row sheet take seconds instead of minutes. Not
  changed because it touches stock and needs its own tests.
- **Drug detail** lists every batch including empty ones; harmless until a
  drug has hundreds of restocks.
- **`my_pharmacy_id()` / `my_role()` must stay `stable`** (they run inside
  every row-level-security check); do not inline them or mark them volatile.

