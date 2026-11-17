-- Task 15B. One maintenance case = one operating_tasks row.
-- This ledger stores scoped evidence, never a parallel scheduler or effect gateway.
set lock_timeout = '10s';
set statement_timeout = '5min';

create table public.maintenance_case_events (
  business_id uuid not null references public.businesses(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  task_id text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 160),
  kind text not null check (kind in
    ('report','repair_claim','operational_verification','blocked','reopened','follow_up')),
  actor_kind text not null check (actor_kind in ('owner','staff','supervisor')),
  actor_user_id uuid,
  source_kind text not null check (source_kind in
    ('owner_report','owner_relay','owner_operational_check','system_follow_up')),
  source_id text not null check (length(source_id) between 1 and 160),
  note text check (note is null or length(note)<=1200),
  working_confirmed boolean not null default false,
  occurred_at timestamptz not null default statement_timestamp(),
  created_at timestamptz not null default statement_timestamp(),
  primary key (business_id,id),
  unique (business_id,task_id,idempotency_key),
  foreign key (business_id,task_id)
    references public.operating_tasks(business_id,id) on delete cascade
);
create index maintenance_case_events_case_idx
  on public.maintenance_case_events(business_id,task_id,occurred_at desc);

-- New private owner evidence. Staff updates are accepted only through a
-- separately authenticated report flow; staff cannot read other cases.
-- Reason: Tenant-scoped RLS is required for private maintenance evidence before owner read grants.
-- squawk-ignore ban-alter-row-level-security
alter table public.maintenance_case_events enable row level security;
create policy maintenance_case_events_owner_read
  on public.maintenance_case_events for select to authenticated
  using (exists(
    select 1 from public.memberships m
    where m.business_id=maintenance_case_events.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'
  ));
revoke all on public.maintenance_case_events from public,anon,authenticated;
grant select on public.maintenance_case_events to authenticated;
grant all on public.maintenance_case_events to service_role;

-- Existing "members read" + "members write" policies on operating_tasks are
-- PERMISSIVE; they also authorize SELECT. Maintenance reports contain private
-- symptoms, owner identity, and repair evidence. A separate RESTRICTIVE SELECT
-- policy ANDs with those old grants without changing other operating tasks.
-- Supabase service_role / trusted privileged jobs still bypass RLS.
create policy maintenance_case_canonical_owner_only
  on public.operating_tasks as restrictive for select to authenticated
  using (
    kind <> 'maintenance_issue'
    or (
      owner_user_id = (select auth.uid())
      and exists (
        select 1 from public.memberships m
        where m.business_id=operating_tasks.business_id
          and m.user_id=(select auth.uid()) and m.role='owner'
      )
    )
  );

-- Existing operating_tasks has a broad member-write policy. Maintenance
-- state must NOT be closable by direct member UPDATE/DELETE. Protect the
-- existing row on every operation, including kind changes and insertion.
create function public.maintenance_guard_case_row()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_protected boolean:=false;
begin
  -- The trigger covers ALL operating_tasks. Never inspect OLD on INSERT or
  -- NEW on DELETE; ordinary tasks must keep their existing write semantics.
  if tg_op='INSERT' then
    v_protected:=new.kind='maintenance_issue';
  elsif tg_op='UPDATE' then
    v_protected:=old.kind='maintenance_issue' or new.kind='maintenance_issue';
  else
    v_protected:=old.kind='maintenance_issue';
  end if;
  if v_protected then
    -- Owner/member SQL cannot archive, transform, or delete maintenance cases.
    -- Verified SECURITY DEFINER RPCs run as postgres. Trusted erasure may
    -- DELETE via service_role or postgres and must not block FK cascades.
    if current_user not in ('postgres','service_role') or
      (tg_op<>'DELETE' and
        current_setting('app.maintenance_case_transition',true) is distinct from 'allowed')
      then
      raise exception 'Maintenance case transition requires the verified case RPC'
        using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger maintenance_guard_operating_tasks
before insert or update or delete on public.operating_tasks
for each row execute function public.maintenance_guard_case_row();

-- Event receipts cannot be edited. Owner/employee roles have no DELETE grant;
-- trusted service-role deletion remains available for account erasure/privacy.
create function public.maintenance_guard_event_history()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  raise exception 'Maintenance event history is immutable' using errcode='42501';
end $$;
create trigger maintenance_event_history_immutable
before update on public.maintenance_case_events
for each row execute function public.maintenance_guard_event_history();

