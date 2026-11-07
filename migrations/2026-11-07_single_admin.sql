-- 2026-11-07 (later): the platform has exactly one admin.
--
-- The admin console now signs in with an email and password. The owner's account
-- is kinyuadavid2003@gmail.com. This keeps that account as the only row in
-- platform_admins and makes the database refuse a second one.
--
-- What it changes, in order:
--   1. Stops, with nothing changed, if that account is not already an admin
--      (so the platform can never be left with no admin).
--   2. Removes every OTHER row from platform_admins. This only removes admin
--      rights; the pharmacy login those rows belonged to is left alone.
--   3. Adds a unique index so a second admin row cannot be added.
--
-- No password is stored here. Admin rights live only in platform_admins, which
-- the app and the public API cannot read or write.

do $$
declare
  v_keep uuid;
begin
  select u.id into v_keep
    from auth.users u join platform_admins pa on pa.user_id = u.id
   where lower(u.email) = 'kinyuadavid2003@gmail.com';
  if v_keep is null then
    raise exception 'kinyuadavid2003@gmail.com is not in platform_admins yet; nothing was changed';
  end if;

  delete from platform_admins where user_id <> v_keep;
end
$$;

create unique index if not exists platform_admins_only_one on platform_admins ((true));
