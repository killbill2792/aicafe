-- Task 11: Gmail connector, service-only credentials and source-backed provider receipts.
-- Additive only. Applying this migration in production requires separate owner release approval.
set lock_timeout = '3s';
set statement_timeout = '30s';

create table public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider = 'gmail'),
  provider_subject text not null check (length(provider_subject) between 1 and 255),
  email text not null check (length(email) between 3 and 320),
  granted_scopes text[] not null default '{}',
  status text not null check (status in ('active','needs_reconnect','revoking','disconnected')),
  generation bigint not null default 1 check (generation > 0),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, owner_user_id, provider),
  unique (id, business_id, owner_user_id)
);
create index connector_accounts_owner on public.connector_accounts (business_id,owner_user_id,status);
alter table public.connector_accounts enable row level security;
revoke all on public.connector_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.connector_accounts to service_role;

create table public.connector_credentials (
  account_id uuid primary key references public.connector_accounts(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text not null,
  token_expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (length(access_token_enc) > 30 and length(refresh_token_enc) > 30)
);
alter table public.connector_credentials enable row level security;
revoke all on public.connector_credentials from public, anon, authenticated;
grant select, insert, update, delete on public.connector_credentials to service_role;

create table public.connector_oauth_states (
  state_digest text primary key check (state_digest ~ '^[a-f0-9]{64}$'),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  pkce_verifier_enc text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index connector_oauth_states_expiry on public.connector_oauth_states(expires_at);
alter table public.connector_oauth_states enable row level security;
revoke all on public.connector_oauth_states from public, anon, authenticated;
grant select, insert, update, delete on public.connector_oauth_states to service_role;

create table public.connector_provider_receipts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  business_id uuid not null,
  owner_user_id uuid not null,
  proposal_id uuid not null,
  effect_hash text not null check (effect_hash ~ '^[a-f0-9]{64}$'),
  account_generation bigint not null check (account_generation > 0),
  operation text not null check (operation in ('send','draft','modify','trash','restore','create_label')),
  rfc_message_id text,
  provider_message_id text,
  provider_thread_id text,
  state text not null check (state in ('pending','verified','uncertain')),
  provider_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id,business_id,owner_user_id)
    references public.connector_accounts(id,business_id,owner_user_id) on delete cascade,
  foreign key (business_id,proposal_id)
    references public.supervisor_proposals(business_id,id) on delete cascade,
  unique (business_id,proposal_id,effect_hash),
  check (state <> 'verified' or (provider_message_id is not null and provider_accepted_at is not null))
);
create unique index connector_provider_receipts_rfc_id
  on public.connector_provider_receipts(account_id,rfc_message_id)
  where rfc_message_id is not null;
alter table public.connector_provider_receipts enable row level security;
revoke all on public.connector_provider_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.connector_provider_receipts to service_role;

-- Never expose any connector credential or OAuth state through an authenticated RLS policy.
