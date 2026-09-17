# Pharma (Hodhi) — Project Status

**Last updated:** September 17, 2026 (automated SQL tests added and passing; login switched from email to phone number; demo account deleted from Supabase — see items 5 and 10 in section 4)
**Live site:** https://pharmacymngt.netlify.app
**This file's purpose:** Upload this document into a new Claude session (or paste it in) at any time and it will fully understand where this project stands — what's built, what's been fixed, what's still pending, and exactly how this project works day to day. This is the sister project to Shule Web/ShuleTop — same owner, same workflow rules, same accounts — see section 2 for what carries over and what's specific to this project.

---

## 1. What this is

**Hodhi** (Swahili: "hold/reserve/store") is a pharmacy stock & sales management app built for Kenyan pharmacies — the working name is "Hodhi," the project/repo is called **Pharma**. It's a multi-tenant, offline-capable PWA (web app installable to a phone home screen) covering: drug/batch inventory with FEFO (first-expiry-first-out) selling, point-of-sale with split payments (cash/M-Pesa/insurance), returns/voids, prescription capture, staff roles, insurance claims tracking, Excel import/export, and letterheaded printing.

It originated from a real pharmacy's (Rubao Mukothima's) paper stock-take spreadsheet — see `PRODUCT_SPEC.md` in this folder for the full origin story, Kenyan market context (eTIMS/KRA compliance, PPB inspection regime, competitor landscape), and the complete feature list as of "v2" (what shipped before this review).

**Backend:** Supabase (same pattern as Shule Web) — Postgres with Row Level Security, `pharmacy_id` scoping every table, SQL functions (`record_sale`, `record_restock`, `record_write_off`, `record_correction`, `record_return`, `void_sale`, `bootstrap_pharmacy`, `create_staff_invite`, `join_pharmacy_with_code`) doing the actual business logic server-side. See `schema.sql` for the complete schema, and `SETUP.md` for the original Supabase connection notes (the project was already live and smoke-tested before this review started).

---

## 2. Standing rules for this engagement — same as Shule Web/ShuleTop

This project follows the exact same working relationship and rules established on Shule Web. If you're a new Claude session picking this up, read `SHULETOP_PROJECT_STATUS.md` (if it's available to you) for the full detail — the short version:

