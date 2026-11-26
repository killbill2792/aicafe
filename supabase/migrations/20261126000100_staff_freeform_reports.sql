-- A message an employee writes on their own (no open request) can be about a call-out, lateness, supplies, equipment
-- or safety. File it where Supervisor reads staff messages and the roster (staff_coverage) so it is understood from
-- the employee's own words, instead of a generic data-quality item. Same trigger and one inbox item per owner.
set lock_timeout='3s';
set statement_timeout='30s';
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
 v_kind:=case when new.request_id is null or v_request_kind in ('shift_confirmation','coverage_offer')
  then 'staff_coverage' else 'data_quality' end;
 for owner_row in select m.user_id from public.memberships m
   where m.business_id=new.business_id and m.role='owner' loop
  insert into public.operating_tasks
   (business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,status,payload,confidence,evidence)
  values(new.business_id,'staff-response:'||new.id::text||':'||owner_row.user_id::text,
   owner_row.user_id,'olivia',v_kind,'staff_message',new.id::text,
   'needs_owner',jsonb_build_object(
      'title',case when new.request_id is null then 'Staff message' else 'Staff replied to assigned work' end,
      'messageId',new.id,'response',new.response_code,'requiresReview',true,
      'nextAction','Read verified staff response and check whether follow-up or owner approval is required'),
   'high',jsonb_build_array(jsonb_build_object('source','staff_communication_messages',
       'facts',jsonb_build_object('messageId',new.id,'employeeId',new.employee_id,
        'response',new.response_code,'requestId',new.request_id))))
  on conflict (business_id,id) do nothing;
 end loop;
 return new;
end $$;
