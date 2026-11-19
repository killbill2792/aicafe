-- Task15B: extend the original worker inbox and canonical incident ledger.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.maintenance_case_events drop constraint maintenance_case_events_kind_check;
alter table public.maintenance_case_events add constraint maintenance_case_events_kind_check
 check(kind in ('report','repair_claim','operational_verification','blocked','reopened','follow_up','staff_assignment','vendor_send_verified','vendor_reply')) not valid;
alter table public.maintenance_case_events validate constraint maintenance_case_events_kind_check;
alter table public.maintenance_case_events drop constraint maintenance_case_events_source_kind_check;
alter table public.maintenance_case_events add constraint maintenance_case_events_source_kind_check
 check(source_kind in ('owner_report','owner_relay','owner_operational_check','system_follow_up','staff_report','approved_staff_assignment','gmail_effect_receipt','vendor_reply','staff_operational_check')) not valid;
alter table public.maintenance_case_events validate constraint maintenance_case_events_source_kind_check;

-- A second owner of the same business must not see another owner's private
-- case history through an otherwise permissive business-level policy.
create policy maintenance_event_case_owner_only on public.maintenance_case_events
 as restrictive for select to authenticated using (exists(
 select 1 from public.operating_tasks t where t.business_id=maintenance_case_events.business_id
 and t.id=maintenance_case_events.task_id and t.owner_user_id=(select auth.uid())
));

create or replace function public.staff_channel_notice() returns trigger
 language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_row record; v_kind text; v_request_kind text; v_parts text[]; v_symptom text; v_owner uuid; v_owners uuid[]; v_task text; v_auth uuid; v_case public.operating_tasks; v_event public.maintenance_case_events; v_request public.staff_communication_requests; v_working boolean;
