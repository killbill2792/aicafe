-- Generic Supervisor approval and monitored-outcome ledger.
-- All writes are service-only after server-verified owner authorization.
create table public.supervisor_proposals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  location_id uuid,
  request_key uuid not null,
  capability_id text not null check (length(capability_id) between 1 and 120),
  capability_version int not null check (capability_version>0),
  canonical_effect_payload jsonb not null check (jsonb_typeof(canonical_effect_payload)='object'),
  effect_hash text not null check (effect_hash ~ '^[a-f0-9]{64}$'),
  baseline jsonb not null check (jsonb_typeof(baseline)='object'),
  monitor_spec jsonb not null check (jsonb_typeof(monitor_spec)='object'),
  locale text not null check (locale in ('en','es','ar')),
  status text not null default 'draft' check
    (status in ('draft','approved','committed','manual_pending','manual_confirmed','rejected','expired')),
  revision int not null default 1 check (revision>0),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  committed_at timestamptz,
  manual_confirmed_at timestamptz,
  monitoring_start_date date,
  updated_at timestamptz not null default now(),
  foreign key (business_id,thread_id,owner_user_id)
    references public.ai_threads(business_id,id,owner_user_id) on delete cascade,
  unique (business_id,owner_user_id,request_key),
  unique (business_id,id)
);
create index supervisor_proposals_monitor on public.supervisor_proposals (status,monitoring_start_date)
  where status in ('manual_confirmed','committed');
