-- 2026-11-07 (night, later still): returning stock to a supplier - step 1 of 2.
-- A new kind of stock movement, kept in its own file because Postgres only lets a new
-- value be used after the change that adds it is saved. Run this file first, then
-- 2026-11-07_supplier_returns.sql. Safe to run twice. Nothing existing changes.

alter type adjustment_type add value if not exists 'supplier_return';
