-- M1: owner goals and experiments; only trusted server paths author records.
create table owner_initiatives (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  kind text not null check (kind in ('goal','experiment')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  change_description text not null default '',
  change_spec jsonb not null default '{}'::jsonb check (jsonb_typeof(change_spec)='object'),
  adapter_id text,
  starts_on date not null,
  ends_on date not null,
  baseline_from date not null,
  baseline_to date,
  checkin_cadence text not null check (checkin_cadence in ('daily','every_3_days','weekly','end_only')),
  status text not null default 'proposed' check (status in ('proposed','active','completed','cancelled','reverted')),
  locale text not null check (locale in ('en','es','ar')),
  revision int not null default 1 check (revision > 0),
  monitor_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id,thread_id,owner_user_id)
    references ai_threads(business_id,id,owner_user_id) on delete cascade,
  check (ends_on >= starts_on + 6 and ends_on <= starts_on + 91),
  check (baseline_from < starts_on and baseline_from >= starts_on - 92),
  check (baseline_to is null or (baseline_to >= baseline_from and baseline_to < starts_on)),
  check (kind <> 'goal' or (adapter_id is null and change_description = ''))
);
create index owner_initiatives_monitor_idx on owner_initiatives
  (monitor_checked_at asc nulls first,id) where status='active';
create index owner_initiatives_owner_idx on owner_initiatives
  (business_id,owner_user_id,created_at desc);

create table initiative_metrics (
  id uuid primary key default gen_random_uuid(),
  initiative_id uuid not null references owner_initiatives(id) on delete cascade,
  role text not null check (role in ('primary','guardrail')),
  source text not null check (source in ('computed','checkin')),
  metric_key text,
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params)='object'),
  comparator text not null check (comparator in ('gte','lte')),
  target_kind text not null check (target_kind in ('absolute','relative_pct')),
  target numeric not null,
  checkin_question text,
  checkin_audience text check (checkin_audience in ('owner','staff')),
  data_gap text,
  check ((source='computed' and metric_key is not null and checkin_question is null)
    or (source='checkin' and metric_key is null and char_length(btrim(checkin_question)) > 0)),
  check ((source='computed' and checkin_audience is null) or
    (source='checkin' and checkin_audience is not null))
);
create index initiative_metrics_initiative_idx on initiative_metrics(initiative_id);

create table initiative_observations (
  metric_id uuid not null references initiative_metrics(id) on delete cascade,
  business_date date not null,
  value numeric,
  coverage numeric not null check (coverage between 0 and 1),
  source text not null check (source in ('computed','owner_checkin','staff_checkin')),
  note text,
  unique(metric_id,business_date),
  check (value is not null or coverage < 1),
  check (note is null or char_length(note) <= 1000)
);

create table initiative_evaluations (
  id uuid primary key default gen_random_uuid(),
  initiative_id uuid not null references owner_initiatives(id) on delete cascade,
  as_of date not null,
  status text not null check (status in ('on_track','off_track','met','missed','insufficient_data')),
  results jsonb not null default '{}'::jsonb check (jsonb_typeof(results)='object'),
  recommendation text not null check (recommendation in ('keep','revert','adjust','extend','none')),
  digest text not null,
  created_at timestamptz not null default now(),
  unique(initiative_id,digest)
);
create index initiative_evaluations_latest_idx on initiative_evaluations(initiative_id,as_of desc,created_at desc);

alter table owner_initiatives enable row level security;
alter table initiative_metrics enable row level security;
alter table initiative_observations enable row level security;
alter table initiative_evaluations enable row level security;

create policy "initiative owner read" on owner_initiatives for select to authenticated using (
  owner_user_id=(select auth.uid()) and exists (
    select 1 from memberships m where m.business_id=owner_initiatives.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'
  )
);
create policy "initiative metrics owner read" on initiative_metrics for select to authenticated using (
  exists (select 1 from owner_initiatives i where i.id=initiative_metrics.initiative_id)
);
create policy "initiative observations owner read" on initiative_observations for select to authenticated using (
  exists (select 1 from initiative_metrics m where m.id=initiative_observations.metric_id)
);
create policy "initiative evaluations owner read" on initiative_evaluations for select to authenticated using (
  exists (select 1 from owner_initiatives i where i.id=initiative_evaluations.initiative_id)
);
-- RLS owner predicates work transitively through the parent. No authenticated direct writes.
revoke all on owner_initiatives,initiative_metrics,initiative_observations,initiative_evaluations from public,anon,authenticated;
grant select on owner_initiatives,initiative_metrics,initiative_observations,initiative_evaluations to authenticated;
grant all on owner_initiatives,initiative_metrics,initiative_observations,initiative_evaluations to service_role;
