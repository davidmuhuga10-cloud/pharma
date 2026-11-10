# Scale and resilience

*Written 10 November 2026, as part of the November audit.*

This answers one question: **will this system hold up with many pharmacies on
it and real traffic, and does it fail safely when something breaks?**

The brief asked for five specific properties, borrowed from how Erlang/Elixir
systems and WhatsApp are built. Postgres is not the BEAM and cannot be made
into it, so each one is judged on whether the *property* holds here, not on
whether the mechanism looks the same. Where Supabase genuinely cannot support
a pattern, that is said plainly rather than faked.

Every claim below is something that was measured or read out of the live
database. Where a number appears, the command that produced it is named so you
can run it again.

---

## The short version

| Property asked for | Verdict |
|---|---|
| Small isolated units that don't share state | **Holds.** Measured: 42 ms vs 2,009 ms |
| One failure never takes the whole system down | **Mostly holds.** One real single point of failure remains, on first load only |
| Work passed as messages/queues, not blocking | **Holds, after a fix.** A double-send bug was found and closed |
| Operations safe to retry | **Now holds, after a fix.** This was the real gap - it was a money bug |
| Fast and predictable under load | **Holds for the shape of load this product has.** Limits named below |

Two genuine defects came out of this review, both fixed and verified:

1. **Five money/stock writes were not retry-safe.** A lost reply made a second
   real sale. Proved: two identical calls produced 2 sales and took 6 units of
   stock instead of 3.
2. **The evening-summary queue could send the same message twice**, because the
   sender read rows instead of claiming them, and two cron jobs collide at
   15:30 every day.

Both are in `CHANGELOG.md` with their migrations. Neither had damaged live data
yet - that was checked before anything was changed.

---

## 1. Small isolated units that don't share state

**The question that matters:** when pharmacy A is busy, does pharmacy B slow
down? If yes, the product cannot grow, because every new customer makes it
worse for all the existing ones.

**It does not.** This was measured, not assumed
(`tests/tenant-isolation.sh`): a sale in pharmacy A was held open inside an
uncommitted transaction, and meanwhile

- **pharmacy B's sale finished in 42 ms** - it never noticed;
- **pharmacy A's own second sale on the same batch waited 2,009 ms** - which is
  correct, because those two sales are competing for the same physical units of
  stock and must not both get them;
- afterwards both pharmacies' stock figures were exactly right.

The reason it works is that every lock `record_sale` takes is scoped to one
pharmacy. There are exactly three, and no global one:

| What it locks | Scope |
|---|---|
| `update pharmacies set next_invoice_no = next_invoice_no + 1` | that pharmacy's own row |
| `select * from batches ... for update` (FEFO draining) | that pharmacy's batch rows |
| `select * into v_cust from customers ... for update` (credit limit) | that one customer's row |

The invoice counter is the one that could easily have been wrong. It lives as
`next_invoice_no` **on the `pharmacies` table** - one counter per pharmacy. Had
it been a single global row or sequence, every sale in the entire system would
have queued behind every other sale. It is per-tenant, so it is not a
bottleneck.

A detail worth not breaking: the batch lock uses
`order by expiry_date asc, created_at asc, id asc`. A **deterministic** order
is what stops two simultaneous sales taking the same batches in opposite
orders and deadlocking. If you ever change that `ORDER BY`, keep it total.

**Isolation of data** is separate from isolation of contention, and is handled
by row-level security plus `my_pharmacy_id()`. The audit checked this
separately: no cross-tenant foreign-key leaks, and all 12 `admin_*` functions
refuse a non-admin caller (tested by calling each one as a real attendant
inside rolled-back transactions). The November fix to 42 functions closed a
hole where a deactivated account - whose `my_pharmacy_id()` returns NULL -
slipped past a guard written with `is distinct from`, which treats two NULLs as
equal. See `AUDIT_2026-11-10.md`.

**Unit size.** 681 database functions, **median 8 lines, none over 100**. The
front end is one file per screen area. Nothing here is a monolith that has to
be understood all at once.

---

## 2. One failure never takes the whole system down

