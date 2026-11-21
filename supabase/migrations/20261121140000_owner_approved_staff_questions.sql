-- One owner-click staff question inside the existing proposal/effect and 13C employee channel. No new table, scheduler, channel or autonomous send.
set lock_timeout='3s';
set statement_timeout='30s';
-- Only an existing, exact proposal claimed by the owner's verified click can create a worker request. The low-level staff writer remains non-executable by the service role directly; SECURITY DEFINER performs the checked call.
create function public.supervisor_commit_staff_question(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals; e public.employees; t public.operating_tasks;
 a public.alerts; v_revision timestamptz;
 v_business public.businesses; v_effect jsonb; v_local timestamp; v_receipt jsonb;
 v_question text; v_follow_up timestamptz;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501'; end if;
 select * into p from public.supervisor_proposals
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and thread_id=p_thread_id and id=p_proposal_id for update;
 if not found or p.capability_id<>'olivia.staff_question.v1'
  or p.capability_version<>1 or p.status<>'executing'
  or p.effect_hash is distinct from p_effect_hash or not exists(
   select 1 from public.supervisor_effect_attempts a
   where a.business_id=p_business_id and a.proposal_id=p_proposal_id
    and a.effect_hash=p_effect_hash and a.authorization_kind='click'
    and a.state='executing') or not exists(
   select 1 from public.memberships m where m.business_id=p_business_id
    and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'verified_owner_click_required' using errcode='42501';end if;
 v_effect:=p.canonical_effect_payload;
 v_question:=nullif(btrim(v_effect->>'question'),'');
 v_follow_up:=(v_effect->>'followUpAfter')::timestamptz;
 if v_question is null or char_length(v_question) not between 5 and 800
  or v_follow_up is null or v_follow_up<=statement_timestamp()
 then raise exception 'staff_question_not_actionable' using errcode='40001';end if;
 -- Lock employee BEFORE its source task to follow the shared channel's lock
 -- order and prevent stale link/shift/source outcomes.
 select * into e from public.employees
  where business_id=p_business_id and id=(v_effect->>'employeeId')::uuid for update;
 if not found or not e.active or e.staff_auth_user_id is null then
  raise exception 'employee_link_changed' using errcode='40001';end if;
 if v_effect->>'sourceKind'='operating_task' then
  select * into t from public.operating_tasks
   where business_id=p_business_id and id=v_effect->>'sourceTaskId'
    and (owner_user_id=p_owner_user_id or owner_user_id is null) for update;
  if not found or t.status not in ('needs_owner','needs_response','watching') then
   raise exception 'source_task_changed' using errcode='40001';end if;
  v_revision:=t.updated_at;
 elsif v_effect->>'sourceKind'='alert' then
  select * into a from public.alerts where business_id=p_business_id
   and id::text=v_effect->>'sourceTaskId' for share;
  if not found or a.status not in ('new','seen') then
   raise exception 'source_alert_changed' using errcode='40001';end if;
  v_revision:=a.created_at;
 else raise exception 'source_kind_invalid' using errcode='40001';end if;
 if v_revision is distinct from (v_effect->>'sourceRevision')::timestamptz
 then raise exception 'source_revision_changed' using errcode='40001';end if;
 select * into v_business from public.businesses where id=p_business_id;
 if not found or v_business.timezone is null then
  raise exception 'cafe_timezone_unavailable' using errcode='40001';end if;
 v_local:=statement_timestamp() at time zone v_business.timezone;
 if not exists(select 1 from public.scheduled_shifts s
  where s.business_id=p_business_id and s.employee_id=e.id and
   s.status='sent' and s.deleted_at is null and
   (s.local_date+s.start_local)<=v_local and
   (s.local_date+s.end_local+case when s.overnight then interval '1 day' else interval '0 days' end)>v_local)
 then raise exception 'worker_no_longer_on_published_shift' using errcode='40001';end if;
 v_receipt:=public.staff_channel_assign_verified(p_owner_user_id,e.id,'task',
  'Supervisor question',v_question,p_proposal_id,'owner_manual',v_follow_up);
 if v_receipt->>'id' is null then
  raise exception 'staff_question_not_saved' using errcode='40001';end if;
 return v_receipt;
end $$;
revoke all on function public.supervisor_commit_staff_question(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_commit_staff_question(uuid,uuid,uuid,uuid,text) to service_role;
-- Owner-provided physical evidence is NOT an inventory adjustment and NEVER creates a staff request. The proposal revision makes answer/ignore/ask mutually exclusive. The new evidence task enters the SAME Luna investigation queue and retains the owner's attribution for subsequent source rechecks.
create function public.supervisor_answer_staff_question(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,
 p_revision integer,p_owner_message_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals; v_answer text;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where
  business_id=p_business_id and owner_user_id=p_owner_user_id
  and thread_id=p_thread_id and id=p_proposal_id for update;
 if not found or p.capability_id<>'olivia.staff_question.v1' or not exists(
   select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'owner_question_stale' using errcode='40900';end if;
 if p.status='rejected' and p.baseline #>> '{ownerAnswer,ownerMessageId}'=p_owner_message_id::text
 then return jsonb_build_object('answered',true,'alreadyRecorded',true,'employeeContacted',false);end if;
 if p.status<>'draft' or p.revision<>p_revision then
  raise exception 'owner_question_stale' using errcode='40900';end if;
 select nullif(btrim(m.text_content),'') into v_answer from public.ai_messages m
  where m.id=p_owner_message_id and m.business_id=p_business_id and
   m.owner_user_id=p_owner_user_id and m.author_user_id=p_owner_user_id and
   m.thread_id=p_thread_id and m.role='owner'
   and m.content_type='text' and m.created_at>=p.created_at
   and m.owner_input_response is null and m.owner_input_prompt_message_id is null;
 if v_answer is null or char_length(v_answer)>1200 then
  raise exception 'owner_answer_invalid' using errcode='22023';end if;
 update public.supervisor_proposals set status='rejected',revision=revision+1,
  baseline=baseline||jsonb_build_object('ownerAnswer',jsonb_build_object(
   'text',v_answer,'ownerUserId',p_owner_user_id,'ownerMessageId',p_owner_message_id,'receivedAt',statement_timestamp(),
   'provenance','owner_report_unverified')),
  updated_at=statement_timestamp() where business_id=p_business_id and id=p_proposal_id;
 insert into public.operating_tasks(
  business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,
  status,payload,confidence,evidence)
 values(p_business_id,'staff-question-owner-answer:'||p_proposal_id::text,
  p_owner_user_id,'olivia','data_quality','staff_question_answer',p_proposal_id::text,
  'needs_owner',jsonb_build_object('title','Owner provided a physical count or answer',
    'sourceTaskId',p.canonical_effect_payload->>'sourceTaskId',
    'sourceKind',p.canonical_effect_payload->>'sourceKind','answeredByOwner',true,
    'nextAction','Recheck source records before deriving any inventory or staffing change'),
  'low',jsonb_build_array(jsonb_build_object('source','owner_report',
   'facts',jsonb_build_object('proposalId',p_proposal_id,'ownerUserId',p_owner_user_id,
    'answer',v_answer,'ownerMessageId',p_owner_message_id,'independentlyVerified',false,'sourceTaskId',
      p.canonical_effect_payload->>'sourceTaskId'))))
 on conflict(business_id,id) do nothing;
 return jsonb_build_object('answered',true,'ownerEvidenceOnly',true,'employeeContacted',false);
end $$;
revoke all on function public.supervisor_answer_staff_question(uuid,uuid,uuid,uuid,integer,uuid)
 from public,anon,authenticated;
grant execute on function public.supervisor_answer_staff_question(uuid,uuid,uuid,uuid,integer,uuid) to service_role;
-- A lost HTTP response never re-sends a worker question. Resolve only an already-durable request, then finish its SAME previously clicked effect.
create function public.supervisor_reconcile_staff_question(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals; a public.supervisor_effect_attempts;
 r public.staff_communication_requests; tz text;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where
  business_id=p_business_id and owner_user_id=p_owner_user_id
  and thread_id=p_thread_id and id=p_proposal_id for update;
 if not found or p.capability_id<>'olivia.staff_question.v1'
 then raise exception 'staff_question_not_found' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where
  business_id=p_business_id and proposal_id=p.id and effect_hash=p.effect_hash
  and authorization_kind='click' for update;
 if not found then return jsonb_build_object('state','not_authorized');end if;
 select * into r from public.staff_communication_requests where
  business_id=p_business_id and source_type='owner_manual'
  and source_id=p.id::text and employee_id=(p.canonical_effect_payload->>'employeeId')::uuid
  and prompt=p.canonical_effect_payload->>'question';
 if not found then return jsonb_build_object('state','unknown');end if;
 if p.status='executing' and a.state in ('executing','uncertain') then
  select timezone into tz from public.businesses where id=p_business_id;
  if tz is null then raise exception 'cafe_timezone_unavailable' using errcode='42501';end if;
  if a.state='uncertain' then
   update public.supervisor_effect_attempts set state='executing' where id=a.id;
  end if;
  p:=public.supervisor_finish_effect_attempt(p_business_id,p_owner_user_id,
   p_thread_id,p.id,a.attempt_key,p.revision,'verified','committed',
   ((statement_timestamp() at time zone tz)::date+1));
 end if;
 if p.status<>'committed' then return jsonb_build_object('state','unknown');end if;
 return jsonb_build_object('state','verified','requestId',r.id,'employeeContacted',true);
end $$;
revoke all on function public.supervisor_reconcile_staff_question(uuid,uuid,uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.supervisor_reconcile_staff_question(uuid,uuid,uuid,uuid) to service_role;
-- Extend the existing fifteen-minute Supervisor tick, not a new scheduler. One overdue worker request becomes one durable owner task; silence cannot count as declined or as a verified answer. Any later follow-up requires a fresh owner-clicked proposal after Luna rechecks current source evidence.
create function public.staff_question_escalate_due(p_business_id uuid)
 returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare saved integer;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 insert into public.operating_tasks
 (business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,
  status,payload,confidence,evidence)
 select r.business_id,'staff-question-unanswered:'||r.id::text||':'||p.owner_user_id::text,
   p.owner_user_id,'olivia','data_quality','staff_question',r.id::text,
   'needs_owner',jsonb_build_object('title','Staff question unanswered',
     'requestId',r.id,'proposalId',p.id,'response','unknown',
     'nextAction','Recheck recent orders, stock and schedule evidence; propose another owner-approved follow-up only if needed'),
   'low',jsonb_build_array(jsonb_build_object('source','staff_communication_requests',
     'facts',jsonb_build_object('requestId',r.id,'employeeId',r.employee_id,
       'sourceTaskId',p.canonical_effect_payload->>'sourceTaskId',
       'status','open','response','none_verified')))
 from public.staff_communication_requests r
 join public.supervisor_proposals p on p.business_id=r.business_id and
  p.id::text=r.source_id and p.capability_id='olivia.staff_question.v1'
  and p.status='committed' and p.owner_user_id is not null
 where r.business_id=p_business_id and r.source_type='owner_manual'
  and r.kind='task' and r.status='open'
  and r.due_at is not null and r.due_at<=statement_timestamp()
 on conflict(business_id,id) do nothing;
 get diagnostics saved=row_count;
 return saved;
end $$;
revoke all on function public.staff_question_escalate_due(uuid)
 from public,anon,authenticated;
grant execute on function public.staff_question_escalate_due(uuid) to service_role;
-- The existing investigation SQL checkpoint writes the owner report's ai_messages row once. This BEFORE INSERT hook appends the already-supported proposal_card block only when the claimed incident and saved inert proposal agree on café, owner, thread, source ID and current source revision. The model cannot inject a proposal ID into chat prose to obtain this card.
create function public.supervisor_attach_staff_question_card()
 returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_source text; v_proposal uuid; v_task public.operating_tasks;
 v_alert public.alerts; v_effect jsonb; v_revision timestamptz;
begin
 if auth.role() is distinct from 'service_role' or new.role<>'supervisor'
  or new.content_type<>'blocks' or new.grounding->>'intent'<>'priority_investigation'
  or jsonb_typeof(new.structured_content)<>'array' then return new;end if;
 v_source:=new.grounding #>> '{evidence,0,identifier}';
 if v_source is null then return new;end if;
 select (i.evidence->>'staffQuestionProposalId')::uuid into v_proposal
  from public.supervisor_investigations i where
    i.business_id=new.business_id and i.owner_user_id=new.owner_user_id
    and i.thread_id=new.thread_id and i.source_type in ('operating_task','alert')
    and i.source_id=v_source and i.phase='awaiting_owner';
 if v_proposal is null then return new;end if;
 select canonical_effect_payload into v_effect from public.supervisor_proposals p
  where p.business_id=new.business_id and p.owner_user_id=new.owner_user_id
   and p.thread_id=new.thread_id and p.id=v_proposal
   and p.status='draft' and p.capability_id='olivia.staff_question.v1'
   and p.canonical_effect_payload->>'sourceTaskId'=v_source
   and p.canonical_effect_payload->>'sourceKind'=new.grounding #>> '{evidence,0,source}';
 if not found then return new;end if;
 if v_effect->>'sourceKind'='operating_task' then
  select * into v_task from public.operating_tasks where
   business_id=new.business_id and (owner_user_id=new.owner_user_id or owner_user_id is null)
   and id=v_source and status in ('needs_owner','needs_response','watching');
  if not found then return new;end if;
  v_revision:=v_task.updated_at;
 elsif v_effect->>'sourceKind'='alert' then
  select * into v_alert from public.alerts where business_id=new.business_id
   and id::text=v_source and status in ('new','seen');
  if not found then return new;end if;
  v_revision:=v_alert.created_at;
 else return new;end if;
 if not exists(select 1 from public.supervisor_proposals p
    where p.business_id=new.business_id and p.owner_user_id=new.owner_user_id
      and p.thread_id=new.thread_id and p.id=v_proposal
      and p.status='draft' and p.capability_id='olivia.staff_question.v1'
      and p.canonical_effect_payload->>'sourceTaskId'=v_source
      and (p.canonical_effect_payload->>'sourceRevision')::timestamptz=v_revision)
 then return new;end if;
 if exists(select 1 from public.ai_messages m
    where m.business_id=new.business_id and m.owner_user_id=new.owner_user_id
      and m.thread_id=new.thread_id and m.structured_content @>
        jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal::text)))
 then return new;end if;
 new.structured_content:=new.structured_content||
  jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal::text));
 return new;
end $$;
revoke all on function public.supervisor_attach_staff_question_card() from public,anon,authenticated;
create trigger supervisor_staff_question_report_card
 before insert on public.ai_messages for each row
 execute function public.supervisor_attach_staff_question_card();
