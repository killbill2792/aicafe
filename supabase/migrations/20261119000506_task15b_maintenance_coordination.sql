-- Task15B: extend the original worker inbox and canonical incident ledger.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.maintenance_case_events drop constraint maintenance_case_events_kind_check;
alter table public.maintenance_case_events add constraint maintenance_case_events_kind_check
 check(kind in ('report','repair_claim','operational_verification','blocked','reopened','follow_up','staff_assignment')) not valid;
alter table public.maintenance_case_events validate constraint maintenance_case_events_kind_check;
alter table public.maintenance_case_events drop constraint maintenance_case_events_source_kind_check;
alter table public.maintenance_case_events add constraint maintenance_case_events_source_kind_check
 check(source_kind in ('owner_report','owner_relay','owner_operational_check','system_follow_up','staff_report','approved_staff_assignment')) not valid;
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
declare owner_row record; v_kind text; v_request_kind text; v_parts text[]; v_symptom text; v_owner uuid; v_owners uuid[]; v_task text; v_auth uuid; v_case public.operating_tasks; v_event public.maintenance_case_events;
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
create function public.maintenance_assign_staff(
 p_business_id uuid,p_task_id text,p_employee_id uuid,p_nonce uuid,p_prompt text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid:=auth.uid(); v_case public.operating_tasks; v_receipt jsonb;
 v_request uuid; v_previous public.maintenance_case_events;
begin
 if auth.role()<>'authenticated' or v_owner is null or not exists(
  select 1 from public.memberships m where m.business_id=p_business_id and m.user_id=v_owner and m.role='owner'
 ) then raise exception 'Owner access required' using errcode='42501'; end if;
 if p_nonce is null or char_length(btrim(coalesce(p_prompt,''))) not between 1 and 1200 then
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
  ) then raise exception 'Assignment nonce conflict' using errcode='23505'; end if;
  return jsonb_build_object('id',v_previous.source_id,'replayed',true);
 end if;
 if v_case.status='handled' or v_case.payload->>'maintenanceStage'='verified_repaired' then
  raise exception 'Case is closed' using errcode='22023'; end if;
 v_receipt:=public.staff_channel_owner_assign(p_employee_id,'task',
   left('Maintenance: '||coalesce(v_case.payload->>'equipmentLabel','Equipment'),200),
   btrim(p_prompt),p_nonce);
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
 update public.operating_tasks set status='needs_owner',
  payload=payload||jsonb_build_object('maintenanceStage',case when payload->>'maintenanceStage' in ('repair_claimed','request_sent')
   then payload->>'maintenanceStage' else 'assigned' end),
  evidence=evidence||jsonb_build_array(jsonb_build_object('source','staff_communication_requests',
   'facts',jsonb_build_object('requestId',v_request,'employeeId',p_employee_id,'kind','staff_assignment'))),
  updated_at=statement_timestamp() where business_id=p_business_id and id=p_task_id;
 perform set_config('app.maintenance_case_transition','',true);
 return v_receipt;
end $$;
revoke all on function public.maintenance_assign_staff(uuid,text,uuid,uuid,text) from public,anon;
grant execute on function public.maintenance_assign_staff(uuid,text,uuid,uuid,text) to authenticated;