**The most important finding here is a negative one:** `record_sale` makes **no
calls outside the database at all**. Checked directly against the live
definition for `pg_net`, `net.http`, `http_post`, `dblink` and any SMS call -
none present.

That matters more than it sounds. If sending a receipt or a notification were
inline with recording a sale, then an SMS provider having a bad afternoon would
stop every pharmacy in the country from selling. Instead a sale is pure
database work that either commits or doesn't.

Only **two** functions in the whole schema reach the network, and both are
scheduled background jobs: `queue_evening_summaries` and
`nudge_summary_sender`. They use `pg_net`, which posts asynchronously and does
not hold the caller.

SMS failures are recorded per message. A row goes to `failed` with the reason;
the rest of the batch continues. One bad phone number does not stop the others.

**Where the front end degrades well:**

- If the app cannot start, it now says so instead of spinning for ever - a
  hint at 12 seconds, a plain explanation and a **Try again** at 30. Fixed
  earlier today; the guard sits in `<head>` so it exists before the scripts it
  protects.
- The service worker caches the app shell so a returning user opens offline,
  but it **never** caches Supabase API calls - a stale "in stock" answer at the
  counter is worse than a slow one. That is the right call.
- Screens that fail to load show a retry card rather than "Loading..." for
  ever (`errorCard()` in `js/core.js`).

**The one real single point of failure that remains:** `vendor-supabase.js` is
**218 KB** and is required before anything works. On a **first** load over weak
mobile data it can stall, and when it does the app cannot start at all - this
is exactly what happened on 10 November. A returning visit is fine because the
service worker has it cached. So the exposure is specifically *first load on a
bad connection*, which is also the worst possible moment: a pharmacy trying the
product for the first time.

This is the most valuable remaining piece of engineering work in the system.
Options, cheapest first:

1. Serve it compressed and far-future-cached (check what Netlify is already
   doing - Brotli should take 218 KB down to roughly 60 KB on the wire).
2. Load only the Supabase modules actually used, rather than the whole bundle.
3. Show the login screen before the vendor file arrives, and only block the
   actions that genuinely need it.

**Not a single point of failure, worth knowing anyway:** the Supabase Free plan
pauses a project after about a week with no activity. A busy pharmacy will
never reach that; one that signs up and goes quiet will find the app down. That
is a billing decision, not an engineering one.

---

## 3. Work passed as messages and queues, not blocking

The evening summary is the one genuine fan-out in the product: at 18:30 Nairobi
every pharmacy that wants one gets a summary SMS. It is built as a queue, and
that is the right shape:

```
queue_evening_summaries()     writes one sms_log row per pharmacy  (the queue)
      |                        and nudges the sender
      v
send-queued-summaries         claims a batch, sends it, marks each row
  (edge function)              sent or failed
      ^
      |
nudge_summary_sender()        every 5 minutes, re-nudges while work remains
  (pg_cron, async pg_net)      and recovers anything stranded
```

Nothing blocks on the SMS provider. The work is durable - it is rows in a
table, so a crash loses nothing. Each message's outcome is recorded
individually.

**The defect found here.** The sender used to pick work up like this:

```sql
select id, to_phone, body from sms_log
 where kind = 'summary' and status = 'queued'
 order by created_at limit 100
```

...then call the provider, and only *afterwards* mark the rows sent. Nothing
reserved them in between, so **two senders running at the same time read the
same hundred rows and both sent them.**

That was reachable, not hypothetical. The two schedules collide by
construction:

```
30 15 * * *      queue_evening_summaries()   <- also nudges the sender
*/5 15-16 * * *  nudge_summary_sender()      <- fires at :30 as well
```

Both post to the edge function in the same minute, every single evening. It had
not been noticed only because one summary message has ever been sent on this
project - there is no production history yet. With real pharmacies it would
have meant owners getting the same summary twice, and the SMS bill paid twice.

**The fix** adds the missing step - claiming:

```sql
update sms_log set status = 'sending', claimed_at = now()
 where id in (select id from sms_log
               where kind='summary' and status='queued'
               order by created_at limit p_limit
               for update skip locked)          -- <- this is the whole fix
returning id, to_phone, body;
```

