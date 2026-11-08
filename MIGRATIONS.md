# Pharma - Database migrations

How the database changes safely while real pharmacies use it.

## The files

- `schema.sql` - the complete database as it should be today. A new project (or the local test database) is built from this one file.
- `migrations/YYYY-MM-DD_name.sql` - one dated change. Each is **also folded into the end of `schema.sql`** under a `-- Folded in from migrations/<file>` banner, so the two never disagree.
- `migrations/YYYY-MM-DD_name.ROLLBACK_if_needed.sql` - how to undo that change. Written at the same time as the migration, run only if the change misbehaves. Rollback files are not part of `schema.sql` and are ignored by `tests/rpc-contract.test.js`.

## Rules for a migration

1. **Safe to run twice.** Use `create ... if not exists`, `create or replace`, `drop ... if exists`. The live project and a rebuilt project must end up the same.
2. **Never rewrite history.** Do not edit a migration that has been applied; add a new one.
3. **One purpose per file**, with a comment at the top saying what was wrong, what changes, and why it is safe.
4. **Guard anything that only exists on Supabase** (`pg_cron`, `pg_net`, `vault`) with an `if exists` check, so the file also loads into the plain local Postgres the tests use. Example: `migrations/2026-11-08_summary_sender_retry.sql`.
5. **New table = RLS on, a `pharmacy_id` policy, least privilege, and an index starting with `pharmacy_id`** (`CLAUDE.md` rules 11 and 12).
6. **Security-definer functions** set `search_path` and revoke execute from `public`/`anon`; grant to `authenticated` only what the app calls.
7. **Write the rollback file** before applying. If a change cannot be undone (dropped data), say so at the top of the rollback file and take a backup first.

## Applying a change

1. Write the migration and its rollback file; fold the migration into `schema.sql`.
2. Run the SQL tests against the local throwaway database (`tests/README.md`) and the JS tests (`npm test`). Add a test for any new rule and break the rule once on purpose to see it fail.
3. Apply to the live project **before** deploying code that needs it: Supabase dashboard -> SQL editor, or the migration tooling. Applying through the tooling also records it in the project's migration history.
4. Check the Supabase **Advisors** (security and performance) for new warnings.
5. Deploy the site. Bump `CACHE_NAME` in `sw.js` if any cached file changed.
6. Add the entry to `CHANGELOG.md`, `README.md` and `PHARMA_PROJECT_STATUS.md` (`CLAUDE.md` rule 2).

## Keeping the repository and the live project the same

The live project is the source of truth for what is running; the repository is the source of truth for how to rebuild it. They can drift when something is applied from the dashboard and not saved here. To check:

- **Functions the app calls:** `node tests/rpc-contract.test.js` confirms every database function and edge function the browser code calls exists in `schema.sql`, `migrations/` or `supabase/functions/`.
- **Live versus repository:** compare the live definitions with `schema.sql` using the dashboard's SQL editor, for example `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1;` against the `create function` names in `schema.sql`; and `select * from cron.job;` against the table in `ARCHITECTURE.md`. Do this after every dashboard-made change, and at least monthly.
- **Edge functions:** the source in `supabase/functions/<name>/` must be what is deployed. Deploy from the folder with `supabase functions deploy <name>`; set `--no-verify-jwt` only for the functions listed as JWT-off in `ARCHITECTURE.md`. A function must import only files inside its own folder.

## History note

Migrations before 2026-11-08 were applied to the live project without a matching rollback file. `2026-11-08_summary_sender_retry.sql` is the first with one; add them for every change from here on.
