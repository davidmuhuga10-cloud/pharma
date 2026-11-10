# Pharma backups

Pharma's Supabase project is on the Free plan, which keeps **no backups you
can restore from**. This repository is the backup: a scheduled GitHub Action
dumps the database every night, proves the dump restores before keeping it,
and stores the last 14 daily, 8 weekly and 12 monthly copies.

It costs nothing. The database is about 20 MB and compresses to well under
1 MB; the run uses roughly 60 of the 2,000 free private-repo Actions minutes a
month.

## This repository must stay private

The dumps contain patients' names and phone numbers, controlled-drug records,
customers' debts, and the password hashes from `auth.users`.

The code repository `davidmuhuga10-cloud/pharma` is **public**, which is why
the backups live here instead and why the workflow file is here too. Never
copy a dump, or this workflow's secret, into the public repository.

## One-time setup

1. **Create this repository private.** On GitHub: New repository, name it
   `pharma-backups`, tick **Private**, create it.

2. **Add the workflow.** Put `backup.yml` at `.github/workflows/backup.yml`
   and this file at `BACKUPS.md`, and push.

3. **Add the connection string as a secret.** In Supabase open
   **Project Settings -> Database -> Connection string** and pick the
   **Session pooler** tab. Copy the whole URI and put your database password
   where it says `[YOUR-PASSWORD]`. It looks like:

   ```
   postgresql://postgres.ovegzdlrhlcpjfcsoumu:YOURPASSWORD@aws-N-eu-central-1.pooler.supabase.com:5432/postgres
   ```

   In this repository go to **Settings -> Secrets and variables -> Actions ->
   New repository secret**, name it exactly `SUPABASE_DB_URL`, and paste it.

   Two hosts that will *not* work, both for real reasons:
   - `db.ovegzdlrhlcpjfcsoumu.supabase.co` (the direct connection) is
     IPv6-only on the Free plan and GitHub's runners have no IPv6, so it
     hangs and times out.
   - the **transaction** pooler on port **6543** cannot be dumped from;
     `pg_dump` needs session mode. Use the session pooler on **5432**.

4. **Run it once by hand.** Actions tab -> *Pharma database backup* -> **Run
   workflow**. It should finish green and commit a `daily/` folder. If it
   fails, the log says which step and why.

Nobody but you ever handles that password: it goes straight from the Supabase
dashboard into the GitHub secret box.

## What a run produces

In `daily/`, `weekly/` and `monthly/`, per date:

| File | What it is |
|---|---|
| `<date>_public.sql.gz` | the whole `public` schema: every table, view, function, trigger, policy, and all the rows |
| `<date>_auth_users.sql.gz` | the rows of `auth.users` - the sign-in accounts |
| `<date>_auth_users_structure.sql.gz` | `auth.users`' column layout, used by the restore check |
| `<date>_counts.txt` | how many rows each table had, taken from the live database before the dump |

## How the run proves the dump is good

A backup nobody has restored is not a backup, so every run restores what it
just dumped into a throwaway Postgres 17 and only commits if all of this
holds:

- **Every table has exactly the row count `counts.txt` recorded.** This is the
  check that matters. A dump can be perfectly valid SQL and still be empty -
  counting tables or `COPY` blocks would not notice, and the job would
  cheerfully commit nothing-at-all every night. Comparing against counts taken
  from the live database is the only thing that catches that.
- **`auth.users` came back with at least one account.** Without it a restore
  gives you all the data and nobody who can sign in.
- **`profiles_id_fkey` exists afterwards.** `public.profiles.id` references
  `auth.users(id)`, so `auth.users` has to be restored *first*. Restore
  `public` first and Postgres cannot re-create that foreign key, drops it with
  only a warning, and you end up with a database that looks fine but has lost
  a constraint. This check is what keeps the restore order honest.

Some errors in the restore log are normal and ignored: `--clean` trying to
drop a schema that is in use, and triggers on `auth.users` pointing at
functions that this stripped copy does not have.

If a run fails, GitHub emails you. A red run means **do not trust that
night's backup** - read the log before anything else.

## Restoring

### Getting one table, or a few rows, back

The usual case: something was deleted or edited by mistake and you want
yesterday's version of it.

```bash
# pick a date, unpack it
gunzip -c daily/2026-11-09_public.sql.gz > restore.sql

# load it into a local Postgres (never into the live project)
createdb oneoff
psql oneoff -f restore.sql

# find what you need, then copy just that across by hand
psql oneoff -c "select * from sales where sold_at::date = '2026-11-08';"
```

Pull the rows you need out of the local copy and put them back through the
app, or with a small, specific `insert`/`update` against the live project.
**Do not** load a whole dump over a live database to recover a few rows: that
wipes everything that happened since.

### Rebuilding the whole project after losing it

1. Make a new Supabase project. Note its reference and password.
2. In the SQL editor, run `schema.sql` from the code repository, so the
   structure, functions and policies are in place.
3. Restore the accounts first, then the data - in this order:

   ```bash
   gunzip -c monthly/2026-11-01_auth_users.sql.gz > auth_users.sql
   gunzip -c monthly/2026-11-01_public.sql.gz     > public.sql

   # NEW project's session pooler URI
   NEW="postgresql://postgres.<newref>:<password>@aws-N-<region>.pooler.supabase.com:5432/postgres"

   psql "$NEW" -f auth_users.sql     # accounts first: profiles point at them
   psql "$NEW" -f public.sql
   ```

4. Check the counts against that date's `counts.txt`.
5. Point the app at the new project: `SUPABASE_URL` and the publishable key in
   `config.js`, `SUPABASE_URL` in the Netlify environment variables, and
   redeploy the Edge Functions.
6. People will have to sign in again. Their passwords still work, because the
   hashes came across in `auth.users`.

### Practise it

Restore a dump into a local Postgres once, so the first time you do it is not
during an emergency. Each night's run already proves the dump *can* be
restored; this is about you knowing the steps.

## What this does not cover

- **Edge Functions**, Netlify environment variables, and the Supabase project
  settings. Those live in the code repository and in the two dashboards, not
  in the database.
- **Anything between the last run and now.** The window is up to 24 hours. If
  that is ever too much, the fix is Supabase's paid point-in-time recovery,
  not a more frequent version of this.
- **Supabase's `storage` schema.** Pharma does not use file storage; if that
  changes, this needs to change with it.
