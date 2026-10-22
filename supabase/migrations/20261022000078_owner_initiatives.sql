-- M1: owner goals and experiments; only trusted server paths author records.
create table owner_initiatives (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  request_key text not null,
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
  evidence_revision bigint not null default 0 check (evidence_revision >= 0),
  monitor_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id,owner_user_id,request_key),
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
  revision int not null default 1 check(revision>0),
  verified_at timestamptz not null default now(),
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
  inputs jsonb not null default '{}'::jsonb check (jsonb_typeof(inputs)='object'),
  transition_key text not null check (char_length(transition_key) between 12 and 160),
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


-- A single service-role RPC atomically creates both an inert proposal and its
-- metric rows. The logical owner message/arguments key survives tool-call retries.
create or replace function create_owner_initiative_atomic(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_request_key text, p_proposal jsonb, p_metrics jsonb
) returns uuid language plpgsql security definer set search_path=public
as $$
declare new_id uuid; metric jsonb;
begin
  if char_length(p_request_key) < 12 or
     jsonb_typeof(p_metrics) <> 'array' or jsonb_array_length(p_metrics) < 1
     or jsonb_array_length(p_metrics)>13 then
    raise exception 'invalid initiative input' using errcode='23514';
  end if;
  if not exists(select 1 from memberships where business_id=p_business_id
       and user_id=p_owner_user_id and role='owner')
     or not exists(select 1 from ai_threads where business_id=p_business_id
       and owner_user_id=p_owner_user_id and id=p_thread_id) then
    raise exception 'owner/thread scope mismatch' using errcode='42501';
  end if;
  insert into owner_initiatives(
    business_id,owner_user_id,thread_id,request_key,
    kind,title,change_description,change_spec,adapter_id,starts_on,ends_on,
    baseline_from,baseline_to,checkin_cadence,status,locale
  ) values (
    p_business_id,p_owner_user_id,p_thread_id,p_request_key,
    p_proposal->>'kind',p_proposal->>'title',p_proposal->>'changeDescription',
    coalesce(p_proposal->'changeSpec','{}'::jsonb),p_proposal->>'adapterId',
    (p_proposal->>'startsOn')::date,(p_proposal->>'endsOn')::date,
    (p_proposal->>'baselineFrom')::date,(p_proposal->>'baselineTo')::date,
    p_proposal->>'checkinCadence','proposed',p_proposal->>'locale'
  ) on conflict (business_id,owner_user_id,request_key) do nothing returning id into new_id;
  if new_id is null then
    select id into new_id from owner_initiatives
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and request_key=p_request_key;
    if new_id is null then raise exception 'initiative request conflict'; end if;
    return new_id;
  end if;
  for metric in select value from jsonb_array_elements(p_metrics) loop
    insert into initiative_metrics(
      initiative_id,role,source,metric_key,params,comparator,target_kind,target,
      checkin_question,checkin_audience,data_gap
    ) values (
      new_id,metric->>'role',metric->>'source',metric->>'metric_key',
      coalesce(metric->'params','{}'::jsonb),metric->>'comparator',
      metric->>'target_kind',(metric->>'target')::numeric,
      metric->>'checkin_question',metric->>'checkin_audience',metric->>'data_gap'
    );
  end loop;
  if not exists(select 1 from initiative_metrics where initiative_id=new_id and role='primary')
    then raise exception 'primary initiative metric required' using errcode='23514';
  end if;
  return new_id;