`for update skip locked` is *the* Postgres queue primitive: a second worker
skips rows the first has locked rather than reading them too. Concurrent
senders now get **disjoint** batches, so overlap stops being a correctness
problem and becomes useful - the work gets shared out.

Verified by running two senders at once: **5 rows each, 0 claimed by both, all
10 taken.** The same test against the old code showed both workers holding the
same 5 rows.

**Recovery**, because claiming introduces a new way to fail: a sender that dies
mid-send would strand its rows in `sending`. `claimed_at` records when a row
was taken and `requeue_stalled_summaries()` returns anything in flight for over
15 minutes - comfortably longer than the sender's own ~110 second budget, so it
can only ever catch a send that really is dead. It runs from the nudge that
already fires every 5 minutes. A crashed sender now costs a few minutes'
delay, not a lost message. That is the "fail safely, recover fast" half.

**Headroom.** The sender drains in rounds of 100 with 5 sends in flight, inside
a 110-second budget, and is re-nudged every 5 minutes while anything remains.
At a few hundred milliseconds per send that is on the order of a thousand-plus
messages per invocation, and it simply continues on the next nudge if there are
more. Thousands of pharmacies are fine. This is not the thing that will break
first.

**Where the queue pattern is deliberately *not* used:** recording a sale. A
sale must be true the instant the seller is handed the receipt - stock, money
and the controlled-drugs ledger have to agree before anyone walks away. That
belongs in one transaction, not a queue, and it is correct that it is.

---

## 4. Operations safe to retry

**This was the real gap, and it was a money bug.**

`act()` in `js/core.js` disables a button while its request is in flight, so a
double *tap* was never the problem. The problem is the case that actually
happens on Kenyan mobile data: **the request arrives, the sale is recorded, and
the reply is lost coming back.** The button comes back, the seller sees an
error, and presses Complete again.

Five functions created money, stock or ledger rows with no way to tell a retry
from a new request:

| Function | What a lost reply cost |
|---|---|
| `record_sale` | two sales, stock drained twice, customer charged once |
| `record_customer_payment` | the customer credited twice, their debt understated |
| `record_restock` | the same delivery added to stock twice |
| `record_supplier_lpo` | a duplicate delivery, stock doubled |
| `record_expense` | the same expense counted twice, profit understated |

Demonstrated rather than argued: on a local copy of the database, two identical
`record_sale` calls produced **2 sales, 2 payment rows, and took 6 units of
stock instead of 3**.

Live data was checked for damage already done before anything was changed -
**zero** near-duplicate sales exist (same pharmacy, same seller, same total,
under three minutes apart). Nothing needed repairing. This closed the hole
before it was hit at scale.

**The fix.** The browser makes one id per attempt and **reuses it across
retries**, clearing it only once the write has succeeded. Each table gained a
nullable `client_request_id` with a **unique index on
`(pharmacy_id, client_request_id)`**, and each function returns the row it
already created if it sees that id again.

The index, not the application code, is what makes a duplicate impossible. The
check in the function handles the ordinary sequential retry; if two requests
ever race past it, Postgres lets only one commit.

Three deliberate choices:

- The check sits **after** the role and pharmacy checks, so an unauthorized
  caller cannot use it to probe which request ids exist.
- The id is scoped **per pharmacy**, so the same id in two pharmacies is two
  different requests and can never return the other's sale. Tested.
- The column is nullable and the argument defaults to null, so a caller that
  sends no id behaves exactly as before.

Verified with 20 checks in `tests/retry-safety.sql`, and
`tests/retry-safety.test.js` (in `npm test`) fails if any call site stops
sending the id, generates a fresh one inline, or clears it before the error
check.

**Already safe, left alone:** `void_sale` refuses a second void outright, and
`record_return` caps cumulative returns at the quantity sold, so a retried
return is refused rather than double-crediting stock. Both were read, not
assumed.

**Still not retry-safe, and deliberately not fixed:** `save_customer` with no
id creates a customer each time, so a retry during checkout can leave two
customers with the same name. That is a tidiness problem, not a money one, and
it is visible and fixable by the user in the app. Worth doing when someone is
next in that code; not worth another migration now.

---

## 5. Fast and predictable under load

