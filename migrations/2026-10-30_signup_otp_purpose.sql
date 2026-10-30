-- Allow phone codes to be used for sign-up verification as well as password reset.
alter table public.phone_otps drop constraint if exists phone_otps_purpose_check;
alter table public.phone_otps add constraint phone_otps_purpose_check
  check (purpose in ('password_reset', 'signup'));
