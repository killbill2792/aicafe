# Migration safety lint

Each pull request checks **only new or changed** `supabase/migrations/*.sql` files between `BASE_SHA` and `HEAD_SHA`. Earlier migrations are history: they are not relinted. The existing Repo guards job runs the pinned `squawk-cli@2.70.0` after `npm ci`; no database, secrets, SQL execution, or separate required check is involved. The job uses read-only repository permissions.

## How it works

The guard asks Git for the added or modified SQL migrations on this PR, checks that every rule-level exception has a nearby written reason, then passes those exact paths to Squawk. Squawk reports the filename and line and fails the Repo guards job on a violation. A PR without migration changes skips this lint. Use `BASE_SHA=<base commit SHA> HEAD_SHA=<head commit SHA> node scripts/guards/migrations-lint.mjs` locally after `npm ci`.

## Rules and fixes

- **Drop / rename / type change:** do not drop or rename an existing table, column, view, function, index, policy, or other schema object in one step. Add the replacement first, move readers and writers, backfill if needed, and remove the old object only in an approved follow-up.
- **NOT NULL on an existing column:** add it nullable, populate and verify all existing rows, then add a validated check and tighten the column in a separately reviewed migration.
- **Foreign key / CHECK constraint:** add as `NOT VALID`, then `VALIDATE CONSTRAINT` after existing rows pass. An indexed referencing key reduces lock and scan pressure.
- **Timestamp and integer types:** use `timestamptz` for instants and `bigint` for counters/IDs instead of `timestamp` and `integer`.
- **RLS safety:** never turn RLS off or drop a policy casually. A new table needs RLS and tenant-scoped policies; review their conditions through the pinned Supabase skill and Codex. Squawk's policy creation/alteration bans are intentionally disabled, so creating or editing a policy is possible. The opt-in `ban-alter-row-level-security` rule also flags `ENABLE ROW LEVEL SECURITY`; for a **brand-new** table, add the narrow statement-level ignore with a reason confirming that policies and access were reviewed.
- **Indexes:** Supabase runs migrations in a transaction, so `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` do not work in this path. Squawk's concurrent-index *requirements* are disabled, but its transaction checks are kept.

The configured PostgreSQL target is 17.0, following the current Supabase default; confirm against the project's `SHOW server_version` before any future major-version upgrade. Lint does not replace testing the migration on a disposable local database.

## Narrow escape hatch

When a particular statement must deliberately break one rule, keep the exception **directly before that statement**:

```sql
set lock_timeout = '1s';
set statement_timeout = '5s';
-- Reason: approved cleanup after replacement and dependent readers were deployed.
-- squawk-ignore ban-drop-column
alter table public.example drop column retired_column;
```

Other Squawk safety checks, including lock and statement timeouts, remain active and must still pass. Choose timeout values appropriate to the operation and deployment.

Name specific rule(s) only, with a one-line `-- Reason: ...` immediately above the Squawk directive. Explain the concrete safety review in the PR. The guard rejects bare `squawk-ignore`, file-wide `squawk-ignore-file`, and transaction-mode overrides. Do not use an ignore to bypass RLS isolation checks or suppress an unreviewed destructive migration.

## Manual smoke check (do not commit samples)

After `npm ci`, use the CLI directly with transient SQL:

```sh
printf 'alter table public.example drop column old_column;\n' | ./node_modules/.bin/squawk --config .squawk.toml --stdin-filepath bad.sql
# Expected: non-zero, ban-drop-column
printf 'select 1;\n' | ./node_modules/.bin/squawk --config .squawk.toml --stdin-filepath good.sql
# Expected: exit 0
```