**The structural thing that matters most is already right:** every
tenant-scoped table has an index **leading with `pharmacy_id`**. Checked across
all 14 tables that carry the column - all of them. This is what makes the
product's cost per pharmacy flat rather than growing: each pharmacy's queries
touch only its own rows, so signing up pharmacy number 500 does not slow down
pharmacy number 1.

Current size, for honesty about what has and has not been proven: the whole
database is about **7 MB**, the largest table is `stock_adjustments` at 1.8 MB
and 3,428 rows, across **4 pharmacies and 534 sales**. So the *structure* is
ready for scale; the *load* has not arrived yet. Nothing below has been
observed failing - these are the places to watch.

Measured: the dashboard RPC returns in **21.6 ms**. Zero unindexed foreign
keys.

The audit flagged 30 "unused indexes" (`idx_scan = 0`). I recommend **leaving
them**: they sit on tiny tables, cost 344 kB on a 7 MB database, and
`idx_scan = 0` on a 60-row table measures how little data there is, not whether
the index is worth having. They are the scale preparation. Removing them would
be optimising the wrong direction.

**What will break first, in order:**

1. **First load on a weak connection** - the 218 KB vendor file (section 2).
   This is already biting and is the top priority.
2. **Reports over long date ranges.** They read detail rows and total them in
   the browser. At a few years of history per pharmacy this becomes slow before
   anything else does. The fix when it comes is aggregating in SQL, or a
   rolled-up daily totals table.
3. **The Free plan's connection ceiling**, if many pharmacies are ever active
   at the same minute. The app talks through PostgREST, which pools, so this is
   further away than it sounds - but it is a plan limit, not something code can
   fix.

`fetchAllRows()` already pages past PostgREST's 1,000-row response cap, so
large result sets return completely instead of silently truncating. That is a
real trap avoided.

**Known waste, worth cleaning when convenient:** `dashboard_data_raw` computes
a `rush` figure on every single dashboard load and **nothing ever displays
it**. Either wire it up or delete it. Six other functions are unused
(`controlledLevel`, `balanceBadge`, `dashRushGraphHtml`, `dashProfitHtml`,
`parseFlexibleExpiry`, `valuationLine`) - several look like half-finished
features, so they were listed rather than deleted, so that a person can decide
which.

**Confirmed harmless:** `demo_tick()` runs hourly on the live database, which
looks alarming. It only touches pharmacies explicitly listed in `demo_config`
(currently exactly one), not a wildcard, so it cannot write into a real
pharmacy's data.

---

## What I did not do

Said plainly so nobody assumes otherwise:

- **No load test at realistic scale.** Everything above is measured on real
  structure with small data, plus targeted concurrency tests. Nobody has run
  500 simulated pharmacies at it. The isolation result (42 ms vs 2,009 ms) is
  the strongest evidence that it would hold, because it shows the contention is
  per-tenant by construction rather than by luck.
- **No systematic UI pass at tablet widths.** Two issues were fixed reactively
  after the owner spotted them. The rest of the screens between roughly 480 px
  and 640 px have not been reviewed.
- **Around 30 front-end files were not read line by line**, `admin.js` (1,208
  lines) among them.

## Reproducing any of this

```bash
# stand up a throwaway copy (never run against production)
createdb hodhi_test
psql hodhi_test -f tests/00_auth_stub.sql
psql hodhi_test -f schema.sql                 # loads clean, zero errors

bash tests/tenant-isolation.sh                # pharmacies do not contend

psql hodhi_test -f migrations/2026-11-10_retry_safe_writes.sql
psql hodhi_test -f tests/retry-safety.sql     # 20 checks

psql hodhi_test -f migrations/2026-11-10_claim_queued_sms.sql
bash tests/sms-claim.sh                       # 15 checks + two senders at once

npm test                                      # the source-level checks
```

A useful thing learned while doing this: the five money functions rebuilt from
`schema.sql` hashed **identically** to the live database (md5 of
`pg_get_functiondef`, all five). So `schema.sql` is a faithful rebuild for
these, even though it is an append-only log in which `record_sale` appears 11
times and only the last copy is real. See trap 1 in `START_HERE.md`.
