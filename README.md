# Pharma

Pharmacy stock and sales for Kenyan pharmacies: batches with expiry (FEFO), sales and receipts, restocking, suppliers, expenses, insurance claims, reports. A vanilla-JS installable web app (PWA) on Supabase (Postgres, auth, row-level security). No build step.

Live site: https://pharmacymngt.netlify.app

## Layout

| File | What it is |
|---|---|
| `index.html`, `style.css` | The app's one HTML page and one stylesheet |
| `js/` | The app's code, split by area (`core`, `shell`, `auth`, `dashboard`, `inventory`, `import`, `stock-actions`, `sell`, `reports`, `reports-stock`, `claims-settings`, `suppliers`, `expenses`, `customers`, `controlled-stocktake`, `main`). Plain scripts that share one global scope, loaded in the order listed in `index.html`; `main.js` (starts the app) must stay last |
| `config.js` | Supabase URL and public (anon) key |
| `sw.js`, `manifest.json` | Offline app shell and install settings |
| `nativeShell.js`, `capacitor.config.json`, `www/`, `android/` | The Android app: a Capacitor shell around the live site (see `android/ANDROID_APP.md`) |
| `admin.html`, `admin.js`, `admin.css` | Platform admin portal at `/admin` |
| `schema.sql` | Full database: tables, views, functions, security |
| `migrations/` | SQL changes (28 Oct fixes; 29 Oct nightly cleanup, faster dashboard, the credit / refills / SMS / controlled drugs / stock take batch, and `2026-10-29_d_scalability.sql`: indexes plus the server-side sales report and supplier balances; and `2026-10-29_e_import_cleanup_admin.sql`: fast bulk import, old-log cleanup, admin portal indexes; and `2026-10-29_f_lock_down_table_access.sql`: row-level security audit and least-privilege table access; and `2026-10-30_b_lock_admin_pharmacy_stats.sql`: closes the admin helper `admin_pharmacy_stats()` to the public API; run each new migration in Supabase before deploying the matching code) |
| `supabase/functions/` | Edge Functions: `send-otp`, `verify-otp` (text codes for password reset and sign-up), `signup-by-phone` (creates an account only after the code is verified), `reset-password-by-phone` and `send-sms` (customer reminders) |
| `netlify.toml`, `netlify/functions/` | Netlify settings, the daily keep-alive ping that stops the free-tier database pausing, and the M-Pesa SMS purchase (`sms-topup`, `pay-callback`; needs the MPESA_* and SUPABASE_SERVICE_ROLE_KEY variables set in Netlify) |
| `tests/` | SQL tests, the no-gray-text test, the loading-screen test and the Android shell tests |

## Screens

- **Phone (under 860px):** top bar with a hamburger that opens the left drawer; bottom bar with Home, Inventory, Sell, Expenses, Reports.
- **Desktop (860px and up):** left sidebar (including Customers); split sign-in screen.
- **Customers:** credit (kopa) balances and statements, refills, SMS reminders. **Stock take** and **Controlled drugs** are reached from Inventory (and the phone menu).
- **Plans:** every pharmacy starts a 90-day free trial; the admin marks the first payment and can add or take away days. When the plan ends the pharmacy is locked out until the admin extends or activates it.
- **Sign-in:** phone + password log-in (every password box has a show/hide eye); new pharmacies create an account; staff with an invite code use "Have a code? Staff login". The app shows the view for the person's role.

## Run and test

Open `index.html` through any static server. The Android app is built on your computer with Android Studio: `npm install`, `npx cap sync android`, `npx cap open android` (full steps in `android/ANDROID_APP.md`). Tests:

```bash
node tests/banned-colours.test.js        # no gray text
node tests/android-shell.test.js         # Android settings agree with each other
node tests/native-shell.test.js          # print and back button inside the app
node tests/critical-css.test.js          # loading screen styles match in index.html and style.css
node tests/js-split.test.js              # js/ files: load order, offline cache list, one init()
node --experimental-strip-types tests/send-sms.test.js   # SMS sending logic (no network)
cd tests && npm install && node run_tests.js   # SQL tests, local throwaway Postgres
```

## Where to read more

`CLAUDE.md` (working rules), `PHARMA_PROJECT_STATUS.md` (full history and roadmap), `CHANGELOG.md`, `SETUP.md` (deployment), `PRODUCT_SPEC.md`.
