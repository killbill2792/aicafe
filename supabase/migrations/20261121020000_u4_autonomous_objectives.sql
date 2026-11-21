-- U4: extend the existing routine, occurrence and system-model-attempt ledgers.
-- NO production execution in this development PR. No new scheduler or worker tables.
set lock_timeout = '3s';
set statement_timeout = '30s';

alter table public.supervisor_routines
  add column if not exists execution_mode text not null default 'priority',
  add column if not exists objective_text text,
  add column if not exists objective_source_message_id uuid,
  add column if not exists objective_updates jsonb not null default '[]'::jsonb;

alter table public.supervisor_routines
  add constraint supervisor_routines_u4_mode
    check(execution_mode in ('priority','objective','watch')) not valid;
alter table public.supervisor_routines
  add constraint supervisor_routines_u4_objective
    check(
      (execution_mode='priority' and objective_text is null)
      or (execution_mode='objective' and objective_source_message_id is not null
          and length(btrim(objective_text)) between 1 and 4000)
      or (execution_mode='watch' and objective_source_message_id is null
          and length(btrim(objective_text)) between 1 and 4000)
    ) not valid;
alter table public.supervisor_routines
  add constraint supervisor_routines_u4_updates
    check(jsonb_typeof(objective_updates)='array'
      and jsonb_array_length(objective_updates)<=20
      and octet_length(objective_updates::text)<=16384) not valid;
create unique index supervisor_u4_one_watch_per_owner
  on public.supervisor_routines(business_id,owner_user_id)
  where execution_mode='watch';
alter table public.supervisor_routines
  add constraint supervisor_routines_u4_source_message
  foreign key(objective_source_message_id) references public.ai_messages(id) on delete restrict not valid;

alter table public.supervisor_routine_occurrences
  add column if not exists u4_result jsonb;
alter table public.supervisor_routine_occurrences
  add constraint supervisor_routine_occurrences_u4_result
  check(u4_result is null or (jsonb_typeof(u4_result)='object'
       and octet_length(u4_result::text)<=8192)) not valid;

-- New owner-authorized objectives preserve the entire original authenticated
-- owner message. A model-chosen title is a label, never the saved objective.
create or replace function public.u4_create_objective_routine(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_title text,p_cadence text,p_weekdays integer[],p_local_time time,
  p_routine_id uuid,p_owner_message_id uuid
) returns public.supervisor_routines
language plpgsql security definer set search_path=''
as $u4_create$
declare m public.ai_messages;v public.supervisor_routines;
begin
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or p_owner_message_id is null then
    raise exception 'u4_owner_message_required' using errcode='42501'; end if;
  select * into m from public.ai_messages where id=p_owner_message_id
    and business_id=p_business_id and thread_id=p_thread_id
    and owner_user_id=p_owner_user_id and author_user_id=p_owner_user_id
    and role='owner' and content_type='text';
  if not found or length(btrim(coalesce(m.text_content,''))) not between 1 and 4000
    then raise exception 'u4_objective_source_unavailable' using errcode='42501'; end if;
  -- The retained RPC verifies café timezone, schedule and retry-stable ID.
  select * into v from public.create_supervisor_routine(
    p_business_id,p_owner_user_id,p_thread_id,p_title,p_cadence,
    p_weekdays,p_local_time,p_routine_id);
  if v.execution_mode='objective'
    and v.objective_source_message_id=p_owner_message_id then return v; end if;
  if v.execution_mode<>'priority' or v.objective_source_message_id is not null
    then raise exception 'u4_objective_conflict' using errcode='23505'; end if;
  update public.supervisor_routines set
    execution_mode='objective',objective_text=m.text_content,
    objective_source_message_id=m.id,updated_at=clock_timestamp()
    where business_id=p_business_id and id=v.id returning * into v;
  return v;
