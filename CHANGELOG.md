# Changelog

Newest first. The detailed story for each item is in `PHARMA_PROJECT_STATUS.md`.

## 2026-11-10: View cart before payment, and the mouse wheel no longer changes number boxes

- The blue bar at the bottom of Sell now says **View cart →** and opens a **Cart** pop-up: every drug with − / + buttons, a typed quantity, its line total and a red **Remove** button, then the Total, **Hold sale** and **Continue to payment →**. Before this, the bar went straight to the payment screen, so a seller could not see the drugs while paying or take one out (the cart itself was always on the Sell screen, but above the stock list, where it was easy to miss). Approved from a sketch built from the real styles.
- The payment pop-up is now titled **Payment — KES …** (the word Checkout is gone) and has a **← Back to cart · 3 drugs · 6 items** link at the top. If stock ran short while paying, the message's button also goes back to the cart. Nothing about how a sale is priced, paid or saved changed (`quote_sale` / `record_sale` untouched, no database change).
- **Remove** also appears on each line of the cart card on the Sell screen, whose button now reads "Continue to payment →". Holding a sale closes the pop-up; removing the last drug closes it too.
- **Balance** only shows when the payment is split or the amount is short. With a single payment for the whole bill it was always 0 and just confused people.
- **Mouse wheel bug:** scrolling the wheel over a number box that had the cursor in it nudged the value (a 49.95 appeared in an Amount box). Every number box in the app now lets go of focus when the wheel turns over it, so the value stays as typed and the page scrolls normally (`WHEEL-GUARD` block at the end of `js/core.js`). Typing and arrow keys still work.
- Cache bumped to `hodhi-shell-v4m`.
- Test: `tests/view-cart.test.js` (shown failing first; runs the Remove and wheel code for real). Whole chain passes except `android-shell.test.js`, which could not run on the working copy (Android files not staged; none were touched). NOT checked on a real phone or the Android app.

## 2026-11-09 (midnight): Accept the Terms when creating an account

- **Create account** and **Staff join** now show an unticked box, "I agree to the Terms of Service and Privacy Policy" (both words link to the new pages, opening in a new tab so nothing typed is lost). Without the tick, no text code is sent and the screen says "Please tick the box to accept the Terms of Service and Privacy Policy." **Log in** has no box, only a small line under the button: "By signing in you accept our Terms and Privacy Policy." Approved from a sketch built from the real sign-in styles; box and line are black text with green links, the box is 20px (tap size), phone layout otherwise unchanged (`termsAgreeHtml()` in `js/auth.js`, `.agree` / `.agree-note` in `style.css`).
- The tick is checked in the browser only; the acceptance is not saved in the database (no date/time record per account). Saving it would need a small database change and is not done.
- Cache bumped to `hodhi-shell-v4l`.
- Test: `tests/accept-terms.test.js` (shown failing first).

## 2026-11-09 (late night): Terms, Privacy, Cookie Policy, Features, Pricing and a Blog

- Added nine new public pages, all plain static HTML outside the app shell: `terms.html`, `privacy.html`, `cookies.html`, `features.html`, `pricing.html`, `blog.html` and three starter posts (`blog-stock-batch-expiry.html`, `blog-mpesa-credit-sales.html`, `blog-stock-take.html`).
- The legal pages are attributed to **Flovo Digital** (the company behind Pharma), with its real contact details (`info@flovodigital.com`, `+254 705 041 512`). As instructed: no business registration number and no physical/office address anywhere.
- Terms of Service is written at the same depth as Shule Web's (27 numbered clauses plus a data-processing Schedule with three annexes), but every fact in it is real to Pharma: the SMS Wallet (top up by M-Pesa, refill/credit/custom/evening-summary SMS, auto-refund on a failed send), that Pharma records sales but is not a bank, that insurance-claim tracking is not insurance, that controlled-drug records do not replace Pharmacy and Poisons Board duties, and the real roles. Liability cap, indemnity, disclaimers and suspension rights protect Flovo Digital. Governing law is Kenya, with Nairobi mediation before court.
- Pricing says what is real (free for 3 months) and invents no figures afterwards: it asks people to WhatsApp or email for a quotation.
- Cookie Policy lists exactly what the app stores (sign-in session, profile/dashboard caches, install-prompt timing, offline app files), checked against the code. There is no advertising or tracking.
- `robots.txt` explicitly allows the nine pages; `sitemap.xml` lists them.
- Deliberately did not touch the sign-in screen (`js/auth.js`, `index.html` markup): the phone design is not to be changed. The new pages link back to `index.html` for sign-in.
- No `sw.js` cache bump: none of the new pages are in the offline-shell precache list.
- Test: `tests/marketing-pages.test.js`; `tests/banned-colours.test.js` now also scans the new pages.

## 2026-11-10 (night): Search result info for Google

- Added a `SoftwareApplication` block (JSON-LD) to `index.html` so Google can show Pharma's category and free-trial price in search results, not just the title and description. Nothing visible on the page changed. Cache bumped to `hodhi-shell-v4k`.
- Test: `tests/seo-schema.test.js`.
- `robots.txt`, `sitemap.xml`, title, meta description, canonical link and Open Graph tags were already in place and correct; this was the one gap. Submitted to Google Search Console (domain verified by DNS TXT record).

## 2026-11-09 (night): The platform admin is hidden from a pharmacy's Staff list

- Settings > Staff in Goodlife listed "Pharma Admin, Co-owner (you)": the platform admin's own account. The admin lives in Demo Pharmacy and had Goodlife open for support; the database lets anyone read their own profile row, so it came up in the other pharmacy's list. Support and admin accounts must not show in any pharmacy. A new read-only database function `hidden_staff_ids()` names the platform admins among the people the caller can see (their pharmacy plus their own row) and the Staff list drops them. If the database cannot answer, the list shows as before and Settings still opens. Nothing about how the admin signs in or works changed.
- Database file: `migrations/2026-11-09_hide_platform_admin_from_staff.sql` (rollback beside it, folded into `schema.sql`). Run it on the project; deploy order does not matter, until it is run the admin is simply still listed. Cache `hodhi-shell-v4j`.
- Test: `tests/hidden-admin.test.js` (shown failing before the change).

## 2026-11-09 (evening): Whole-app screen check on phone, tablet and desktop

- Went through 57 screens (every report, every pop-up and form, checkout with and without a discount and a split payment, login, sign-up, join, the menu, settings and staff permissions) at phone 360 and 393 px, tablet portrait 768x1024 and landscape 1024x768, and a 1366x768 desktop. No sideways scrolling, nothing off screen, no errors, no grey text, nothing blank.
- **Fixed:** the claim-status dropdown in the Insurance Claims table was 21px tall; it is now at least 36px. "Forgot password?" on the login screen had a 15px tap area; the tap area is now bigger without moving anything (the screen is pixel-identical). Long drug names in the "full list" pop-ups (top sellers, expiring, out of stock) were cut off with "..."; they now wrap.
- **Left as it is, on purpose:** the permission tick boxes are 20px but the whole row is the tap area. The small labels on the phone dashboard tiles (10px) and the bottom tab names (10.5px) are the approved phone design. Coloured badges (Rx, expiry, Low) stay on phone list rows; only the shared report tables use plain coloured text.
- Cache bumped to `hodhi-shell-v4i`. Not checked: a real phone, a real tablet, a real thermal printer. Screens were run with a browser emulator and made-up shop data, so empty-sale item lists in that test are not a bug.

## 2026-11-09 (afternoon, last): Phone, tablet and printed receipt check

- Checked the new screens (cart quantity box, checkout with and without a discount, a rejected discount, split payment, receipt, reversed-sale detail) at 360, 375 and 393 px wide phones and 768 and 1024 px tablets with touch emulation: no sideways scrolling and nothing outside the screen.
- **Touch size:** on a touch screen the cart - / + buttons and the quantity box are now 40px (they were 28px).
- **Printed receipt (80mm):** the Discount line and the payment lines printed larger than the items, and a payment amount could wrap under its label ("KES" on one line, "1,500" on the next). They now match the items, and an amount never wraps.
- Cache bumped to `hodhi-shell-v4h`. Not checked: a real phone and a real thermal printer.

## 2026-11-09 (afternoon, later): Discount is whole shillings only

- The Discount box takes whole numbers only (10 is fine, 10.5 is refused with "whole shillings, less than KES <bill>" and Confirm stays off). The bill itself can still have cents; only the discount cannot.
- Database: migration `2026-11-09_sale_discount_whole.sql` (with a rollback file) adds `sales_discount_whole`, so a call that skips the app cannot record cents either. Not applied live when this was written.
- `tests/sale-discount.test.js` extended (5 checks shown failing first).

## 2026-11-09 (afternoon): Checkout layout fix, typed quantity in the cart

- **Checkout pop-up had no side margins** (everything ran edge to edge). Checkout renames its pop-up body to `checkoutBody`, so the app's `#sheetBody` padding rule never applied; the rule now names `#checkoutBody` too. This was there before the discount work.
- **The Discount box moved** to just under the payment lines and above "Split into another payment method", with a faint 0, so it no longer reads as a required first step.
- **Type a quantity in the cart.** Each cart line has a box between - and +: type 20 once instead of tapping + twenty times. 0 removes the line; more than the shelf holds is cut back to the stock with a message; text or a negative number changes nothing.
- **M-Pesa reference is optional** (it already was; now pinned by a test). Totals, discount, split lines and balance were checked end to end in a browser: 20 x 18.50 = 370, 20 off = 350, 0.10 off = 369.90, a 200 + 150 split balances to 0, and the sale is sent with the discount and the two payments adding to 350.
- Cache bumped to `hodhi-shell-v4g`. `tests/sale-discount.test.js` extended (5 new checks shown failing first).

