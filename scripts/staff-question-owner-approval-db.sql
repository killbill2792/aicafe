\set ON_ERROR_STOP on
begin;
select gen_random_uuid() biz,gen_random_uuid() other_biz, gen_random_uuid() owner_id,gen_random_uuid() outsider,
 gen_random_uuid() staff_user,gen_random_uuid() employee, gen_random_uuid() task_uuid,gen_random_uuid() thread_id,
 gen_random_uuid() proposal,gen_random_uuid() owner_proposal,
 gen_random_uuid() rejected_proposal,gen_random_uuid() stale_proposal \gset
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,encrypted_password,created_at,updated_at)
select x,'00000000-0000-0000-0000-000000000000','authenticated','authenticated', x::text||'@example.invalid',now(),'',now(),now()
from unnest(array[:'owner_id'::uuid,:'outsider'::uuid,:'staff_user'::uuid]) x; insert into public.businesses(id,name,timezone,currency,is_demo)
 values(:'biz','Question fixture','America/Los_Angeles','USD',false), (:'other_biz','Other fixture','America/Los_Angeles','USD',false);
insert into public.memberships(business_id,user_id,role) values(:'biz',:'owner_id','owner'),(:'other_biz',:'outsider','owner');
insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents)
 values (:'employee',:'biz','On-shift worker',true,'hour',1800); set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),
 set_config('request.jwt.claim.sub',:'owner_id',true); select public.staff_link_existing_login(:'biz',:'employee',:'staff_user'||'@example.invalid');
reset role;
select set_config('request.jwt.claim.role','service_role',true);
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values(:'thread_id',:'biz',:'owner_id',gen_random_uuid());
insert into public.scheduled_shifts( business_id,employee_id,local_date,start_local,end_local,source,status)
 values(:'biz',:'employee',(now() at time zone 'America/Los_Angeles')::date, '00:00','23:59','owner','sent');
insert into public.operating_tasks(business_id,id,owner_user_id,agent_id, kind,entity_type,entity_id,status,payload,confidence,evidence)
 values(:'biz','staff-question-fixture:'||:'task_uuid',:'owner_id','olivia', 'data_quality','ingredient',:'task_uuid','needs_owner',
  '{"title":"Cup stock discrepancy"}','low','[]'); insert into public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
 canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) select v.id,t.business_id,t.owner_user_id,:'thread_id',gen_random_uuid(),
  'olivia.staff_question.v1',1, jsonb_build_object('sourceKind','operating_task','sourceTaskId',t.id,'employeeId',:'employee','question',
   case when v.id=:'stale_proposal'::uuid then 'Can you cover the evening shift?' else 'How many takeaway cups are left?' end,'reason','Source and physical count differ',
   'evidence',jsonb_build_array(jsonb_build_object('source','order_lines','asOf','verified check')),
   'followUpAfter',statement_timestamp()+interval '4 hours', 'sourceRevision',t.updated_at,'employeeName','On-shift worker'),
  repeat('d',64),'{}','{"durationDays":1,"metricScope":"staff_question_receipt"}','en' from public.operating_tasks t
 cross join (values(:'proposal'::uuid),(:'owner_proposal'::uuid),(:'rejected_proposal'::uuid), (:'stale_proposal'::uuid)) v(id)
 where t.business_id=:'biz' and t.id='staff-question-fixture:'||:'task_uuid';
select set_config('test.staffquestion.biz',:'biz',true),
 set_config('test.staffquestion.owner',:'owner_id',true), set_config('test.staffquestion.outsider',:'outsider',true),
 set_config('test.staffquestion.thread',:'thread_id',true), set_config('test.staffquestion.employee',:'employee',true),
 set_config('test.staffquestion.proposal',:'proposal',true), set_config('test.staffquestion.owner_proposal',:'owner_proposal',true),
 set_config('test.staffquestion.rejected_proposal',:'rejected_proposal',true),
 set_config('test.staffquestion.task','staff-question-fixture:'||:'task_uuid',true), set_config('test.staffquestion.request','',true);
