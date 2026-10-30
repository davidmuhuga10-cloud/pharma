-- 2026-10-30 (b): admin_pharmacy_stats() was callable by anyone, signed in or not.
--
-- It is an internal helper for admin_overview() and admin_pharmacy_detail()
-- (which check that the caller is the platform admin) and was locked down on
-- 2026-10-28. The trials migration then dropped and recreated it to add three
-- columns, and a re-created function is executable by everyone again. Through
-- the public API that handed any visitor every pharmacy's name, town, owner
-- name and phone, staff counts and sales figures.
--
-- admin_overview() and admin_pharmacy_detail() run with the owner's rights, so
-- they still call it. Safe to re-run.

revoke all on function public.admin_pharmacy_stats() from public, anon, authenticated;
