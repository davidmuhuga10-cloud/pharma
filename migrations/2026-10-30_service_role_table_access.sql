-- 2026-10-30 Give the server-side account its table access back
--
-- service_role is the account Supabase Edge Functions (send-otp, verify-otp,
-- reset-password-by-phone, send-sms) and the Netlify functions use. It had no
-- access to any public table, so saving a password-reset code failed with
-- "Could not send a code right now" and SMS could not be logged or sent.
-- Row-level security still applies to everyone else; signed-out visitors and
-- signed-in users are not changed.
--
-- Safe to run more than once.
begin;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
commit;