end;
$$;
revoke all on function create_owner_initiative_atomic(uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function create_owner_initiative_atomic(uuid,uuid,uuid,text,jsonb,jsonb) to service_role;


-- A logical delivery is immutable and separately deduplicated from corrections.
create table initiative_checkin_operations(
  metric_id uuid not null references initiative_metrics(id) on delete cascade,
  operation_key text not null,
  business_date date not null,
  revision int not null,
  created boolean not null,
  corrected boolean not null,
  created_at timestamptz not null default now(),
  primary key(metric_id,operation_key)
);
alter table initiative_checkin_operations enable row level security;
revoke all on initiative_checkin_operations from public,anon,authenticated;
grant all on initiative_checkin_operations to service_role;

-- Locks one metric/day across concurrent requests, but only allows a correction
-- that carries the currently visible revision. Older deliveries replay their own
-- original outcome instead of reverting a newer answer.
create or replace function record_owner_initiative_checkin_atomic(
  p_business_id uuid,p_owner_user_id uuid,p_metric_id uuid,p_date date,
  p_value numeric,p_note text,p_expected_revision int,p_operation_key text
) returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  start_day date; end_day date; current_revision int; initiative_key uuid;
  old_value numeric; old_note text; old_source text;
  old_operation initiative_checkin_operations%rowtype;
  is_new boolean := false; is_correction boolean := false;
begin
  if char_length(p_operation_key)<12 then
    raise exception 'check-in operation identity required' using errcode='23514';
  end if;
  if not exists(select 1 from memberships where business_id=p_business_id
    and user_id=p_owner_user_id and role='owner') then
    raise exception 'owner membership required' using errcode='42501';
  end if;
  select i.id,i.starts_on,i.ends_on into initiative_key,start_day,end_day
    from initiative_metrics m join owner_initiatives i on i.id=m.initiative_id
    where m.id=p_metric_id and m.source='checkin'
      and m.checkin_audience='owner' and i.business_id=p_business_id
      and i.owner_user_id=p_owner_user_id and i.status='active'
    for update of i;
  if not found or p_date<start_day or p_date>end_day then
    raise exception 'check-in not authorized' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_metric_id::text||':'||p_date::text,0));
  select * into old_operation from initiative_checkin_operations
    where metric_id=p_metric_id and operation_key=p_operation_key;
  if found then
    return jsonb_build_object('created',old_operation.created,
      'corrected',old_operation.corrected,'revision',old_operation.revision);
  end if;
  select revision,value,note,source into current_revision,old_value,old_note,old_source
    from initiative_observations
    where metric_id=p_metric_id and business_date=p_date for update;
  if not found then
    if p_expected_revision is not null then
      raise exception 'stale check-in revision' using errcode='40001';
    end if;
    insert into initiative_observations(metric_id,business_date,value,coverage,source,note,revision)
      values(p_metric_id,p_date,p_value,case when p_value is null then 0 else 1 end,
        'owner_checkin',p_note,1);
    current_revision:=1;
    is_new:=true;
  else
    if p_expected_revision is distinct from current_revision or old_source<>'owner_checkin' then
      raise exception 'stale check-in revision' using errcode='40001';
    end if;
    if old_value is distinct from p_value or old_note is distinct from p_note then
      update initiative_observations set value=p_value,
        coverage=case when p_value is null then 0 else 1 end,
        note=p_note,revision=current_revision+1
        where metric_id=p_metric_id and business_date=p_date;
      current_revision:=current_revision+1;
      is_correction:=true;
    end if;
  end if;
  insert into initiative_checkin_operations(metric_id,operation_key,business_date,
    revision,created,corrected)
    values(p_metric_id,p_operation_key,p_date,current_revision,is_new,is_correction);
  if is_new or is_correction then
    -- Owner corrections invalidate the active monitor lease. All fenced writes
    -- and terminal completion from its old evidence snapshot must then fail.
    update owner_initiatives set evidence_revision=evidence_revision+1,
      monitor_lease_token=null,monitor_lease_until=null,updated_at=now()
      where id=initiative_key;
  end if;
  return jsonb_build_object('created',is_new,'corrected',is_correction,
    'revision',current_revision);
end;
$$;
revoke all on function record_owner_initiative_checkin_atomic(
  uuid,uuid,uuid,date,numeric,text,int,text) from public,anon,authenticated;
grant execute on function record_owner_initiative_checkin_atomic(
  uuid,uuid,uuid,date,numeric,text,int,text) to service_role;


-- Durable and exclusive bounded monitor work leases. A queued row is not a claim:
-- overlapping cron invocations must not hold simultaneous writer authority.
alter table owner_initiatives
  add column monitor_lease_token uuid,
  add column monitor_lease_until timestamptz;
