# Getting Hodhi live

## Done already
Your new Supabase project is connected — **schema.sql** has already been
run against it (all tables, views, RPC functions, and Row Level Security
are live), and **config.js** already points at it. I also ran a full
smoke test directly against the live database before handing this back:
signed up two separate test pharmacies, added a drug, restocked it in two
batches with different expiry dates, sold across both batches, and
confirmed (a) FEFO correctly drained the soonest-expiring batch first, (b)
one pharmacy's data is completely invisible to the other's login, and (c)
a forged request naming a different pharmacy is rejected outright. All
test data was deleted afterward — the database is empty and ready for a
real signup.

Along the way I fixed two real bugs before they could reach production:
tables had Row Level Security policies but no base GRANT to the
`authenticated` role (would have made every request fail outright,
regardless of RLS), and the dashboard views were missing
`security_invoker`, which in Postgres would have let them quietly run
with the view owner's elevated privileges instead of the caller's —
bypassing RLS entirely. Both are fixed in the live database and in this
schema.sql.

## Deploy
Same as Kodi/Shule: drag this whole folder into Netlify (or connect it to a
git repo) as a static site. `manifest.json` + `icons/` already make it an
installable PWA on Android/iOS home screens.

## First login
There's no seed data — the first person to sign up ("Create an account")
becomes that pharmacy's owner, and 16 starter drug categories (the same
ones seen in Rubao Mukothima's stock-take sheet — Antibiotics, Analgesics,
Antimalarials, etc.) are created automatically. From there: add drugs →
restock them with a real batch (quantity, price, expiry) → start selling.
Then open **Settings** and fill in the pharmacy's address, town, phone and
email — that's what appears as the letterhead on every printed report and
receipt, so it's worth doing on day one.

## What's in v2
Sign up/log in, add drugs, restock (creates a batch with its own expiry and
price — old stock is never overwritten), sell (cart-based, FEFO stock
deduction — oldest-expiring batch sold first automatically, with a
printable receipt at checkout), a dashboard with stock value /
today-week-month sales / out-of-stock / low-stock / expiring-soon, a
reports tab (today/week/month totals, by payment method, top-selling
drugs, transaction list), and a settings tab for the business's own
letterhead details and alert thresholds.

**Selling:** split payments (one sale can be paid across cash + M-Pesa +
insurance in one checkout, each with its own reference — the sale won't
confirm until the lines add up to the total), prescription capture (drugs
flagged Rx prompt for patient/prescriber name at the point of sale), and
held/parked sales (set a cart aside and resume it later — nothing is
deducted from stock until checkout actually happens).

**After a sale:** every transaction has a detail view from Reports showing
its items, payments and invoice number. Individual items can be returned
(restores stock, logs a refund) without touching the rest of the sale, and
a whole sale can be voided — refused if any item on it was already
returned, so stock never gets credited twice.

**Insurance claims:** a claim is created automatically whenever a payment
line uses "insurance," and can be tracked from pending through
submitted/paid/rejected in Reports, with its own Excel export.

**Stock:** bulk import from Excel for an initial stock-take (handles the
same messy `12.2027`-style expiry format seen in a real pharmacy's sheet),
a reorder list built from out-of-stock/low-stock drugs that exports to
Excel or prints for a supplier, suppliers as their own record with
autocomplete at restock time, and markdowns — a near-expiry batch can be
discounted instead of written off, applied automatically at sale time.

**Staff access:** the owner generates a short invite code for a role
(pharmacist or attendant) from Settings; the staff member redeems it on
signup. The owner can deactivate a staff account or change its role at any
time — no separate admin system, it's all inside the app.

**Desktop and mobile:** the layout isn't just a phone screen stretched
wide — above ~860px it switches to a left sidebar with a proper
multi-column dashboard, same as a desktop POS; below that it's the
thumb-friendly bottom-nav layout for a phone at the counter.

**Printing:** the Stock tab, Reports tab, every completed sale, and the
reorder list each have a "Print" button. Each one prints a clean,
letterheaded page (pharmacy name, address, phone) via the browser's own
print dialog — no extra app needed, works the same on desktop or a phone
connected to a receipt/A4 printer.

**Excel:** the Stock tab, Reports tab, reorder list, and insurance claims
list all have a "⬇ Excel" button that downloads a real .xlsx (via
SheetJS, not just a CSV) — ready to hand to an accountant or attach to an
SHA claim.

**Offline resilience:** a service worker (`sw.js`) caches the app shell
(HTML/CSS/JS/icons) so the app still opens on a bad connection — it
deliberately never caches live data (stock levels, prices), only the app
itself, so a pharmacist is never shown stale stock. Every screen that
loads data now shows a "Try again" retry card instead of a spinner that
hangs forever if the connection drops mid-load.

Not in v2 yet: automated SMS/WhatsApp alerts (needs Africa's Talking or a
similar gateway, which isn't connected yet), direct KRA eTIMS submission,
and M-Pesa STK push at checkout. See PRODUCT_SPEC.md section 6 for the full
list of what shipped in v2 and the one deliberate scope change (in-app
staff access control instead of a separate cross-pharmacy admin system).
All of these slot into the same schema without a rebuild — exactly how
Kodi grew from v0.1 to v0.71.
