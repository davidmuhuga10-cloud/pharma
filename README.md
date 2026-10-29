# Pharma

Pharmacy stock and sales for Kenyan pharmacies: batches with expiry (FEFO), sales and receipts, restocking, suppliers, expenses, insurance claims, reports. A vanilla-JS installable web app (PWA) on Supabase (Postgres, auth, row-level security). No build step.

Live site: https://pharmacymngt.netlify.app

## Layout

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The app: one HTML page, one stylesheet, one script |
| `config.js` | Supabase URL and public (anon) key |
| `sw.js`, `manifest.json` | Offline app shell and install settings |
| `nativeShell.js`, `capacitor.config.json`, `www/`, `android/` | The Android app: a Capacitor shell around the live site (see `android/ANDROID_APP.md`) |
| `admin.html`, `admin.js`, `admin.css` | Platform admin portal at `/admin` |
| `schema.sql` | Full database: tables, views, functions, security |
| `migrations/` | SQL changes (28 Oct review; 29 Oct nightly cleanup and faster dashboard), already applied live |
| `netlify.toml`, `netlify/functions/` | Netlify settings and the daily keep-alive ping that stops the free-tier database pausing |
| `tests/` | SQL tests, the no-gray-text test, the loading-screen test and the Android shell tests |

## Screens

- **Phone (under 860px):** top bar with a hamburger that opens the left drawer; bottom bar with Home, Inventory, Sell, Expenses, Reports.
- **Desktop (860px and up):** left sidebar; split sign-in screen.
- **Sign-in:** phone + password log-in; new pharmacies create an account; staff with an invite code use "Have a code? Staff login". The app shows the view for the person's role.

## Run and test

Open `index.html` through any static server. The Android app is built on your computer with Android Studio: `npm install`, `npx cap sync android`, `npx cap open android` (full steps in `android/ANDROID_APP.md`). Tests:

```bash
node tests/banned-colours.test.js        # no gray text
node tests/android-shell.test.js         # Android settings agree with each other
node tests/native-shell.test.js          # print and back button inside the app
node tests/critical-css.test.js          # loading screen styles match in index.html and style.css
cd tests && npm install && node run_tests.js   # SQL tests, local throwaway Postgres
```

## Where to read more

`CLAUDE.md` (working rules), `PHARMA_PROJECT_STATUS.md` (full history and roadmap), `CHANGELOG.md`, `REVIEW.md` (the code review), `SETUP.md` (deployment), `PRODUCT_SPEC.md`.