create index owner_initiatives_lease_idx on owner_initiatives
  (monitor_lease_until,monitor_checked_at) where status='active';

create or replace function claim_owner_initiative_monitor(
  p_id uuid,p_revision int,p_token uuid
) returns int language plpgsql security definer set search_path=public
as $$
declare v_revision int;
begin
  update owner_initiatives set
    monitor_lease_token=p_token,monitor_lease_until=now()+interval '90 seconds',
    monitor_checked_at=now(),updated_at=now(),revision=revision+1
  where id=p_id and revision=p_revision and status='active'
    and (monitor_lease_until is null or monitor_lease_until<=now())
  returning revision into v_revision;
  return v_revision;
end;
$$;
revoke all on function claim_owner_initiative_monitor(uuid,int,uuid) from public,anon,authenticated;
grant execute on function claim_owner_initiative_monitor(uuid,int,uuid) to service_role;

create or replace function release_owner_initiative_monitor(
  p_id uuid,p_token uuid,p_completed boolean,p_expected_evidence_revision bigint
) returns boolean language plpgsql security definer set search_path=public
as $$
declare v_id uuid;
begin
  update owner_initiatives set
    monitor_lease_token=null,monitor_lease_until=null,
    status=case when p_completed then 'completed' else status end,
    updated_at=now()
  where id=p_id and monitor_lease_token=p_token and status='active'
    and (not p_completed or evidence_revision=p_expected_evidence_revision)
  returning id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function release_owner_initiative_monitor(uuid,uuid,boolean,bigint) from public,anon,authenticated;
grant execute on function release_owner_initiative_monitor(uuid,uuid,boolean,bigint) to service_role;

-- Serializable with claim/release via the parent row lock. A worker that lost
-- its lease can never write a late observation, including after a long timeout.
create or replace function write_owner_initiative_monitor_observation(
  p_business_id uuid,p_owner_user_id uuid,p_initiative_id uuid,p_token uuid,
  p_metric_id uuid,p_date date,p_value numeric,p_coverage numeric,p_note text,
  p_allow_invalidation boolean
) returns boolean language plpgsql security definer set search_path=public
as $$
declare permitted uuid; stored uuid;
begin
  select id into permitted from owner_initiatives
    where id=p_initiative_id and business_id=p_business_id and owner_user_id=p_owner_user_id
      and monitor_lease_token=p_token and monitor_lease_until>now()
      and status='active' for update;
  if permitted is null then return false; end if;
  if not exists(select 1 from initiative_metrics where id=p_metric_id
       and initiative_id=p_initiative_id and source='computed') then
    raise exception 'monitor metric scope mismatch' using errcode='42501';
  end if;
  insert into initiative_observations as existing (
    metric_id,business_date,value,coverage,source,note,revision
  ) values (p_metric_id,p_date,p_value,p_coverage,'computed',p_note,1)
  on conflict (metric_id,business_date) do update set
    value=excluded.value,coverage=excluded.coverage,note=excluded.note,
    verified_at=now(),
    revision=existing.revision+case when
      existing.value is distinct from excluded.value
      or existing.coverage is distinct from excluded.coverage
      or existing.note is distinct from excluded.note
      then 1 else 0 end
    where existing.source='computed'
      and (existing.coverage<=excluded.coverage or p_allow_invalidation)
  returning metric_id into stored;
  return stored is not null;
end;
$$;
revoke all on function write_owner_initiative_monitor_observation(
  uuid,uuid,uuid,uuid,uuid,date,numeric,numeric,text,boolean) from public,anon,authenticated;
grant execute on function write_owner_initiative_monitor_observation(
  uuid,uuid,uuid,uuid,uuid,date,numeric,numeric,text,boolean) to service_role;

