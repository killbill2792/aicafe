-- Correct durable chat observation and same-thread follow-up handoff. No new queue or executor.
set lock_timeout='3s';
set statement_timeout='30s';

-- Follow-ups retain their own admitted run until a canonical combined answer is saved.
create function public.supervisor_collect_owner_followups_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,p_job_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs; j public.ai_agent_jobs; f record; v_messages jsonb:='[]';
begin
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
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
   -- Never skip a separate attachment, clarification, external or already-started turn.
   exit when f.execution_version<>2 or f.input_locale is distinct from r.input_locale
     or cardinality(f.input_attachment_ids)>0 or cardinality(f.owner_answer_ids)>0
     or f.awaiting_question_id is not null or f.owner_input_response is not null or f.owner_input_prompt_message_id is not null
     or f.role<>'owner' or f.content_type<>'text' or coalesce(f.grounding->>'sourceChannel','web')<>'web'
     or exists(select 1 from public.ai_agent_jobs where durable_run_id=f.id);
   v_messages:=v_messages||jsonb_build_array(jsonb_build_object('id',f.request_key,'text',f.text_content));
 end loop;
 return v_messages;
end $$;
revoke all on function public.supervisor_collect_owner_followups_v2(uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_collect_owner_followups_v2(uuid,uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.supervisor_research_checkpoint_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_expected_seq integer,p_write boolean,p_state jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_state jsonb; v_seq integer;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_write is null or p_expected_seq is null
   then raise exception 'checkpoint_research_denied' using errcode='42501'; end if;
 perform 1 from public.supervisor_runs r where r.id=p_run_id and r.business_id=p_business_id
   and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id for update;
 if not found then raise exception 'checkpoint_research_denied' using errcode='42501'; end if;
 select checkpoint_seq into v_seq from public.supervisor_run_steps where run_id=p_run_id
   and business_id=p_business_id and step_key='owner_turn' for update;
 if not found or v_seq<>p_expected_seq or not public.supervisor_owner_job_fence_v2(
   p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'checkpoint_research_lease_lost' using errcode='42501'; end if;
 if not p_write then
   select state into v_state from public.supervisor_research_continuations where run_id=p_run_id;
   return v_state;
 end if;
 if jsonb_typeof(p_state) is distinct from 'object' then raise exception 'checkpoint_research_invalid'; end if;
 insert into public.supervisor_research_continuations(run_id,state) values(p_run_id,p_state)
 on conflict(run_id) do update set state=excluded.state,updated_at=clock_timestamp();
 -- Publish only the owner-facing answer, never the private continuation transcript.
 update public.ai_agent_jobs set progress=
   coalesce((select jsonb_agg(e order by ord) from
     (select e,ord from jsonb_array_elements(progress) with ordinality t(e,ord)
       where e->>'kind' is distinct from 'live_view' order by ord desc limit 11) recent),'[]'::jsonb)
   ||jsonb_build_array(jsonb_build_object('kind','live_view','text',coalesce(p_state->>'text',''),
     'presentations',coalesce((select jsonb_agg(jsonb_build_object('offset',e->'presentationOffset','block',e->'presentation'))
       from jsonb_array_elements(case when jsonb_typeof(p_state->'presentations')='array' then p_state->'presentations' else '[]'::jsonb end) e
       where e->>'source'='response_presentation' and e->'accepted'='true'::jsonb),'[]'::jsonb))),
   updated_at=clock_timestamp()
 where durable_run_id=p_run_id and durable_claim_token=p_claim_token and status='running'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id;
 return 'true'::jsonb;
end $$;

create or replace function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat','thinking') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=
     coalesce((select jsonb_agg(e order by ord) from
       (select e,ord from jsonb_array_elements(progress) with ordinality t(e,ord)
        order by ord desc limit 11) recent),'[]'::jsonb)
       ||jsonb_build_array(p_step) where id=j.id;
 elsif p_action='thinking' then
   if jsonb_typeof(p_step->'summary') is distinct from 'string' then
     raise exception 'invalid_job_summary'; end if;
   update public.ai_agent_jobs set progress=
     coalesce((select jsonb_agg(e order by ord) from
       (select e,ord from jsonb_array_elements(progress) with ordinality t(e,ord)
        where e->>'kind' is distinct from 'thinking' order by ord desc limit 11) recent),'[]'::jsonb)
     ||jsonb_build_array(jsonb_build_object('kind','thinking','summary',p_step->'summary')) where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
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
   for v_id in select value::uuid from jsonb_array_elements_text(coalesce(p_grounding#>'{agentMetadata,absorbedOwnerMessageIds}','[]'::jsonb))
   loop
     if v_id=any(r.owner_answer_ids) then v_ids:=array_append(v_ids,v_id); continue; end if;
     if not exists(select 1 from public.supervisor_research_continuations c where c.run_id=r.id
       and coalesce(c.state->'followUpIds','[]'::jsonb) ? v_id::text) then continue; end if;
     select * into f from public.supervisor_runs where request_key=v_id and business_id=r.business_id
       and owner_user_id=r.owner_user_id and thread_id=r.thread_id and execution_version=2
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