## 2026-11-09 (later): Discount on the whole bill, and reversing a sale

- **Discount at checkout.** One box, "Discount (KES)", typed in shillings (not a percentage), taken off the whole bill and never off a single drug. No cap, no reason, no permission switch: every role can use it, including owners who sell on their own account. It must stay below the bill (it can never take a sale to zero or below). The payment line follows the new total.
- **Checkout now starts on M-Pesa** (was Cash); the seller can change it, and a split line also starts on M-Pesa.
- **Nothing is edited after a sale.** A sale with a mistake is reversed (the old "Void entire sale" is now "Reverse sale", the same word as Customers and Expenses). The owner and pharmacists can reverse any sale; any other member of staff can reverse the sale they made themselves, today. The sale detail shows "Reversed by <name> · date time · reason", the Sales Report Excel has Discount, Reversed and Reversed by columns.
- **Receipt** (screen and 80mm print) shows a Discount line above the Total. The sale detail shows Bill, Discount and Total.
- **Money stays right with no other change:** `sales.total_amount` is the amount charged, so takings, the dashboard, profit and the evening summary already use it. Returns refund the discounted share of a line. Top sellers are unchanged (they add up line totals, so on discounted sales their money is a little above takings).
- **Database (migration `2026-11-09_sale_discount.sql`, with a rollback file):** `sales.discount_amount`, `sales.voided_by`; `record_sale` gets an optional `p_discount` (the old 6-argument version is dropped so the name is not ambiguous; the previous app version still works); `record_return`, `void_sale` and `sales_report_page` updated. Tried against the live database inside a call that always rolls back (11 checks, nothing saved).
- New `tests/sale-discount.test.js` (in `npm test`; shown failing on the old code first). Cache bumped to `hodhi-shell-v4f`.
- Not checked: a real phone, a real thermal print, and a credit or insurance sale being reversed by a seller (those pay-later records are not touched by a reversal, same as when a pharmacist reverses one).

## 2026-11-09: Per-staff permissions and the Seller dashboard

- **Each member of staff has their own permissions.** Settings -> Staff -> Permissions (and the admin portal, for any pharmacy) shows the person's switches: profit and margin, stock value, debt the shop owes, whole-shop sales and graph, top sellers, customer credit, Stock Valuation report, Sales Report, cost prices on Inventory, Excel and Print, and the controlled drugs register (no access / view only / view and record). Presets: Sales and stock only; Everything except profit, margin and stock value; Everything, like the owner; Custom. Every save is logged (who, when, before, after); the last save wins. Owner and co-owner are never limited.
- **Defaults.** A new Seller starts on "Sales and stock only". Everyone who exists today keeps seeing what they saw (nothing saved = everything).
- **Seller dashboard** (for anyone who may not see whole-shop sales): alerts, Sell and Close cash drawer, the stock check box, My sales today (their own sales only), Out of stock and Low stock by name, top sellers by units with Today / 7 Days / Month, Expiring soon. No profit, margin, stock value, debt or whole-shop graph.
- **Hidden behind the switches:** the Stock Valuation menu entry and report, the Sales Report tile, the Inventory Stock value column and the cost columns in Excel and Print, Excel and Print buttons on every report. The saved dashboard on a phone is now kept per person.
- **Database enforcement (migration `2026-11-09_staff_access.sql`, with a rollback file):** `dashboard_data` and `dashboard_data_custom` drop the figures a person may not see (the old bodies are `*_raw`, closed to the browser), `dashboard_extras`, `supplier_owed_summary` and `v_drug_stock` blank theirs, `my_sales_today()` is new, and `profiles.access` can only be changed through `set_staff_access` / `admin_set_staff_access`. Limit: row level security is per pharmacy, so a technical Seller calling the API directly could still read cost prices and sales tables; this closes the screens, downloads and the functions the app uses.
- New `js/staff-access.js` (shared by the app and the admin portal). New `tests/staff-access.test.js` (in `npm test`; shown failing on the old code, and again after breaking the rule on purpose). `tests/dash-tile-links.test.js` and `tests/report-tables.test.js` updated for the new tile and Inventory column code. Cache `hodhi-shell-v4e`.

## 2026-11-08 (night): Reports and lists share one table; stock take review fixed