create or replace function write_owner_initiative_monitor_evaluation(
  p_business_id uuid,p_owner_user_id uuid,p_initiative_id uuid,p_token uuid,
  p_as_of date,p_status text,p_recommendation text,p_results jsonb,
  p_inputs jsonb,p_transition_key text,p_digest text
) returns boolean language plpgsql security definer set search_path=public
as $$
declare permitted uuid; stored uuid;
begin
  select id into permitted from owner_initiatives
    where id=p_initiative_id and business_id=p_business_id and owner_user_id=p_owner_user_id
      and monitor_lease_token=p_token and monitor_lease_until>now()
      and status='active' for update;
  if permitted is null then return false; end if;
  insert into initiative_evaluations (
    initiative_id,as_of,status,recommendation,results,inputs,transition_key,digest
  ) values (
    p_initiative_id,p_as_of,p_status,p_recommendation,p_results,p_inputs,
    p_transition_key,p_digest
  ) on conflict (initiative_id,digest) do nothing returning id into stored;
  return stored is not null;
end;
$$;
revoke all on function write_owner_initiative_monitor_evaluation(
  uuid,uuid,uuid,uuid,date,text,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function write_owner_initiative_monitor_evaluation(
  uuid,uuid,uuid,uuid,date,text,text,jsonb,jsonb,text,text) to service_role;


-- Aggregate all order rows inside PostgreSQL; PostgREST's 1000-row response
-- cap and the daily rollup's old limited-source reader cannot certify sales.
-- Synthetic CSV product groups retain a provable SALES sum but are not orders.
create or replace function initiative_daily_order_sales_proof(
  p_business_id uuid,p_date date
) returns table(order_count bigint,net_sales_cents bigint,synthetic_count bigint)
language sql security definer set search_path=public
as $$
  select count(*)::bigint,coalesce(sum(o.net_sales_cents),0)::bigint,
    count(*) filter(where o.pos_order_id is null
      or o.pos_order_id like 'csv-%' or o.pos_order_id like 'csv:%')::bigint
  from orders o where o.business_id=p_business_id and o.business_date=p_date;
$$;
revoke all on function initiative_daily_order_sales_proof(uuid,date) from public,anon,authenticated;
grant execute on function initiative_daily_order_sales_proof(uuid,date) to service_role;


-- The notification outbox write and lease/evidence check are one transaction.
-- A stale worker may not publish a recommendation from an invalidated snapshot.
create or replace function insert_monitor_team_update_fenced(
  p_initiative_id uuid,p_token uuid,p_evidence_revision bigint,p_row jsonb
) returns text language plpgsql security definer set search_path=public
as $$
declare b uuid; u uuid; saved uuid;
begin
  select i.business_id,i.owner_user_id into b,u from owner_initiatives i
    where i.id=p_initiative_id and i.monitor_lease_token=p_token
      and i.monitor_lease_until>now() and i.evidence_revision=p_evidence_revision
      and i.status='active' for update of i;
  if not found then return 'stale'; end if;
  if p_row->>'business_id' is distinct from b::text or
     p_row->>'owner_user_id' is distinct from u::text or
     p_row->>'subject_type' is distinct from 'owner_initiative' or
     p_row->>'subject_id' is distinct from p_initiative_id::text then
    raise exception 'team update tenant/initiative scope mismatch' using errcode='42501';
  end if;
  insert into team_updates(business_id,owner_user_id,agent_id,domain,kind,
    severity,subject_type,subject_id,facts,text,locale,actions,dedupe_key)
  values(b,u,p_row->>'agent_id',p_row->>'domain',p_row->>'kind',
    p_row->>'severity','owner_initiative',p_initiative_id,
    coalesce(p_row->'facts','{}'::jsonb),p_row->>'text',p_row->>'locale',
    coalesce(p_row->'actions','[]'::jsonb),p_row->>'dedupe_key')
  on conflict (business_id,dedupe_key) do nothing returning id into saved;
  return case when saved is null then 'duplicate' else 'created' end;
end;
$$;
revoke all on function insert_monitor_team_update_fenced(uuid,uuid,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function insert_monitor_team_update_fenced(uuid,uuid,bigint,jsonb)
  to service_role;
