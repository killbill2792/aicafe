-- Engine admission is immutable. Keep legacy follow-up collection and settlement
-- on the owning pin, including legacy checkpoints written before this migration.
set lock_timeout = '3s';
set statement_timeout = '30s';

create or replace function public.supervisor_collect_owner_followups_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,p_job_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs; j public.ai_agent_jobs; f record; v_messages jsonb:='[]';
begin
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and engine='legacy' for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_followup_lease_lost' using errcode='42501'; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and durable_claim_token=p_claim_token and status='running' and business_id=r.business_id
   and owner_user_id=r.owner_user_id and thread_id=r.thread_id for update;
 if not found then raise exception 'durable_followup_lease_lost' using errcode='42501'; end if;
 for f in select x.*,m.text_content,m.role,m.content_type,m.grounding,m.owner_input_response,m.owner_input_prompt_message_id
   from public.supervisor_runs x join public.ai_messages m on m.id=x.request_key
    and m.business_id=x.business_id and m.owner_user_id=x.owner_user_id and m.thread_id=x.thread_id
   where x.business_id=r.business_id and x.owner_user_id=r.owner_user_id and x.thread_id=r.thread_id
     and (x.created_at,x.id)>(r.created_at,r.id) and x.status in ('pending','running')
   order by x.created_at,x.id
 loop
   -- A different pin breaks the contiguous legacy follow-up sequence.
   exit when f.engine<>r.engine or f.execution_version<>2 or f.input_locale is distinct from r.input_locale
     or cardinality(f.input_attachment_ids)>0 or cardinality(f.owner_answer_ids)>0
     or f.awaiting_question_id is not null or f.owner_input_response is not null or f.owner_input_prompt_message_id is not null
     or f.role<>'owner' or f.content_type<>'text' or coalesce(f.grounding->>'sourceChannel','web')<>'web'
     or exists(select 1 from public.ai_agent_jobs where durable_run_id=f.id);
   v_messages:=v_messages||jsonb_build_array(jsonb_build_object('id',f.request_key,'text',f.text_content));
 end loop;
 return v_messages;
end $$;

CREATE OR REPLACE FUNCTION public.supervisor_publish_owner_reply_v2(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_claim_token uuid, p_job_id uuid, p_reply_id uuid, p_blocks jsonb, p_grounding jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages; f public.supervisor_runs; v_ids uuid[]:='{}'; v_runs uuid[]:='{}'; v_id uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks)<1
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or coalesce(p_grounding->>'status','') not in ('answered','verified','partial','unavailable','insufficient_evidence','estimated')
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
 if r.input_attachment_version_hash is distinct from public.supervisor_owner_attachment_fingerprint_v2(r.business_id,r.owner_user_id,r.thread_id,r.input_attachment_ids) then raise exception 'owner_run_attachment_changed' using errcode='42501'; end if;
 select * into s from public.supervisor_run_steps where business_id=r.business_id and run_id=r.id
   and step_key='owner_turn' for update;
 if not found or s.status<>'leased' or s.claim_token is distinct from p_claim_token
   or s.lease_until<=clock_timestamp() or s.checkpoint_phase<>'ready'
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and durable_claim_token=p_claim_token and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and owner_message_id=r.request_key for update;
 if not found then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 if j.status='done' and j.reply_message_id is distinct from p_reply_id then
   raise exception 'durable_reply_conflict'; end if;
 if j.status not in ('running','done') then raise exception 'durable_job_lease_lost'; end if;
 if j.status='running' then
   -- Recheck the immutable pin even when an earlier checkpoint lists the message.
   for v_id in select value::uuid from jsonb_array_elements_text(coalesce(p_grounding#>'{agentMetadata,absorbedOwnerMessageIds}','[]'::jsonb))
   loop
     if v_id=any(r.owner_answer_ids) then v_ids:=array_append(v_ids,v_id); continue; end if;
     if not exists(select 1 from public.supervisor_research_continuations c where c.run_id=r.id
       and coalesce(c.state->'followUpIds','[]'::jsonb) ? v_id::text) then continue; end if;
     select * into f from public.supervisor_runs where request_key=v_id and business_id=r.business_id
       and owner_user_id=r.owner_user_id and thread_id=r.thread_id and execution_version=2
       and r.engine='legacy' and engine=r.engine
       and status in ('pending','running') and cardinality(input_attachment_ids)=0
       and (created_at,id)>(r.created_at,r.id) for update;
     if found and not exists(select 1 from public.ai_agent_jobs where durable_run_id=f.id) then
       v_ids:=array_append(v_ids,v_id); v_runs:=array_append(v_runs,f.id);
     end if;
   end loop;
   if p_grounding#>'{agentMetadata,absorbedOwnerMessageIds}' is not null then
     p_grounding:=jsonb_set(p_grounding,'{agentMetadata,absorbedOwnerMessageIds}',to_jsonb(v_ids));
   end if;
 end if;
 insert into public.ai_messages(id,business_id,owner_user_id,thread_id,role,content_type,
   structured_content,grounding)
 values(p_reply_id,r.business_id,r.owner_user_id,r.thread_id,'supervisor','blocks',p_blocks,p_grounding)
 on conflict(id) do nothing;
 select * into m from public.ai_messages where id=p_reply_id and business_id=r.business_id
   and owner_user_id=r.owner_user_id and thread_id=r.thread_id and role='supervisor'
   and grounding->>'ownerMessageId'=r.request_key::text
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'=p_grounding->>'status'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 -- Only messages actually included by the model share this reply; late arrivals
 -- remain independently queued. No second execution or synthetic answer.
 update public.supervisor_run_steps s2 set status='completed',result_ref=case when s2.step_key='authorize_owner'
     then 'owner:'||x.request_key::text else m.id::text end,completed_at=clock_timestamp(),
   claim_token=null,worker_id=null,lease_until=null,error_code=null,next_retry_at=null,updated_at=clock_timestamp()
 from public.supervisor_runs x where s2.run_id=x.id and x.id=any(v_runs) and s2.status<>'completed';
 update public.supervisor_runs set status='completed',final_report_ref=m.id::text,finished_at=clock_timestamp(),
   dispatch_after=null,updated_at=clock_timestamp() where id=any(v_runs);
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 -- The final persisted answer may honestly describe incomplete data.
 -- Completion is proved by the scoped reply and endReason, not confidence.
 return to_jsonb(m);
end $function$;
