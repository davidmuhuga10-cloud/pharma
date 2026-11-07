-- 2026-11-08: findings from the pre-launch audit.
--
-- 1. SECURITY (cross-pharmacy leak). evening_summary_text(p_pharmacy_id) was
--    executable by every signed-in user and never checked that the pharmacy
--    asked for was the caller's own. Anyone with any account on the app could
--    pass another pharmacy's id and read that pharmacy's day: how many sales,
--    the day's takings, whether the cash drawer balanced and by how much, and
--    the low/expiring stock counts.
--
--    Nothing in the app ever called it directly - its only callers are
--    queue_evening_summary_now() (which does check the caller owns the
--    pharmacy) and the nightly sweep. Both are security definer, so they keep
--    working with no grant at all. Taking the grant away closes the hole
--    without changing a single screen.
--
--    The rest of the lockout and tenant rules were checked and are sound:
--    my_pharmacy_id() already returns nothing once a trial or plan has expired,
--    so row-level security and every RPC that compares against it already fail
--    closed on the server, not just in the browser. The demo_* and
--    cash_drawer_figures helpers are already revoked from signed-in users.
--
-- 2. PERFORMANCE (database linter). Five foreign keys had no index behind them,
--    which makes deletes and joins on those columns scan the whole table as the
--    data grows, and one index existed twice under two names.

revoke execute on function public.evening_summary_text(uuid) from authenticated;

create index if not exists stock_sheet_uploads_take_idx       on public.stock_sheet_uploads (take_id);
create index if not exists stock_sheet_uploads_applied_by_idx on public.stock_sheet_uploads (applied_by);
create index if not exists stock_sheet_uploads_undone_by_idx  on public.stock_sheet_uploads (undone_by);
create index if not exists support_access_granted_by_idx      on public.support_access (granted_by);
create index if not exists support_access_events_access_idx   on public.support_access_events (access_id);

-- Identical to password_reset_attempts_phone_key_idx, which stays.
drop index if exists public.password_reset_attempts_phone_time;
