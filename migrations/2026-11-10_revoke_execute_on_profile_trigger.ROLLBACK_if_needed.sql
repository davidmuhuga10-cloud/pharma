-- 2026-11-10_revoke_execute_on_profile_trigger.ROLLBACK_if_needed.sql
--
-- Undoes 2026-11-10_revoke_execute_on_profile_trigger.sql by putting the
-- default grant back on prevent_profile_privilege_escalation().
--
-- Running this brings back the Supabase advisor warning
-- (anon/authenticated can execute a SECURITY DEFINER function) for this
-- function, and gains nothing: a trigger function cannot usefully be called
-- over REST anyway. There is no known reason to run it -- it exists only so
-- the migration has a stated way back, per MIGRATIONS.md.
--
-- No data is touched by either the migration or this rollback.

grant execute on function public.prevent_profile_privilege_escalation() to public;
