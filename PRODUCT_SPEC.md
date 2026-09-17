# Hodhi — Pharmacy Stock & Sales App
### Product concept, working name: **Hodhi** (Swahili: "hold/reserve/store" — a stock-keeper's word)
Alternate names to consider: DawaPoa, Stoo, Dawa Point, Kanzu Rx

---

## 1. Where this came from

Rubao Mukothima's pharmacy stock-take spreadsheet (313 line items, one snapshot dated
31.08.26) and this brief from the pharmacist, verbatim:

> Need to capture the following: 1. Total stock 2. Daily sales 3. Weekly sales
> 4. Monthly sales 5. Occasional restock. Drugs with short expiry to be
> distinguished. Out of stock drugs also to be distinguished. Add any other
> classification.

What the spreadsheet actually shows about how she works today:
- Drugs are grouped by **form** (Syrups, then a separate "TABLETS AND CAPSULES"
  block — Injectables, Powders/Creams, Eye/Ear Drops, ORS, T.E.O and
  Non-Pharmaceuticals appear further down) and, inside each form, by
  **therapeutic class** (Analgesics/Antipyretics, Antibiotics/Antifungals/
  Amoebicides, Bronchodilators/Anti-Allergy, Antacids/Anti-H-Pylori,
  Supplements, Antimalarials, Anti-DM, Hypertensives/Convulsants,
  Antiemetics/Laxatives, Contraceptives, Others).
- Columns: Drug name, Qty, Price per unit, Total (=Qty×Price), Expiry date,
  and an "RSTK" (restock) column — which exists in the template but is
  **empty on every single row**. The intent to flag restocking was there;
  the workflow to actually use it never happened, because it's manual.
- This is a **point-in-time stock count**, not a transaction ledger — there's
  no sales history in the sheet at all. Every stock take means retyping or
  re-checking ~300 rows by hand, and "what sold this week" isn't answerable
  from this file — someone would have to remember, or dig through an M-Pesa
  statement and a physical receipt book.
- Expiry dates are typed free-hand (`12.2027`, and at least one clear typo:
  `12.203` where `12.2030` or `12.2028` was probably meant) — nothing
  flags a bad date or an expiry that's coming up soon.

This confirms the brief isn't inventing new needs — it's asking us to automate
exactly the workflow she's already doing by hand, plus fix the two things the
spreadsheet structurally can't do: flag things automatically, and remember
sales over time.

## 2. Kenyan market context (why this is sellable beyond one pharmacy)

- **eTIMS (KRA electronic invoicing)** is now mandatory for VAT-registered
  businesses, retail pharmacies included: every sale needs an invoice routed
  through eTIMS with a QR-coded validation, in real time. A pharmacy running
  sales through Excel/a receipt book has no path to this without a POS
  layer. This is a compliance deadline turning into a forcing function for
  every pharmacy in the country to adopt *some* digital sales system in the
  next couple of years — that's the wedge. ([Adamjee Auditors](https://adamjeeauditors.com/kra-etims-compliance-kenya-retailers/), [DawaTrack](https://dawatrack.com/blog/etims-for-pharmacies-in-kenya-a-plain-language-guide-for-pharmacy-owners-2026/))
