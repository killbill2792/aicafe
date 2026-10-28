-- Audit log for the café data sync tool (scripts/sync-cafe-data.mjs). Records only aggregate
-- per-table row counts and an error code when a run fails — never row-level data, business
-- names, or any personal information.
create table if not exists cafe_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'error')),
  table_counts jsonb not null default '{}'::jsonb,
  error_table text,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists cafe_sync_runs_started_at_idx on cafe_sync_runs (started_at desc);

alter table cafe_sync_runs enable row level security;
-- No policies: this table is only ever read or written by the sync script's direct Postgres
-- connection (SUPABASE_DB_URL), which bypasses RLS. No anon or authenticated access is granted.
