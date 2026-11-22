-- U4 terminal failure remains owner-visible, never a fake completed report.
set lock_timeout='3s';set statement_timeout='30s';
create policy operating_u4_failure_owner_only on public.operating_tasks
  as restrictive for all to authenticated
  using(kind<>'u4_run_failure' or (owner_user_id=(select auth.uid()) and exists(
    select 1 from public.memberships m where m.business_id=operating_tasks.business_id
      and m.user_id=(select auth.uid()) and m.role='owner')))
  with check(kind<>'u4_run_failure' or (owner_user_id=(select auth.uid()) and exists(
    select 1 from public.memberships m where m.business_id=operating_tasks.business_id
      and m.user_id=(select auth.uid()) and m.role='owner')));
create policy operating_u4_failure_no_insert on public.operating_tasks
  as restrictive for insert to authenticated with check(kind<>'u4_run_failure');
create policy operating_u4_failure_no_update on public.operating_tasks
  as restrictive for update to authenticated using(kind<>'u4_run_failure')
  with check(kind<>'u4_run_failure');
create policy operating_u4_failure_no_delete on public.operating_tasks
  as restrictive for delete to authenticated using(kind<>'u4_run_failure');
create function public.u4_notice_failed_occurrence() returns trigger
language plpgsql security definer set search_path='' as $failure$
declare r public.supervisor_routines;msg uuid;
begin
  if new.state<>'failed' or old.state='failed' then return new;end if;
  select * into r from public.supervisor_routines
    where business_id=new.business_id and id=new.routine_id;
  if not found or r.execution_mode<>'objective' or
    not public.supervisor_routine_owner_authorized(
      r.business_id,r.owner_user_id,r.thread_id) then return new;end if;
  insert into public.operating_tasks(
    business_id,id,owner_user_id,agent_id,kind,status,confidence,payload,
    evidence,entity_type,entity_id,dedupe_key,created_at)
  values(new.business_id,'u4-failed:'||new.run_id::text,r.owner_user_id,
    'leo','u4_run_failure','needs_owner','high',
    jsonb_build_object('title',r.title,'threadId',r.thread_id::text,
      'routineId',r.id::text,'runId',new.run_id::text,
      'localDate',new.local_date::text,'attempts',new.attempts,
      'failureKind',case when new.last_error='lease_expired'
        then 'lease_expired' else 'execution_failed' end),
    '[]'::jsonb,'u4_routine',r.id::text,'u4-failed:'||new.run_id::text,
    statement_timestamp())
  on conflict do nothing;
  msg:=md5('u4-failed-report:'||new.run_id::text)::uuid;
  insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
    content_type,structured_content,grounding)
  values(msg,r.business_id,r.thread_id,r.owner_user_id,'supervisor','blocks',
    jsonb_build_array(jsonb_build_object('type','text',
      'text','Luna could not finish this review. Open Work to see its status.'),
      jsonb_build_object('type','task_card','agent','leo','title',r.title,
        'status','needs_owner',
        'href','/operations?agent=leo&status=needs_owner&task=u4-failed:'||new.run_id::text)),
    jsonb_build_object('status','partial','intent','operating_tasks',
      'agentMetadata',jsonb_build_object('runId',new.run_id::text,
        'routineId',r.id::text,'u4Kind','failed',
        'externalEffects','not_attempted')))
  on conflict(id) do nothing;
  return new;
end $failure$;
revoke all on function public.u4_notice_failed_occurrence() from public,anon,authenticated;
create trigger u4_occurrence_failure_notice
  after update of state on public.supervisor_routine_occurrences
  for each row when(new.state='failed' and old.state is distinct from new.state)
  execute function public.u4_notice_failed_occurrence();
create function public.u4_acknowledge_failed_run(
  p_business_id uuid,p_owner_user_id uuid,p_task_id text
) returns boolean language plpgsql security definer set search_path='' as $ack$
begin
  if coalesce(auth.role(),'')<>'authenticated'
    or auth.uid() is distinct from p_owner_user_id or not exists(
      select 1 from public.memberships m where m.business_id=p_business_id
      and m.user_id=p_owner_user_id and m.role='owner')
    then raise exception 'u4_ack_denied' using errcode='42501';end if;
  update public.operating_tasks t set status='handled',resolved_at=statement_timestamp()
    where t.business_id=p_business_id and t.owner_user_id=p_owner_user_id
      and t.id=p_task_id and t.kind='u4_run_failure' and t.status='needs_owner';
  return found;
end $ack$;
revoke all on function public.u4_acknowledge_failed_run(uuid,uuid,text)
  from public,anon,service_role;
grant execute on function public.u4_acknowledge_failed_run(uuid,uuid,text)
  to authenticated;