begin
 -- Owner replies are visible to employees, never fake new staff events.
 if new.actor<>'employee' then return new; end if;

 -- A structured crew report still uses the original authenticated staff
 -- submission/nonce. Free-form reports and ambiguous ownership retain the
 -- existing generic owner notice. No model-supplied identity is trusted.
 if new.request_id is null and new.response_code='report' and new.channel='web' then
  v_parts:=string_to_array(new.body,E'\n');
  if v_parts[1]='Maintenance report v1' and char_length(btrim(v_parts[2])) between 1 and 120
     and v_parts[3] in ('critical','high','normal','unknown') then
   v_symptom:=btrim(array_to_string(v_parts[4:array_length(v_parts,1)],E'\n'));
   select e.staff_auth_user_id into v_auth from public.employees e
    where e.business_id=new.business_id and e.id=new.employee_id and e.active
      and e.staff_auth_user_id=auth.uid();
   select array_agg(m.user_id order by m.user_id) into v_owners from public.memberships m
    where m.business_id=new.business_id and m.role='owner';
   if v_auth is not null and cardinality(v_owners)=1 and char_length(v_symptom) between 1 and 1200 then
    v_owner:=v_owners[1]; v_task:='maintenance:'||new.id::text;
    perform set_config('app.maintenance_case_transition','allowed',true);
    insert into public.operating_tasks
     (business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,status,payload,confidence,evidence)
    values(new.business_id,v_task,v_owner,'leo','maintenance_issue','staff_message',new.id::text,
      'needs_owner',jsonb_build_object('equipmentLabel',btrim(v_parts[2]),'symptom',v_symptom,
       'severity',v_parts[3],'reportedAt',new.received_at,'maintenanceStage','reported',
       'repairVerified',false,'externalSent',false),
      'low',jsonb_build_array(jsonb_build_object('source','staff_communication_messages',
       'facts',jsonb_build_object('messageId',new.id,'employeeId',new.employee_id,
        'severity',v_parts[3],'quality','unverified'))));
    insert into public.maintenance_case_events
     (business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,source_kind,source_id,note,occurred_at)
    values(new.business_id,v_task,'staff-report:'||new.id::text,'report','staff',v_auth,
      'staff_report',new.id::text,v_symptom,new.received_at);
    perform set_config('app.maintenance_case_transition','',true);
    return new;
   end if;
  end if;
 end if;
 -- Replies to a case-linked assignment update the same incident, never
 -- declare a repair solely from the employee's task-completed response.
 if new.request_id is not null then
  select e.* into v_event from public.maintenance_case_events e
   join public.staff_communication_requests r on r.business_id=e.business_id and r.id::text=e.source_id
   where e.business_id=new.business_id and e.kind='staff_assignment'
    and r.id=new.request_id and r.employee_id=new.employee_id;
  if found then
   select * into v_case from public.operating_tasks t
    where t.business_id=new.business_id and t.id=v_event.task_id
      and t.kind='maintenance_issue' for update;
   if found and v_case.status<>'handled' and exists(select 1 from public.memberships m
     where m.business_id=v_case.business_id and m.user_id=v_case.owner_user_id and m.role='owner') then
    select * into v_request from public.staff_communication_requests r
      where r.business_id=new.business_id and r.id=new.request_id and r.employee_id=new.employee_id;
    v_working:=v_request.source_type='maintenance_verify' and new.channel='web'
      and new.response_code='complete' and new.body='I physically tested the equipment and confirm it is working.'
      and v_case.payload->>'maintenanceStage'='repair_claimed'
      and exists(select 1 from public.employees e where e.business_id=new.business_id
        and e.id=new.employee_id and e.active and e.staff_auth_user_id=auth.uid())
      and exists(select 1 from public.maintenance_case_events e where e.business_id=new.business_id
        and e.task_id=v_case.id and e.kind='repair_claim' and e.created_at<v_event.created_at)
      and not exists(select 1 from public.maintenance_case_events e where e.business_id=new.business_id
        and e.task_id=v_case.id and e.kind in ('repair_claim','reopened') and e.created_at>=v_event.created_at);
    if v_working then
      insert into public.maintenance_case_events
       (business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,source_kind,source_id,note,working_confirmed,occurred_at)
      values(new.business_id,v_case.id,'staff-working:'||new.id::text,'operational_verification',
       'staff',auth.uid(),'staff_operational_check',new.id::text,new.body,true,new.received_at);
      perform set_config('app.maintenance_case_transition','allowed',true);
      update public.operating_tasks set status='handled',resolved_at=statement_timestamp(),
        payload=payload||jsonb_build_object('maintenanceStage','verified_repaired','repairVerified',true),
        evidence=evidence||jsonb_build_array(jsonb_build_object('source','staff_communication_messages',
         'facts',jsonb_build_object('messageId',new.id,'workingConfirmed',true))),
        updated_at=statement_timestamp() where business_id=new.business_id and id=v_case.id;
      perform set_config('app.maintenance_case_transition','',true);
      return new;
    end if;
    insert into public.maintenance_case_events
     (business_id,task_id,idempotency_key,kind,actor_kind,source_kind,source_id,note,occurred_at)
    values(new.business_id,v_case.id,'staff-reply:'||new.id::text,'follow_up','staff',
     'staff_report',new.id::text,left(new.body,1200),new.received_at)
    on conflict (business_id,task_id,idempotency_key) do nothing;
    perform set_config('app.maintenance_case_transition','allowed',true);
    update public.operating_tasks set status='needs_owner',
     evidence=evidence||jsonb_build_array(jsonb_build_object('source','staff_communication_messages',
      'facts',jsonb_build_object('messageId',new.id,'response',new.response_code,'requestId',new.request_id))),
     updated_at=statement_timestamp()
     where business_id=new.business_id and id=v_case.id;
    perform set_config('app.maintenance_case_transition','',true);
    return new;
   end if;
  end if;
 end if;
 if new.request_id is not null then
  select kind into v_request_kind from public.staff_communication_requests r
   where r.business_id=new.business_id and r.id=new.request_id;
 end if;
 v_kind:=case when v_request_kind in ('shift_confirmation','coverage_offer')
  then 'staff_coverage' else 'data_quality' end;
 for owner_row in select m.user_id from public.memberships m
   where m.business_id=new.business_id and m.role='owner' loop
  insert into public.operating_tasks
   (business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,status,payload,confidence,evidence)
  values(new.business_id,'staff-response:'||new.id::text||':'||owner_row.user_id::text,
   owner_row.user_id,'olivia',v_kind,'staff_message',new.id::text,
   'needs_owner',jsonb_build_object(
      'title',case when new.request_id is null then 'Staff issue reported' else 'Staff replied to assigned work' end,
      'messageId',new.id,'response',new.response_code,'requiresReview',true,
      'nextAction','Read verified staff response and check whether follow-up or owner approval is required'),
   'high',jsonb_build_array(jsonb_build_object('source','staff_communication_messages',
       'facts',jsonb_build_object('messageId',new.id,'employeeId',new.employee_id,
        'response',new.response_code,'requestId',new.request_id))))
  on conflict (business_id,id) do nothing;
 end loop;
 return new;