end
$u4_create$;
revoke all on function public.u4_create_objective_routine(
  uuid,uuid,uuid,text,text,integer[],time,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.u4_create_objective_routine(
  uuid,uuid,uuid,text,text,integer[],time,uuid,uuid) to authenticated,service_role;

-- A real owner edit is appended to the objective context; the original
-- objective remains available for interpretation. Revision compare-and-swap
-- uses the existing change RPC within this same database transaction.
create or replace function public.u4_edit_objective_routine(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_routine_id uuid,
  p_revision bigint,p_patch jsonb,p_owner_message_id uuid
) returns public.supervisor_routines
language plpgsql security definer set search_path=''
as $u4_edit$
declare m public.ai_messages;v public.supervisor_routines;changes jsonb;
begin
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or p_owner_message_id is null then
    raise exception 'u4_owner_message_required' using errcode='42501'; end if;
  select * into m from public.ai_messages where id=p_owner_message_id
    and business_id=p_business_id and thread_id=p_thread_id
    and owner_user_id=p_owner_user_id and author_user_id=p_owner_user_id
    and role='owner' and content_type='text';
  if not found then raise exception 'u4_edit_source_unavailable' using errcode='42501'; end if;
  select * into v from public.supervisor_routines where business_id=p_business_id
    and id=p_routine_id and owner_user_id=p_owner_user_id
    and thread_id=p_thread_id for update;
  if not found or v.execution_mode<>'objective' or v.revision<>p_revision
    then raise exception 'u4_revision_or_scope_changed' using errcode='40001'; end if;
  changes:=v.objective_updates||jsonb_build_array(jsonb_build_object(
    'sourceMessageId',m.id::text,'text',m.text_content,'revision',p_revision+1));
  if jsonb_array_length(changes)>20 or octet_length(changes::text)>16384
    then raise exception 'u4_objective_history_limit' using errcode='22023'; end if;
  select * into v from public.change_supervisor_routine(
    p_business_id,p_owner_user_id,p_thread_id,p_routine_id,p_revision,p_patch);
  update public.supervisor_routines set objective_updates=changes
    where business_id=p_business_id and id=p_routine_id returning * into v;
  return v;
end
$u4_edit$;
revoke all on function public.u4_edit_objective_routine(
  uuid,uuid,uuid,uuid,bigint,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.u4_edit_objective_routine(
  uuid,uuid,uuid,uuid,bigint,jsonb,uuid) to authenticated,service_role;

-- One explicitly system-originated hidden daily review per café owner.
-- No forged owner message, no extra queue; it uses the normal occurrence key.
create or replace function public.u4_ensure_watch_routine(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_local_time time
) returns uuid
language plpgsql security definer set search_path=''
as $u4_watch$
declare v public.supervisor_routines;tz text;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then raise exception 'u4_watch_denied' using errcode='42501'; end if;
  select id into v.id from public.supervisor_routines
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and execution_mode='watch' limit 1;
  if v.id is not null then return v.id; end if;
  select timezone into tz from public.businesses where id=p_business_id;
  if tz is null or p_local_time is null then
    raise exception 'u4_watch_schedule_unavailable' using errcode='22023'; end if;
  insert into public.supervisor_routines(
    business_id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,
    execution_mode,objective_text)
  values(p_business_id,p_owner_user_id,p_thread_id,'Luna Watch','daily',
    '{}'::bigint[],p_local_time,tz,'watch',
    'Independently review the most consequential verified café developments and opportunities. Investigate source data across relevant domains; identify what the owner may not know to ask. Report only issues with meaningful next steps, and stay quiet when no owner action is warranted. Do not perform external effects.')
  on conflict do nothing returning * into v;
  if v.id is null then select * into v from public.supervisor_routines
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and execution_mode='watch'; end if;
  if v.id is null then raise exception 'u4_watch_create_unavailable'; end if;
  return v.id;
end
$u4_watch$;
revoke all on function public.u4_ensure_watch_routine(uuid,uuid,uuid,time)
  from public,anon,authenticated;
grant execute on function public.u4_ensure_watch_routine(uuid,uuid,uuid,time) to service_role;

-- Fencing before every paid model request and prior to report acceptance.
create or replace function public.u4_routine_lease_active(
  p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid
) returns boolean language sql stable security definer set search_path=''
as $u4_active$
 select coalesce(auth.role(),'')='service_role' and exists(
   select 1 from public.supervisor_routine_occurrences o
   join public.supervisor_routines r on r.business_id=o.business_id and r.id=o.routine_id
   where o.business_id=p_business_id and o.routine_id=p_routine_id
     and o.run_id=p_run_id and o.lease_token=p_lease_token
     and o.state='running' and o.lease_until>statement_timestamp()
     and r.status='active' and r.revision=o.revision
     and r.execution_mode in ('objective','watch')
     and public.supervisor_routine_owner_authorized(r.business_id,r.owner_user_id,r.thread_id)
 )
$u4_active$;
revoke all on function public.u4_routine_lease_active(uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.u4_routine_lease_active(uuid,uuid,uuid,uuid) to service_role;

-- Reports and the occurrence completion commit atomically, with same work ID.
-- A silent watch review still leaves a bounded persisted evidence receipt.
create or replace function public.u4_publish_objective_report(
 p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,
 p_report text,p_attention text,p_proof jsonb,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=''
as $u4_publish$
declare r public.supervisor_routines;o public.supervisor_routine_occurrences;msg uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_now is null
   or p_attention not in ('attention','none')
   or length(btrim(coalesce(p_report,''))) not between 1 and 2600
   or p_proof is null or jsonb_typeof(p_proof)<>'object'
   or octet_length(p_proof::text)>4096 then
   raise exception 'u4_report_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_routines
   where business_id=p_business_id and id=p_routine_id for update;
 if not found or r.execution_mode not in ('objective','watch') or r.status<>'active'
   or not public.supervisor_routine_owner_authorized(
       r.business_id,r.owner_user_id,r.thread_id) then
   return false; end if;
 select * into o from public.supervisor_routine_occurrences
   where business_id=p_business_id and routine_id=p_routine_id
     and run_id=p_run_id for update;
 if not found or o.state<>'running' or o.lease_token is distinct from p_lease_token
   or o.lease_until<=greatest(p_now,statement_timestamp())
   or o.revision<>r.revision then return false; end if;
 if r.execution_mode='objective' or p_attention='attention' then
   msg:=md5('u4-objective-report:'||p_run_id::text)::uuid;
   insert into public.ai_messages(
     id,business_id,thread_id,owner_user_id,role,
     content_type,structured_content,grounding)
   values(msg,r.business_id,r.thread_id,r.owner_user_id,'supervisor',
     'blocks',jsonb_build_array(jsonb_build_object('type','text','text',btrim(p_report))),
     jsonb_build_object('status','verified','intent',
       case when r.execution_mode='watch' then 'u4_watch' else 'u4_routine' end,
       'evidence',coalesce(p_proof->'sources','[]'::jsonb),
       'agentMetadata',jsonb_build_object('runId',p_run_id::text,
          'routineId',r.id::text,'revision',r.revision,
          'externalEffects','not_attempted')))
   on conflict(id) do nothing;
 end if;
 if not public.finish_supervisor_routine_occurrence(
   p_business_id,p_routine_id,p_run_id,p_lease_token,true,'u4-verified:'||p_run_id::text,
   greatest(p_now,statement_timestamp())) then
   raise exception 'u4_lease_lost' using errcode='40001'; end if;
 update public.supervisor_routine_occurrences set
   u4_result=jsonb_build_object('attention',p_attention,
     'summary',left(p_report,2400),'proof',p_proof,'reviewedAt',p_now::text)
   where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id;
 return true;
end
$u4_publish$;
revoke all on function public.u4_publish_objective_report(
  uuid,uuid,uuid,uuid,text,text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function public.u4_publish_objective_report(
  uuid,uuid,uuid,uuid,text,text,jsonb,timestamptz) to service_role;

-- The existing system usage ledger is the sole billable-attempt owner.
alter table public.supervisor_system_usage_events
  drop constraint supervisor_system_usage_events_source_scope_check;
alter table public.supervisor_system_usage_events
  add constraint supervisor_system_usage_events_source_scope_check
  check(source_type in ('alert','operating_task','durable_run','routine')) not valid;
