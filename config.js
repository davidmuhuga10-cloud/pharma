/* Pharma — Supabase connection details.
   The publishable/anon key below is DESIGNED to be public - it ships inside
   every app that uses Supabase this way. Row Level Security (set up in
   schema.sql) is what actually protects the data, not secrecy of this key.
   Never put the "secret" / "service_role" key here or anywhere in this app.

   Connected to the live "Hodhi" Supabase project — schema.sql has already
   been run against it (tables, views, RPC functions, RLS all in place). */
const SUPABASE_URL = 'https://ovegzdlrhlcpjfcsoumu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5L7-aCEhUgaMMX83IzhWXg_yyUHtALP';