end $$;

-- Use the existing owner-approved task producer, in the SAME transaction
-- as the linked maintenance receipt. No extra staff identity or sender.

-- One private writer serves both authenticated manual approval and the
-- existing Supervisor gateway. Never impersonate a user with JWT settings.
create function public.staff_channel_assign_verified(
 p_owner_id uuid,p_employee_id uuid,p_kind text,p_title text,p_prompt text,p_nonce uuid,
 p_source_type text,p_due_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare emp public.employees%rowtype; assignment public.staff_communication_requests%rowtype;
 v_title text;v_prompt text;
begin
 -- Serialize owner messages and assignments for this employee too. A lost
 -- response can overlap a retry with the same nonce; its receipt must be
 -- checked after the earlier transaction commits, not race the insert.
 select * into emp from public.employees where id=p_employee_id for update;
 -- Do not reveal earlier assignment receipts to anyone except a
 -- verified owner; then check prior nonce BEFORE current worker eligibility.
 if not found or not exists(select 1 from public.memberships m where m.business_id=emp.business_id and m.user_id=p_owner_id and m.role='owner') then
   raise exception 'owner_target_required' using errcode='42501'; end if;
 v_title:=nullif(btrim(coalesce(p_title,'')),'');
 v_prompt:=nullif(btrim(coalesce(p_prompt,'')),'');
 if p_nonce is null or p_source_type not in ('owner_manual','maintenance_task','maintenance_verify') or p_kind not in ('checklist','task') or
    v_title is null or char_length(v_title)>200 or
    v_prompt is null or char_length(v_prompt)>2000 then
    raise exception 'invalid_assignment' using errcode='22023'; end if;
 select * into assignment from public.staff_communication_requests r
  where r.business_id=emp.business_id and r.employee_id=emp.id
   and r.source_type=p_source_type and r.source_id=p_nonce::text for update;
 if found then
   if assignment.kind<>p_kind or assignment.title<>v_title or
      assignment.prompt<>v_prompt or assignment.due_at is distinct from p_due_at then
    raise exception 'assignment_nonce_conflict' using errcode='40900'; end if;
   return jsonb_build_object('id',assignment.id,'replayed',true);
 end if;
 if not emp.active or emp.staff_auth_user_id is null then
  raise exception 'owner_target_unavailable' using errcode='40900'; end if;
 insert into public.staff_communication_requests
  (business_id,employee_id,kind,source_type,source_id,source_revision,title,prompt,due_at)
 values (emp.business_id,emp.id,p_kind,p_source_type,p_nonce::text,'v1',v_title,v_prompt,p_due_at)
 returning * into assignment;
 return jsonb_build_object('id',assignment.id,'replayed',false);
end $$;

revoke all on function public.staff_channel_assign_verified(uuid,uuid,text,text,text,uuid,text,timestamptz)
 from public,anon,authenticated,service_role;
create or replace function public.staff_channel_owner_assign(
 p_employee_id uuid,p_kind text,p_title text,p_prompt text,p_nonce uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'owner_target_required' using errcode='42501';end if;
 return public.staff_channel_assign_verified(auth.uid(),p_employee_id,p_kind,p_title,p_prompt,p_nonce,'owner_manual',null);
end $$;
create function public.maintenance_assign_staff_verified(
 p_owner_id uuid,p_business_id uuid,p_task_id text,p_employee_id uuid,p_nonce uuid,p_prompt text,
 p_purpose text,p_due_at timestamptz,p_expected_revision timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid:=p_owner_id; v_case public.operating_tasks; v_receipt jsonb;
 v_request uuid; v_previous public.maintenance_case_events;
begin
 if v_owner is null or not exists(
  select 1 from public.memberships m where m.business_id=p_business_id and m.user_id=v_owner and m.role='owner'
 ) then raise exception 'Owner access required' using errcode='42501'; end if;
 if p_nonce is null or p_purpose not in ('task','verify_working') or char_length(btrim(coalesce(p_prompt,''))) not between 1 and 1200 then
  raise exception 'Invalid maintenance assignment' using errcode='22023'; end if;
 -- Same lock order as staff replies, to avoid employee/case deadlocks.
 perform 1 from public.employees e where e.business_id=p_business_id and e.id=p_employee_id for update;
 if not found then raise exception 'Employee unavailable' using errcode='42501'; end if;
 select * into v_case from public.operating_tasks t
  where t.business_id=p_business_id and t.id=p_task_id and t.kind='maintenance_issue'
   and t.owner_user_id=v_owner for update;
 if not found then raise exception 'Case unavailable' using errcode='42501'; end if;
 select * into v_previous from public.maintenance_case_events e
  where e.business_id=p_business_id and e.task_id=p_task_id and e.idempotency_key='assign:'||p_nonce::text;
 if found then
  if v_previous.note is distinct from btrim(p_prompt) or not exists(
   select 1 from public.staff_communication_requests r where r.business_id=p_business_id
    and r.id::text=v_previous.source_id and r.employee_id=p_employee_id
    and r.source_type=case when p_purpose='verify_working' then 'maintenance_verify' else 'maintenance_task' end
    and r.due_at is not distinct from p_due_at
  ) then raise exception 'Assignment nonce conflict' using errcode='23505'; end if;
  return jsonb_build_object('id',v_previous.source_id,'replayed',true);
 end if;
 if p_expected_revision is not null and v_case.updated_at is distinct from p_expected_revision then
  raise exception 'Maintenance case changed' using errcode='40001';end if;
 if p_due_at is not null and p_due_at<=statement_timestamp() then raise exception 'Maintenance deadline elapsed' using errcode='40001';end if;
 if p_purpose='verify_working' and v_case.payload->>'maintenanceStage'<>'repair_claimed' then
  raise exception 'Repair claim required before assigning independent check' using errcode='40001';end if;
 if v_case.status='handled' or v_case.payload->>'maintenanceStage'='verified_repaired' then
  raise exception 'Case is closed' using errcode='22023'; end if;
 v_receipt:=public.staff_channel_assign_verified(v_owner,p_employee_id,'task',
   left('Maintenance: '||coalesce(v_case.payload->>'equipmentLabel','Equipment'),200),
   btrim(p_prompt),p_nonce,case when p_purpose='verify_working' then 'maintenance_verify' else 'maintenance_task' end,p_due_at);
 v_request:=(v_receipt->>'id')::uuid;
 -- Reusing a previously unrelated manual assignment cannot establish a
 -- maintenance approval or steal an assignment linked to another case.
 if v_receipt->>'replayed'='true' then
  raise exception 'Assignment nonce already used' using errcode='23505'; end if;
 insert into public.maintenance_case_events
  (business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,source_kind,source_id,note)
 values(p_business_id,p_task_id,'assign:'||p_nonce::text,'staff_assignment','owner',v_owner,
  'approved_staff_assignment',v_request::text,btrim(p_prompt));
 perform set_config('app.maintenance_case_transition','allowed',true);
 update public.operating_tasks set status='needs_owner',due_at=coalesce(p_due_at,due_at),
  payload=payload||jsonb_build_object('maintenanceStage',case when payload->>'maintenanceStage' in ('repair_claimed','request_sent')
   then payload->>'maintenanceStage' else 'assigned' end),
  evidence=evidence||jsonb_build_array(jsonb_build_object('source','staff_communication_requests',
   'facts',jsonb_build_object('requestId',v_request,'employeeId',p_employee_id,'kind','staff_assignment','purpose',p_purpose))),
  updated_at=statement_timestamp() where business_id=p_business_id and id=p_task_id;
 perform set_config('app.maintenance_case_transition','',true);
 return v_receipt;
end $$;

revoke all on function public.maintenance_assign_staff_verified(uuid,uuid,text,uuid,uuid,text,text,timestamptz,timestamptz)
 from public,anon,authenticated,service_role;
create function public.maintenance_assign_staff(
 p_business_id uuid,p_task_id text,p_employee_id uuid,p_nonce uuid,p_prompt text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null then
  raise exception 'Owner access required' using errcode='42501';end if;
 return public.maintenance_assign_staff_verified(auth.uid(),p_business_id,p_task_id,p_employee_id,p_nonce,p_prompt,'task',null,null);
end $$;
revoke all on function public.maintenance_assign_staff(uuid,text,uuid,uuid,text) from public,anon;
grant execute on function public.maintenance_assign_staff(uuid,text,uuid,uuid,text) to authenticated;

-- Serialize draft creation per case without changing the owner-visible case
-- revision. Existing generic Gmail proposals have no maintenanceCaseId.
create function public.maintenance_guard_vendor_proposal()
 returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.operating_tasks; v_case_id text:=new.canonical_effect_payload->>'maintenanceCaseId';
begin
 if v_case_id is null then return new;end if;
 if new.capability_id not in ('alex.gmail_effect.v1','leo.maintenance_staff_assignment.v1') or
   (new.capability_id='alex.gmail_effect.v1' and new.canonical_effect_payload->>'operation'<>'send')
   or new.canonical_effect_payload->>'maintenanceCaseRevision' is null then
  raise exception 'Invalid maintenance effect' using errcode='22023';end if;
 select * into v_case from public.operating_tasks t where t.business_id=new.business_id and
  t.id=v_case_id and t.kind='maintenance_issue' and t.owner_user_id=new.owner_user_id for update;
 if not found or v_case.status not in ('needs_owner','needs_response','watching') or
   v_case.updated_at is distinct from (new.canonical_effect_payload->>'maintenanceCaseRevision')::timestamptz or
   not exists(select 1 from public.memberships m where m.business_id=new.business_id
    and m.user_id=new.owner_user_id and m.role='owner') then
  raise exception 'Maintenance case changed' using errcode='42501';end if;
 if exists(select 1 from public.supervisor_proposals p where p.business_id=new.business_id
   and p.owner_user_id=new.owner_user_id and p.canonical_effect_payload->>'maintenanceCaseId'=v_case_id
   and p.status in ('draft','approved','executing') and
   (p.thread_id<>new.thread_id or p.request_key<>new.request_key)) then
  raise exception 'Existing case approval requires review' using errcode='23505';end if;
 return new;
end $$;
revoke all on function public.maintenance_guard_vendor_proposal() from public,anon,authenticated;
create trigger maintenance_vendor_proposal_guard before insert on public.supervisor_proposals
 for each row execute function public.maintenance_guard_vendor_proposal();

-- A verified provider send is copied to the case only from the existing
-- gateway completion transaction; neither a model nor an owner can forge it.
create function public.maintenance_vendor_receipt()
 returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_receipt public.connector_provider_receipts; v_case public.operating_tasks;
 v_case_id text:=new.canonical_effect_payload->>'maintenanceCaseId';
begin
 if v_case_id is null or new.capability_id<>'alex.gmail_effect.v1' or new.status<>'committed'
   or old.status='committed' then return new;end if;
 select r.* into v_receipt from public.connector_provider_receipts r
  join public.supervisor_effect_attempts a on a.business_id=r.business_id and a.proposal_id=r.proposal_id
   and a.effect_hash=r.effect_hash and a.authorization_kind='click' and a.state='verified'
  where r.business_id=new.business_id and r.owner_user_id=new.owner_user_id and r.proposal_id=new.id
   and r.effect_hash=new.effect_hash and r.state='verified' and r.operation='send'
   and r.provider_message_id is not null and r.provider_accepted_at is not null;
 if not found then raise exception 'Maintenance provider receipt required' using errcode='42501';end if;
 select * into v_case from public.operating_tasks t where t.business_id=new.business_id and
  t.id=v_case_id and t.kind='maintenance_issue' and t.owner_user_id=new.owner_user_id for update;
 if not found then return new;end if;
 insert into public.maintenance_case_events
  (business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,source_kind,source_id,occurred_at)
 values(new.business_id,v_case_id,'gmail-send:'||v_receipt.id::text,'vendor_send_verified',
   'supervisor',new.owner_user_id,'gmail_effect_receipt',v_receipt.id::text,v_receipt.provider_accepted_at)
 on conflict(business_id,task_id,idempotency_key) do nothing;
 if found and v_case.status<>'handled' then
  perform set_config('app.maintenance_case_transition','allowed',true);
  update public.operating_tasks set status='needs_owner',
   due_at=coalesce((new.canonical_effect_payload->>'maintenanceDueAt')::timestamptz,due_at),
   payload=payload||jsonb_build_object('externalSent',true,
    'maintenanceStage',case when payload->>'maintenanceStage'='repair_claimed' then 'repair_claimed' else 'request_sent' end),
   evidence=evidence||jsonb_build_array(jsonb_build_object('source','connector_provider_receipts',
    'facts',jsonb_build_object('receiptId',v_receipt.id,'providerAccepted',true,'deliveryVerified',false))),
   updated_at=statement_timestamp() where business_id=new.business_id and id=v_case_id;
  perform set_config('app.maintenance_case_transition','',true);
 end if;
 return new;
end $$;
revoke all on function public.maintenance_vendor_receipt() from public,anon,authenticated;
create trigger maintenance_vendor_receipt_record after update of status on public.supervisor_proposals
 for each row execute function public.maintenance_vendor_receipt();

-- The existing leased worker is the only caller. This is an archive of a
-- provider read, not an outbound effect or proof that equipment works.
create function public.maintenance_record_vendor_reply(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_task_id text,p_lease_token uuid,
 p_receipt_id uuid,p_provider_thread_id text,p_message_id text,p_sender text,
 p_received_at timestamptz,p_note text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.operating_tasks; v_receipt public.connector_provider_receipts;
begin
 if auth.role() is distinct from 'service_role' or not exists(
   select 1 from public.memberships m where m.business_id=p_business_id
    and m.user_id=p_owner_user_id and m.role='owner'
 ) or not exists(
   select 1 from public.supervisor_investigations i
    where i.business_id=p_business_id and i.owner_user_id=p_owner_user_id and i.thread_id=p_thread_id
      and i.source_type='operating_task' and i.source_id=p_task_id and i.lease_token=p_lease_token
      and i.lease_until>statement_timestamp() and i.phase='awaiting_owner'
 ) then raise exception 'Maintenance worker not authorized' using errcode='42501';end if;
 if p_message_id is null or p_message_id !~ '^[a-zA-Z0-9_-]{8,100}$' or
   p_received_at is null or p_received_at>statement_timestamp()+interval '5 minutes' or
   length(coalesce(p_note,''))>1200 then
  raise exception 'Invalid vendor reply' using errcode='22023';end if;
 select * into v_case from public.operating_tasks t where t.business_id=p_business_id
   and t.id=p_task_id and t.owner_user_id=p_owner_user_id and t.kind='maintenance_issue' for update;
 if not found or v_case.status not in ('needs_owner','needs_response','watching') then
  raise exception 'Maintenance case unavailable' using errcode='42501';end if;
 select r.* into v_receipt from public.connector_provider_receipts r
  join public.supervisor_proposals p on p.business_id=r.business_id and p.id=r.proposal_id
    and p.owner_user_id=r.owner_user_id and p.effect_hash=r.effect_hash
  join public.maintenance_case_events e on e.business_id=r.business_id
    and e.task_id=p_task_id and e.kind='vendor_send_verified' and e.source_id=r.id::text
  where r.business_id=p_business_id and r.owner_user_id=p_owner_user_id and r.id=p_receipt_id
    and r.state='verified' and r.operation='send' and r.provider_thread_id=p_provider_thread_id
    and r.provider_message_id<>p_message_id and r.provider_accepted_at<p_received_at
    and p.capability_id='alex.gmail_effect.v1' and p.canonical_effect_payload->>'maintenanceCaseId'=p_task_id
    and lower(p.canonical_effect_payload->'to'->>0)=lower(p_sender);
 if not found then raise exception 'Vendor reply not linked to a verified send' using errcode='42501';end if;
 insert into public.maintenance_case_events
  (business_id,task_id,idempotency_key,kind,actor_kind,source_kind,source_id,note,occurred_at)
 values(p_business_id,p_task_id,'gmail-reply:'||v_receipt.account_id::text||':'||p_message_id,
  'vendor_reply','supervisor','vendor_reply',p_message_id,p_note,p_received_at)
 on conflict(business_id,task_id,idempotency_key) do nothing;
 if not found then return false;end if;
 perform set_config('app.maintenance_case_transition','allowed',true);
 update public.operating_tasks set status='needs_owner',
  evidence=evidence||jsonb_build_array(jsonb_build_object('source','gmail',
   'facts',jsonb_build_object('messageId',p_message_id,'replyReceived',true,'repairVerified',false))),
  updated_at=statement_timestamp() where business_id=p_business_id and id=p_task_id;
 perform set_config('app.maintenance_case_transition','',true);
 return true;
end $$;
revoke all on function public.maintenance_record_vendor_reply(uuid,uuid,uuid,text,uuid,uuid,text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.maintenance_record_vendor_reply(uuid,uuid,uuid,text,uuid,uuid,text,text,text,timestamptz,text) to service_role;

-- Capability commit uses the existing gateway's exact executing click claim.
-- The worker is never allowed to set an authenticated-owner session.
create function public.maintenance_commit_staff_assignment(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals; v_receipt jsonb;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and id=p_proposal_id for update;
 if not found or p.capability_id<>'leo.maintenance_staff_assignment.v1' or p.capability_version<>1
   or p.status<>'executing' or p.effect_hash<>p_effect_hash or not exists(
     select 1 from public.supervisor_effect_attempts a where a.business_id=p_business_id
      and a.proposal_id=p_proposal_id and a.effect_hash=p_effect_hash and a.authorization_kind='click'
      and a.state='executing'
   ) then raise exception 'Maintenance owner click required' using errcode='42501';end if;
 v_receipt:=public.maintenance_assign_staff_verified(p_owner_user_id,p_business_id,
   p.canonical_effect_payload->>'maintenanceCaseId',(p.canonical_effect_payload->>'employeeId')::uuid,
   p_proposal_id,p.canonical_effect_payload->>'prompt',p.canonical_effect_payload->>'purpose',
   (p.canonical_effect_payload->>'dueAt')::timestamptz,
   (p.canonical_effect_payload->>'maintenanceCaseRevision')::timestamptz);
 return v_receipt;
end $$;
revoke all on function public.maintenance_commit_staff_assignment(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.maintenance_commit_staff_assignment(uuid,uuid,uuid,uuid,text) to service_role;

-- Independent postcondition used both by completion and existing receipt-only
-- recovery. A completed task does not assert equipment repair.
create function public.maintenance_staff_assignment_receipt(p public.supervisor_proposals)
 returns text language sql stable security definer set search_path=public,pg_temp as $$
 select e.source_id from public.maintenance_case_events e
 join public.staff_communication_requests r on r.business_id=e.business_id and r.id::text=e.source_id
 where e.business_id=p.business_id and e.task_id=p.canonical_effect_payload->>'maintenanceCaseId'
  and e.idempotency_key='assign:'||p.id::text and e.kind='staff_assignment'
  and e.actor_user_id=p.owner_user_id and e.note=p.canonical_effect_payload->>'prompt'
  and r.employee_id::text=p.canonical_effect_payload->>'employeeId' and r.prompt=e.note
  and r.source_id=p.id::text and r.source_type=case when p.canonical_effect_payload->>'purpose'='verify_working'
   then 'maintenance_verify' else 'maintenance_task' end
  and r.due_at is not distinct from (p.canonical_effect_payload->>'dueAt')::timestamptz;
$$;
revoke all on function public.maintenance_staff_assignment_receipt(public.supervisor_proposals) from public,anon,authenticated,service_role;
create function public.maintenance_staff_commit_guard()
 returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.capability_id='leo.maintenance_staff_assignment.v1' and new.status='committed'
  and old.status<>'committed' and (public.maintenance_staff_assignment_receipt(new) is null or not exists(
    select 1 from public.supervisor_effect_attempts a where a.business_id=new.business_id and
      a.proposal_id=new.id and a.effect_hash=new.effect_hash and a.authorization_kind='click' and a.state='verified'
  )) then raise exception 'Maintenance assignment receipt required' using errcode='42501';end if;
 return new;
end $$;
revoke all on function public.maintenance_staff_commit_guard() from public,anon,authenticated;
create trigger maintenance_staff_commit_guard before update of status on public.supervisor_proposals
 for each row execute function public.maintenance_staff_commit_guard();

-- Extend rather than duplicate the existing receipt-only reconciler. Fail
-- migration if the known integration anchor changes; preserve unrelated cases.
do $migration$
declare function_sql text;
 old_branch text:=$anchor$  elsif p.capability_version = 1 and p.capability_id = 'alex.menu_price_change.v1' then$anchor$;
 new_branch text:=$replacement$  elsif p.capability_version = 1 and p.capability_id = 'leo.maintenance_staff_assignment.v1'
      and a.authorization_kind = 'click' then
    proof_ref := public.maintenance_staff_assignment_receipt(p);
    if proof_ref is not null then
      proof_ref := 'staff_communication_requests:' || proof_ref;
      next_status := 'committed';
      next_start := a.business_date + 1;
    end if;
  elsif p.capability_version = 1 and p.capability_id = 'alex.menu_price_change.v1' then$replacement$;
begin
 function_sql:=pg_get_functiondef('public.supervisor_reconcile_effect_attempt(uuid,uuid,uuid,uuid,integer)'::regprocedure);
 if function_sql is null or position(old_branch in function_sql)=0 then
  raise exception 'maintenance_reconciler_contract_changed';end if;
 execute replace(function_sql,old_branch,new_branch);
end $migration$;