insert into public.supervisor_investigations( business_id,owner_user_id,thread_id,source_type,source_id, revision_hash,stable_key,phase,evidence)
 values(:'biz',:'owner_id',:'thread_id','operating_task', 'staff-question-fixture:'||:'task_uuid',repeat('a',64),repeat('b',64),'awaiting_owner',
 jsonb_build_object('staffQuestionProposalId',:'rejected_proposal')); insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
 content_type,structured_content,grounding) values(gen_random_uuid(),:'biz',:'thread_id',:'owner_id','supervisor','blocks',
 jsonb_build_array(jsonb_build_object('type','text','text','I propose a factual check.')),
 jsonb_build_object('status','partial','intent','priority_investigation','evidence', jsonb_build_array(jsonb_build_object('source','operating_task',
 'identifier','staff-question-fixture:'||:'task_uuid'))))
 returning id as proposal_card_message \gset
select set_config('test.staffquestion.card',:'proposal_card_message',true);
do $$
 begin if not exists(select 1 from public.ai_messages m where m.id=current_setting('test.staffquestion.card')::uuid and m.structured_content @> jsonb_build_array(jsonb_build_object('type','proposal_card',
 'proposalId',current_setting('test.staffquestion.rejected_proposal')))) then raise exception 'proactive report failed to render actual owner approval card';end if;
end $$;
do $$
 declare b uuid:=current_setting('test.staffquestion.biz')::uuid; o uuid:=current_setting('test.staffquestion.owner')::uuid; th uuid:=current_setting('test.staffquestion.thread')::uuid; p uuid:=current_setting('test.staffquestion.proposal')::uuid; begin begin perform public.supervisor_commit_staff_question(b,o,th,p,repeat('d',64)); raise exception 'unapproved employee question was sent'; exception when insufficient_privilege then null;end; begin perform public.supervisor_commit_staff_question(b,current_setting('test.staffquestion.outsider')::uuid,th,p,repeat('d',64)); raise exception 'foreign owner could send'; exception when insufficient_privilege then null;end; if exists(select 1 from public.staff_communication_requests where source_id=p::text) then raise exception 'draft created a request';end if;
end $$;
select public.supervisor_transition_proposal(:'biz',:'owner_id',:'proposal',1,'approve',null); select claim->>'attempt_key' as attempt_key,
 (claim->'proposal'->>'revision')::integer as effect_revision
 from (select public.supervisor_claim_effect(:'biz',:'owner_id',:'thread_id',:'proposal',2,'click') claim) x \gset
select public.supervisor_commit_staff_question(:'biz',:'owner_id',:'thread_id',:'proposal',repeat('d',64))->>'id' as request_id \gset
select set_config('test.staffquestion.request',:'request_id',true);
do $$
 begin if (select count(*) from public.staff_communication_requests where business_id=current_setting('test.staffquestion.biz')::uuid and source_id=current_setting('test.staffquestion.proposal') and employee_id=current_setting('test.staffquestion.employee')::uuid and kind='task' and prompt='How many takeaway cups are left?')<>1 then raise exception 'approved question was not saved exactly once';end if; if exists(select 1 from public.staff_communication_messages where business_id=current_setting('test.staffquestion.biz')::uuid) then raise exception 'approval falsely created an employee response';end if;
end $$;
select public.supervisor_commit_staff_question(:'biz',:'owner_id',:'thread_id',:'proposal',repeat('d',64));
update public.supervisor_effect_attempts set state='uncertain' where proposal_id=:'proposal' and business_id=:'biz';
select public.supervisor_reconcile_staff_question(:'biz',:'owner_id',:'thread_id',
 :'proposal')->>'state' as recovered_state \gset
