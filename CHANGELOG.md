# Changelog

Newest first. The detailed story for each item is in `PHARMA_PROJECT_STATUS.md`.

## 2026-10-29

- **Phone bottom bar:** the tab icons are now glass 3D chips, the same look as the menu drawer; the active tab turns gold and lifts. The desktop sidebar is unchanged.
- **Loading page:** new green page with the red hospital cross and a gold heartbeat line. It is part of `index.html` with its styles inline, so it appears before any script downloads, and it is shown straight after you press Log in. New test: `tests/critical-css.test.js`.
- **Faster start:** the pharmacy, categories and suppliers load together after sign-in (was one after another); a returning user's app frame appears at once from a saved copy and is re-checked in the background (a switched-off account is still sent to sign-in); the 880 KB Excel library loads quietly after the first screen instead of before it; early connection to Supabase.
- **Faster dashboard:** 4 requests instead of 8 (out-of-stock and low-stock worked out from the stock list already loaded; supplier debt summed inside the database by the new `supplier_owed_summary` function). The last dashboard is shown instantly with a thin "updating" bar while fresh numbers load, and shimmering placeholders replace "Loading dashboard…" on a first visit.
- **Database:** nightly `housekeeping_daily()` (pg_cron, 03:30 Nairobi) removes one-time codes and password-reset attempts older than 2 days. Daily keep-alive ping (`netlify/functions/keep-alive.js`, `netlify.toml`) so the free-tier project never pauses. Migrations `2026-10-29_daily_housekeeping.sql` and `2026-10-29_dashboard_speed.sql` (both already applied to the live project and added to `schema.sql`). SQL tests: 43 (was 38).
- Service worker cache is now `hodhi-shell-v2i`.

## 2026-10-28

- **Android app:** added the Capacitor Android shell (`android/`, `capacitor.config.json`, `nativeShell.js`, `www/`, root `package.json`), modeled on Kodi's: it loads the live site, prints through Android's print service, handles the back button, and shows a green splash and an offline screen. App id `com.pharmacymngt.app`, version 1 (1.0.0). Launcher icon and splash use the red hospital cross. Not yet built or run on a phone: build it with Android Studio (`android/ANDROID_APP.md`). New tests: `tests/android-shell.test.js`, `tests/native-shell.test.js`. Service worker cache is now `hodhi-shell-v2h`.
- **Rules:** added `CLAUDE.md` and `tests/banned-colours.test.js` (no gray text); added this changelog and `README.md`.
- **Phone sign-in:** new "dispensing label" design on a "Daylight" background (cream paper, curved green header, gold heartbeat line at the top and a green one at the bottom) with a red hospital-cross mark, "Know your stock", an emoji benefit row in glass 3D chips (same recipe as Kodi's), and a cream label card. Desktop sign-in unchanged. The "Have a code? Staff login" link stays on the log-in and create-account screens. The staff-code screen's title is "Join pharmacy" and its "Ask the pharmacy owner for a staff invite code" hint is removed. Sign-up placeholders are now "Afya Bora Pharmacy" and "Daud Kinyua"; the staff-code screen's name placeholder is also "Daud Kinyua".
- **Phone navigation:** hamburger opens a left drawer (Overview, Stock, Money, More); the bottom bar is Home, Inventory, Sell, Expenses, Reports. Desktop sidebar unchanged.
- **Review fixes:** checkout price match, return/void/write-off stock, cross-tenant writes, anon RPC access, owner lockout, prescription enforcement, atomic insurance claims, XSS, service worker caching. See `REVIEW.md` and `migrations/2026-10-28_*.sql`.
