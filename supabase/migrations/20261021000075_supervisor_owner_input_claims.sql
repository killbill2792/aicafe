-- One-shot claims for owner-confirmed Supervisor-provided facts.
-- No owner/browser access: all writes go through the authenticated Server route,
-- compiled write registry, and existing domain action. A crash after claiming
-- may leave 'started': it must never automatically repeat the domain write.
create table if not exists public.supervisor_owner_input_claims (
  question_id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'started' check (state in ('started','applied','uncertain')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supervisor_owner_input_claims_owner_idx
  on public.supervisor_owner_input_claims(business_id,owner_user_id,created_at desc);
alter table public.supervisor_owner_input_claims enable row level security;
revoke all on public.supervisor_owner_input_claims from public,anon,authenticated;
grant select,insert,update on public.supervisor_owner_input_claims to service_role;
comment on table public.supervisor_owner_input_claims is
  'Private one-time claims; started/uncertain never grants automatic retry of a domain effect.';
