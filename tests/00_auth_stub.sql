-- Minimal stand-in for the parts of Supabase's "auth" schema this app's
-- schema.sql depends on: an auth.users table to satisfy the FK on profiles,
-- and an auth.uid() function reads back whatever the test harness sets as
-- the "current user" for that connection — exactly mirroring how Supabase's
-- real auth.uid() derives from the caller's JWT, except we set it directly.
create schema if not exists auth;

-- Supabase's three API roles. Without these, every GRANT and REVOKE in
-- schema.sql fails with 'role "authenticated" does not exist' — and because
-- psql keeps going after an error unless ON_ERROR_STOP is set, the whole
-- permissions layer was being skipped silently on every test run. That is
-- exactly where the "anon can execute every SECURITY DEFINER RPC" bug lived,
-- invisible to this suite. Creating them here means `psql -v ON_ERROR_STOP=1`
-- now loads schema.sql cleanly and the grants are actually exercised.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  last_sign_in_at timestamptz
);

-- admin_pharmacy_stats()/admin_pharmacy_detail() read auth.sessions for the
-- "last seen" figure, so the stub needs it to load section 10 at all.
create table if not exists auth.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Convenience used only by the test harness, never by the app itself.
create or replace function test_set_user(p_user_id uuid) returns void
language sql as $$
  select set_config('app.current_user_id', p_user_id::text, false);
$$;
