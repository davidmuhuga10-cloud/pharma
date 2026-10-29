-- 2026-10-29 (part A of 2): new enum values.
--
-- Run this on its own, BEFORE 2026-10-29_b_credit_controlled_stocktake_refills_sms.sql.
-- Postgres will not let a value added with ALTER TYPE be used in the same
-- transaction, so it has to be committed first.
--
--   payment_method 'credit'     a sale (or part of one) put on the customer's account (kopa)
--   adjustment_type 'stock_take' a stock adjustment made by approving a stock take
--
-- Safe to re-run.

alter type payment_method add value if not exists 'credit';
alter type adjustment_type add value if not exists 'stock_take';
