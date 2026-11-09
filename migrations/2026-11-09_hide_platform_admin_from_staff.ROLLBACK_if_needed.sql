-- ROLLBACK for 2026-11-09_hide_platform_admin_from_staff.sql
-- The Staff list goes back to showing every member of the pharmacy, platform admin included.
drop function if exists public.hidden_staff_ids();