-- Owner reports are saved immediately as one canonical open operating task.
-- Source identity and retry nonce are provided by the authenticated caller,
-- not by a model. An owner report is evidence of a REPORT, not a sensor proof.
create function public.maintenance_report_case(
  p_business_id uuid,p_case_nonce uuid,p_equipment_label text,
  p_symptom text,p_severity text,p_observed_at timestamptz
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_owner uuid:=auth.uid();
  v_task text;
  v_existing public.operating_tasks;
begin
  if auth.role()<>'authenticated' or v_owner is null or not exists (
    select 1 from public.memberships m
    where m.business_id=p_business_id and m.user_id=v_owner and m.role='owner'
  ) then
    raise exception 'Owner access required' using errcode='42501';
  end if;
  if p_case_nonce is null or length(btrim(coalesce(p_equipment_label,''))) not between 1 and 120
    or length(btrim(coalesce(p_symptom,''))) not between 1 and 1200
    or p_severity not in ('critical','high','normal','unknown')
    or p_observed_at is null or p_observed_at>statement_timestamp()+interval '5 minutes'
    or p_observed_at<statement_timestamp()-interval '90 days' then
    raise exception 'Invalid maintenance report' using errcode='22023';
  end if;
  v_task:='maintenance:'||p_case_nonce::text;
  perform set_config('app.maintenance_case_transition','allowed',true);
  insert into public.operating_tasks
    (id,business_id,agent_id,kind,entity_type,entity_id,status,payload,
     confidence,evidence,owner_user_id)
  values
    (v_task,p_business_id,'leo','maintenance_issue','equipment_report',
     p_case_nonce::text,'needs_owner',
     jsonb_build_object('equipmentLabel',btrim(p_equipment_label),
       'symptom',btrim(p_symptom),'severity',p_severity,
       'reportedAt',p_observed_at,'maintenanceStage','reported',
       'repairVerified',false,'externalSent',false),
     'low',
     jsonb_build_array(jsonb_build_object('source','owner_report',
       'facts',jsonb_build_object('reported',true,'severity',p_severity,
         'quality','unverified'))),
     v_owner)
  on conflict (business_id,id) do nothing;
  select * into v_existing from public.operating_tasks
    where business_id=p_business_id and id=v_task for update;
  if not found or v_existing.kind<>'maintenance_issue' or
     v_existing.owner_user_id is distinct from v_owner or
     v_existing.payload->>'equipmentLabel' is distinct from btrim(p_equipment_label) or
     v_existing.payload->>'symptom' is distinct from btrim(p_symptom) or
     v_existing.payload->>'severity' is distinct from p_severity or
     v_existing.payload->>'reportedAt' is distinct from to_jsonb(p_observed_at)#>>'{}' then
    -- The nonce may not silently refer to a different report.
    raise exception 'Maintenance report nonce conflict' using errcode='23505';
  end if;
  insert into public.maintenance_case_events
    (business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,
     source_kind,source_id,note,occurred_at)
  values (p_business_id,v_task,'report:'||p_case_nonce::text,'report','owner',
    v_owner,'owner_report',p_case_nonce::text,p_symptom,p_observed_at)
  on conflict (business_id,task_id,idempotency_key) do nothing;
  return v_task;
end $$;
revoke all on function public.maintenance_report_case(uuid,uuid,text,text,text,timestamptz)
  from public,anon;
grant execute on function public.maintenance_report_case(uuid,uuid,text,text,text,timestamptz)
  to authenticated;

-- Owner-only observed progress, with a second source check before closing.
-- The owner may relay a technician's claim but that claim alone NEVER closes.
-- An owner physical/operational verification must follow it.
create function public.maintenance_record_progress(
  p_business_id uuid,p_task_id text,p_nonce uuid,p_kind text,
  p_note text,p_working_confirmed boolean
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_owner uuid:=auth.uid();
  v_case public.operating_tasks;
  v_stage text;
  v_source text;
begin
  if auth.role()<>'authenticated' or v_owner is null or not exists (
    select 1 from public.memberships m where m.business_id=p_business_id
      and m.user_id=v_owner and m.role='owner'
  ) then raise exception 'Owner access required' using errcode='42501'; end if;
  if p_nonce is null or p_task_id is null or length(p_task_id) not between 1 and 160
     or p_kind not in ('repair_claim','operational_verification','blocked','reopened','follow_up')
     or length(coalesce(p_note,''))>1200
     or (p_kind in ('repair_claim','blocked') and length(btrim(coalesce(p_note,'')))=0)
     then
    raise exception 'Invalid maintenance update' using errcode='22023';
  end if;
  select * into v_case from public.operating_tasks
    where business_id=p_business_id and id=p_task_id
      and kind='maintenance_issue' and owner_user_id=v_owner for update;
  if not found then raise exception 'Maintenance case unavailable' using errcode='42501'; end if;
  -- Retried requests return their original stage without recording a second event.
  if exists(select 1 from public.maintenance_case_events e
    where e.business_id=p_business_id and e.task_id=p_task_id
      and e.idempotency_key=p_nonce::text) then
    -- An idempotency key reused for a DIFFERENT owner action is a conflict,
    -- never a successful no-op that could be reported as approved/verified.
    if not exists(select 1 from public.maintenance_case_events e
      where e.business_id=p_business_id and e.task_id=p_task_id
        and e.idempotency_key=p_nonce::text
        and e.kind=p_kind
        and e.note is not distinct from p_note
        and e.working_confirmed=coalesce(p_working_confirmed,false)) then
      raise exception 'Maintenance action nonce conflict' using errcode='23505';
    end if;
    return v_case.payload->>'maintenanceStage';
  end if;
  v_stage:=v_case.payload->>'maintenanceStage';
  if p_kind='repair_claim' then
    if v_stage='verified_repaired' then raise exception 'Case already resolved' using errcode='22023'; end if;
    v_source:='owner_relay';
    v_stage:='repair_claimed';
  elsif p_kind='operational_verification' then
    if v_stage<>'repair_claimed' or p_working_confirmed is distinct from true
      or not exists(select 1 from public.maintenance_case_events e
        where e.business_id=p_business_id and e.task_id=p_task_id and e.kind='repair_claim')
      then raise exception 'Independent working-equipment check and prior claim required'
        using errcode='22023'; end if;
    v_source:='owner_operational_check';
    v_stage:='verified_repaired';
  elsif p_kind='reopened' then
    if v_stage not in ('verified_repaired','blocked') then
      raise exception 'Only closed or blocked cases can reopen' using errcode='22023'; end if;
    v_source:='owner_report';
    v_stage:='reopened';
  elsif p_kind='blocked' then
    v_source:='owner_report';
    v_stage:='blocked';
  else
    v_source:='owner_report';
    if v_stage='verified_repaired' then raise exception 'Case already resolved' using errcode='22023'; end if;
  end if;
  insert into public.maintenance_case_events
    (business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,
     source_kind,source_id,note,working_confirmed)
  values (p_business_id,p_task_id,p_nonce::text,p_kind,'owner',v_owner,
    v_source,p_nonce::text,p_note,coalesce(p_working_confirmed,false));
  perform set_config('app.maintenance_case_transition','allowed',true);
  update public.operating_tasks set
    status=case when v_stage='verified_repaired' then 'handled' else 'needs_owner' end,
    resolved_at=case when v_stage='verified_repaired' then statement_timestamp() else null end,
    payload=payload||jsonb_build_object('maintenanceStage',v_stage,
      'repairVerified',(v_stage='verified_repaired')),
    -- Evidence revision reawakens the *existing* 15A agent when a case
    -- changes, instead of suppressing updates for 24 hours.
    evidence=evidence||jsonb_build_array(jsonb_build_object(
      'source','maintenance_case_events','facts',jsonb_build_object(
        'kind',p_kind,'maintenanceStage',v_stage,
        'workingConfirmed',coalesce(p_working_confirmed,false),
        'observedAt',statement_timestamp()))),
    updated_at=statement_timestamp()
  where business_id=p_business_id and id=p_task_id;
  return v_stage;
end $$;
revoke all on function public.maintenance_record_progress(uuid,text,uuid,text,text,boolean)
  from public,anon;
grant execute on function public.maintenance_record_progress(uuid,text,uuid,text,text,boolean)
  to authenticated;
