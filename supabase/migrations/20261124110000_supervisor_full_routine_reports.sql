-- Preserve full verified U4 research narratives in the existing owner-private
-- occurrence. Only the nonempty narrative check changes; all scoped leases,
-- proof, owner authorization, deduplication, push and Work pointers remain.
set lock_timeout='3s';set statement_timeout='30s';
create or replace function public.u4_publish_objective_report(
 p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,
 p_report text,p_attention text,p_proof jsonb,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=''
as $u4_publish$
declare r public.supervisor_routines;o public.supervisor_routine_occurrences;
        msg uuid; blocks jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_now is null
   or p_attention not in ('attention','none')
   or length(btrim(coalesce(p_report,'')))=0
   or p_proof is null or jsonb_typeof(p_proof)<>'object'
   or octet_length(p_proof::text)>4096
   or jsonb_typeof(p_proof->'sources')<>'array'
   or jsonb_array_length(p_proof->'sources')<1
   or jsonb_typeof(p_proof->'sourceCount')<>'number'
   or coalesce((p_proof->>'sourceCount')::integer,0)<1
   or p_proof->>'externalEffects'<>'not_attempted'
   or p_proof->>'quality' not in ('verified','partial') then
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
   -- One owner-private Work/Operations Inbox pointer per completed occurrence.
   insert into public.operating_tasks(
     business_id,id,owner_user_id,agent_id,kind,status,confidence,payload,
     evidence,entity_type,entity_id,dedupe_key,created_at)
   values(r.business_id,'u4:'||p_run_id::text,r.owner_user_id,
     'leo','u4_report','watching',
     case when p_proof->>'quality'='verified' then 'high' else 'medium' end,
     jsonb_build_object('title',r.title,'threadId',r.thread_id::text,
       'routineId',r.id::text,'runId',p_run_id::text,
       'localDate',o.local_date::text,'asOf',p_now::text),
     '[]'::jsonb,'u4_routine',r.id::text,'u4:'||p_run_id::text,p_now)
   on conflict(business_id,id) do nothing;
   if not exists(select 1 from public.operating_tasks t
     where t.business_id=r.business_id and t.id='u4:'||p_run_id::text
       and t.kind='u4_report' and t.owner_user_id=r.owner_user_id
       and t.payload->>'runId'=p_run_id::text
       and t.payload->>'routineId'=r.id::text)
   then raise exception 'u4_report_task_identity_conflict' using errcode='23505'; end if;
   -- Queue ONLY devices that actively consented before this one report.
   -- This is not a Luna job; the same minute cron sends generic PWA notices.
   insert into public.u4_push_receipts(
     business_id,owner_user_id,device_hash,run_id)
   select s.business_id,s.owner_user_id,s.device_hash,p_run_id
     from public.u4_push_subscriptions s
     where s.business_id=r.business_id and s.owner_user_id=r.owner_user_id
       and s.revoked_at is null
   on conflict do nothing;
   msg:=md5('u4-objective-report:'||p_run_id::text)::uuid;
   -- Full evidence-backed output lives ONCE on the occurrence. The chat
   -- is a short, idempotent pointer and does not duplicate that report.
   blocks:=jsonb_build_array(
     jsonb_build_object('type','text',
       'text','Luna review finished. Open Work to read the report.'),
     jsonb_build_object('type','task_card','agent','leo',
       'title',r.title,'status','watching',
       'href','/operations?agent=leo&status=watching&task=u4:'||p_run_id::text));
   insert into public.ai_messages(
     id,business_id,thread_id,owner_user_id,role,
     content_type,structured_content,grounding)
   values(msg,r.business_id,r.thread_id,r.owner_user_id,'supervisor',
     'blocks',blocks,
     jsonb_build_object('status',p_proof->>'quality','intent','operating_tasks',
       'evidence',p_proof->'sources',
       'agentMetadata',jsonb_build_object('runId',p_run_id::text,
          'routineId',r.id::text,'revision',r.revision,
          'u4Kind',case when r.execution_mode='watch' then 'watch' else 'routine' end,
          'externalEffects','not_attempted')))
   on conflict(id) do nothing;
   if not exists(select 1 from public.ai_messages m
     where m.id=msg and m.business_id=r.business_id
       and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id
       and m.role='supervisor'
       and m.grounding->'agentMetadata'->>'runId'=p_run_id::text)
     then raise exception 'u4_report_identity_conflict' using errcode='23505'; end if;
 end if;
 if not public.finish_supervisor_routine_occurrence(
   p_business_id,p_routine_id,p_run_id,p_lease_token,true,'u4-verified:'||p_run_id::text,
   greatest(p_now,statement_timestamp())) then
   raise exception 'u4_lease_lost' using errcode='40001'; end if;
 update public.supervisor_routine_occurrences set
   u4_result=jsonb_build_object('attention',p_attention,
     'summary',btrim(p_report),'proof',p_proof,'reviewedAt',p_now::text)
   where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id;
 return true;
end
$u4_publish$;


revoke all on function public.u4_publish_objective_report(
  uuid,uuid,uuid,uuid,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.u4_publish_objective_report(
  uuid,uuid,uuid,uuid,text,text,jsonb,timestamptz) to service_role;
