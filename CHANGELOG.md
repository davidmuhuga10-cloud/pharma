# Changelog

Newest first. The detailed story for each item is in `PHARMA_PROJECT_STATUS.md`.

## 2026-10-28

- **Rules:** added `CLAUDE.md` and `tests/banned-colours.test.js` (no gray text); added this changelog and `README.md`.
- **Phone sign-in:** new "dispensing label" design on a "Daylight" background (cream paper, curved green header, gold heartbeat line at the top and a green one at the bottom) with a red hospital-cross mark, "Know your stock", an emoji benefit row in glass 3D chips (same recipe as Kodi's), and a cream label card. Desktop sign-in unchanged. The "Have a code? Staff login" link stays on the log-in and create-account screens. The staff-code screen's title is "Join pharmacy" and its "Ask the pharmacy owner for a staff invite code" hint is removed. Sign-up placeholders are now "Afya Bora Pharmacy" and "Daud Kinyua"; the staff-code screen's name placeholder is also "Daud Kinyua".
- **Phone navigation:** hamburger opens a left drawer (Overview, Stock, Money, More); the bottom bar is Home, Inventory, Sell, Expenses, Reports. Desktop sidebar unchanged.
- **Review fixes:** checkout price match, return/void/write-off stock, cross-tenant writes, anon RPC access, owner lockout, prescription enforcement, atomic insurance claims, XSS, service worker caching. See `REVIEW.md` and `migrations/2026-10-28_*.sql`.
- Service worker cache is now `hodhi-shell-v2g`.
