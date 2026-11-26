-- A message an employee writes on their own (no open request) can be about a call-out, lateness, supplies, equipment
-- or safety. File it where Supervisor reads staff messages and the roster (staff_coverage) so it is understood from
-- the employee's own words, instead of a generic data-quality item. Same trigger and one inbox item per owner.
set lock_timeout='3s';
set statement_timeout='30s';
create or replace function public.staff_channel_notice() returns trigger
 language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_row record; v_kind text; v_request_kind text;
begin
 if new.actor<>'employee' then return new; end if;
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
