-- ============================================================================
-- PHARMA — review fixes part 2 (grants), 2026-10-28
-- Applied live as migrations:
--   revoke_public_execute_and_guard_signup_rpcs
--   restore_authenticated_execute_grants
-- Safe to re-run.
-- ============================================================================
-- ----------------------------------------------------------------------------
-- 17. GRANTS — revoke the default PUBLIC execute (migration
--    revoke_public_execute_and_guard_signup_rpcs + restore_authenticated_execute_grants)
-- ----------------------------------------------------------------------------
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and in
-- Supabase the `anon` role inherits PUBLIC. Section 9 above added a grant to
-- `authenticated` but never took the default one away, so every RPC in this
-- schema was reachable unauthenticated at /rest/v1/rpc/<name>. Section 10's
-- admin functions were the only ones that explicitly revoked it.
--
-- Most were still safe in practice (my_pharmacy_id() is null for a signed-out
-- caller, so "Not authorized for this pharmacy" fires first), but
-- join_pharmacy_with_code was not: SECURITY DEFINER means it reads
-- staff_invites with RLS bypassed, and its only guard asked whether the CALLER
-- already had a profile — false for anon. That made it an oracle an anonymous
-- visitor could use to brute-force 6-character invite codes.
--
-- Note the order: revoking from PUBLIC is not enough on its own, because
-- several functions had no explicit `authenticated` grant and were reaching
-- the app through PUBLIC too — including my_role(), which every RLS policy
-- calls. Revoke, then grant explicitly.
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      -- never callable through the API by design: admin_pharmacy_stats is
      -- internal to admin_overview/admin_pharmacy_detail, log_sign_in is an
      -- auth.users trigger, rls_auto_enable is Supabase's own.
      and p.proname not in ('admin_pharmacy_stats', 'log_sign_in', 'rls_auto_enable')
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- Both signup RPCs now state that they need a signed-in user rather than
-- relying on a null auth.uid() happening to break a later insert.
-- bootstrap_pharmacy also gains the "already in a pharmacy" check that
-- join_pharmacy_with_code already had.
create or replace function bootstrap_pharmacy(p_name text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pharmacy_id uuid;
  v_cat text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a pharmacy';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'Give the pharmacy a name';
  end if;

  insert into pharmacies (name, phone) values (trim(p_name), p_phone) returning id into v_pharmacy_id;

  insert into profiles (id, pharmacy_id, full_name, phone, role)
  values (auth.uid(), v_pharmacy_id, p_full_name, p_phone, 'owner');

  foreach v_cat in array array[
    'Analgesics/Antipyretics', 'Antibiotics/Antifungals/Amoebicides',
    'Bronchodilators/Anti-Allergy', 'Antacids/Anti-H-Pylori', 'Antimalarials',
    'Anti-DM', 'Hypertensives/Convulsants', 'Antiemetics/Laxatives',
    'Contraceptives', 'Supplements', 'Eye/Ear Drops', 'ORS',
    'Injectables', 'Powders/Creams', 'Non-Pharmaceuticals', 'Others'
  ] loop
    insert into drug_categories (pharmacy_id, name) values (v_pharmacy_id, v_cat);
  end loop;

  return v_pharmacy_id;
end;
$$;

create or replace function join_pharmacy_with_code(p_code text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite record;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to redeem an invite code';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a pharmacy';
  end if;

  select * into v_invite from staff_invites
  where code = upper(p_code) and used_at is null and expires_at > now()
  for update;

  if v_invite is null then
    raise exception 'Invalid or expired invite code';
  end if;

  if v_invite.account_expires_hours is not null then
    v_expires_at := now() + (v_invite.account_expires_hours || ' hours')::interval;
  else
    v_expires_at := null;
  end if;

  insert into profiles (id, pharmacy_id, full_name, phone, role, account_expires_at)
  values (auth.uid(), v_invite.pharmacy_id, p_full_name, p_phone, v_invite.role, v_expires_at);

  update staff_invites set used_by = auth.uid(), used_at = now() where id = v_invite.id;

  return v_invite.pharmacy_id;
end;
$$;

grant execute on function bootstrap_pharmacy(text, text, text) to authenticated;
grant execute on function join_pharmacy_with_code(text, text, text) to authenticated;
