# Start here

You have just inherited Pharma. This file assumes you know nothing about it,
have nobody to ask, and need to be useful today. Read it before anything else.

It is in two parts: **Part 1 for the developer**, **Part 2 for the owner**, who
does not write code and needs to know what to ask for and how to check it.

---

# Part 1 — For the developer

## What this is, in four sentences

Pharma is a point-of-sale and stock system for Kenyan pharmacies. Several
pharmacies share one database; each only ever sees its own rows. It is a plain
JavaScript web app — **no build step, no framework, no npm install to run it** —
talking to Supabase (Postgres with row-level security and auth). You can open
`index.html`, change a file, refresh, and see it.

Real money and real medicine stock depend on it being right.

## Your first hour

Read in this order. Do not skip to the code.

1. **`ARCHITECTURE.md`** — how the pieces fit, the roles, the scheduled jobs.
2. **This file's "Five traps" section below.** It will save you a day.
3. **`OPERATIONS.md`** — what to do when something breaks, and how backups work.
4. **`MIGRATIONS.md`** — how to change the database. There is exactly one right
   way and it is not negotiable.
5. **`CHANGELOG.md`** — newest first. Skim the last twenty entries. Each says
   what was wrong, what changed, and how it was checked. This is where the
   project's hard-won knowledge lives.

Then run the tests (`npm test`). They should all pass. If they do not, fix that
before you write a line of your own.

## The one flow you must understand: a sale

Everything else is variations on this.

1. The seller picks drugs; the browser calls **`quote_sale`** to price them.
2. On confirm, the browser calls **`record_sale`** — one database function, one
   transaction. It is the heart of the system.
3. Inside `record_sale`: it checks you belong to this pharmacy, checks your
   role, then drains stock **FEFO** — first-expiry-first-out — taking from the
   batch that expires soonest, locking each batch row (`FOR UPDATE`) so two
   tills cannot sell the same unit twice.
4. It refuses to sell a prescription-only drug without a patient name, and a
   controlled drug without patient, prescriber and prescription number — and
   writes a controlled-drugs ledger entry, which is a legal record.
5. It checks the payment lines add up to the total, takes the next invoice
   number atomically, and writes the sale.

**If you change `record_sale`, you are changing money and controlled-drug
records.** Read the whole function first and run `tests/run_tests.js` (the SQL
tests) against a local throwaway database. Never test it against production.

## Five traps

These are real. Each one cost a careful reader a mistake.

### Trap 1 — `schema.sql` is a log, not a snapshot

`schema.sql` is every migration ever, appended in order. **`record_sale` appears
in it 11 times. `edit_drug` 10 times. `dashboard_data` 6 times.** Only the
**last** definition is real.

Worse, the formatting is inconsistent: some are
`create or replace function public.x(...)`, others
`create or replace function x(...)`. A search-and-replace written against one
style silently matches nothing.

**The live database is the source of truth.** To see what a function really
does right now, run this in the Supabase SQL editor:

```sql
select pg_get_functiondef('public.record_sale(uuid,jsonb,jsonb,text,text,uuid,numeric)'::regprocedure);
```

Use `schema.sql` to rebuild from scratch, not to answer "what does this do".

### Trap 2 — `staff_can()` is not a permission check

The name lies. For a seller with no custom access map, **`staff_can('discount')`
returns `true`.** It is only the owner's per-person *override* layer — "the
owner switched this off for this one employee".

A real permission check is **both**:

```sql
if coalesce(my_role()::text,'') not in ('owner','co_owner','pharmacist')
   or not staff_can('discount') then
  raise exception '...';
end if;
```

Writing `if staff_can('discount')` on its own is a security hole that looks
like a check. The three permission concepts are:

| | What it means |
|---|---|
| `my_role()` | owner / co_owner / pharmacist / attendant / stock_taker / accountant |
| `staff_can(key)` | the owner's per-person override, **defaults to true** |
| `can(action)` in `js/core.js` | the browser's copy, used only to show or hide buttons |

`can()` decides what the screen *offers*. The database decides what is
*allowed*. They must agree, and the database must never trust the browser.

### Trap 3 — two functions have no `CREATE` under their own name

`dashboard_data_raw` and `dashboard_data_custom_raw` were created under the
names `dashboard_data` / `dashboard_data_custom` and then renamed with
`ALTER FUNCTION ... RENAME TO`. Searching `schema.sql` for
`create function dashboard_data_raw` finds **nothing**. They exist; look in the
live database (Trap 1).

### Trap 4 — `esc()` is not safe inside `onclick`

The app builds HTML by string concatenation, including about **200** inline
`onclick="fn('...')"` handlers.

`esc()` escapes for HTML. It turns `'` into `&#39;`. But the browser
HTML-decodes an attribute **before** parsing the JavaScript inside it, so
`&#39;` becomes a real quote again and ends the string early. A drug named
"Jack's Cough Syrup" used to make seven buttons silently do nothing.

- Value going into **HTML text or a normal attribute** → `esc()`
- Value going into a **JavaScript string inside `onclick`** → **`jsArg()`**

Both are in `js/core.js` with a comment explaining the difference. If you add a
new `onclick` that passes anything a person typed, use `jsArg()`.

### Trap 5 — four helpers exist twice, and a fix to one misses the other

`admin.html` loads only `admin.js` and shares no code with the app, so these
four are duplicated, byte for byte:

| Function | App copy | Why it matters |
|---|---|---|
| `esc()` | `js/core.js` | escapes HTML. Escaping bugs have happened here (Trap 4) |
| `act()` | `js/core.js` | small DOM helper |
| `normalizePhone()` | `js/shell.js` | `07..` / `+2547..` / `7..` -> `2547..`, used to find an account |
| `phoneToAuthEmail()` | `js/shell.js` | turns a phone number into the e-mail Supabase Auth stores |

