\set ON_ERROR_STOP on
-- Real migrated database, exact authenticated roles and source receipts.
begin;
select gen_random_uuid() biz,gen_random_uuid() other_biz, gen_random_uuid() owner_id,
 gen_random_uuid() other_owner,gen_random_uuid() coowner,gen_random_uuid() staff_user,
 gen_random_uuid() employee,gen_random_uuid() foreign_employee,gen_random_uuid() nonce,
 gen_random_uuid() assignment_nonce \gset
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,encrypted_password,created_at,updated_at)
select id,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 id::text||'@example.invalid',now(),'',now(),now()
from unnest(array[:'owner_id'::uuid,:'other_owner'::uuid,:'coowner'::uuid,:'staff_user'::uuid]) id;
insert into public.businesses(id,name,timezone,currency,is_demo)
 values (:'biz','Maintenance test café','America/Los_Angeles','USD',false),
 (:'other_biz','Other café','Europe/London','GBP',false);
insert into public.memberships(business_id,user_id,role)
 values (:'biz',:'owner_id','owner'),(:'other_biz',:'other_owner','owner');
insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents)
 values (:'employee',:'biz','Test worker',true,'hour',2000),
 (:'foreign_employee',:'other_biz','Other worker',true,'hour',2000);
select set_config('test.maintenance15b.biz',:'biz',true),set_config('test.maintenance15b.other_biz',:'other_biz',true),
 set_config('test.maintenance15b.owner',:'owner_id',true),set_config('test.maintenance15b.other_owner',:'other_owner',true),
 set_config('test.maintenance15b.employee',:'employee',true),set_config('test.maintenance15b.foreign_employee',:'foreign_employee',true),
 set_config('test.maintenance15b.staff',:'staff_user',true),set_config('test.maintenance15b.assignment_nonce',:'assignment_nonce',true);
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',:'owner_id',true);
select public.staff_link_existing_login(:'biz',:'employee',:'staff_user'||'@example.invalid');
select set_config('request.jwt.claim.sub',:'staff_user',true);
select public.staff_channel_submit(null,'report',E'Maintenance report v1\nEspresso machine\nhigh\nBoiler not heating',:'nonce')->>'id' as msg \gset
select set_config('test.maintenance15b.case','maintenance:'||:'msg',true);
select public.staff_channel_submit(null,'report',E'Maintenance report v1\nEspresso machine\nhigh\nBoiler not heating',:'nonce');
do $$
begin
 if exists(select 1 from public.operating_tasks where id=current_setting('test.maintenance15b.case')) then
  raise exception 'worker can read private maintenance case';
 end if;
 if exists(select 1 from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')) then
  raise exception 'worker can read private maintenance ledger';
 end if;
end $$;
select set_config('request.jwt.claim.sub',:'owner_id',true);
do $$
declare b uuid:=current_setting('test.maintenance15b.biz')::uuid; t text:=current_setting('test.maintenance15b.case');
begin
 if (select count(*) from public.operating_tasks where business_id=b and id=t and
   kind='maintenance_issue' and payload->>'equipmentLabel'='Espresso machine' and
   payload->>'maintenanceStage'='reported')<>1 then raise exception 'canonical staff case missing';end if;
 if (select count(*) from public.maintenance_case_events where business_id=b and task_id=t
   and kind='report' and actor_kind='staff' and source_kind='staff_report')<>1 then
  raise exception 'staff report not recorded exactly once';end if;
 begin
  perform public.maintenance_assign_staff(b,t,current_setting('test.maintenance15b.foreign_employee')::uuid,
    gen_random_uuid(),'Check the machine');
  raise exception 'foreign employee accepted';
 exception when insufficient_privilege then null; end;
end $$;
select public.maintenance_assign_staff(:'biz','maintenance:'||:'msg',:'employee',
 :'assignment_nonce','Check whether the technician has arrived')->>'id' as req \gset
select set_config('test.maintenance15b.request',:'req',true);
select public.maintenance_assign_staff(:'biz','maintenance:'||:'msg',:'employee',
 :'assignment_nonce','Check whether the technician has arrived');
do $$
begin
 if (select count(*) from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')
   and kind='staff_assignment' and source_id=current_setting('test.maintenance15b.request'))<>1 then
  raise exception 'assignment not recorded exactly once';end if;
end $$;
select set_config('request.jwt.claim.sub',:'staff_user',true);
select public.staff_channel_submit(:'req','complete','Technician says repaired',gen_random_uuid());
select set_config('request.jwt.claim.sub',:'owner_id',true);
do $$
begin
 if not exists(select 1 from public.operating_tasks where id=current_setting('test.maintenance15b.case')
   and status='needs_owner' and payload->>'maintenanceStage'='assigned'
   and payload->>'repairVerified'='false') then raise exception 'staff completion falsely closed case';end if;
 if (select count(*) from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')
   and kind='follow_up' and source_kind='staff_report')<>1 then raise exception 'linked response missing';end if;
end $$;

-- Exercise the actual approval gateway with a simulated Gmail transport receipt.
reset role;
select set_config('request.jwt.claim.role','service_role',true);
select gen_random_uuid() th,gen_random_uuid() vp,gen_random_uuid() sp \gset
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
 values (:'th',:'biz',:'owner_id',gen_random_uuid());
insert into public.connector_accounts(business_id,owner_user_id,provider,provider_subject,email,
 granted_scopes,enabled_operations,status)
 values (:'biz',:'owner_id','gmail','maintenance-fixture','owner@example.invalid',
 array['https://www.googleapis.com/auth/gmail.modify'],array['read','send'],'active') returning id as account \gset
select set_config('test.maintenance15b.thread',:'th',true),set_config('test.maintenance15b.vendor',:'vp',true),
 set_config('test.maintenance15b.verify',:'sp',true),set_config('test.maintenance15b.account',:'account',true);
insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
select :'vp',business_id,owner_user_id,:'th',gen_random_uuid(),'alex.gmail_effect.v1',1,
 jsonb_build_object('accountId',:'account','generation',1,'operation','send',
 'maintenanceCaseId',id,'maintenanceCaseRevision',updated_at,'to',jsonb_build_array('repair@example.invalid'),
 'maintenanceDueAt',statement_timestamp()+interval '1 day'),repeat('c',64),'{}',
 '{"durationDays":1,"metricScope":"gmail_provider_receipt"}','en'
from public.operating_tasks where business_id=:'biz' and id='maintenance:'||:'msg';
do $
declare b uuid:=current_setting('test.maintenance15b.biz')::uuid;
 o uuid:=current_setting('test.maintenance15b.owner')::uuid;
 th uuid:=current_setting('test.maintenance15b.thread')::uuid;
 p uuid:=current_setting('test.maintenance15b.vendor')::uuid;
 t text:=current_setting('test.maintenance15b.case');
 claim jsonb; attempt uuid; rev integer;
begin
 begin
  perform public.supervisor_claim_effect(b,o,th,p,1,'click');
  raise exception 'unapproved vendor effect accepted';
 exception when insufficient_privilege or raise_exception then
  if sqlerrm='unapproved vendor effect accepted' then raise;end if;
 end;
 perform public.supervisor_transition_proposal(b,o,p,1,'approve',null);
 claim:=public.supervisor_claim_effect(b,o,th,p,2,'click');
 attempt:=(claim->>'attempt_key')::uuid;rev:=(claim->'proposal'->>'revision')::integer;
 insert into public.connector_provider_receipts(account_id,business_id,owner_user_id,proposal_id,
 effect_hash,account_generation,operation,rfc_message_id,state)
 values(current_setting('test.maintenance15b.account')::uuid,b,o,p,repeat('c',64),1,'send',
 '<maintenance-fixture@example.invalid>','pending');
 begin
  perform public.supervisor_finish_gmail_effect_attempt(b,o,th,p,attempt,rev,'verified','committed',current_date);
  raise exception 'pending receipt committed';
 exception when insufficient_privilege then null;end;
 if exists(select 1 from public.maintenance_case_events where business_id=b and task_id=t and kind='vendor_send_verified')
 then raise exception 'premature send receipt';end if;
 update public.connector_provider_receipts set state='verified',provider_message_id='maintenance-fixture-message',
 provider_thread_id='maintenance-fixture-thread',provider_accepted_at=statement_timestamp()
 where business_id=b and proposal_id=p;
 perform public.supervisor_finish_gmail_effect_attempt(b,o,th,p,attempt,rev,'verified','committed',current_date);
 if not exists(select 1 from public.operating_tasks where business_id=b and id=t and status='needs_owner'
 and payload->>'externalSent'='true' and payload->>'repairVerified'='false'
 and payload->>'maintenanceStage'='request_sent') then raise exception 'verified send did not advance case';end if;
 if (select count(*) from public.maintenance_case_events where business_id=b and task_id=t and kind='vendor_send_verified')<>1
 then raise exception 'case receipt missing or duplicated';end if;
 begin
  perform public.maintenance_record_vendor_reply(b,o,th,t,gen_random_uuid(),
   (select id from public.connector_provider_receipts where business_id=b and proposal_id=p),
   'maintenance-fixture-thread','fixture-reply-message','repair@example.invalid',statement_timestamp(),'Repaired');
  raise exception 'unleased reply archived';
 exception when insufficient_privilege then null;end;
end $;
-- Technician claim does not establish operational verification.
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',:'owner_id',true);
select public.maintenance_record_progress(:'biz','maintenance:'||:'msg',gen_random_uuid(),'repair_claim','Technician reports repair',false);
reset role;
select set_config('request.jwt.claim.role','service_role',true);
insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
select :'sp',business_id,owner_user_id,:'th',gen_random_uuid(),'leo.maintenance_staff_assignment.v1',1,
 jsonb_build_object('maintenanceCaseId',id,'maintenanceCaseRevision',updated_at,'employeeId',:'employee',
 'employeeName','Test worker','equipmentLabel','Espresso machine','prompt','Perform independent safe operational check',
 'purpose','verify_working','dueAt',null),repeat('d',64),'{}',
 '{"durationDays":1,"metricScope":"maintenance_staff_receipt"}','en'
from public.operating_tasks where business_id=:'biz' and id='maintenance:'||:'msg';
do $
declare b uuid:=current_setting('test.maintenance15b.biz')::uuid;
 o uuid:=current_setting('test.maintenance15b.owner')::uuid;
 th uuid:=current_setting('test.maintenance15b.thread')::uuid;
 p uuid:=current_setting('test.maintenance15b.verify')::uuid;
 claim jsonb; attempt uuid; rev integer; r jsonb; replay jsonb;
begin
 begin
  perform public.maintenance_commit_staff_assignment(b,o,th,p,repeat('d',64));
  raise exception 'unapproved assignment committed';
 exception when insufficient_privilege then null;end;
 perform public.supervisor_transition_proposal(b,o,p,1,'approve',null);
 claim:=public.supervisor_claim_effect(b,o,th,p,2,'click');
 attempt:=(claim->>'attempt_key')::uuid;rev:=(claim->'proposal'->>'revision')::integer;
 begin
  perform public.supervisor_finish_effect_attempt(b,o,th,p,attempt,rev,'verified','committed',current_date);
  raise exception 'assignment without receipt committed';
 exception when insufficient_privilege then null;end;
 r:=public.maintenance_commit_staff_assignment(b,o,th,p,repeat('d',64));
 replay:=public.maintenance_commit_staff_assignment(b,o,th,p,repeat('d',64));
 if r->>'id' is distinct from replay->>'id' then raise exception 'assignment replay duplicated';end if;
 perform set_config('test.maintenance15b.verify_request',r->>'id',true);
 perform public.supervisor_finish_effect_attempt(b,o,th,p,attempt,rev,'verified','committed',current_date);
end $;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',:'staff_user',true);
select public.staff_channel_submit(current_setting('test.maintenance15b.verify_request')::uuid,'complete',
 'I physically tested the equipment and confirm it is working.',gen_random_uuid());
select set_config('request.jwt.claim.sub',:'owner_id',true);
do $
begin
 if not exists(select 1 from public.operating_tasks where id=current_setting('test.maintenance15b.case')
 and status='handled' and payload->>'repairVerified'='true') then raise exception 'independent verification did not close';end if;
 if (select count(*) from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')
 and kind='operational_verification' and source_kind='staff_operational_check')<>1 then
 raise exception 'independent staff check receipt missing';end if;
end $;

select set_config('request.jwt.claim.sub',:'other_owner',true);
do $$
begin
 if exists(select 1 from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case'))
 then raise exception 'cross-café evidence leaked';end if;
 begin
  perform public.maintenance_assign_staff(current_setting('test.maintenance15b.biz')::uuid,
   current_setting('test.maintenance15b.case'),current_setting('test.maintenance15b.employee')::uuid,
   gen_random_uuid(),'Unauthorized work');
  raise exception 'foreign owner assigned';exception when insufficient_privilege then null;end;
end $$;
reset role;
insert into public.memberships(business_id,user_id,role) values (:'biz',:'coowner','owner');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'coowner',true);
do $$
begin
 if exists(select 1 from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case'))
 then raise exception 'co-owner private evidence leaked';end if;
end $$;
rollback;
