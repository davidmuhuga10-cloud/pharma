# Pharma (Hodhi) — Project Status

**Last updated:** September 17, 2026 (English enforced as the only language for now; bulk Excel import fixed and verified against a real stock-take sheet — 131/312 rows now import correctly, up from 0 — see items 6 and 12 in section 4, and "Can the manual stock-take spreadsheet be retired now?" in section 6)
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
| 6 | Swahili translation only covers navigation labels, not the whole app, despite the language toggle existing | ✅ **Resolved for now** — the language toggle is removed and the app is locked to English (`t()` in `app.js` always returns the English string, ignoring anything stored on the profile, and Settings shows a plain "English (Kiswahili is coming soon)" note instead of a dropdown). This avoids a pharmacist landing on a half-translated screen. Finishing the Swahili translation and bringing the toggle back is still a legitimate future item — the `STRINGS.sw` table in `app.js` is untouched and ready to be extended |
| 7 | Visual/UX: no logo or brand identity, desktop auth screen wastes most of the screen, single flat color palette, emoji used as icons, generic system font | ✅ **Fixed** — added a real logo mark (`logoMarkHtml()` in `app.js`, a green rounded badge with a capsule glyph, used on the topbar and every auth screen); replaced every emoji icon (nav bar, print/import/export/reorder buttons, cart, warnings, close buttons) with a hand-drawn inline SVG icon set (`ICONS`/`icon()` in `app.js` — no icon-font CDN dependency, same reasoning as vendoring Supabase/xlsx); redesigned the desktop auth screen as a real two-column split (brand panel with feature highlights + form), collapsing to a simple stacked layout on mobile; added subtle shadows/depth to cards, buttons and the sheet modal instead of flat borders only. Verified in a real browser (screenshots taken) before shipping. Font is still the system stack (no new external font dependency added, deliberately, to avoid reintroducing the CDN-reliability problem from bug #1) |
| 8 | Backups | ❓ **Unconfirmed** — need to check that Supabase point-in-time recovery is switched on for this project (a one-click Supabase dashboard setting, not a code change) |
| 9 | eTIMS (KRA e-invoicing) integration | 🔲 **Not started** — not urgent today, but flagged as a real compliance deadline coming for VAT-registered Kenyan pharmacies; the sales record already has the fields designed to support it later without a rebuild |
| 10 | Login required an email — pharmacy staff reliably have a phone number, not necessarily a checked email | ✅ **Fixed** — login, signup and staff-join screens now ask for a **phone number**, not email. Supabase Auth is still email-shaped under the hood, so `app.js` derives a stable, never-shown "auth email" from the phone number (`phoneToAuthEmail()` in `app.js`, e.g. `0712345678` → `p254712345678@hodhi.local`) and uses that everywhere `sb.auth.*` needs an email. **Action needed in the Supabase dashboard**: turn OFF "Confirm email" under Authentication → Providers → Email — the derived address can't receive a confirmation mail, so with confirmation on, every new signup would be locked out with no way to confirm. The one pre-existing account (`Rubao Mukothima Pharmacy`, owner "Daudi", a demo/test account) was deleted from the live Supabase project at the user's request — the project now has 0 pharmacies, 0 profiles, 0 auth users, so the first real signup will be a clean start |
| 11 | Forgot password | ✅ **Fixed, but deliberately temporary/insecure — see the security note in section 6.** The Forgot Password screen now asks only for the account's registered phone number and a new password, and changes it immediately — no OTP, no code, no confirmation. This is implemented as a Supabase Edge Function, `reset-password-by-phone` (deployed, `verify_jwt` off), because changing another user's password needs the project's service-role key, which must never be shipped to the browser — the function is the one place that key is used, for exactly this one action. **As requested, this was built with zero friction on purpose**; the trade-off is that anyone who knows a pharmacy staff member's phone number can currently take over their account. Fine for now while this is essentially a single-pharmacy pilot; needs real protection (an SMS OTP, or at least a rate limit) before onboarding pharmacies you don't personally know — see section 6 |
| 12 | The bulk Excel importer (built specifically for real stock-take sheets, see section 4's "what's already solid") actually failed on a real one | ✅ **Fixed.** Tested directly against a real stock-take file the user uploaded (`RUBAO MUKOTHIMA STOCK TAKE`, 312 rows) and found the importer brought in **0 of 312 rows** — the sheet has a title row above the real column headers ("DRUGS / QTY / PRICE PER UNIT / EXP DT" is row 2, not row 1), which broke the assumption that row 1 is the header row, so every value landed under the wrong key. Fixed in `app.js`: the importer now reads the file as raw rows and searches the first several rows for the one that actually contains a recognized column name, instead of assuming it's row 1; it also now recognizes the header "DRUGS" (plural, as real sheets use it), and treats an ALL-CAPS row with a name but no quantity/price (e.g. "ANALGESICS/ANTIPYRETICS", "COUGH SYRUPS") as a category heading, carrying it forward onto the drug rows beneath it — matching how a person reads the sheet by eye. Category names are now also matched against existing categories ignoring punctuation/spacing (so "ANTACIDS/ANTI H PYLORI" matches the seeded "Antacids/Anti-H-Pylori"). Re-tested against the same real file: **131 rows now import correctly**, 157 are correctly skipped (no current quantity — they're catalog items this stock-take shows as out of stock, not a bug), 19 rows are recognized as category headers rather than stock lines, and the rest are blank spacer rows in the sheet. See section 6 for what this does and doesn't mean for "can Hodhi replace the manual spreadsheet" |

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

## 6. Roadmap — what's done, and what's left to reach Shule Web-level reliability

Shule Web earned its reliability over many small rounds: real bugs fixed as they were found, visual polish, and enough day-to-day battle-testing that "it just works" became true rather than assumed. Pharma is earlier in that curve — the backend architecture was solid from day one (see section 4's "what's already solid"), and this engagement has now closed most of the gaps between "well-built" and "reliable." What's below is the honest remaining distance, grouped by what kind of risk each item is, in priority order within each group.

### Done so far (for quick reference — full detail in section 4)
- ✅ Removed the hard CDN dependency (Supabase/Excel libraries vendored locally) — item 1
- ✅ Confirmation before write-off — item 2 (partial; correction still has none)
- ✅ Real forgot-password screen instead of a native `prompt()` — item 3 (superseded by item 11)
- ✅ 18 automated SQL tests covering FEFO, split payments, void/return, invites, privilege escalation — item 5
- ✅ Full visual/UX redesign — logo, icon set, two-column auth layout, shadows/depth — item 7
- ✅ Phone-number login end to end — item 10
- ✅ Immediate, code-free password reset by phone number — item 11
- ✅ Language locked to English, Swahili toggle removed until it's fully translated — item 6
- ✅ Bulk Excel import fixed and verified against a real stock-take sheet — item 12
- ✅ Live, working deploy at https://pharmacymngt.netlify.app, on its own repo/Netlify site
- ✅ Demo/test data cleared from the live Supabase project

### Can the manual stock-take spreadsheet be retired now?
**Getting close, but not yet, and not because of the app.** The importer itself now genuinely works — tested against your real `RUBAO MUKOTHIMA STOCK TAKE` sheet, it correctly pulled in 131 real stock lines with the right drug names, quantities, prices, expiry dates, and (mostly) categories, with no manual retyping. That's the part that was actually broken before and is now fixed and proven, not just assumed.

What still stands between "the importer works" and "stop keeping the spreadsheet":
- **This was a one-time import test, not the live workflow.** The 131 rows haven't been imported into your real Supabase project yet — that's a deliberate choice (a live import is a real, hard-to-undo change to your actual data) and needs your go-ahead first, ideally after you've turned off "Confirm email" and can log in as yourself to do it, or by having me do it if you'd rather.
- **A handful of category names won't auto-match** — two of the sheet's section headers ("ANTIBIOTICS/ANTIFUNGAL/AMOEBICIDES/AZOLES" and a typo'd "POWDEERS/CREAMS") don't line up with the app's seeded category list, so those specific drugs will import without a category and need a quick manual re-categorize afterward. Not a blocker, just a known small cleanup.
- **The spreadsheet is a point-in-time stock take, not day-to-day stock keeping.** Even after import, going forward you'd need to actually use the app for restocks/sales/write-offs day to day (not just import once) for it to stay accurate — that's a habit change for whoever runs the counter, not a code question.
- **Ongoing categorization and new-drug entry** for anything not already in the sheet still happens by hand in the app (or a future import), same as it would in a spreadsheet.

Bottom line: the tool is ready to do the heavy lifting. Whether the manual spreadsheet can actually stop being used depends on doing one real import and then committing to using the app day-to-day — both are next steps for you, not open code work.

### A. Security hardening — do before onboarding any pharmacy you don't personally know
1. **Tighten `reset-password-by-phone` (item 11).** Today it's maximally convenient and maximally weak: the phone number alone changes the password, immediately. Reasonable next steps, cheapest first: (a) a rate limit on the Edge Function (e.g. max 3 attempts per phone number per hour) so it can't be brute-forced or used to lock people out repeatedly — no cost, no UX change; (b) a short-lived code sent by SMS (real OTP) once you're ready to pay for an SMS provider (Africa's Talking is the common Kenyan choice; Twilio also works) — this is the "real" fix; (c) at minimum, notify the account's owner (in-app or a WhatsApp message you send manually) whenever a password is reset, so a takeover doesn't go unnoticed.
2. **Turn off "Confirm email"** in the Supabase dashboard (Authentication → Providers → Email) — required for phone signups to complete at all. One click, not yet confirmed done.
3. **Confirm point-in-time backups are enabled** (item 8) — Supabase dashboard, Database → Backups. One click, not yet done. Without this, a bad migration or an accidental delete has no safety net.
4. **Revisit `record_correction`'s lack of confirmation** (item 2, the one part still open) — low risk (it's a count correction, not a sale or a void) but cheap to close for consistency with write-off and void.

### B. Reliability & data integrity — the "does it just work" category
5. **Extend the automated tests past SQL.** The 18 tests in `tests/` cover the money/stock-critical database functions, which is where a silent bug would be most expensive — but nothing yet tests `app.js` itself (rendering, the cart flow, offline queuing) or runs in CI automatically. A lightweight next step: a GitHub Action that runs `node tests/run_tests.js` against a throwaway Postgres service container on every push, so a bad schema change can't reach `main` unnoticed.
6. **Battle-test the offline/PWA behavior deliberately.** The service worker and offline-first design are already there (see section 4), but they've been read, not stress-tested: what actually happens on a real phone with real network drops mid-sale, a slow 3G connection at a rural pharmacy, or the app being force-closed mid-transaction. Worth a dedicated round of hands-on testing rather than trusting the code alone.
7. **Cross-device/cross-browser pass.** Verified so far mainly on desktop Chrome via the review's own screenshots. Kenyan pharmacy staff will mostly be on Android phones (Chrome) and possibly older/cheaper devices — worth checking real performance and layout there, plus a quick Safari/iOS check if any pharmacy staff use iPhones.
8. **Load a real-sized dataset and check performance.** Everything's been tested with a handful of drugs/batches. Before a pharmacy with hundreds of SKUs and years of sales history goes live, confirm inventory search, reports, and Excel export all stay fast at that scale.

### C. Compliance & business-readiness
9. **eTIMS (KRA e-invoicing) integration** (item 9) — not urgent today, but a real deadline for VAT-registered pharmacies. The schema already has the fields to support it without a rebuild; the integration work itself hasn't started.
10. **Swahili** (item 6) — the toggle is off and the app is English-only for now (done). Finishing the full translation and bringing the toggle back is still open whenever there's appetite for it.

### D. Code health — lower urgency, pays off as the app grows
11. **Refactor the single-file `app.js`** (item 4, 1,700+ lines and growing) into modules once it gets noticeably bigger or a second developer joins — not broken today, just a maintenance cost that compounds.
12. **A staff-facing "who changed what" audit trail** for corrections/voids/write-offs beyond what's already logged, if pharmacy owners start asking "who did this" — not requested yet, flagging as a natural next ask once there's more than one staff account in real use.

### Suggested next session's focus
Given what's already shipped, the highest-value next round is **A.1–A.3** (rate-limit the reset function, flip the two Supabase dashboard settings, confirm backups) — all cheap, all closing real exposure, none requiring new feature work. After that, B.6–B.7 (real-device testing) is what actually earns the "reliable like Shule Web" label, since that's determined by what happens on a pharmacy counter's actual phone, not by code review alone.

**Reminder for whoever picks this up:** after any further code change, the delivery workflow is: edit in the Claude sandbox → verify (`node --check`, real headless-browser render, screenshot) → `SendUserFile` → `device_commit_files` into `C:\Users\user\Downloads\Pharma` → tell the user the exact `git add`/`commit`/`push` commands to run themselves (Claude never runs git for them). Netlify auto-deploys on every push to `main` — no separate deploy step needed once pushed. Edge Functions deploy separately, straight to Supabase (not through git/Netlify) — see `mcp__Supabase__deploy_edge_function` or the Supabase CLI (`supabase functions deploy <name>`).