create table public.supervisor_approvals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  proposal_id uuid not null,
  owner_user_id uuid not null references auth.users(id),
  approved_revision int not null check (approved_revision>0),
  effect_hash text not null check (effect_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null default now(),
  unique (proposal_id),
  foreign key (business_id,proposal_id) references public.supervisor_proposals(business_id,id) on delete cascade
);
create table public.supervisor_monitor_samples (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  proposal_id uuid not null,
  business_date date not null,
  observation jsonb not null check (jsonb_typeof(observation)='object'),
  evidence_source text not null check (length(evidence_source) between 1 and 160),
  recorded_at timestamptz not null default now(),
  unique (business_id,proposal_id,business_date),
  foreign key (business_id,proposal_id) references public.supervisor_proposals(business_id,id) on delete cascade
);
create table public.supervisor_reports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  proposal_id uuid not null,
  report jsonb not null check (jsonb_typeof(report)='object'),
  status text not null check (status in ('in_progress','complete','insufficient_evidence')),
  generated_at timestamptz not null default now(),
  unique (business_id,proposal_id),
  foreign key (business_id,proposal_id) references public.supervisor_proposals(business_id,id) on delete cascade
);
alter table public.supervisor_proposals enable row level security;
alter table public.supervisor_approvals enable row level security;
alter table public.supervisor_monitor_samples enable row level security;
alter table public.supervisor_reports enable row level security;
create policy "owner private proposal read" on public.supervisor_proposals for select to authenticated using
  (owner_user_id=(select auth.uid()) and exists
    (select 1 from public.memberships m where m.business_id=supervisor_proposals.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner private approvals read" on public.supervisor_approvals for select to authenticated using
  (owner_user_id=(select auth.uid()) and exists
    (select 1 from public.memberships m where m.business_id=supervisor_approvals.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner private samples read" on public.supervisor_monitor_samples for select to authenticated using
  (exists (select 1 from public.supervisor_proposals p
      where p.business_id=supervisor_monitor_samples.business_id
      and p.id=supervisor_monitor_samples.proposal_id
      and p.owner_user_id=(select auth.uid()))
   and exists (select 1 from public.memberships m where m.business_id=supervisor_monitor_samples.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner private reports read" on public.supervisor_reports for select to authenticated using
  (exists (select 1 from public.supervisor_proposals p
      where p.business_id=supervisor_reports.business_id
      and p.id=supervisor_reports.proposal_id
      and p.owner_user_id=(select auth.uid()))
   and exists (select 1 from public.memberships m where m.business_id=supervisor_reports.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'));
revoke all on public.supervisor_proposals,public.supervisor_approvals,
 public.supervisor_monitor_samples,public.supervisor_reports from public,anon,authenticated;
grant select on public.supervisor_proposals,public.supervisor_approvals,
 public.supervisor_monitor_samples,public.supervisor_reports to authenticated;
grant all on public.supervisor_proposals,public.supervisor_approvals,
 public.supervisor_monitor_samples,public.supervisor_reports to service_role;

-- Lock the current revision and consume each approval once, atomically.
create function public.supervisor_transition_proposal(
 p_business_id uuid,p_owner_user_id uuid,p_proposal_id uuid,p_revision int,
 p_action text,p_monitoring_start_date date default null
) returns public.supervisor_proposals
language plpgsql security definer set search_path=public as $$
declare p public.supervisor_proposals; approved public.supervisor_approvals;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
  select * into p from public.supervisor_proposals
   where business_id=p_business_id and owner_user_id=p_owner_user_id and id=p_proposal_id for update;
  if p.id is null or p.revision<>p_revision then raise exception 'proposal_revision_conflict'; end if;
  if not exists (select 1 from public.memberships m where
      m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
   then raise exception 'proposal_owner_required'; end if;
  if p_action='approve' and p.status='draft' then
    insert into public.supervisor_approvals
      (business_id,proposal_id,owner_user_id,approved_revision,effect_hash)
      values (p_business_id,p.id,p_owner_user_id,p.revision,p.effect_hash);
    update public.supervisor_proposals set status='approved',approved_at=now(),
      approved_by=p_owner_user_id,revision=revision+1,updated_at=now() where id=p.id;
  elsif p_action='reject' and p.status in ('draft','approved') then
    update public.supervisor_proposals set status='rejected',revision=revision+1,
      updated_at=now() where id=p.id;
  elsif p_action in ('manual_pending','committed') and p.status='approved' then
    select * into approved from public.supervisor_approvals
      where business_id=p_business_id and proposal_id=p.id and owner_user_id=p_owner_user_id
      and effect_hash=p.effect_hash and approved_revision=p.revision-1;
    if approved.id is null then raise exception 'approval_missing_or_changed'; end if;
    update public.supervisor_proposals set status=p_action,revision=revision+1,
      committed_at=case when p_action='committed' then now() else null end,
      monitoring_start_date=case when p_action='committed' then coalesce(p_monitoring_start_date,current_date+1) else null end,
      updated_at=now() where id=p.id;
  elsif p_action='manual_confirmed' and p.status='manual_pending'
    and p_monitoring_start_date is not null
    and p_monitoring_start_date between current_date and current_date+3 then
    update public.supervisor_proposals set status='manual_confirmed',
      manual_confirmed_at=now(),monitoring_start_date=p_monitoring_start_date,
      revision=revision+1,updated_at=now() where id=p.id;
  else raise exception 'invalid_supervisor_proposal_transition'; end if;
  select * into p from public.supervisor_proposals where id=p_proposal_id;
  return p;
end $$;
revoke all on function public.supervisor_transition_proposal(uuid,uuid,uuid,int,text,date)
  from public,anon,authenticated;
grant execute on function public.supervisor_transition_proposal(uuid,uuid,uuid,int,text,date)
  to service_role;

-- Prevent a privileged lifecycle transition from silently replacing the approved effect.
create function public.supervisor_proposal_immutability()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.business_id is distinct from new.business_id
   or old.owner_user_id is distinct from new.owner_user_id
   or old.thread_id is distinct from new.thread_id
   or old.location_id is distinct from new.location_id
   or old.request_key is distinct from new.request_key
   or old.capability_id is distinct from new.capability_id
   or old.capability_version is distinct from new.capability_version
   or old.canonical_effect_payload is distinct from new.canonical_effect_payload
   or old.effect_hash is distinct from new.effect_hash
   or old.baseline is distinct from new.baseline
   or old.monitor_spec is distinct from new.monitor_spec
   or old.locale is distinct from new.locale
   or old.created_at is distinct from new.created_at
  then raise exception 'immutable_supervisor_effect'; end if;
  if new.revision <> old.revision + 1
   then raise exception 'supervisor_revision_required'; end if;
  return new;
end $$;
create trigger supervisor_proposal_immutable before update on public.supervisor_proposals
  for each row execute function public.supervisor_proposal_immutability();
-- Product/location scope is tenant-local. Never attach a location of another business.
create unique index if not exists locations_business_id_id_idx on public.locations(business_id,id);
alter table public.supervisor_proposals add constraint supervisor_proposal_tenant_location
  foreign key (business_id,location_id) references public.locations(business_id,id);