- **PPB's new risk-based inspection regime (2026 licensing cycle)** now grades
  premises against Good Storage & Distribution Practice and can suspend a
  licence over documentation gaps — storage conditions, stock movement
  records, staff training records. A system that keeps an automatic,
  timestamped record of every stock movement is now a licensing hedge, not
  just a convenience. ([PPB inspection regime summary](https://www.wansom.ai/briefly/news/ppb-announces-new-inspection-regime-for-pharmaceutical-industry-2026-07-08_85459506-3511-4e6a-964a-813cd7b3d75b))
- **SHA (formerly NHIF)** claims are increasingly processed through
  pharmacy systems rather than manual paperwork — a growing share of retail
  pharmacy revenue in Kenya runs through insurance, and claims need a paper
  trail tying a sale to a batch and a patient.
- There is existing competition — **PharmaPOS** (KES 4,000/mo, M-Pesa STK +
  eTIMS + SHA + FEFO batch tracking + cold-chain), **Zameda**, **phAMACore**,
  **DawaTrack** — so this is a proven, paying market, not an unproven bet.
  Nobody has a lock on Tharaka-Nithi or the smaller upcountry chemists;
  those players read as Nairobi-first, higher-price, sales-team-led. The
  same gap Kodi found against enterprise property-management software is
  open here: a cheap, WhatsApp/SMS-simple, phone-first tool sold
  relationship-first to independent chemists who currently use an exercise
  book or an Excel sheet like this one.

Sources: [PharmaPOS](https://pharmacypos.co.ke/) · [DawaTrack eTIMS guide](https://dawatrack.com/blog/etims-for-pharmacies-in-kenya-a-plain-language-guide-for-pharmacy-owners-2026/) · [Adamjee Auditors — eTIMS for retailers](https://adamjeeauditors.com/kra-etims-compliance-kenya-retailers/) · [PPB inspection regime](https://www.wansom.ai/briefly/news/ppb-announces-new-inspection-regime-for-pharmaceutical-industry-2026-07-08_85459506-3511-4e6a-964a-813cd7b3d75b) · [nids.co.ke pharmacy POS roundup](https://nids.co.ke/best-pharmacy-point-of-sale-system-software-in-kenya/)

## 3. The five asks, mapped to features

| Her words | What Hodhi does |
|---|---|
| Total stock | Live per-drug stock (sum of all unexpired batch quantities), plus total stock **value** at cost and at retail — always current, no manual stock-take needed. A full stock-take mode still exists for physical counts, but it reconciles against the system instead of being the only record. |
| Daily / weekly / monthly sales | Every sale is logged at the point it happens (few taps). Dashboard shows today/this-week/this-month totals automatically, no waiting for month-end. |
| Occasional restock | A "Restock" action adds a new **batch** (qty, cost price, expiry, supplier) to a drug — old stock isn't overwritten, so FEFO (first-expiry-first-out) selling and per-batch expiry tracking both fall out of this for free. |
| Short-expiry drugs distinguished | Every batch has an expiry date; the dashboard and inventory list surface an **Expiring Soon** shelf (default 90/60/30-day bands, configurable per pharmacy) in red/amber, separately from normal stock. |
| Out-of-stock drugs distinguished | Any drug at zero live stock across all batches shows in an **Out of Stock** shelf, distinct from "low stock" (below reorder level but not zero). |
| "Add any other classification" | Built in beyond what she asked for: **Low Stock** (below a per-drug reorder threshold you set), **Slow Movers** (no sale in 60+ days — dead stock tying up cash), **Fast Movers** (top sellers by volume/value — what to never run out of), and a **Near-Expiry Discount** flag (system suggests marking down stock expiring within 30 days rather than writing it off as a total loss). |

## 4. Beyond the brief — the "sellable to anyone" layer

- **Multi-tenant from day one**, same pattern as Kodi and Shule: one Supabase
  project, one set of tables, every row scoped to a `pharmacy_id`, Row Level
  Security enforcing that a pharmacy only ever sees its own data. Onboarding
  a new pharmacy is a signup, not a new deployment.
- **FEFO-aware selling**: when a sale is recorded, stock is deducted from the
  batch expiring soonest first, automatically — the single highest-leverage
  feature for a pharmacy, since it directly cuts expiry write-offs.
- **M-Pesa-first, like Kodi**: record cash / M-Pesa / insurance per sale,
  optional M-Pesa till reconciliation later, matching how Kenyan retail
  actually gets paid.
- **SMS/WhatsApp reorder nudges**: "Amoxicillin 250mg is out of stock" or
  "Panadol Extra expires in 21 days — 35 units left" pushed to the owner's
  phone, not something they have to remember to check a dashboard for.
- **Offline-first PWA**: exactly like Kodi and Shule, installs to the home
  screen with no app-store friction, and a sale can still be recorded during
  a network blip in a rural sub-county and sync once back online — this
  matters a lot outside Nairobi.
- **eTIMS-ready invoice numbering & VAT fields** built into the sales record
  from day one, even before a direct KRA integration exists, so switching
  that on later is a settings change, not a rebuild.
- **Simple compliance log**: every stock movement (restock, sale, adjustment,
  write-off/expiry disposal) is timestamped and attributed to a user —
  exactly the audit trail PPB's new inspection regime is now grading
  pharmacies on.
- **Super Admin dashboard** across all pharmacy tenants (same pattern as
  Kodi's `/admin`) — for you and the client to see usage, support pharmacies,
  and eventually manage billing across every pharmacy that signs up.

## 5. MVP scope for the first working version (v0.1)

To get something real in front of Rubao Mukothima's pharmacy fast, v0.1 is:
sign up / log in, add drugs + first batches (can bulk-import from a sheet
like the one she sent), record a sale, record a restock, and one dashboard
showing Total Stock Value, Today/Week/Month Sales, Out of Stock, Low Stock,
and Expiring Soon. Everything in section 4 (SMS nudges, eTIMS numbers,
insurance claims, cold-chain, admin dashboard) layers on top the same way
Kodi grew from v0.1 to v0.71 — feature by feature, driven by what real usage

## 6. v2 — what actually shipped, and one deliberate change from the plan

Section 4 above sketched a cross-pharmacy **Super Admin dashboard** as part of
"beyond the brief." Once staff access was actually being built, the simpler
and more correct design won out: instead of a separate admin system with its
own billing/subscription tables, access control lives **inside each
pharmacy's own app** — the owner generates a short invite code for a role
(pharmacist/attendant), the staff member redeems it on signup, and the owner
can deactivate or change a staff member's role from Settings at any time. No
cross-tenant dashboard, no billing system — that scope was cut on purpose.

Everything else planned for "beyond the brief" did ship in v2:

- **Split payments** — one sale can be paid across cash + M-Pesa + insurance
  in a single checkout, each line with its own reference, validated to add
  up to the total before the sale can be confirmed.
- **Prescription capture** — drugs flagged "prescription-only" prompt for
  patient name (required) and prescriber name (optional) at the point of
  sale, stored per sale line.
- **Held/parked sales** — a cart can be set aside mid-transaction and resumed
  later without touching stock until checkout actually happens.
- **Returns and voids** — an item can be returned against a specific sale
  (restores stock, logs a refund) without disturbing the rest of the sale;
  a whole sale can be voided, but voiding is refused once any item on it has
  already been returned, to avoid crediting stock twice.
- **Insurance claims tracking** — a claim is created automatically whenever
  a payment line uses "insurance," and can be moved through
  pending → submitted → paid/rejected from Reports, with its own Excel export.
- **Sequential invoice numbers** (`INV-000001`, ...) per pharmacy, shown on
  receipts, reports, and the sale detail view.
- **Bulk import from Excel** for the initial stock-take (handles the same
  messy `12.2027`-style expiry format seen in the real client sheet), plus a
  **reorder list** (auto-built from out-of-stock and low-stock drugs) that
  exports to Excel or prints, ready to hand to a supplier.
- **Suppliers** as their own record (not just free text on a batch), with an
  autocomplete at restock time.
- **Markdowns** — a near-expiry batch can be discounted instead of written
  off, and the discount applies automatically at the point of sale.
- **Role-based permissions** (owner / pharmacist / attendant) gating which
  actions each account can take — selling and viewing reports for everyone,
  editing stock and restocking for pharmacist and owner, void/return/staff
  management/business settings for the owner (and pharmacist, for
  void/return/discount/claims).
- **English/Swahili toggle** per staff account.

**Still deliberately not built:** automated SMS/WhatsApp alerts (needs
Africa's Talking or similar, not yet connected — everything else is designed
to slot that in later without a rebuild, the same way Kodi grew feature by
feature), direct KRA eTIMS submission, and M-Pesa STK push at checkout.
shows is needed.