- **One table for every report and list.** Filter tiles or a date-range bar on top, a table showing 10 rows at a time with Prev / Next and "Showing 1-10 of N", status as plain coloured text (red, amber, green or black, no badge background), numbers right-aligned, Excel and Print in the heading. On a phone each row becomes a small card. Built once in `js/export.js` (`rtTable`, `pageSlice`, `pagerHtml`, `rangeBarHtml`, `stCell`) and used by: Sales report, Expiry Dates report, Stock Valuation, Low Stock, Insurance Claims, Cash drawer closings, Expenses, the Suppliers list and statement, the Customers list, statement and refills, the controlled drugs register and ledger, past stock takes and their differences, the reorder list and the no-expiry-date list.
- **Date filters.** Sales gets a custom From-To next to Today / This week / This month (the database end date is the day after "To", so the whole last day counts). Insurance Claims gets a date range plus a status filter. Cash closings and Expenses get a date range (closings now load every closing in the range, not just the latest 30). Expiry gets "expiring from - to".
- **Expiry Dates report is one screen:** five tiles (All needing attention, Expired, Expiring in 30 days, Expiring in 90 days, Unknown expiry), the date window, and the table. Saving a date for a batch with no expiry now keeps it in the list with its real date.
- **Printed reports are plain black and white.** The pharmacy's name and one contact line, the report title, a Printed / summary line, then the table (thin black lines, closed with a line on the left and right edges). No page border, band, badge, colours or striped rows, so it prints cleanly on any printer. Every row stays on one line (no wrapping), the heading repeats on each page, and a money column prints plain numbers with the currency once in the heading ("Value (cost, KES)") instead of "KES" splitting above the number. A column that mixes money and words is left alone. Status words print bold black. Receipts keep their 80mm till-roll layout. Excel is unchanged. This replaces the green letterhead band, gold rule, ribbon and frame from earlier tonight.
- **Stock take:** tapping "Review & approve" straight after typing the last count opened a review that said "Nothing has been counted yet", because that count was still being saved. The review now says "Please wait... saving your last counts" and then shows the real result.
- **Gray text:** the no-gray test now also catches dark near-grays (it found `#4A4139` in the sign-in screen, now `#000`). Rule: a gray font becomes `#000`.
- New tests `tests/report-tables.test.js` and `tests/stocktake-review-wait.test.js` (both in `npm test`, both shown failing first). `tests/cash-drawer.test.js` and `tests/supplier-returns.test.js` updated for the new tables.
- **Inventory is now the same table.** Five boxes on top (All drugs, Low stock, Out of stock, Expiring in 90 days or the pharmacy's own window, Unknown expiry; tap one to filter), then search with barcode, the tool buttons (Count / edit in Excel, Stock take, Import, Sync common drugs, Controlled, Reorder list, No-expiry list), then a table of Drug / In stock / Reorder at / Stock value / Soonest expiry / Status, 10 a page. Tapping a row opens the drug. Status and expiry notes are plain coloured text. This table shows from 760px wide up; **the phone keeps the exact list it had** (search, Add drug, button grid, the reorder and no-expiry notices, one row per drug with Out / Low / OK, Load more), so nothing changed on a phone except that the letter circle before each drug name is gone. Excel and Print carry every drug in the picked box that matches the search (the print heading names the box). On desktop the old "needs reordering" and "no expiry date" links became the Low stock and Unknown expiry boxes, and the two lists stay one tap away as buttons.
- **Search row fix (Inventory and Sell, phone and desktop).** The scan-barcode button was as wide as the whole row and squashed the search box to a sliver, and showed only a camera icon. It now reads "Scan barcode" and is only as wide as its label; the search box takes the rest of the row (placeholder shortened to "Search drugs..." / "Search a drug..." so it fits). New `.scan-btn` class in `style.css`, checks in `tests/report-tables.test.js` (shown failing first).
- **Expiry Dates: the full list.** A sixth tile, "All batches", lists every batch in stock whatever its date (the old report did; "All needing attention" only shows expired, the next 90 days and no-date batches). Its Print and Excel carry the whole list, with "Later · 150d left" for far-off batches.
- **Printed tables are a full grid:** a line round the table, between every row and between every column (the first black-and-white version only had lines under the rows).
- **Numbered page buttons** on every table: Prev, 1 2 3 ... Next on a desktop (first, last and the pages around the current one), and the old Prev / "Page 2 of 5" / Next on a phone (`pageNumbers()` and `pagerHtml()` in `js/export.js`).
- Cache bumped to `hodhi-shell-v4d`.
- Not changed: screens with inline editing (counting in a stock take, Sell) are still lists. Not checked: a real phone or a real print preview of the live screens (the table and print layout were checked with screenshots and a PDF of sample data).

## 2026-11-08 (evening): Growth hardening, sender kept in step with live, engineering docs

- **Lists that would silently stop at 1,000 rows now page.** The database returns at most 1,000 rows per request, so a long list was cut off with no error. Fixed for: the items of a stock take (one row per drug, so a pharmacy with more than 1,000 drugs lost items from its count and from the saved take), a supplier's purchase orders, payments and returns (the whole history is shown on the supplier screen and used for its statement), and the common-drugs catalogue. All use `fetchAllRows()`.
- **Ordering from a supplier by WhatsApp** looked up each drug's last supplier with one request carrying every low-stock drug id, capped at 3,000 rows. It now sends the ids 100 at a time and reads each group newest-first, so the newest supplier is still the one chosen and a long reorder list no longer fails quietly.
- **Evening summary sender, version 3, now in the repository.** It had been deployed live but the repository still held version 2 (200 messages per call, no retry). `supabase/functions/send-queued-summaries/` now matches what runs: it empties the whole queue in rounds of 100 inside a time budget, compares the secret in constant time, and stops if a status update fails. It carries its own copy of the sending code so it deploys on its own; `tests/evening-summary.test.js` now checks that copy is word-for-word the same as `send-sms/sender.ts`.
- **Retry for unsent summaries.** `migrations/2026-11-08_summary_sender_retry.sql` (applied live earlier today, now recorded with `pg_net`, `nudge_summary_sender()` and the `pharma-summary-drain` job every 5 minutes between 18:00 and 19:59 Nairobi, plus its `ROLLBACK_if_needed.sql`). Folded into `schema.sql`.
- **New test `tests/rpc-contract.test.js`** (in `npm test`): fails if the browser code calls a database function or edge function that does not exist, or an edge function imports a file outside its own folder. Shown red once by renaming a call.
- **New docs:** `ARCHITECTURE.md`, `OPERATIONS.md` (daily and weekly checks, incident playbooks, capacity guide, open items), `MIGRATIONS.md` (rules, rollback convention, keeping repository and live project the same). `SETUP.md` rewritten: it still described the first day of the project.
- Cache bumped to `hodhi-shell-v4c`.
- Not changed, flagged in `OPERATIONS.md`: signed-in staff can still update some plain tables such as `drugs` directly; public sign-up and leaked-password protection settings need confirming in the Supabase dashboard; plan and backups need confirming.

## 2026-11-08 (later): Documentation corrected, offline leftovers identified

- `PRODUCT_SPEC.md` still promised an **offline-first PWA where "a sale can still be recorded during a network blip"**. That was built in Nov 2026 and then deliberately removed, because syncing sales later caused duplicate sales and stock counts that disagreed with the server. The spec now says so plainly, so nobody re-plans around it.
- The same file still listed SMS alerts as "deliberately not built". SMS has been live for a while (customer reminders, refill nudges, the evening summary, credit bought by M-Pesa at KES 1 each). Corrected; eTIMS, M-Pesa STK push and WhatsApp alerts remain genuinely unbuilt.
- `README.md` was missing nine test files from its run list; all are listed now.
- Three files from the abandoned offline work are still in the repo and are dead: `js/offline-sale.js`, `tests/offline-sale.test.js`, `migrations/2026-11-07_offline_selling.sql`. Nothing loads them, `index.html` and `sw.js` do not list them, and that migration was never applied to the live database. They are removed in this commit.
- Whole suite re-run against the repo itself rather than a working copy: every JS test green, 565 SQL checks pass.

## 2026-11-08: Custom domain, link previews, loading states, lifecycle test

- **Custom domain.** Everything now points at `pharmamanagement.site`. The old address was still hard-coded in nine places, two of them user-visible: the Android app's own config (so the installed app loaded the old domain) and the offline "retry" button in `www/error.html` and its Android copy.
- **Link previews and search.** `index.html` had no description, canonical, Open Graph or Twitter tags at all, so sharing the link showed a bare URL. Added, plus a new 1200x630 `icons/link-preview.png`. `robots.txt` and `sitemap.xml` now point at the real domain.
- **Loading states.** Inventory, Sell, Customers, Suppliers and Expenses showed the word "Loading..."; they now show placeholder rows shaped like the real list (`listSkeletonHtml()` in core.js), so nothing jumps when data arrives.
- **First-time guidance.** One line added to the bare empty states: insurance claims, cash closings, the controlled-drugs register and stock takes.
- **Full lifecycle test.** One pharmacy walked start to finish as the real signed-in role: sign up (90-day trial), add stock, sell, SMS wallet, trial expires, locked out of selling and restocking, admin activates, selling resumes with stock intact. 565 checks pass.
- Cache bumped to `hodhi-shell-v4b`.

## 2026-11-08: Pre-launch audit - security, performance, SEO

- **Security fix (cross-pharmacy leak).** `evening_summary_text()` could be called by any signed-in user with any pharmacy's id, and never checked it was their own. It returned that pharmacy's day: number of sales, total takings, whether the cash drawer balanced and by how much, and low/expiring stock counts. Nothing in the app called it directly, so the grant was removed - no screen changes. Applied to the live database. New test proves a second pharmacy is refused.
- **Checked and found sound (no change needed):** the trial/plan lockout really is enforced by the database, not only the browser - `my_pharmacy_id()` returns nothing once a plan has expired, so row-level security and every RPC that compares against it fail closed. Tests confirm a locked pharmacy cannot read its stock, cannot insert directly and cannot record a sale. The M-Pesa callback validates its secret in constant time and credits a wallet only once, for a purchase this site started. The public key in `config.js` is the publishable key, which is designed to be public; no secret key anywhere in the front end. The `demo_*` helpers and `cash_drawer_figures` are already closed to signed-in users.
- **Performance.** Five foreign keys had no index behind them (deletes and joins on those columns would scan the whole table as data grows); one index existed twice under two names. Fixed and applied live.
- **Shipped at last:** `robots.txt` and `sitemap.xml` existed in the project but had never been committed, so the live site was serving neither.
- 554 SQL checks pass (13 new), full JS suite green.

## 2026-11-07 (night, last): Square flat buttons and tags across the whole app

- Every button inside the app is now a flat, square-cornered, thin, uppercase bar with a solid background colour (the look the owner picked from a reference): black for normal and Excel/Print/back buttons, red for secondary and danger, green for counting, blue for bringing drugs in, lime for the big add button. Badges (OK / Low / Out and the rest) and the search box are square too. One shared block at the end of `style.css`, scoped to the signed-in app only, so the sign-in screens are untouched. Inventory's buttons were rearranged to match (Add drug on top, then Count / Stock Take, Import / Sync, then Controlled / Excel / Print). Cache bumped to `hodhi-shell-v4a`. Replaces the rounded tile layout from earlier tonight.

## 2026-11-07 (night, latest of all): Toolbar buttons across the app - fixed and restyled

- Inventory's action buttons are now a two-column grid of colour-coded tiles, each with a coloured icon badge: green for counting and Stock Take, blue for Import and Sync, red for Controlled, plain for Excel and Print. "+ Add drug" sits full-width above them. Cache bumped again to `hodhi-shell-v3z`.

- Fix: a row of grouped buttons (Inventory's Sync/Import/Stock Take/Controlled/Excel/Print, a supplier's New LPO/Record payment, a report's Excel/Print, and every other screen built the same way) was flattening every button inside it to the same plain style, no matter what colour it was supposed to be. On the Supplier screen this was worse than just dull — "+ New LPO" lost its black background's white text and became black text on a black background, unreadable. Fixed so a button that is meant to be black (primary) or red (secondary) keeps that colour wherever it sits.
- Improved: plain grouped buttons (no special colour) now look like individual rounded, shaded buttons with a little space and shadow around each one, instead of being squeezed into one shared thin-bordered box. At narrow phone widths a group now wraps into clean separate rows instead of two different buttons being crammed on top of each other inside one box.
- One shared style change (`style.css`) - every screen using this button pattern is fixed at once: Inventory, Sell, Reports, Suppliers, Customers, Expenses, Claims settings, Controlled drugs, Stock take. No screen-by-screen rewrite, so nothing else about how any button works has changed.
- Checked: the full existing test suite still passes, including the one that checks the app's black/red colour theme specifically. Checked by eye at phone-narrow, phone-normal and desktop widths with a throwaway copy of the real page before shipping.
- Cache bumped to `hodhi-shell-v3y` so returning phones pick up the new button styling.

## 2026-11-07 (night, even later still): Undo a stock sheet, and fix a batch's price

- New: an "Undo this upload" button right after applying an Excel stock sheet (and again from the Count or edit in Excel menu, as long as nothing newer has been applied since). Puts back a rename, reorder number or price change exactly as it was, but only the parts nothing else has touched again in the meantime — anything changed again since is left alone and the owner is told so, never silently overwritten. If the sheet opened a stock take that is still waiting for approval, undo cancels it; if it was already approved, real stock has already moved and that part is left as it is.
- New: an "Edit price" button on each batch (Inventory > a drug > its batches), owner/co-owner only, same reasoning as the existing "Edit expiry" — it changes money without changing the physical stock on the shelf. Fixes a wrongly-typed sell or cost price on that one batch directly, instead of voiding a sale, Correct count to zero, and receiving the drug again at the right price. Shows up in the drug's price history, marked "Batch fix".
- Database: new `migrations/2026-11-07_stock_sheet_undo_and_batch_price.sql` — `stock_sheet_uploads` table (before/after snapshot of every sheet applied), `apply_stock_sheet()` updated to save that snapshot and return an `upload_id`, new `undo_stock_sheet()` and `correct_batch_price()`. 32 new SQL checks (541 total). Built and tested here first, then applied to the live database with the owner's go-ahead.
- What I could not test here: this environment has no real mobile browser, so the two buttons have only been checked by reading the code and the database logic directly (541 SQL checks, all passing) — not tapped on a real phone.

## 2026-11-07 (night, later): Dashboard tiles tap through to detail

- New: the 4 dashboard tiles (Sales, Profit, Stock value, Debt owed) are now clickable/tappable, each landing on the detailed, printable/Excel-able screen that already covers it: Sales and Profit both open the Sales Report (profit is not broken out sale by sale anywhere yet, so this is the closest real detail there is); Stock value opens the Stock Valuation Report; Debt owed opens the Suppliers list. Nothing new to build for the detail screens themselves - they already existed, with Excel export and Print (the browser's own print dialog, where 'Save as PDF' is one of the destinations, same as every other report in the app). No database change.

## 2026-11-07 (night, latest): Everything applied live

- All 6 pending database migrations applied to the live project, in order: price history, cash drawer, supplier returns (enum + table), evening summary, barcode.
- Both Edge Functions deployed: send-sms (updated) and send-queued-summaries (new). CRON_SHARED_SECRET set in Edge Function secrets, matched by pharma_cron_shared_secret / pharma_cron_sender_url in the database Vault — the automatic nightly summary send is now fully wired up, not just built.
- Small hardening fix: the 3 new database functions from this round were missing the `search_path` lock every other function already has. Added it — no behaviour change, just closes a security-advisor warning.
- Full SQL test suite re-run against the exact schema now live: 509 passed, 0 failed.

## 2026-11-07 (night, later): 80mm receipt printing

- New: the sale receipt (the 'Print receipt' button after Checkout) now prints sized for an 80mm thermal till roll — narrow, one line per drug with its quantity and price underneath, dashed section rules instead of a wide table. It still prints through the browser's normal print dialog, so a pharmacy with an ordinary A4/letter printer is not broken by it; the 80mm size is only a hint the printer can still be changed, same as any other print job.
- Every other report (Inventory, Sales, Low Stock, supplier statements and so on) is unaffected — only the sale receipt uses the narrow layout.

## 2026-11-07 (night, later): Barcode scanning

- New: a drug can have a barcode. Scanning it on Sell or Inventory (camera, via a Scan button, or a USB barcode scanner, which types the number fast and presses Enter for you) finds the drug straight away instead of typing its name. Add/Edit drug gained an optional Barcode field with the same Scan button. Typing or scanning works everywhere; nothing is forced on a drug that has none.
- Camera scanning uses the phone's own browser feature (BarcodeDetector) — nothing new was downloaded or installed, and where a browser doesn't support it the Scan button simply does not appear (typing and USB scanners still work there).
- Two drugs in the same pharmacy cannot share a barcode — the same rule, and the same 'bring the hidden one back instead' message, that already applied to a drug's name.

## 2026-11-07 (night, later): The evening summary SMS

- New: Messages > Evening summary. A short SMS at the end of the day — today's sales, whether the cash drawer was closed, and what is low or expiring. Off for every pharmacy until the owner turns it on; each part (sales, cash drawer, stock) can be switched off on its own. Nothing is forced on anyone.
- The owner picks the phone number it goes to and can press 'Send a test now' to see it right away, the same way refill reminders already work.
- Once turned on, it also sends itself automatically each evening (about 18:30), through the database's own scheduler — no one needs to be in the app. It respects the same daily SMS limit and on/off switch as every other message, and sends at most one summary a day.
- Migration (applied live): pharmacies.evening_summary_enabled / evening_summary_phone / evening_summary_sections; evening_summary_text(), queue_evening_summary_now() and queue_evening_summaries(); a new scheduled job 'pharma-evening-summary'. A typed phone number that is not real is cleared instead of saved.
- New Edge Function send-queued-summaries, cron-triggered only (checked by a shared secret, not a login), reusing the same sending code as send-sms so a summary goes out exactly the way a person's own message does.
- What I could not test here: the automatic nightly send reaches outside the database (through pg_net and a shared secret that still need to be set up on the live project), so it cannot be rehearsed offline. Turn it on for one pharmacy first and check the message arrives before telling others. The message-building and queuing rules themselves are fully tested (26 SQL checks).

## 2026-11-07 (night, later): Ordering from a supplier by WhatsApp

- New button on the Low Stock report: Order by WhatsApp. Pick a supplier, tick the drugs (drugs last bought from that supplier are ticked first), check the quantities, and a WhatsApp chat opens with the order message already typed.
- Nothing is sent by the app and nothing is saved — it only opens WhatsApp with the message ready, the same way customer reminders already work. The person sends it themselves, from their own WhatsApp.
- A supplier with no usable phone number, or no drugs ticked, is told so instead of a broken link. The message can also be copied, for a supplier reached another way.
- Service worker cache bumped to hodhi-shell-v3r.

## 2026-11-07 (night, later): Returning stock to a supplier

- New button on every batch: Return to supplier. Pick the quantity, the credit (starts as quantity x cost, can be changed; a batch with no cost needs it typed) and a reason. Stock leaves the batch, the stock audit trail records it as 'Returned to supplier', and the credit lowers what the supplier is owed.
- The supplier statement shows the credit line, a Credit total, and a Credit column in Excel and Print. The Suppliers list and the dashboard 'Debt owed' follow. A supplier with no returns is worked out exactly as before.
- Controlled drugs returned to a supplier are on the controlled register as 'Returned to supplier'.
- Owner, co-owner and pharmacist only; accountants can read the records. New table supplier_returns (row-level security, indexed). Existing data is untouched.
- Not included: undoing a return. A wrong return is corrected by restocking and a note on the statement.
- Service worker cache bumped to hodhi-shell-v3q.

## 2026-11-07 (night, later): Closing the cash drawer

- New screen in Reports: Close the cash drawer. At the end of a shift the person counts the cash; the app works out what should be there (cash sales and cash customer payments, less cash refunds, cash expenses and cash supplier payments, plus the float left last time) and records the difference.
- A seller counts blind: the expected figure is hidden until the closing is saved. Owners, co-owners and pharmacists see the figures first. Owners, co-owners, pharmacists and accountants read the history. Stock takers have no cash drawer.
- A count that does not match needs a short reason. The refusal does not say short or over.
- New table cash_closings (row-level security, indexed by pharmacy). Two people closing together are queued, so a period is never counted twice. Existing data is untouched.
- Service worker cache bumped to hodhi-shell-v3p.

## 2026-11-07 (night, later): price history

- Drug screen: new Price history list (old price to new price, when, who, and whether it came from a restock or an Excel sheet), last 10 changes.
- Database: `migrations/2026-11-07_price_history.sql` (folded into schema.sql): a trigger on drugs records every change of the selling price into `price_changes`, from any path (restock, sheet, edit). A first price is not a change. The stock sheet no longer writes its own record (no double entries). No existing row is edited.

## 2026-11-07 (night, last++++++++): strict Excel, and the stock sheet

- **Import is now all-or-nothing.** Every row is checked before anything is saved: drug name, unit, whole-number qty, sell price above 0, cost not above sell, a real expiry in the future (12.2027, 31/12/2027 or UNKNOWN), a known form and category, no duplicate rows. If any row is wrong nothing is imported and the pharmacy sees every row to fix (Excel row number and the reason). The database repeats the check without saving (dry run), and the real import undoes the whole block on any failure. Rows are no longer skipped quietly, a missing price no longer imports at 0, a missing expiry no longer imports as unknown (write UNKNOWN on purpose).
- **Blank template** has the headers only (the old one had a sample drug that could be imported by mistake) plus a "How to fill" sheet.
- **Count or edit in Excel** (Inventory): download a stock sheet of every drug, fill it, upload it. Counted quantities go into a stock take for the owner to approve (stock does not change until then). Names, units, reorder numbers and selling prices change when applied. A price change also updates the stock on the shelf, past sales keep their price, and each change is recorded in `price_changes`. Any wrong row refuses the whole sheet. Stock takers can upload counts only.
- Database: `migrations/2026-11-07_excel_sheets.sql` (folded into schema.sql): `import_stock_rows` gains optional `p_dry_run` / `p_strict` (older app versions still work), new table `price_changes` (row-level security, indexed), new `apply_stock_sheet`. Cache `hodhi-shell-v3n`.

## 2026-11-07 (night, last+++++++): days-of-stock-left alert

- Settings > Alert thresholds: new box "Warn me when a drug will last fewer than (days)". Empty = off, and it is off for every pharmacy until the owner types a number, so nothing changes for anyone today.
- When on, each drug's warning number is worked out from its sales in the last 30 days (voided sales and returns taken off). A drug with its own number (typed in Edit details) always keeps it. A drug with no sales yet keeps its stored number.
- Edit details: the reorder box becomes "Warn me at (optional)"; empty = use the days alert. Stock list shows "~N days left" under each drug (or "Warns at N (own number)").
- Database: `migrations/2026-11-07_days_left_alert.sql` (folded into schema.sql). `v_drug_stock.reorder_level` is now the number in force, so low stock, the reorder list and the dashboard follow with no other change. New: `pharmacies.low_stock_days`, `drugs.reorder_custom`, view columns `reorder_own`, `daily_rate`, `days_left`; `edit_drug` takes an optional `p_reorder_custom`. Existing drugs whose number differs from the pharmacy default are marked as having their own number. Cache `hodhi-shell-v3m`.

## 2026-11-07 (night, last++++++): Kiswahili note removed

- Settings > Account: the "Language: English (Kiswahili is coming soon...)" line is gone. Nothing else changed. Cache `hodhi-shell-v3l`.

## 2026-11-07 (night, last+++++): red out-of-stock strip

- Dashboard: the "N out of stock" strip text is now plain red instead of brown. Colour only. Service worker cache bumped to v3k.

## 2026-11-07 (night, last++++): space under the heart line

- Phone sign-in: the logo and everything under it sit 16px lower, so the heartbeat line no longer touches the logo. Checked at six phone sizes with the install bar showing: everything still fits without cutting off the bottom. Cache `hodhi-shell-v3j`.

## 2026-11-07 (night, last+++): install bar no longer covers the sign-in on phones

- On a phone the "Install Pharma app" bar at the top sat on top of the sign-in page and hid the heart line and the top of the green header. The page now moves down by the bar's height (as it already did on computers) and the log-in screen gets that much shorter, so nothing is hidden and the bottom is not cut off. When the bar goes, the page goes back up.
- Also fixed a stray closing tag I had left in the sign-in hero code. New checks in `tests/auth-desktop.test.js` (balanced tags) and `tests/install.test.js`. Service worker cache is now `hodhi-shell-v3i`.

## 2026-11-07 (night, last++): desktop sign-in feature card

- On a computer, the four icon tiles on the app sign-in (Batch tracking, Expiry alerts, Daily reports, Printed receipts) are replaced by a cream card with dotted lines, copied from the eatery app's "Today's menu" card; the tagline is a green italic line and a green stripe divides the two halves. **Phones and tablets under 860px are unchanged** (checked pixel for pixel at five sizes). The admin console sign-in is unchanged. Service worker cache is now `hodhi-shell-v3h`. `tests/auth-desktop.test.js` updated.

## 2026-11-07 (night, last+): admin opens any pharmacy directly

- Like "Login as School" in Shule Web, but with no password, no code and no email link: on a pharmacy's page the admin taps **Open this pharmacy** and works inside it as a co-owner (view and fix), with a "Leave" banner to come back. Shule Web signs in as the school's own admin through a server function; Pharma does not need one because its pharmacy data is already filtered by one database rule, so the admin simply acts as that pharmacy.
- **Get support stays** as built (owner grants 1 to 24 hours, can stop, sees history). It is now a courtesy, not a requirement. When the owner did grant it, the owner's history shows each open; a direct open is logged for the admin but not shown to the owner.
- A direct session closes by itself after 8 hours. Only the platform admin can open a pharmacy; owners and staff cannot.
- `migrations/2026-11-07_admin_direct_access.sql` (folded into `schema.sql`): `admin_open_support` no longer needs a grant, `my_pharmacy_id/my_role/my_subscription/support_context` accept the admin's open session, and `support_access_events` can log a direct open. No data changed. SQL tests: 378 pass; `tests/support-profile.test.js` extended.

## 2026-11-07 (night, last): Profile button and Get support

- The top-bar "Log out" is now a **Profile** button (person icon). It opens: change password (asks for the current one), **Get support**, and Sign out.
- **Get support:** the owner or a co-owner reads "Pharma admin will get access to your pharmacy", picks 1, 2, 4, 8 or 24 hours and grants access. They can stop it any time and see past grants. The admin opens that pharmacy from the pharmacy page ("Open this pharmacy (support view)"), can view and fix, and sees a banner with "Leave". Access ends by itself when the time is up. A grant opens only the pharmacy that gave it.
- Database (applied to the live project, nothing deleted): new `support_access`, `support_session`, `support_access_events` (closed to the public API), 7 new functions, and `my_pharmacy_id()`, `my_role()`, `my_subscription()` gained one admin-only first step; everyone else behaves exactly as before. Admin account got a home profile "Pharma Admin" (co-owner) in Demo Pharmacy. `migrations/2026-11-07_support_access.sql`, folded into `schema.sql`.
- The Get support notice now uses Kodi's warm light background (not the peach one), and inside the app the font is Kodi's (Inter first, then the phone's own font; headings slightly lighter and tighter). Sign-in pages untouched.
- Pop-ups (forms and confirm boxes) copy the Kodi style: white card with a header band and divider, light square close button, bold labels, 12px boxes, green save button, solid red for destructive actions like Reverse, blurred backdrop. Inside the app only. Cache bumped to `hodhi-shell-v3g`.
- New `tests/support-profile.test.js`; SQL tests: 367 pass. Service worker cache is now `hodhi-shell-v3g`.

## 2026-11-07 (night, later): less green inside the app

- White page background; black top bar on phone and desktop with green menu button and Log out, and no "P" badge before the pharmacy name.
- Phone bottom bar: Kodi's soft blue, plain emoji with no tiles, and six tabs (Customers added).
- Black Sell-style buttons, red Restock-style buttons, black checkout bar. Darker background and 12px corners on the date filter and the "Check if a drug is in stock" box.
- Desktop left menu stays green and no longer shows the user's name.
- Sign-in screens, tiles, graphs, badges and the other greens are unchanged. Service worker cache is now `hodhi-shell-v3e`. New `tests/app-theme.test.js`.

## 2026-11-07 (night): admin console redesign

- **Sign-in:** the admin console now looks like the pharmacy app's sign-in and uses an email and password (not a phone number), with a show/hide eye on every password box.
- **Password reset:** "Forgot password?" emails a reset link; the link opens a "Choose a new password" screen. The Account page changes the password after checking the current one.
- **Side menu:** Overview, Pharmacies, Billing and Account in a left menu on a desktop and a bottom bar on a phone. Overview adds "Needs your attention" and "Newest pharmacies". Billing lists every plan, soonest to end first, with one-tap "+30 days" and "Mark paid / Renew". The pharmacy page is unchanged apart from its back link.
- **One admin:** `migrations/2026-11-07_single_admin.sql` keeps `kinyuadavid2003@gmail.com` as the only platform admin and adds a unique index so a second one is refused (folded into `schema.sql`; applied to the live project on 7 Nov 2026 after the owner confirmed the new login works - the old admin row was removed, its pharmacy login and data were left alone). New account added live; no data deleted.
- New `tests/admin-shell.test.js`; SQL tests: 331 pass. Admin pages are not in the service-worker cache, so no cache bump.

## 2026-11-07 (later): login boxes

- Password boxes no longer auto-capitalise or auto-correct, so showing the password with the eye cannot turn "abc" into "Abc" and cause a false "incorrect". Service worker cache is now `hodhi-shell-v3d`. New `tests/login-inputs.test.js`.
- Checked the slow login: the database answers in 3 to 12 ms; the wait is the network to the Frankfurt server and about 1 s for Supabase to sign in.

## 2026-11-07 (late): Sales graph line is dark navy

- The line on the Dashboard Sales graph was green on a green card and hard to see. It is now dark navy (`#14367A`); the card, tiles and chip stay green. Service worker cache is now `hodhi-shell-v3c`. New `tests/dashboard-chart.test.js`.

## 2026-11-07 (evening): self-running demo pharmacy

- **Demo account:** "Demo Pharmacy" (login 0700000000) now has 39 drugs, 12 customers and 3 months of sales, payments, restocks and expenses, and its plan runs to 31 Dec 2027.
- **Stays busy by itself:** an hourly database job (08:05 to 20:05 Nairobi) posts 3 to 10 sales a day, KES 2,000 to 8,000 in total, restocks anything that runs low, collects on-account payments and posts small expenses. Roughly 60 small rows a day.
- **Safe:** works on the one pharmacy listed in the new `demo_config` table and nothing else; not callable from the app or API; demo customers are never texted.
- **Every stock state is always visible:** 3 drugs out of stock, 4 low, 3+ expired batches, 2+ expiring within 30 days and 5+ within 90, the rest healthy. Refreshed daily by the same job; old expired stock is written off after 60 days and replaced.
- Migrations `2026-11-07_demo_account.sql` and `2026-11-07_demo_showcase.sql` (applied live, folded into `schema.sql`). SQL tests: 329 pass. No app files changed.

## 2026-11-07: senior review (security, speed, scale, comments)

- **Security:** an owner could give their pharmacy free subscription months by editing the plan fields directly. Those fields (plan end date, status, invoice numbers, SMS settings) can now only be changed by Pharma support. Staff invite codes are longer (10 random characters).
- **SMS sign-in codes:** guess limits can no longer be beaten by sending many tries at the same instant; added per-address and platform-wide hourly limits on code SMS; no code is sent to a number that cannot use it. Password reset no longer downloads every user. (Edge functions `send-otp`, `verify-otp`, `reset-password-by-phone` must be deployed.)
- **Speed:** the stock view is 3-4x faster on big data; duplicate indexes removed.
- **Long lists:** stock, sell, inventory, customers, refills, expiry, expenses and report lists no longer stop at 1000 rows. New `tests/paging.test.js`.
- **Comments:** code comments rewritten short and plain across the project; no code changed.
- Migration `2026-11-07_senior_review_fixes.sql`. Service worker cache is now `hodhi-shell-v3b`.

## 2026-10-31 (morning): no browser pop-ups, and an open app updates itself

- **Reported:** a pharmacy phone showed the browser's own box "pharmacymngt.netlify.app says: Label for this held sale (optional)…". That box was replaced on 29 Oct by an in-app pop-up ("Hold this sale"); the phone was still running an old copy of the app that had stayed open and never reloaded. The live site has no browser pop-up anywhere.
- **Fixed for good:** the app now reloads itself when a new version has been downloaded, at a safe moment only (cart empty, no pop-up or sheet open, nobody typing), and checks for a new version each time you return to the app. New test `tests/no-native-dialogs.test.js` (added to `npm test`) fails if any file ever uses `alert()`, `confirm()` or `prompt()`.
- **On a phone still showing the old box:** close Pharma completely (swipe it away from recent apps) and open it again, once.

## 2026-10-31 (night): desktop sign-in left panel restored

- **Fixed:** on a computer the sign-in's green left panel was empty. When the desktop menu was saved, an older copy of `style.css` replaced a newer one and wiped the "AUTH, desktop" styles. They are back (split screen: green hero with the cross mark, "Pharma", "Know your stock", four glass chips on the left; label card on the right).
- **Also put back from the newer version:** the Stock Valuation one-line rows; `tests/banned-colours.test.js` (scans every file in `js/`, now also `install.js`); the earlier changelog and status entries that the same save had dropped.
- **Kept:** the Kodi-style docked desktop menu and the install bar. The scrolling sidebar with the Profile button (night entry below) is replaced by that menu, so `tests/sidebar.test.js` now checks the docked menu instead.
- Service worker cache is now `hodhi-shell-v3a`.

## 2026-10-31 (evening): install bar on computers

- **Computers:** the "Install Pharma app on this computer [Install]" bar now also shows on the sign-in pages in Chrome, Edge, Brave and Opera, and in Safari 17+ on a Mac. There is **no popup on a computer**, so nothing covers the sign-in fields; the page is moved down by the height of the bar instead. The bar appears once the browser says Pharma can be installed, so it is not offered when Pharma is already installed. Tap it to open the browser's install box; the bar says "Installing… this can take a minute. Keep this tab open." (and returns to "Install" after 30 seconds if nothing finishes), then "Pharma is installed. Open it from your desktop or Start menu." for 6 seconds. If you cancel the box and tap again, the bar says where to click (the install icon at the right end of the address bar, or the browser menu). Safari on a Mac says "File, then Add to Dock". Firefox on a computer cannot install apps, so nothing is shown there. Phones and tablets are unchanged. `sw.js` cache is `hodhi-shell-v2y`.

## 2026-10-31 (later): fixed "Install Pharma app" bar on the sign-in pages

- **Fixed bar:** a slim bar with a red line under it stays at the top of the sign-in, create-account and staff-login pages on phones and tablets: "Install Pharma app [Install]". It stays after "Not now" (that only hides the popup, for 3 days) and goes away once Pharma is installed. Tapping it installs in one tap on Android Chrome; on iPhone it shows the Share steps; where the browser has not offered install yet it shows the menu steps; inside WhatsApp or Facebook it offers Open in Chrome.
- **Install progress:** after you accept the browser's install box, the card says "Installing… keep this page open" and the bar says "Installing…", so it no longer looks stuck and repeat taps are ignored. If nothing finishes within 30 seconds, the card closes and the bar goes back to "Install" so one more tap tries again. When the phone reports the install finished, the card says "Pharma is installed".
- Changed `install.js`; `sw.js` cache is now `hodhi-shell-v2x`; `tests/install.test.js` checks the bar, the progress state and that the 3-day and phones-only rules are still there. Checked in a headless browser with Android, iPhone, WhatsApp, Firefox, desktop and installed-app user agents. Not testable here: the real install box and a real stalled install.

## 2026-10-31: security headers, and developer files no longer downloadable

- **Security headers (new `_headers`):** other sites can no longer put Pharma inside their own page (clickjacking), the page may only talk to itself and your Supabase project, and the browser must trust the file types it is told. Checked in a headless browser: the sign-in page loads with no blocked items, and framing is refused.
- **Developer files hidden (new `_redirects`):** the site is published from the whole project folder, so `schema.sql`, `migrations/`, `supabase/`, `tests/`, `android/`, `CLAUDE.md` and similar could be downloaded by anyone. They now answer "not found". The app does not use any of them.
- Live database re-checked on 31 Oct: all 34 tables have row locking, every function that takes a pharmacy is guarded, and anonymous visitors can run no useful function. Still to do in the Supabase dashboard: turn OFF "Allow new users to sign up" (now that sign-up goes through the code check) and turn ON leaked-password protection.

## 2026-10-30: "Install Pharma" popup, and the installed website matches the Android app

- **Install popup:** a small card with a red border shows as soon as the site opens in a browser that can install it: **Install app** and **Not now** (hidden for 3 days). Phones and tablets only (nothing on a computer). Android installs in one tap, with no "unknown sources" warning. iPhone shows the two steps (Share, then Add to Home Screen). Inside WhatsApp, Facebook, Instagram and TikTok on Android it offers **Open in Chrome**; on iPhone it says to open the link in Safari. It never shows inside the installed app or the Android app. New file `install.js`; test `tests/install.test.js`.
- **Looks like the Android app:** the installed website now launches on the same Pharma green as the app's splash (manifest `background_color`), keeps the green status bar, and has its own name and icon on iPhone (new home-screen tags in `index.html`, which iPhone needs because it ignores `manifest.json` for these). **The install icon is now the app's white cross on red** (it was an old white H on green); all icons in `icons/` were regenerated from the Android app's own icon, plus `icons/apple-touch-icon.png` for iPhone.

## 2026-10-30 (evening): desktop menu now matches Kodi's side menu (replaces the scrolling sidebar)

- **Desktop menu:** on wide screens the left bar is now the phone menu, docked open (200px): logo and pharmacy name at the top, small CAPITAL group headings (MENU, STOCK, MONEY, MORE), and an emoji tile then the name on every row. The selected row has a lighter panel, a gold bar on its edge and a gold tile. Two-word names (Controlled Drugs, Stock Valuation) stack on two lines; Stock Take is one line. Your name and role are at the bottom. Phones are unchanged. The old icon bar is no longer shown on desktop.

## 2026-10-30 (day): edit a drug, stop selling it, delete one added by mistake

- **Edit details:** on a drug's sheet (Inventory > tap the drug) the owner, a co-owner or a pharmacist can fix the name, category, form, unit, reorder level, prescription flag and pack size/label. Stock is untouched, and past sales and reports show the corrected name. A name already used by another drug (any capitals, hidden drugs included) is refused with a plain message.
- **Stop selling:** hides the drug from Sell, Inventory and the low-stock lists; all its sales history stays. Refused while any stock is left (expired stock counts), with the amount: sell it or write it off first. Brought back from **Hidden drugs** (button at the bottom of Inventory).
- **Delete drug:** only offered for a drug that never had a batch; the database also refuses it if there is any sale, return, order line, adjustment, stock take or controlled-drug entry. Always asks first.
- Adding a drug whose name is taken now says so and points to Hidden drugs.
- Database: three new functions `edit_drug`, `set_drug_active`, `delete_drug` (migration `2026-10-30_c_edit_hide_delete_drug.sql`, already applied to the live project and folded into `schema.sql`). `sw.js` cache is `hodhi-shell-v2z`.
- Tested: 23 new database checks in `tests/run_tests.js` (rename, duplicate name, hide with stock / expired stock, delete rules, roles, other pharmacy) and a scripted browser run on phone and desktop.

## 2026-10-30 (late): the sign-up and reset code text says "Pharma", not "Hodhi"

- **Fixed:** the SMS that carries the 6-digit code for creating an account and resetting a password said "Your Hodhi verification code is ...". It now says "Your Pharma verification code is ... It expires in 5 minutes. Do not share this code." The text lives in the `send-otp` Supabase Edge Function, not in the app, so it was fixed on the live project (version 4, already deployed; no app update or Netlify deploy is needed for it). The other messages checked were already right: the password-changed notice says "Pharma", the sign-up, reset and send-sms functions say "Pharma", no saved SMS or pharmacy name contains "Hodhi", and the SMS sender name is `Flovo_sms`.
- **Left as "hodhi" on purpose:** the hidden login address ending `@hodhi.local` (phones are stored as `p254...@hodhi.local`; changing it would lock every existing user out), the two browser storage keys, the cache name `hodhi-shell-...` and the test database name. Nobody sees these.

## 2026-10-30 (night): desktop left bar with every module and a Profile button; desktop sign-in matches the phone

- **Every module on the desktop sidebar:** Home, Inventory, Sell, Customers, SMS, Stock Take, Controlled Drugs, Reorder List, Expiry Dates, Suppliers, Expenses, Stock Valuation, Insurance Claims, Reports, Settings, in one scrolling list (no group headings, which stay only in the phone's menu). The rows come from the same permission-gated list as the phone's menu (`navMenuItems()`), so a role only sees what it may use and the two can never drift apart. Stock Take, Controlled Drugs and the report screens used to be reachable only from inside other screens on the desktop.
- **Scrolls, with a visible bar:** the brand block stays at the top and the pharmacy / user card at the bottom; the list between them scrolls (white scrollbar on the green). Tapping a row far down does not jump the list back to the top, and a screen opened some other way scrolls its row into view.
- **Glass icons:** the same glass chips as the phone's bottom bar and menu replace the flat line icons. The bar keeps its narrow width (a chip above a short label). One row is lit (gold) at a time: inside Stock Take only Stock Take is lit, inside Expiry Dates only Expiry Dates.
- **Phone unchanged:** the bottom bar still shows Home, Inventory, Sell, Expenses, Reports; the slide-out menu is untouched. One small difference on both: tapping Reports always opens the reports list, not the report that was open last.
- **Account card removed, Profile added:** the card at the bottom of the sidebar is gone. On a desktop the topbar's Log out button is now a **Profile** button; it opens a small card with your name, role and pharmacy, and the Log out button (Escape or a click elsewhere closes it). A phone keeps the plain Log out button.
- **Thicker scrollbar:** the sidebar scrollbar is 20px wide (it was 10px), white on the green, with a rounded thumb that is easy to grab.
- **Desktop sign-in matches the phone's (option A, chosen from a sketch):** at 860px and up the sign-in is a split screen made of the same pieces as the phone: the green hero on the left (red-cross mark, "Pharma", "Know your stock", gold heartbeat line, the four glass feature chips: Batch tracking, Expiry alerts, Daily reports, Printed receipts) and, on the right, the cream "Welcome back" label card (perforated edges, small monospace field labels, the eye on the password, "Forgot password?", the gold LOG IN stamp and the BATCHES · FEFO / KES strip) with "Create an account" and "Staff login" under it, and a green heartbeat line along the bottom. The sign-up, staff-login and password-reset steps use the same card. The old desktop headline ("Know Your Stock, Never Run Dry") and the three floating stat cards (with the sample figures) are removed. The phone screen is unchanged. Test `tests/auth-desktop.test.js`.
- Test `tests/sidebar.test.js` (proven red), added with `tests/valuation-row.test.js` to `npm test`; checked in a real browser at 860, 1024 and 1280px (including a 480px-tall window) and at 320, 360, 390 and 430px phones for the five roles.
- Service worker cache is now `hodhi-shell-v2y`.

## 2026-10-30 (evening): stock valuation shows cost and price per unit; two tests that had stopped checking

- **Stock Valuation:** each drug now reads like "20 tablets · cost KES 50 · price KES 100": the quantity, then what one unit cost and what one unit sells for, with the value of all the stock still shown on the right. The quantity / cost / price text is on a line of its own that never wraps (it uses the whole row width and shrinks slightly on narrow phones; checked at 320, 390 and 1280px, including a long name and six-figure values). A drug held in batches bought at different prices shows the average, and a drug whose cost was never entered (stock imported from a sheet has selling prices only) shows a dash for the cost instead of "KES 0". Print and Excel have the same two new columns, Unit cost and Unit price. No database change: the per-unit figures are the existing stock values divided by the quantity. New test `tests/valuation-row.test.js` (proven red against the old wording).
- **Two tests had silently stopped working after the code split** (both still pointed at the deleted `app.js`): `banned-colours.test.js` skipped the missing file, so the no-gray-text rule was no longer checked in any of the app's code; `critical-css.test.js` crashed. The first now scans every file in `js/` and the second reads `js/core.js`. The code passes both; a gray text colour added to a `js/` file now fails the test (shown once).
- Service worker cache is now `hodhi-shell-v2v`.

## 2026-10-30 (later): a data leak in the admin helper closed, changelog tidied

- **Fixed:** `admin_pharmacy_stats()`, the helper behind the admin portal, could be called through the public API by anyone, even someone not signed in, and returned every pharmacy's name, town, owner name and phone, staff counts and sales figures. It had been locked down on 28 Oct, but the trials migration re-created it (to add the plan columns) and a re-created function is open to everyone again. It is now closed to signed-out and signed-in users; the admin portal is unaffected because the admin functions that call it run with the owner's rights. Migration `2026-10-30_b_lock_admin_pharmacy_stats.sql` (already applied to the live project; also in `schema.sql`, after the function).
- **New rule with a test:** the SQL tests now fail if `admin_pharmacy_stats`, `log_sign_in` or `rls_auto_enable` can be called by signed-in or signed-out users, or if signed-out visitors can call any owner-rights function other than `keep_alive()` (proven red once against the previous schema). SQL tests: 228.
- **Changelog:** removed the repeated "Sell search and checkout bar" and "Floating pop-ups" entries (one still said the bar was gold; it is blue).

## 2026-10-30: sign-up now confirms the phone number first

- **Code before account:** creating a pharmacy account or joining as staff now texts a 6-digit code to the phone number first. The account is only created after the right code is entered (new Edge Function `signup-by-phone`; `send-otp` and `verify-otp` accept the new purpose `signup`; migration `2026-10-30_signup_otp_purpose.sql`).
- **One manual step in Supabase:** Authentication > Sign In / Providers > turn OFF "Allow new users to sign up", so nobody can skip the code by calling sign-up directly. Log in, password reset and the new sign-up all keep working with it off.

## 2026-10-30: trials, paid plans and admin pharmacy management

- **Trial and plan:** every new pharmacy gets a 90-day free trial and becomes Active when the admin marks its first payment. The admin list and each pharmacy page show "Trial · N days left", "Active · N days left", or "Trial ended".
- **Admin controls:** add or take away days (any number), end the plan now, mark as paid for a number of days, and delete a pharmacy. Delete is only allowed once the plan has ended, asks for the admin password again, then the exact pharmacy name, and refuses to delete a pharmacy that holds the admin account. Migration `2026-10-30_trials_and_admin_management.sql`.
- **Lock-out:** when the end date passes, the pharmacy is shut out of all its data by the database itself (`my_pharmacy_id()` / `my_role()` return nothing) and the app shows "Your free trial has ended". The platform admin is never locked out; adding days or marking as paid unlocks straight away. `my_subscription()` tells the app the plan state. Migration `2026-10-30_trial_lockout.sql`.
- **Admin screens:** removed "Recent sign-ins" and "Show as a table"; the post-login loading screen is now the same as the pharmacy app's; admin sign-in has a show/hide eye.
- **Password eye:** every password box in the app (log in, sign up, staff join, new password, reset) has a show/hide eye.
- **Review tune-up:** indexes on three foreign keys, the profiles policy reads `auth.uid()` once per query, and the three password-reset functions are saved in `supabase/functions/` (migration `2026-10-30_review_fk_indexes_and_profiles_policy.sql`).
- **SMS wallet (buy SMS with M-Pesa):** each pharmacy has a KES SMS wallet. The owner taps Buy SMS on Customers > Messages, gets an M-Pesa prompt, and the wallet is credited when Safaricom confirms (exactly once, never by the screen). Each SMS costs `sms_platform_config.price_per_sms` (KES 1) per 160-character part, charged when it is queued and refunded automatically if it fails to send. The Messages tab shows credit, messages left and the last 30 days of use. The admin pharmacy page shows the same numbers and can add or remove credit by hand. Same Daraja app and same SMS sender as Kodi. Migration `2026-10-30_sms_wallet.sql`; functions `sms-topup` and `pay-callback` (Netlify). New pharmacies start with no SMS credit.
- **SMS has its own menu item** (phone menu and desktop sidebar, for owners, co-owners and pharmacists): credit, Buy SMS, usage and the message list on one page. The Messages tab under Customers still works.
- **Password-reset codes and SMS were failing** ("Could not send a code right now"): the server-side database account (`service_role`) had lost access to every table, so a code could not be saved. Access restored (migration `2026-10-30_service_role_table_access.sql`); signed-out and signed-in users are unchanged.
- **Netlify build:** `MPESA_ENV` is excluded from Netlify's secret scan (`netlify.toml`), because its value is an ordinary word ("production") that appears in the code and docs and made the scan fail the build.
- **To switch on payments:** add to Netlify environment variables `MPESA_ENV`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, `MPESA_SHORTCODE`, `MPESA_TILL_NUMBER`, `MPESA_CALLBACK_SECRET` (same values as Kodi, with a new long random secret) and `SUPABASE_SERVICE_ROLE_KEY` (Pharma's). Until they are set the Buy SMS button says payments are being set up.

## 2026-10-29 (fifth batch): row-level security and table access locked down

- **Row-level security:** it was already ON for all 31 tables, and no pharmacy could see another's rows. But the older tables still let any signed-in person (an attendant included) insert, edit or delete rows directly through the public API, skipping the checked functions: rewrite a sale's total, change a batch quantity, or delete the stock-movement audit trail. Signed-out visitors and signed-in users also held privileges (TRUNCATE, TRIGGER, REFERENCES) that row-level security does not cover, and the server-only tables (one-time codes, reset attempts, SMS settings) were open to signed-in users at the table-privilege level (row-level security still blocked every row).
- **Fixed** (migration `2026-10-29_f_lock_down_table_access.sql`): signed-out visitors hold nothing; nobody holds TRUNCATE / TRIGGER / REFERENCES; server-only tables are closed to signed-in users; sales, sale items, sale payments, stock adjustments, returns, supplier deliveries and payments, expenses, the drug catalogue, categories and staff invites are read-only from the app (changed only by the checked functions, which are unaffected). The few things the app writes directly are narrowed: a batch can only have its mark-down % changed, an insurance claim only its status; drugs, suppliers, profiles and pharmacies cannot be deleted directly and profiles and pharmacies cannot be added directly. New tables start with the same least-privilege defaults.
- **Daily keep-alive ping:** it used to read one row from the pharmacies table with the public signed-out key, which the lock-down now refuses. It calls a new `keep_alive()` instead, which returns the time and no pharmacy data, so the free-tier project still never pauses from a quiet week.
- **New rule with a test:** SQL tests now fail if any table has row-level security off, if signed-out users or signed-in users hold privileges they should not, or if an attendant can edit a sale, a batch quantity or the audit trail directly (proven red once by running the tests without the migration). SQL tests: 215.

## 2026-10-29 (fourth batch): fast bulk import, log cleanup, admin portal indexes, drug detail

- **Bulk import is fast.** The Excel stock import sent two requests per row (a 2,000-row sheet meant 4,000 requests and several minutes, and a dropped connection left it half done). The database now takes 200 rows per request (`import_stock_rows()`, up to 500 allowed) and runs every row through the normal restock, so every rule is unchanged (who may restock, price and expiry checks, the stock record, the controlled-drug ledger). A bad row is skipped and the message tells you the first problem ("Imported 1,998 rows, 2 failed (first problem - Panadol: ...)"). A drug already in the pharmacy is matched whatever the letter case. Only the owner, co-owner, a pharmacist or a stock taker can import.
- **Nightly cleanup also removes old logs:** sign-in records older than 13 months and SMS log rows older than 2 years. Stock adjustments and the controlled-drugs ledger are the audit trail and are never deleted.
- **Admin portal:** three indexes so "the last 30 days across all pharmacies" no longer reads every sale ever made (`sales(sold_at) where not voided`, `sales(pharmacy_id, created_at)`, `stock_adjustments(created_at)`). The portal's numbers are unchanged.
- **Drug detail** shows every batch that still has stock plus the latest 5 used-up batches (with a note), and its requests run together, so a drug restocked hundreds of times opens quickly.
- Migration `2026-10-29_e_import_cleanup_admin.sql`. SQL tests: 199 (was 183). Service worker cache is now `hodhi-shell-v2p`.

## 2026-10-29 (third batch): speed, database, code layout

Speed and staying fast as a pharmacy grows (more sales, more drugs, more staff).

- **Reports no longer break on a busy month.** The Sales report used to download every sale, every item and every payment of the period and add them up in the browser, passing hundreds of sale ids in the web address. Past a few hundred sales the request was too long and the report simply failed (and a month of sales was megabytes). The database now does the adding up (`sales_report()`), and the list of sales arrives 20 at a time (`sales_report_page()`) with "Load more". The items of a sale are fetched only when it is opened. Print and Excel fetch the whole list in blocks of 1,000 when tapped. Several quick taps on Today / Week / Month can no longer show an older answer over a newer one.
- **Suppliers list** asks the database for each supplier's balance (`supplier_balances()`) instead of downloading every delivery and payment ever recorded, and loads the two things at the same time.
- **Expenses** loads only this year (the widest range on the screen). Also fixed: the Month/Week/Today filter compared against the previous day's date in Nairobi (it used UTC), so the last day of the previous month could be included.
- **Sell:** at most 100 products are drawn at once (typing finds the rest), so a pharmacy with thousands of products does not slow down each tap. Checkout reuses the customer list loaded in the last minute instead of reloading every customer's balance before every sale; it is refreshed after each sale.
- **Excel library (880 KB):** no longer downloaded on install, and not at all in the background on Data Saver or a 2G/3G connection (it loads when someone taps Excel). Everywhere else it still loads quietly after the first screen.
- **Database indexes** for the tables that had none starting with the pharmacy (sales payments, returns, insurance claims, held sales, suppliers, staff invites), plus a faster lookup of the oldest-expiry batch when selling and of sales by drug. All added with `if not exists`, no data touched. Migration `2026-10-29_d_scalability.sql` (run it in Supabase **before** deploying the app).
- **The app's code is split into smaller files.** `app.js` (5,700 lines) is now 17 files in `js/` (one per area: sell, reports, suppliers, customers...), loaded in order by `index.html`. The split is byte-for-byte the same code (checked), so nothing behaves differently. New `tests/js-split.test.js` keeps the load order, the offline cache list and the single `init()` call correct. The old `app.js` is deleted.
- Service worker cache is now `hodhi-shell-v2o`. SQL tests: 183 (was 173).

## 2026-10-29 (second batch): credit, SMS, controlled drugs, stock take

- **Customers and credit (kopa):** new Customers screen (Customers, Refills, Messages tabs). People can buy on credit: Checkout has a **Credit** payment method (also as part of a split with cash), needs a saved customer (or "+ New customer" on the spot), and stops a sale that would take them over their credit limit. Each customer has a balance, a statement (print), payments (cash, M-Pesa, bank) and reversals (owner or pharmacist, with a reason). A return on a credit sale lowers the debt by the credit that sale carried, never more. Voiding a credit sale removes it from the debt. Sellers can add customers and take payments; only the owner or a pharmacist sets credit limits. The accountant can view, not change.
- **Refills:** repeat customers (blood pressure, diabetes, family planning) get a refill plan; Due, Next 7 days and All lists; selling that medicine to that customer moves the date on by itself.
- **SMS:** reminders for refills and debts, one at a time (message shown and editable first) or "Remind all due" (up to 50). Free WhatsApp link beside each. Sent by the new `send-sms` Edge Function through the same Africa's Talking account as the password-reset codes. The database approves and logs every message first: only the owner or a pharmacist can send, customers marked "never text" are skipped, nobody is reminded twice in a day, and each pharmacy has a daily limit (30, set by the platform, not by the pharmacy). Owner can switch SMS off. Every message is listed under Messages with sent or failed and why.
- **Controlled drugs:** the owner or a pharmacist can mark a drug as a Dangerous drug (DDA) or Psychotropic. Selling one needs the patient, the prescriber and the prescription number, and every movement (received, sold, returned, voided, corrected, written off, stock take) is written to a ledger nobody can edit, with the balance after each. The register shows shelf versus ledger and flags any mismatch; per-drug ledger can be printed or exported to Excel.
- **Stock take:** count the shelf (a stock taker can count), see differences from the system, give a reason for each (missing, damaged, expired, found), and an owner or pharmacist approves in one step. Sales made while counting do not look like losses. History shows the value lost or gained at cost.
- **Dashboard:** alerts for money owed by customers, refills due, controlled drugs that do not match the ledger, and a stock take in progress (5th, optional request; the dashboard still draws if it fails).
- **Fixes found while testing:** typing an amount at checkout put the digits in reverse ("100" became "001") because the box lost its cursor on every keystroke; now it keeps focus and cursor.
- **Android app, top of the screen:** on newer phones the clock and battery were drawn on top of the green header. The page now keeps its top bar, the menu and the sign-in screen below the status bar (green still shows behind it), and the app no longer tries to switch the screen mode at run time. No new app build is needed: it takes effect when the website is deployed (close and reopen the app once).
- **Sell search and checkout bar:** typing in the Sell search now shows the matches directly under the box (above the cart, with "N matches in stock" or "Nothing in stock matches ..."), so results are never hidden below the cart or the keyboard. The search box is no longer rebuilt on every key press (that confuses phone keyboards and could drop letters); the same fix applies to every other search box (Inventory, Stock take, new delivery, common drugs). The checkout bar at the bottom of Sell ("2 items · KES 60 Checkout") is now blue with white text so it stands out from the green.
- **Floating pop-ups:** every pop-up (checkout, restock, forms) now floats in the middle of the screen with a gap from all edges and rounded corners all round, instead of sitting flat against the bottom. The slide-out menu is unchanged.
- **Sales graph is a rolling last 7 days:** the dashboard's Week view used to be "this week so far", so every Monday the graph shrank to a single dot. It is now the last 7 days (today and the 6 days before, Nairobi days) with all 7 day names always shown, and it is compared with the 7 days before. A day with no sales is a 0, so the line always spans the week. The tab is called "7 Days". Month, Year and Today are unchanged, and the Sales report keeps its own "this week" for exact date ranges. Migration `2026-10-29_c_rolling_week.sql` (applied live); SQL tests are now 173.
- **Sign-in screen does not scroll:** on a phone the log-in page is locked to the screen and its spacing tightens on shorter phones (and under the Android status bar) so the form and both links always fit. Sign-up and the other steps have more fields and may still scroll when they must.
- **Pharma's own pop-ups:** Hold sale, Resume held sale, Discard held sale, Write off and Correct count used the browser's own boxes, which print the website address ("... says"). They are now Pharma pop-ups (the phone's Back button closes them). Hold sale also no longer holds the sale when you press Cancel.
- **No technical wording on screen:** every error goes through one plain-language filter, so no one sees the names of the services behind the app, codes or database wording ("Your session has ended", "You do not have permission to do that", "Something went wrong on our side"). Pharma's own messages pass through unchanged.
- **"Please wait, loading…":** opening any tab or report from the bottom bar, the menu or the Reports tiles shows a cover for as long as the screen loads, and extra taps are ignored until it has opened.
- **Menu names:** two-word names now start each word with a capital (Stock Take, Controlled Drugs, Reorder List, Expiry Dates, Stock Valuation, Insurance Claims, All Reports).
- **Database:** migrations `2026-10-29_a_enum_values.sql` then `2026-10-29_b_credit_controlled_stocktake_refills_sms.sql` (applied to the live project and added to `schema.sql`). `record_sale` gains an optional `p_customer_id` (the old five-argument version is dropped so calls cannot become ambiguous; old calls still work). New tables are readable by the pharmacy's own staff only and written only through checked functions. SQL tests: 163 (was 43); new `tests/send-sms.test.js` (18). Service worker cache is now `hodhi-shell-v2j`.

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
- **Fixes:** checkout price match, return/void/write-off stock, cross-tenant writes, anon RPC access, owner lockout, prescription enforcement, atomic insurance claims, XSS, service worker caching. See `migrations/2026-10-28_*.sql`.
