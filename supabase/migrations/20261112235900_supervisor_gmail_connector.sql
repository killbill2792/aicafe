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

-- Gmail receipt-specific completion reuses the ONE Task 10 effect reservation.
-- Unlike the generic local effects, a Gmail 'verified' transition REQUIRES an
-- independently persisted provider receipt; an attempt key is never a receipt.
create function public.supervisor_finish_gmail_effect_attempt(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,
  p_attempt_key uuid,p_revision integer,p_state text,p_next_status text default null,
  p_monitoring_start_date date default null
) returns public.supervisor_proposals
language plpgsql security definer set search_path = public as $$
declare p public.supervisor_proposals; a public.supervisor_effect_attempts;
  r public.connector_provider_receipts;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  if not exists(select 1 from public.memberships m where m.business_id=p_business_id
      and m.user_id=p_owner_user_id and m.role='owner') then
    raise exception 'gmail_owner_required' using errcode='42501'; end if;
  select * into p from public.supervisor_proposals where business_id=p_business_id
    and owner_user_id=p_owner_user_id and thread_id=p_thread_id and id=p_proposal_id for update;
  select * into a from public.supervisor_effect_attempts where business_id=p_business_id
    and proposal_id=p_proposal_id and attempt_key=p_attempt_key for update;
  if p.id is null or p.status<>'executing' or p.revision<>p_revision
    or p.capability_id<>'alex.gmail_effect.v1' or p.capability_version<>1
    or a.id is null or a.effect_hash<>p.effect_hash
    or a.authorization_kind<>'click' or a.state not in ('executing','uncertain') then
    raise exception 'gmail_attempt_conflict' using errcode='P0001'; end if;
  if p_state='uncertain' then
    update public.supervisor_effect_attempts set state='uncertain' where id=a.id;
    return p;
  end if;
  if p_state<>'verified' or p_next_status<>'committed'
    or p_monitoring_start_date is null then
    raise exception 'gmail_completion_requires_provider_receipt' using errcode='42501'; end if;
  select * into r from public.connector_provider_receipts where business_id=p_business_id
    and owner_user_id=p_owner_user_id and proposal_id=p_proposal_id
    and effect_hash=p.effect_hash and state='verified'
    and provider_message_id is not null and provider_accepted_at is not null
    and account_id::text=p.canonical_effect_payload->>'accountId'
    and account_generation::text=p.canonical_effect_payload->>'generation'
    and operation=p.canonical_effect_payload->>'operation' for update;
  if r.id is null then raise exception 'gmail_provider_receipt_missing' using errcode='42501'; end if;
  update public.supervisor_effect_attempts set state='verified',
    verified_at=now(),receipt_ref='gmail:'||r.provider_message_id where id=a.id;
  update public.supervisor_proposals set status='committed',committed_at=now(),
    monitoring_start_date=p_monitoring_start_date,revision=revision+1,updated_at=now()
    where id=p.id returning * into p;
  return p;
end $$;
revoke all on function public.supervisor_finish_gmail_effect_attempt(
  uuid,uuid,uuid,uuid,uuid,integer,text,text,date) from public,anon,authenticated;
grant execute on function public.supervisor_finish_gmail_effect_attempt(
  uuid,uuid,uuid,uuid,uuid,integer,text,text,date) to service_role;