select public.supervisor_reconcile_staff_question(:'biz',:'owner_id',:'thread_id',:'proposal');
do $$
 begin if (select count(*) from public.staff_communication_requests where source_id=current_setting('test.staffquestion.proposal') and business_id=current_setting('test.staffquestion.biz')::uuid)<>1 then raise exception 'duplicate question';end if;
 if not exists(select 1 from public.supervisor_proposals where id=current_setting('test.staffquestion.proposal')::uuid and status='committed') then raise exception 'uncertain receipt was not safely reconciled';end if;
end $$;
do $$
begin
 begin
  perform public.supervisor_answer_staff_question(:'biz',:'owner_id',:'thread_id',:'owner_proposal',1,gen_random_uuid());
  raise exception 'a fabricated owner message was accepted';
 exception when sqlstate '22023' then null;end;
end $$;
select gen_random_uuid() as owner_answer_message \gset
select set_config('test.staffquestion.owner_answer_message',:'owner_answer_message',true);
insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id)
 values(:'owner_answer_message',:'biz',:'thread_id',:'owner_id',:'owner_id','owner','text',
  'There are approximately 40 cups remaining.',gen_random_uuid());
select public.supervisor_answer_staff_question(:'biz',:'owner_id',:'thread_id',
 :'owner_proposal',1,:'owner_answer_message');
do $$
 begin if not exists(select 1 from public.supervisor_proposals where id=current_setting('test.staffquestion.owner_proposal')::uuid and status='rejected' and baseline->'ownerAnswer'->>'text'= 'There are approximately 40 cups remaining.' and baseline->'ownerAnswer'->>'ownerMessageId' is not null) then raise exception 'owner answer not durable';end if; if not exists(select 1 from public.operating_tasks where id='staff-question-owner-answer:'||current_setting('test.staffquestion.owner_proposal') and evidence @> '[{"source":"owner_report"}]'::jsonb) then raise exception 'owner answer did not enter existing investigation queue';end if; if not exists(select 1 from public.supervisor_proposals where id=current_setting('test.staffquestion.rejected_proposal')::uuid and status='rejected' and baseline->'ownerAnswer'->>'ownerMessageId' is not null) then raise exception 'equivalent pending draft not superseded';end if; if not exists(select 1 from public.supervisor_proposals where canonical_effect_payload->>'question'='Can you cover the evening shift?' and status='draft') then raise exception 'unrelated staff question was closed';end if; if exists(select 1 from public.staff_communication_requests where source_id=current_setting('test.staffquestion.owner_proposal')) then raise exception 'owner answer contacted worker';end if;
end $$;
do $$
 begin if public.supervisor_answer_staff_question(current_setting('test.staffquestion.biz')::uuid,current_setting('test.staffquestion.owner')::uuid,current_setting('test.staffquestion.thread')::uuid, current_setting('test.staffquestion.owner_proposal')::uuid,1,current_setting('test.staffquestion.owner_answer_message')::uuid)->>'alreadyRecorded' is distinct from 'true' then raise exception 'identical owner message retry lost';end if; begin perform public.supervisor_answer_staff_question(current_setting('test.staffquestion.biz')::uuid,current_setting('test.staffquestion.outsider')::uuid,current_setting('test.staffquestion.thread')::uuid, current_setting('test.staffquestion.rejected_proposal')::uuid,1,current_setting('test.staffquestion.owner_answer_message')::uuid); raise exception 'cross-cafe owner answer was accepted'; exception when sqlstate '40900' then null;end;
end $$;
update public.staff_communication_requests set due_at=statement_timestamp()-interval '1 second' where id=:'request_id';
select public.staff_question_escalate_due(:'biz'); select public.staff_question_escalate_due(:'biz');
do $$
 begin if (select count(*) from public.operating_tasks where id='staff-question-unanswered:'||current_setting('test.staffquestion.request')||':'||current_setting('test.staffquestion.owner'))<>1 then
 raise exception 'unanswered follow-up lost or repeated';end if; if (select count(*) from public.staff_communication_requests where source_id=current_setting('test.staffquestion.proposal'))<>1 then raise exception 'no-response created a second outbound request';end if;
end $$;
rollback;
