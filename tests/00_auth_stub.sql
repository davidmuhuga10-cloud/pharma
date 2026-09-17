-- Minimal stand-in for the parts of Supabase's "auth" schema this app's
-- schema.sql depends on: an auth.users table to satisfy the FK on profiles,
-- and an auth.uid() function reads back whatever the test harness sets as
-- the "current user" for that connection — exactly mirroring how Supabase's
-- real auth.uid() derives from the caller's JWT, except we set it directly.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
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