- **"DON'T CHANGE IF UNSURE"** — the standing rule across both projects. Never widen a fix beyond what was asked; scope every change as narrowly as possible; ask rather than guess when a root cause is ambiguous.
- **File delivery workflow**: edit files in the Claude sandbox → verify (`node --check` per file, run in a real headless browser to catch runtime errors, screenshot to verify visual/UX claims) → deliver via `SendUserFile` → write into the user's real folder via the device-bridge `device_commit_files` tool (when connected) → give the user exact `git` commands to run themselves. **Claude never runs git commands on the user's behalf** — not because of a technical limitation this time (there's no sandboxed git repo to push from here at all; this is a fresh project), but because that's the standing rule on both projects.
- **Verification rigor**: don't ship a claim about how something looks or behaves without actually rendering it (headless Chromium via Playwright) and looking at the result. This was used throughout the initial code review (see section 4) to separate real bugs from testing artifacts.
- Every commit should carry the same attribution trailer used on Shule Web (check the active session's own instructions for the exact current text, since it can change).

**What's different from Shule Web:**
- **Separate GitHub repo, separate Netlify site** — this was a deliberate choice (see section 5) so that deploying Pharma changes never touches or risks Shule Web, and vice versa. They share the same GitHub account (`davidmuhuga10-cloud`) and the same Netlify account, but are otherwise fully independent projects.
- **Separate local folder**: `C:\Users\user\Downloads\Pharma` on the user's computer (mirrors how Shule Web lives in `C:\Users\user\Downloads\shule-web`).
- **No version-number convention yet** — Shule Web uses "Version N" commit messages by long-standing convention. Pharma is new; adopt the same convention starting now if the user wants consistency (recommended), starting at "Version 1" for the initial import already committed.

---

## 3. How this project came to exist

The user uploaded a zip (`hodhi-pharmacy-app-v2_2.zip`) of an already-built app — built by a previous developer or AI session, not from scratch here — describing it as looking like "beginner" work with a bad login UI and asking for a senior-developer-style review, a roadmap, and then for all the issues found to be fixed. A full code review was done first (see section 4), which found the opposite of "beginner code" underneath: a well-architected multi-tenant backend with real security thinking, let down mainly by plain/generic visual design and a handful of fixable rough edges. That review is preserved as a Claude document (a "living doc," not a file in this repo) — ask the user for the link if you need the full original writeup; the essentials are captured in section 4 below regardless.

After the review, the user asked to set this up as its own project (this folder, this repo) so it can deploy independently via Netlify, then to work through the fixes identified.

---

## 4. Code review findings (from the initial audit)

### What's already solid — don't rebuild this
- Row Level Security on every table, correctly scoped by `pharmacy_id`
- Base `GRANT`s present for the `authenticated` role (the exact gap that silently breaks a lot of RLS-only setups — already handled here, see `schema.sql` near line 873)
- All dashboard views use `security_invoker = true` (prevents RLS bypass via view-owner privileges)
- A dedicated trigger (`prevent_profile_privilege_escalation`) stops a staff account from promoting itself to owner by editing its own profile row directly — a specific, non-obvious attack that a lot of hobby-grade apps miss entirely
- FEFO (first-expiry-first-out) batch selling, split payments, held/parked sales, sequential invoice numbers, prescription capture, item-level returns with double-credit protection on voids, staff invite codes (single-use, 7-day expiry, role-scoped)
- Bulk Excel import that understands the real messy `12.2027`-style expiry format from actual pharmacy stock-take sheets, real `.xlsx` export (not CSV), letterheaded print output everywhere
- Offline-first service worker (app shell only, never caches live stock data) with proper retry states instead of infinite spinners

### Real bugs/gaps found, and their status
| # | Issue | Status |
|---|---|---|
| 1 | Entire app depended on `cdn.jsdelivr.net` for the Supabase and Excel libraries, with no fallback — a slow/blocked CDN froze the app at "Loading Hodhi…" forever with no error | ✅ **Fixed** — both libraries vendored locally (`vendor-supabase.js`, `vendor-xlsx.js`), `index.html` updated to load them locally, plus a global error handler so a load failure now shows a real error + Reload button instead of an infinite spinner |
| 2 | No confirmation before destructive actions (write-off, void, correction) | ✅ **Partially fixed** — added a native confirm() before write-off (the one fully irreversible action with no required reason field). Void already required typing a reason as a soft gate. Correction still has no extra confirmation — low risk since it's just a count correction, but worth revisiting |
| 3 | Password reset used a native browser `prompt()` popup — looks broken on mobile, blocked in some in-app browsers | ✅ **Fixed** — replaced with a proper `renderForgotPassword()` screen matching the rest of the auth flow |
| 4 | Whole app is one 1,706-line file with hand-built string concatenation and inline `onclick` handlers — fragile but not currently broken (verified escaping is correct everywhere it was checked) | 🔲 **Not started** — this is a refactor, not a bug; lower priority than the items below |
| 5 | No automated tests, especially for the SQL functions doing money/stock math (FEFO deduction, split-payment balancing, void/return credit) | ✅ **Fixed** — see `tests/` in this folder. A free, local, throwaway Postgres database (never the live Supabase project) loaded with the real unmodified `schema.sql` plus a minimal stand-in for Supabase's `auth` schema; `node run_tests.js` runs 18 checks covering bootstrap_pharmacy, FEFO batch draining order, split-payment validation, overselling rejection, void/return double-credit protection, staff invite single-use/role-scoping, and the privilege-escalation trigger. All 18 pass. See `tests/README.md` for how to run it again after a schema change |
| 6 | Swahili translation only covers navigation labels, not the whole app, despite the language toggle existing | 🔲 **Not started** — either finish it or remove the toggle until it's complete |
| 7 | Visual/UX: no logo or brand identity, desktop auth screen wastes most of the screen, single flat color palette, emoji used as icons, generic system font | ✅ **Fixed** — added a real logo mark (`logoMarkHtml()` in `app.js`, a green rounded badge with a capsule glyph, used on the topbar and every auth screen); replaced every emoji icon (nav bar, print/import/export/reorder buttons, cart, warnings, close buttons) with a hand-drawn inline SVG icon set (`ICONS`/`icon()` in `app.js` — no icon-font CDN dependency, same reasoning as vendoring Supabase/xlsx); redesigned the desktop auth screen as a real two-column split (brand panel with feature highlights + form), collapsing to a simple stacked layout on mobile; added subtle shadows/depth to cards, buttons and the sheet modal instead of flat borders only. Verified in a real browser (screenshots taken) before shipping. Font is still the system stack (no new external font dependency added, deliberately, to avoid reintroducing the CDN-reliability problem from bug #1) |
| 8 | Backups | ❓ **Unconfirmed** — need to check that Supabase point-in-time recovery is switched on for this project (a one-click Supabase dashboard setting, not a code change) |
| 9 | eTIMS (KRA e-invoicing) integration | 🔲 **Not started** — not urgent today, but flagged as a real compliance deadline coming for VAT-registered Kenyan pharmacies; the sales record already has the fields designed to support it later without a rebuild |
| 10 | Login required an email — pharmacy staff reliably have a phone number, not necessarily a checked email | ✅ **Fixed** — login, signup and staff-join screens now ask for a **phone number**, not email. Supabase Auth is still email-shaped under the hood, so `app.js` derives a stable, never-shown "auth email" from the phone number (`phoneToAuthEmail()` in `app.js`, e.g. `0712345678` → `p254712345678@hodhi.local`) and uses that everywhere `sb.auth.*` needs an email. **Action needed in the Supabase dashboard**: turn OFF "Confirm email" under Authentication → Providers → Email — the derived address can't receive a confirmation mail, so with confirmation on, every new signup would be locked out with no way to confirm. Knock-on effect: self-service "forgot password" (which relied on emailing a reset link) no longer works, since there's no real email on file — the Forgot Password screen now explains that staff should get a new invite code from the owner, and the owner should contact whoever manages Hodhi for this pharmacy. The one pre-existing account (`Rubao Mukothima Pharmacy`, owner "Daudi", a demo/test account) was deleted from the live Supabase project at the user's request — the project now has 0 pharmacies, 0 profiles, 0 auth users, so the first real signup will be a clean start |

---

## 5. Deployment setup — journey and current state

**Decision made:** Pharma gets its own GitHub repo and its own Netlify site, fully separate from Shule Web, even though both share the same GitHub account (`davidmuhuga10-cloud`) and Netlify account. Reason: keeps deploys independent — a Pharma push can never accidentally affect the live Shule Web site or vice versa.

**Steps completed:**
1. Created `C:\Users\user\Downloads\Pharma` on the user's computer and copied in the full app (all files from the original zip, plus the Phase 1 fixes above) via the Claude device bridge.
2. Ran `git init`, `git add -A`, `git commit -m "Version 1: initial import"`, `git branch -M main` locally in that folder — succeeded, 20 files committed.
3. **Hit a snag**: the first push failed because the user was signed into a *different* personal GitHub account (`David-kinyua`) than the one Shule Web uses (`davidmuhuga10-cloud`), and had created the `pharma` repo there by mistake. Corrected by deleting that repo and creating a fresh empty `pharma` repo under `davidmuhuga10-cloud` instead, then re-pointing the git remote (`git remote set-url origin https://github.com/davidmuhuga10-cloud/pharma.git`) before pushing again.
4. **Next**: confirm the push to `davidmuhuga10-cloud/pharma` succeeded, then connect that repo to Netlify (Netlify dashboard → Add new site → Import an existing project → GitHub → select `pharma`; no build command needed, it's a static site like Shule Web; publish directory `/`).

**If you're picking this up and don't know whether the push/Netlify connection succeeded:** ask the user, or check https://github.com/davidmuhuga10-cloud/pharma directly to see if the code is there, and check the user's Netlify dashboard for a `pharma`-named site.

---

## 6. What's next (in priority order)

1. ✅ Confirmed git push + Netlify deploy live end to end at https://pharmacymngt.netlify.app — verified in a real browser, no console errors, self-hosted libraries loading, real Supabase connection working.
2. ✅ Visual/UX design pass (item 7) — done and shipped, see section 4.
3. ✅ Automated tests for the SQL money/stock logic (item 5) — done, 18/18 passing, see `tests/`.
4. ✅ Phone-number login (item 10) — done in `app.js`. **Still needs one manual step from you**: in the Supabase dashboard, Authentication → Providers → Email, turn OFF "Confirm email". Without that, brand-new signups can't finish (the derived email can't receive a confirmation link).
5. Confirm Supabase backups are enabled (item 8) — quick dashboard check, not yet done.
6. Decide on Swahili (finish it or remove the toggle) and on the eTIMS integration timeline.
7. Optional: refactor the single-file `app.js` architecture if the codebase keeps growing (item 4) — not urgent today.
8. Optional, lower priority: a real self-service "forgot password" for phone accounts — right now it's ask-a-human (see item 10). If this becomes a real pain point, options include a real SMS OTP provider (costs money, needs Supabase phone-auth setup) or an owner-facing "reset a staff member's password" tool in Settings.

**Reminder for whoever picks this up:** after any further code change, the delivery workflow is: edit in the Claude sandbox → verify (`node --check`, real headless-browser render, screenshot) → `SendUserFile` → `device_commit_files` into `C:\Users\user\Downloads\Pharma` → tell the user the exact `git add`/`commit`/`push` commands to run themselves (Claude never runs git for them). Netlify auto-deploys on every push to `main` — no separate deploy step needed once pushed.