The last two are the dangerous ones. If the app and the admin console ever
disagree about what e-mail a phone number maps to, the admin console looks up
an account that does not exist, or the wrong one.

`tests/shared-helpers.test.js` fails if the copies drift, so you will be told.
**If it fails, you changed one copy** — copy the change into the other, or
move the function somewhere both pages load and delete both copies.

Eleven other names appear in both files (`init`, `doLogin`, `toast`,
`friendlyError`, `renderLogin`, `logout`, `kpi`, `icon`, `pwField`, `fmtDate`,
`roleLabel`). Those are **not** duplication — same name, genuinely different
code for a different page. Leave them alone.

## How to make a change safely

**Front-end only:**
1. Edit the file. Refresh. There is no build step.
2. If you changed anything in `js/`, bump `CACHE_NAME` in `sw.js`
   (`hodhi-shell-v4n` → `v4o`). Returning users get the old code otherwise.
3. `npm test`.
4. Add a `CHANGELOG.md` entry: what was wrong, what changed, how you checked.
5. Commit and push. Netlify deploys from `main`.

**Database change — follow `MIGRATIONS.md` exactly:**
1. Write `migrations/YYYY-MM-DD_what_it_does.sql` **and** its
   `.ROLLBACK_if_needed.sql` at the same time.
2. Test it on a **local throwaway Postgres** first — never on production.
   `tests/README.md` shows how to stand one up from `schema.sql`.
3. Apply it to the project.
4. **Check the Supabase advisors afterwards for new warnings.** This step is
   not optional: in November 2026 it caught a migration that had accidentally
   exposed four trigger functions on the public API.
5. Append the migration to `schema.sql` under a
   `-- Folded in from migrations/<file>` banner.
6. `CHANGELOG.md`, then commit.

**Never** apply a change to the database that does not exist as a migration
file. The next person rebuilding from `schema.sql` will not get it, and the two
will drift apart silently.

## What is dangerous to touch

| Area | Why |
|---|---|
| `record_sale`, `void_sale`, `record_return` | money, stock and the controlled-drugs ledger. Double-crediting stock on a void has happened before — see the changelog |
| Anything with `my_pharmacy_id()` | that is the wall between pharmacies. A mistake here leaks one pharmacy's data to another |
| Row-level security policies | same |
| `sw.js` | get it wrong and users are stuck on old code with no way to update |

For these, write a test first.

## Things that are better than they look

- **38 test files, all passing.** They are named in plain English and are the
  nearest thing to a specification.
- **Comments explain *why*.** Many record a real bug — they are there to stop
  you "simplifying" the code back into it. Believe them.
- **Error messages are written for pharmacists, not developers.** Keep it that
  way; `friendlyError()` in `js/core.js` does the translating.
- **Backups run nightly and prove themselves** by restoring into a throwaway
  database before they are kept. See `OPERATIONS.md`.

---

# Part 2 — For the owner

You do not write code. You still need to tell whether work was done properly.
Here is how, without reading any.

## The three things that must never break

1. **Money** — what a sale totals, what a customer owes, what a supplier is owed.
2. **Stock** — how many units of each batch are left, and which expires first.
3. **Separation** — one pharmacy must never see another's anything.

If a developer proposes a change near these, it is fair to ask: *"How did you
test that, and what happens if it is wrong?"* A good answer names a test. A bad
answer is "it should be fine".

## What to require of any developer, every time

Ask for these four. They are the project's own rules, not extra:

1. **"Is there a migration file for the database change?"** Every database
   change must exist as a file in `migrations/`, with a rollback file beside
   it. If they changed the database directly without one, it will be lost the
   next time anyone rebuilds.
2. **"Did `npm test` pass?"** One command, runs 35+ checks. It either passes or
   it does not.
3. **"Did you add a CHANGELOG entry?"** Every change gets one saying what was
   wrong, what changed, and how it was checked. This is how the next person
   learns the system.
4. **"Did you check the Supabase advisors afterwards?"** This has already
   caught one real mistake.

A developer who does all four is working the way this project expects. One who
skips them is building up debt you will pay for later.

## What you can check yourself

- **Backups are running.** Open the `BACKUPS` repository on GitHub, look in
  `daily/`. There should be a new commit every morning saying
  **"restore verified"**. If the newest is more than a day old, something is
  wrong — that is worth chasing the same day.
- **The site is up.** https://pharmamanagement.site
- **GitHub emails you when a backup fails.** Do not ignore those.

## If something goes badly wrong

`OPERATIONS.md` is the runbook. It covers the app not loading, texts not
sending, a slow screen, a bad deploy, and **how to restore from backup** —
both getting a few deleted rows back and rebuilding the whole thing.

The important thing to know: **the data is backed up every night and the backup
is proven to restore.** The worst case is losing less than a day.

## The honest state of it

As of 10 November 2026 the system was audited end to end. The money and stock
arithmetic were checked against real data and are correct. Two security holes
were found and fixed, both of the kind where an ordinary employee could do more
than they should. Full detail in `AUDIT_2026-11-10.md`.

Two things remain yours to decide, both business rather than engineering:

- **The Supabase Free plan pauses after about a week of no activity.** Busy
  pharmacies will never hit it; one that signs up and goes quiet will find the
  app down. Moving to the paid plan removes this.
- **The backup window is 24 hours.** Closing it further costs money
  (point-in-time recovery).

Neither stops you selling this to pharmacies today.
