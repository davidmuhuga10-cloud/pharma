# Pharma

Pharmacy stock and sales for Kenyan pharmacies: batches with expiry (FEFO), sales and receipts, restocking, suppliers, expenses, insurance claims, reports. A vanilla-JS installable web app (PWA) on Supabase (Postgres, auth, row-level security). No build step.

Live site: https://pharmamanagement.site

## Layout

| File | What it is |
|---|---|
| `index.html`, `style.css` | The app's one HTML page and one stylesheet |
| `js/` | The app's code, split by area (`core`, `staff-access`, `shell`, `auth`, `dashboard`, `inventory`, `import`, `stock-actions`, `sell`, `reports`, `reports-stock`, `claims-settings`, `suppliers`, `expenses`, `customers`, `controlled-stocktake`, `main`). Plain scripts that share one global scope, loaded in the order listed in `index.html`; `main.js` (starts the app) must stay last |
| `config.js` | Supabase URL and public (anon) key |
| `sw.js`, `manifest.json` | Offline app shell and install settings |
| `nativeShell.js`, `capacitor.config.json`, `www/`, `android/` | The Android app: a Capacitor shell around the live site (see `android/ANDROID_APP.md`) |
| `admin.html`, `admin.js`, `admin.css` | Platform admin console at `/admin`: email sign-in and password reset, left menu (Overview, Pharmacies, Billing, Account); one admin only |
| `schema.sql` | Full database: tables, views, functions, security |
| `migrations/` | SQL changes (28 Oct fixes; 29 Oct nightly cleanup, faster dashboard, the credit / refills / SMS / controlled drugs / stock take batch, and `2026-10-29_d_scalability.sql`: indexes plus the server-side sales report and supplier balances; and `2026-10-29_e_import_cleanup_admin.sql`: fast bulk import, old-log cleanup, admin portal indexes; and `2026-10-29_f_lock_down_table_access.sql`: row-level security audit and least-privilege table access; and `2026-10-30_b_lock_admin_pharmacy_stats.sql`: closes the admin helper `admin_pharmacy_stats()` to the public API; and `2026-11-07_demo_account.sql` + `2026-11-07_demo_showcase.sql`: the self-running demo pharmacy (hourly job posts sales, restocks, payments; always shows out, low, expired and expiring stock); and `2026-11-07_single_admin.sql`: only one platform admin allowed; and `2026-11-07_support_access.sql`: "Get support" - an owner lets the admin into their pharmacy for 1 to 24 hours; and `2026-11-07_admin_direct_access.sql`: the admin can open any pharmacy directly (no grant, no password), logged, closes after 8 hours; and `2026-11-07_days_left_alert.sql`: optional "warn me when a drug will last fewer than N days" next to each drug's own reorder number, off until the owner turns it on; and `2026-11-07_excel_sheets.sql`: strict Excel import (dry-run check, all-or-nothing) and the stock sheet (count, rename, reorder number, selling price from one upload; price changes are recorded); run each new migration in Supabase before deploying the matching code) |
| `supabase/functions/` | Edge Functions: `send-otp`, `verify-otp` (text codes for password reset and sign-up), `signup-by-phone` (creates an account only after the code is verified), `reset-password-by-phone` and `send-sms` (customer reminders) |
| `netlify.toml`, `netlify/functions/` | Netlify settings, the daily keep-alive ping that stops the free-tier database pausing, and the M-Pesa SMS purchase (`sms-topup`, `pay-callback`; needs the MPESA_* and SUPABASE_SERVICE_ROLE_KEY variables set in Netlify) |
| `ARCHITECTURE.md`, `OPERATIONS.md`, `MIGRATIONS.md`, `SETUP.md` | Engineering docs: architecture, running it, changing the database, standing up a copy |
| `tests/` | SQL tests, the no-gray-text test, the report-table test, the loading-screen test and the Android shell tests |

## Screens

- **Phone (under 860px):** top bar with a hamburger that opens the left drawer; bottom bar with Home, Inventory, Sell, Expenses, Reports.
- **Desktop (860px and up):** the phone menu docked open down the left (logo, pharmacy name, grouped rows, like Kodi); split sign-in screen.
- **Inventory:** five filter boxes (All, Low stock, Out of stock, Expiring, Unknown expiry), search or scan, a table 10 drugs a page on desktop (the phone keeps its old list); Excel and Print carry the whole picked list.
- **Staff permissions:** Settings -> Staff -> Permissions (or the admin portal) sets, person by person, what each can see: profit, stock value, debt, whole-shop sales, reports, cost prices, Excel/Print, controlled drugs. A Seller with limits gets the Seller dashboard. Switches and presets live in `js/staff-access.js`.
- **Discount and reversing a sale:** checkout has one Discount (KES) box off the whole bill (any role, no cap, no reason; never below zero), starts on M-Pesa, and the receipt shows the discount. A sale is never edited; it is reversed (owner/pharmacist any sale, anyone their own sale from today) and the owner sees who and when.
- **Customers:** credit (kopa) balances and statements, refills, SMS reminders. **Stock take** and **Controlled drugs** are reached from Inventory (and the phone menu).
- **Plans:** every pharmacy starts a 90-day free trial; the admin marks the first payment and can add or take away days. When the plan ends the pharmacy is locked out until the admin extends or activates it.
- **Sign-in:** phone + password log-in (every password box has a show/hide eye); new pharmacies create an account; staff with an invite code use "Have a code? Staff login". The app shows the view for the person's role.

## Run and test

Open `index.html` through any static server. The Android app is built on your computer with Android Studio: `npm install`, `npx cap sync android`, `npx cap open android` (full steps in `android/ANDROID_APP.md`). Tests:

```bash
node tests/banned-colours.test.js        # no gray text
node tests/report-tables.test.js         # every report/list table: 10 a page, coloured status text, date ranges, print header
node tests/stocktake-review-wait.test.js # stock take review waits for the last count to save instead of saying "nothing counted"
node tests/android-shell.test.js         # Android settings agree with each other
node tests/native-shell.test.js          # print and back button inside the app
node tests/critical-css.test.js          # loading screen styles match in index.html and style.css
node tests/js-split.test.js              # js/ files: load order, offline cache list, one init()
node tests/paging.test.js                # lists read past 1000 rows (fetchAllRows); supplier order sends ids in groups
node tests/rpc-contract.test.js          # every database/edge function the app calls exists in schema.sql, migrations or supabase/functions
node tests/dashboard-chart.test.js       # Sales graph line is navy, not the card green
node tests/login-inputs.test.js          # password boxes: no auto-capitalise / auto-correct
node tests/app-theme.test.js            # app colours: white page, black bars, red buttons, sign-in untouched
node tests/support-profile.test.js      # Profile button, change password, Get support (owner lets the admin in for chosen hours)
node tests/days-alert.test.js            # days-of-stock-left alert: settings box, drug's own number, stock list note
node tests/excel-sheets.test.js           # strict Excel import (any bad row refuses the sheet) and the stock sheet
node tests/admin-shell.test.js           # admin console: email sign-in, reset, eye icons, side menu routes
node tests/valuation-row.test.js         # stock valuation row wording and per-unit maths
node tests/sidebar.test.js               # desktop sidebar: every module present, phone bar unchanged, one lit row
node tests/auth-desktop.test.js          # desktop sign-in: same pieces as the phone, split-screen styles
node --experimental-strip-types tests/send-sms.test.js   # SMS sending logic (no network)
cd tests && npm install && node run_tests.js   # SQL tests, local throwaway Postgres
```

## Where to read more

`CLAUDE.md` (working rules), `ARCHITECTURE.md` (how the pieces fit, tenancy, scheduled jobs, limits), `OPERATIONS.md` (daily checks, incident playbooks, capacity guide), `MIGRATIONS.md` (changing the database safely, rollback files), `SETUP.md` (standing up a copy), `PHARMA_PROJECT_STATUS.md` (full history and roadmap), `CHANGELOG.md`, `PRODUCT_SPEC.md`.
