-- Owner-approved generic Supervisor effect workflows. Additive, no POS writes.
create table if not exists public.supervisor_proposals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  location_id uuid null references public.locations(id) on delete restrict,
  capability_id text not null check (char_length(capability_id) between 1 and 120),
  capability_version integer not null check (capability_version=1),
  canonical_effect_payload jsonb not null check (jsonb_typeof(canonical_effect_payload)='object'),
  effect_hash text not null check (effect_hash ~ '^[a-f0-9]{64}$'),
  simulation jsonb not null check (jsonb_typeof(simulation)='object'),
  monitoring_spec jsonb not null check (jsonb_typeof(monitoring_spec)='object'),
  status text not null default 'draft' check
    (status in ('draft','approved','committed','manual_pending','manual_confirmed','rejected','expired')),
  revision integer not null default 1 check (revision>0),
  created_at timestamptz not null default now(),
  approved_at timestamptz, approved_by uuid references auth.users(id),
  committed_at timestamptz, committed_by uuid references auth.users(id),
  manual_confirmed_at timestamptz, manual_confirmed_by uuid references auth.users(id),
  monitoring_start_date date, report jsonb,
  report_created_at timestamptz,
  foreign key (business_id,thread_id,owner_user_id) references public.ai_threads
    (business_id,id,owner_user_id) on delete cascade,
  unique (business_id,id),
  check ((approved_at is null)=(approved_by is null)),
  check ((manual_confirmed_at is null)=(manual_confirmed_by is null))
);
create index if not exists supervisor_proposals_monitor_idx on
 public.supervisor_proposals (status, monitoring_start_date, business_id);
create index if not exists supervisor_proposals_thread_idx on
 public.supervisor_proposals (business_id,owner_user_id,thread_id,created_at desc);
create table if not exists public.supervisor_approvals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  proposal_id uuid not null,
  proposal_revision integer not null check (proposal_revision>0),
  approved_effect_hash text not null,
  actor_user_id uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  unique(proposal_id,proposal_revision),
  foreign key (business_id,proposal_id) references public.supervisor_proposals(business_id,id)
    on delete cascade
);
create table if not exists public.supervisor_monitor_samples (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  proposal_id uuid not null,
  business_date date not null,
  status text not null check (status in ('verified','unavailable')),
  units integer check (units is null or units >= 0),
  revenue_cents bigint check (revenue_cents is null or revenue_cents >= 0),
  observed_at timestamptz not null default now(),
  unique (proposal_id,business_date),
  foreign key (business_id,proposal_id) references public.supervisor_proposals(business_id,id)
    on delete cascade,
  check ((status='verified' and units is not null and revenue_cents is not null) or
    (status='unavailable' and units is null and revenue_cents is null))
);
-- Immutable effect identity, tenant/scope, monitoring contract and simulation:
-- a privileged service-role actor may change ONLY lifecycle state/results.
create or replace function public.supervisor_enforce_immutable_proposal()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.business_id is distinct from new.business_id
    or old.owner_user_id is distinct from new.owner_user_id
    or old.thread_id is distinct from new.thread_id
    or old.location_id is distinct from new.location_id
    or old.capability_id is distinct from new.capability_id
    or old.capability_version is distinct from new.capability_version
    or old.canonical_effect_payload is distinct from new.canonical_effect_payload
    or old.effect_hash is distinct from new.effect_hash
    or old.simulation is distinct from new.simulation
    or old.monitoring_spec is distinct from new.monitoring_spec
    or old.created_at is distinct from new.created_at
  then raise exception 'immutable_supervisor_effect'; end if;
  if new.revision <> old.revision+1 then raise exception 'supervisor_revision_mismatch'; end if;
  return new;
end; $$;
drop trigger if exists enforce_supervisor_proposal_effect on public.supervisor_proposals;
create trigger enforce_supervisor_proposal_effect before update on public.supervisor_proposals
 for each row execute function public.supervisor_enforce_immutable_proposal();
alter table public.supervisor_proposals enable row level security;
alter table public.supervisor_approvals enable row level security;
alter table public.supervisor_monitor_samples enable row level security;
create policy "proposals owner read" on public.supervisor_proposals for select to authenticated
 using (owner_user_id=(select auth.uid()) and exists (select 1 from public.memberships m
  where m.business_id=supervisor_proposals.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "approvals owner read" on public.supervisor_approvals for select to authenticated
 using (actor_user_id=(select auth.uid()) and exists (select 1 from public.memberships m
  where m.business_id=supervisor_approvals.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "samples owner read" on public.supervisor_monitor_samples for select to authenticated
 using (exists (select 1 from public.supervisor_proposals p join public.memberships m
   on m.business_id=p.business_id where p.id=supervisor_monitor_samples.proposal_id
   and p.business_id=supervisor_monitor_samples.business_id
   and p.owner_user_id=(select auth.uid()) and m.user_id=(select auth.uid()) and m.role='owner'));
revoke all on public.supervisor_proposals,public.supervisor_approvals,
 public.supervisor_monitor_samples from anon,authenticated;
grant select on public.supervisor_proposals,public.supervisor_approvals,
 public.supervisor_monitor_samples to authenticated;
grant all on public.supervisor_proposals,public.supervisor_approvals,
 public.supervisor_monitor_samples to service_role;
