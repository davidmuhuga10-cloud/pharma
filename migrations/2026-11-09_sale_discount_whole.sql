-- 2026-11-09  A bill discount is a whole number of shillings
--
-- WHAT WAS WRONG
--   The discount box accepted cents (10.50). The owner's rule: a discount is whole
--   shillings only. The app now refuses cents; this makes the database refuse them
--   too, so a call that skips the app cannot record one.
--
-- WHAT CHANGES
--   * sales.discount_amount must equal its own whole part (10 passes, 10.5 fails).
--   Every existing sale has a discount of 0, so nothing existing is affected.
--
-- Safe to run twice. Rollback: 2026-11-09_sale_discount_whole.ROLLBACK_if_needed.sql.

alter table public.sales drop constraint if exists sales_discount_whole;
alter table public.sales add constraint sales_discount_whole check (discount_amount = trunc(discount_amount));
