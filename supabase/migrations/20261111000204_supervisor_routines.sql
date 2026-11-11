-- Task 7: one owner-scoped routine occurrence per café-local day, and one
-- private priority notice via the existing operating_tasks + ai_messages inbox.
-- This migration is additive: it never changes the Task 6 durable run/worker path.
create table public.supervisor_routines (
  business_id uuid not null references public.businesses(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 240),
  cadence text not null check (cadence in ('daily','weekly')),
  weekdays integer[] not null default '{}',
  local_time time without time zone not null,
  timezone text not null,
  status text not null default 'active' check (status in ('active','paused','revoked')),
  revision integer not null default 1 check (revision>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id,id),
  foreign key (business_id,thread_id,owner_user_id)
    references public.ai_threads(business_id,id,owner_user_id) on delete cascade,
  check ((cadence='daily' and cardinality(weekdays)=0) or
    (cadence='weekly' and cardinality(weekdays) between 1 and 7)),
  check (weekdays <@ array[1,2,3,4,5,6,7]::integer[])
);
create index supervisor_routines_due_idx on public.supervisor_routines
  (business_id,status,owner_user_id) where status='active';

create table public.supervisor_routine_occurrences (
  business_id uuid not null,
  routine_id uuid not null,
  local_date date not null,
  run_id uuid not null default gen_random_uuid(),
  revision integer not null check (revision>0),
  scheduled_for_utc timestamptz not null,
  state text not null default 'pending'
    check (state in ('pending','running','completed','failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  lease_token uuid,
  lease_until timestamptz,
  next_retry_at timestamptz,
  last_error text,
  receipt_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id,routine_id,local_date),
  unique (run_id),
  foreign key (business_id,routine_id)
    references public.supervisor_routines(business_id,id) on delete cascade,
  check ((state='running')=(lease_token is not null and lease_until is not null)),
  check (state<>'completed' or receipt_ref is not null)
);
create index supervisor_occurrences_retry_idx on public.supervisor_routine_occurrences
  (next_retry_at,lease_until) where state in ('pending','running');

alter table public.supervisor_routines enable row level security;
alter table public.supervisor_routine_occurrences enable row level security;
create policy supervisor_routines_owner_select on public.supervisor_routines
  for select to authenticated using (
    owner_user_id=(select auth.uid()) and exists (
      select 1 from public.memberships m where m.business_id=supervisor_routines.business_id
        and m.user_id=(select auth.uid()) and m.role='owner'
    )
  );
create policy supervisor_occurrences_owner_select on public.supervisor_routine_occurrences
  for select to authenticated using (exists (
    select 1 from public.supervisor_routines r
      where r.business_id=supervisor_routine_occurrences.business_id
        and r.id=supervisor_routine_occurrences.routine_id
        and r.owner_user_id=(select auth.uid())
  ));
revoke all on public.supervisor_routines,public.supervisor_routine_occurrences
  from public,anon,authenticated;
grant select on public.supervisor_routines,public.supervisor_routine_occurrences to authenticated;
grant all on public.supervisor_routines,public.supervisor_routine_occurrences to service_role;

-- Common authorization check is deliberately enforced inside SECURITY DEFINER
-- writes, because relying on a browser-selected café or bypassed RLS is unsafe.
create function public.supervisor_routine_owner_authorized(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid
) returns boolean language sql stable security definer set search_path=public as $$
  select (
    (auth.uid()=p_owner_user_id or coalesce(auth.role(),'')='service_role')
    and exists(select 1 from public.memberships m
      where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
    and exists(select 1 from public.ai_threads t
      where t.business_id=p_business_id and t.id=p_thread_id and t.owner_user_id=p_owner_user_id)
  );
$$;
revoke all on function public.supervisor_routine_owner_authorized(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.supervisor_routine_owner_authorized(uuid,uuid,uuid)
  to service_role;

create function public.create_supervisor_routine(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_title text,p_cadence text,p_weekdays integer[],p_local_time time,
  p_routine_id uuid default null
) returns public.supervisor_routines
language plpgsql security definer set search_path=public as $$
declare v_row public.supervisor_routines;v_zone text;
begin
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'Routine owner or thread not authorized' using errcode='42501'; end if;
  select timezone into v_zone from public.businesses where id=p_business_id;
  if v_zone is null or not exists(select 1 from pg_timezone_names where name=v_zone)
  then raise exception 'Café timezone unavailable' using errcode='22023'; end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 240
    or p_cadence not in ('daily','weekly') or p_local_time is null
    or (p_cadence='daily' and cardinality(p_weekdays)<>0)
    or (p_cadence='weekly' and cardinality(p_weekdays) not between 1 and 7)
    or exists(select 1 from unnest(p_weekdays) n
      where n not between 1 and 7)
    or (select count(distinct n) from unnest(p_weekdays) n)<>cardinality(p_weekdays)
  then raise exception 'Invalid routine schedule' using errcode='22023'; end if;
  insert into public.supervisor_routines
    (business_id,id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone)
  values(p_business_id,coalesce(p_routine_id,gen_random_uuid()),p_owner_user_id,
    p_thread_id,btrim(p_title),p_cadence,p_weekdays,p_local_time,v_zone)
  on conflict (business_id,id) do nothing returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.supervisor_routines
      where business_id=p_business_id and id=p_routine_id
        and owner_user_id=p_owner_user_id and thread_id=p_thread_id
        and title=btrim(p_title) and cadence=p_cadence
        and weekdays=p_weekdays and local_time=p_local_time;
  end if;
  if v_row.id is null then raise exception 'Routine creation conflicted' using errcode='23505'; end if;
  return v_row;
end $$;
revoke all on function public.create_supervisor_routine(uuid,uuid,uuid,text,text,integer[],time,uuid)
  from public,anon;
grant execute on function public.create_supervisor_routine(uuid,uuid,uuid,text,text,integer[],time,uuid)
  to authenticated,service_role;

create function public.change_supervisor_routine(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_routine_id uuid,p_revision integer,p_patch jsonb
) returns public.supervisor_routines
language plpgsql security definer set search_path=public as $$
declare v_row public.supervisor_routines;v_title text;v_cadence text;
        v_weekdays integer[];v_local_time time;v_status text;
begin
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'Routine owner or thread not authorized' using errcode='42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object'
    or p_patch='{}'::jsonb or exists (
      select 1 from jsonb_object_keys(p_patch) k
      where k not in ('title','cadence','weekdays','localTime','status')
    )
  then raise exception 'Invalid routine patch' using errcode='22023'; end if;
  select * into v_row from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id
      and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
  if not found then raise exception 'Routine unavailable' using errcode='23503'; end if;
  if v_row.revision<>p_revision
  then raise exception 'Routine revision changed' using errcode='40001'; end if;
  if v_row.status='revoked'
  then raise exception 'Revoked routine is terminal' using errcode='23514'; end if;
  v_title:=coalesce(p_patch->>'title',v_row.title);
  v_cadence:=coalesce(p_patch->>'cadence',v_row.cadence);
  v_weekdays:=case when p_patch?'weekdays'
    then array(select jsonb_array_elements_text(p_patch->'weekdays')::integer)
    else v_row.weekdays end;
  v_local_time:=coalesce((p_patch->>'localTime')::time,v_row.local_time);
  v_status:=coalesce(p_patch->>'status',v_row.status);
  if length(btrim(v_title)) not between 1 and 240 or v_cadence not in ('daily','weekly')
    or v_status not in ('active','paused','revoked')
    or (v_cadence='daily' and cardinality(v_weekdays)<>0)
    or (v_cadence='weekly' and cardinality(v_weekdays) not between 1 and 7)
    or exists(select 1 from unnest(v_weekdays) n where n not between 1 and 7)
    or (select count(distinct n) from unnest(v_weekdays) n)<>cardinality(v_weekdays)
  then raise exception 'Invalid routine change' using errcode='22023'; end if;
  update public.supervisor_routines set
    title=btrim(v_title),cadence=v_cadence,weekdays=v_weekdays,
    local_time=v_local_time,status=v_status,revision=revision+1,updated_at=now()
  where business_id=p_business_id and id=p_routine_id returning * into v_row;
  return v_row;
end $$;
revoke all on function public.change_supervisor_routine(uuid,uuid,uuid,uuid,integer,jsonb)
  from public,anon;
grant execute on function public.change_supervisor_routine(uuid,uuid,uuid,uuid,integer,jsonb)
  to authenticated,service_role;

-- Only the server scheduler can lease an occurrence. A retry retains run_id;
-- a finished local date can never be claimed again even across DST fall-back.
create function public.claim_supervisor_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_r public.supervisor_routines;v_o public.supervisor_routine_occurrences;
        v_token uuid;v_day integer;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null or p_scheduled_for_utc is null or p_local_date is null
    or p_scheduled_for_utc>p_now then return null; end if;
  select * into v_r from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id for update;
  if not found or v_r.status<>'active' then return null; end if;
  if not public.supervisor_routine_owner_authorized(v_r.business_id,v_r.owner_user_id,v_r.thread_id)
    then raise exception 'Routine owner lost access' using errcode='42501'; end if;
  -- No missed pre-creation or pre-resume backlog, even on a late cron.
  if p_scheduled_for_utc<v_r.updated_at then return null; end if;
  if (p_scheduled_for_utc at time zone v_r.timezone)::date<>p_local_date then
    raise exception 'Routine timezone mismatch' using errcode='22023'; end if;
  v_day:=extract(isodow from p_local_date);
  if v_r.cadence='weekly' and not v_day=any(v_r.weekdays) then return null; end if;
  insert into public.supervisor_routine_occurrences
    (business_id,routine_id,local_date,revision,scheduled_for_utc)
  values(p_business_id,p_routine_id,p_local_date,v_r.revision,p_scheduled_for_utc)
  on conflict do nothing;
  select * into v_o from public.supervisor_routine_occurrences
    where business_id=p_business_id and routine_id=p_routine_id
      and local_date=p_local_date for update;
  if v_o.revision<>v_r.revision or v_o.state in ('completed','failed')
    or v_o.attempts>=5 or (v_o.state='running' and v_o.lease_until>p_now)
    or (v_o.next_retry_at is not null and v_o.next_retry_at>p_now) then return null; end if;
  v_token:=gen_random_uuid();
  update public.supervisor_routine_occurrences set
    state='running',attempts=attempts+1,lease_token=v_token,
    lease_until=p_now+interval '4 minutes',next_retry_at=null,updated_at=p_now
    where business_id=p_business_id and routine_id=p_routine_id
      and local_date=p_local_date returning * into v_o;
  return jsonb_build_object('run_id',v_o.run_id,'lease_token',v_token,'revision',v_o.revision);
end $$;
revoke all on function public.claim_supervisor_routine_occurrence(uuid,uuid,date,timestamptz,timestamptz)
  from public,anon,authenticated;
grant execute on function public.claim_supervisor_routine_occurrence(uuid,uuid,date,timestamptz,timestamptz)
  to service_role;

create function public.finish_supervisor_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,
  p_success boolean,p_receipt_ref text,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_o public.supervisor_routine_occurrences;v_r public.supervisor_routines;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  select * into v_o from public.supervisor_routine_occurrences
    where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id
      for update;
  if not found or v_o.state<>'running' or v_o.lease_token is distinct from p_lease_token
    or v_o.lease_until<=p_now then return false; end if;
  select * into v_r from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id for update;
  if p_success and (v_r.status<>'active' or v_r.revision<>v_o.revision)
  then return false; end if;
  if p_success and (p_receipt_ref is null or length(p_receipt_ref) not between 1 and 160)
  then raise exception 'Routine receipt required' using errcode='22023'; end if;
  update public.supervisor_routine_occurrences set
    state=case when p_success then 'completed'
      when v_o.attempts>=5 then 'failed' else 'pending' end,
    lease_token=null,lease_until=null,
    next_retry_at=case when p_success or v_o.attempts>=5 then null
      else p_now+(interval '1 minute' * least(30,power(2,v_o.attempts)::integer)) end,
    receipt_ref=case when p_success then p_receipt_ref else null end,
    last_error=case when p_success then null else left(p_receipt_ref,160) end,
    updated_at=p_now where business_id=p_business_id and routine_id=p_routine_id
      and run_id=p_run_id;
  return true;
end $$;
revoke all on function public.finish_supervisor_routine_occurrence(uuid,uuid,uuid,uuid,boolean,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.finish_supervisor_routine_occurrence(uuid,uuid,uuid,uuid,boolean,text,timestamptz)
  to service_role;

-- priority_notice is an owner-private view of a VERIFIED current source, not
-- a new inbox. No authenticated role may directly insert/update/delete it.
create unique index operating_priority_notice_dedupe_idx
  on public.operating_tasks(business_id,owner_user_id,dedupe_key)
  where kind='priority_notice';
create policy operating_priority_notice_owner_only on public.operating_tasks
  as restrictive for all to authenticated
  using (kind<>'priority_notice' or (
    owner_user_id=(select auth.uid()) and exists (
      select 1 from public.memberships m where m.business_id=operating_tasks.business_id
        and m.user_id=(select auth.uid()) and m.role='owner')
  ))
  with check (kind<>'priority_notice' or (
    owner_user_id=(select auth.uid()) and exists (
      select 1 from public.memberships m where m.business_id=operating_tasks.business_id
        and m.user_id=(select auth.uid()) and m.role='owner')
  ));
create policy operating_priority_notice_no_insert on public.operating_tasks
  as restrictive for insert to authenticated with check (kind<>'priority_notice');
create policy operating_priority_notice_no_update on public.operating_tasks
  as restrictive for update to authenticated
  using (kind<>'priority_notice') with check (kind<>'priority_notice');
create policy operating_priority_notice_no_delete on public.operating_tasks
  as restrictive for delete to authenticated using (kind<>'priority_notice');

create function public.guard_operating_priority_notice_update() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.kind='priority_notice' or new.kind='priority_notice' then
    if old.kind is distinct from new.kind or old.id is distinct from new.id
      or old.business_id is distinct from new.business_id
      or old.owner_user_id is distinct from new.owner_user_id
      or old.dedupe_key is distinct from new.dedupe_key
      or old.payload is distinct from new.payload
      or old.evidence is distinct from new.evidence then
      raise exception 'Priority notice identity and evidence are immutable' using errcode='23514';
    end if;
    if new.status is distinct from old.status
      and not (old.status='needs_owner' and new.status='handled') then
      raise exception 'Invalid priority notice transition' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_operating_priority_notice_update() from public;
create trigger operating_priority_notice_update_guard before update on public.operating_tasks
  for each row execute function public.guard_operating_priority_notice_update();

-- Atomic verified source -> owner task + grounded chat message transaction.
-- A duplicated retry has the same stable task and message identity.
create function public.post_supervisor_priority_notice(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_stable_key text,p_reason text,p_as_of timestamptz,
  p_routine_id uuid default null,p_run_id uuid default null,p_lease_token uuid default null
) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_task_id text;v_msg_id uuid;v_hash text;v_found boolean;
        v_inserted_task_id text;v_o public.supervisor_routine_occurrences;
        v_r public.supervisor_routines;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'Owner or thread revoked' using errcode='42501'; end if;
  if p_source_type not in ('alert','operating_task') or p_source_id is null
    or length(p_source_id) not between 1 and 256
    or p_revision_hash !~ '^[a-f0-9]{64}$' or p_stable_key !~ '^[a-f0-9]{64}$'
    or p_reason not in ('Overdue item needs review','Actionable café alert needs review',
      'Owner task needs review','Task response needs review') or p_as_of is null
  then raise exception 'Invalid priority evidence' using errcode='22023'; end if;
  if p_routine_id is not null then
    if p_run_id is null or p_lease_token is null
    then raise exception 'Incomplete routine lease' using errcode='42501'; end if;
    select * into v_r from public.supervisor_routines
      where business_id=p_business_id and id=p_routine_id for update;
    select * into v_o from public.supervisor_routine_occurrences
      where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id for update;
    if v_r.status<>'active' or v_o.state<>'running' or
      v_o.revision<>v_r.revision or v_o.lease_token is distinct from p_lease_token
      or v_o.lease_until<=p_as_of then
      raise exception 'Routine lease revoked or expired' using errcode='42501'; end if;
    if v_r.owner_user_id<>p_owner_user_id or v_r.thread_id<>p_thread_id
    then raise exception 'Routine owner mismatch' using errcode='42501'; end if;
  elsif p_run_id is not null or p_lease_token is not null
  then raise exception 'Invalid independent notice lease' using errcode='42501'; end if;
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a where a.business_id=p_business_id
      and a.id::text=p_source_id and a.status in ('new','seen')) into v_found;
  else
    select exists(select 1 from public.operating_tasks t where t.business_id=p_business_id
      and t.id=p_source_id and t.kind not in
        ('priority_notice','commitment','event_plan','event_change','event_report')
      and t.status in ('needs_owner','needs_response')
      and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)) into v_found;
  end if;
  if not v_found then return false; end if;
  v_task_id:='priority:'||p_stable_key;
  insert into public.operating_tasks
    (business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,evidence,
      entity_type,dedupe_key)
  values(p_business_id,v_task_id,p_owner_user_id,'leo','priority_notice','needs_owner',
    jsonb_build_object('title',p_reason,'threadId',p_thread_id::text,
      'sourceType',p_source_type,'sourceId',p_source_id,
      'priorityReason',p_reason,'asOf',p_as_of::text),
    'high',jsonb_build_array(jsonb_build_object('source',p_source_type,
      'facts',jsonb_build_object('sourceId',p_source_id,
        'revisionHash',p_revision_hash,'asOf',p_as_of::text))),
    'priority_source',p_stable_key)
  on conflict do nothing returning id into v_inserted_task_id;
  v_hash:=md5('priority-notice:'||p_business_id::text||':'||p_owner_user_id::text||':'||v_task_id);
  v_msg_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
    substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
  insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
    content_type,structured_content,grounding)
  values(v_msg_id,p_business_id,p_thread_id,p_owner_user_id,'supervisor','blocks',
    jsonb_build_array(jsonb_build_object('type','text','text',p_reason)),
    jsonb_build_object('status','verified','intent','priority_notice',
      'evidence',jsonb_build_array(jsonb_build_object('source',p_source_type,
        'identifier',p_source_id,'asOf',p_as_of::text))))
  on conflict(id) do nothing;
  return v_inserted_task_id is not null;
end $$;
revoke all on function public.post_supervisor_priority_notice(uuid,uuid,uuid,text,text,text,text,text,timestamptz,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.post_supervisor_priority_notice(uuid,uuid,uuid,text,text,text,text,text,timestamptz,uuid,uuid,uuid)
  to service_role;
