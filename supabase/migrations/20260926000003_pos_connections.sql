-- ===== POS connection ===== (docs/04-data-model.md, docs/06-integrations.md)
-- 'demo' is not a real provider adapter but lets the seeded demo business carry a
-- connection row (status 'active') so screens that branch on pos_connections behave
-- the same as a connected real café. See lib/pos/ for the adapter interface.
create table if not exists pos_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  provider text not null check (provider in ('square','toast','clover','csv','demo')),
  merchant_id text,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  status text not null default 'active' check (status in ('active','needs_reconnect','disconnected')),
  last_synced_at timestamptz,
  backfill_completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists pos_connections_business_id_idx on pos_connections (business_id);
