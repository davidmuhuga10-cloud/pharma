-- ROLLBACK for 2026-11-09_sale_discount_whole.sql
-- Removes the rule that a bill discount must be a whole number of shillings.
alter table public.sales drop constraint if exists sales_discount_whole;
