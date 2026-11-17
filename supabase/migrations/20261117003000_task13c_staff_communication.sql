-- Task 13C: shared, task-scoped worker communication. Owner provisions auth accounts separately.
-- Never grant an employee business membership or owner Supervisor tools.
set lock_timeout='3s';
set statement_timeout='30s';

-- Reason: a nullable, initially empty identity mapping is essential to prevent staff role escalation; the existing employees table is small and this one-time FK is protected by a 3s lock timeout.
-- squawk-ignore adding-foreign-key-constraint
alter table public.employees add column if not exists staff_auth_user_id uuid references auth.users(id) on delete set null;
create unique index if not exists employees_one_worker_login
  on public.employees(staff_auth_user_id) where staff_auth_user_id is not null;

-- Identity changes are privileged even though the older employees RLS grants
-- café managers general UPDATE rights. A direct authenticated UPDATE must
-- never turn a manager account into a staff-channel reader. SECURITY INVOKER
-- ensures current_user is the actual SQL invoker (the trusted owner-only
-- SECURITY DEFINER linking RPC executes as postgres; clients do not).
create function public.staff_channel_protect_identity_link()
 returns trigger language plpgsql set search_path=public,pg_temp as $
begin
 if new.staff_auth_user_id is distinct from old.staff_auth_user_id
   and current_user not in ('postgres','service_role') then
  raise exception 'staff_link_rpc_required' using errcode='42501';
 end if;
 return new;
end $;
create trigger staff_channel_protect_identity_link
 before update of staff_auth_user_id on public.employees
 for each row execute function public.staff_channel_protect_identity_link();
revoke all on function public.staff_channel_protect_identity_link() from public,anon,authenticated;

-- A café owner links an ALREADY CONFIRMED Supabase login to exactly one active
-- employee. Exact email is matched only in trusted SQL; no public user directory.
create function public.staff_link_existing_login(
  p_business_id uuid,p_employee_id uuid,p_email text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid; v_employee public.employees%rowtype;
begin
 if auth.uid() is null or not public.scheduling_is_owner(p_business_id) then
  raise exception 'staff_owner_required' using errcode='42501'; end if;
 select * into v_employee from public.employees
  where business_id=p_business_id and id=p_employee_id for update;
 if not found then
  raise exception 'employee_not_found' using errcode='22023'; end if;
 -- Revocation must remain available after an employee is deactivated.
 if p_email is null then
  update public.employees set staff_auth_user_id=null
   where business_id=p_business_id and id=p_employee_id;
  return jsonb_build_object('linked',false);
 end if;
 -- New links are only valid for currently active staff.
 if not v_employee.active then
  raise exception 'active_employee_required' using errcode='22023'; end if;
 if char_length(p_email)>320 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
  raise exception 'invalid_email' using errcode='22023'; end if;
 select u.id into v_user from auth.users u
  where lower(u.email)=lower(p_email) and u.email_confirmed_at is not null;
 if v_user is null then
  raise exception 'confirmed_login_not_found' using errcode='22023'; end if;
 -- Do not turn an owner/manager account into a worker; this also enforces
 -- lack of access to *another* café, except auto-granted shared demo memberships.
 if exists(select 1 from public.memberships m
   join public.businesses b on b.id=m.business_id
   where m.user_id=v_user and b.is_demo=false) then
  raise exception 'management_account_not_worker' using errcode='42501'; end if;
 if exists(select 1 from public.employees e
   where e.staff_auth_user_id=v_user and e.id<>p_employee_id) then
  raise exception 'login_already_linked' using errcode='23505'; end if;
 update public.employees set staff_auth_user_id=v_user
  where business_id=p_business_id and id=p_employee_id;
 -- Some new auth accounts get automatically added to a shared demo café.
 -- Remove that membership rather than allowing a worker onto owner screens.
 delete from public.memberships m using public.businesses b
  where m.business_id=b.id and b.is_demo=true and m.user_id=v_user;
 return jsonb_build_object('linked',true);
end $$;
revoke all on function public.staff_link_existing_login(uuid,uuid,text) from public,anon;
grant execute on function public.staff_link_existing_login(uuid,uuid,text) to authenticated;

create function public.staff_channel_is_employee(p_business_id uuid,p_employee_id uuid)
 returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select (select auth.uid()) is not null and exists(
  select 1 from public.employees e
  where e.business_id=p_business_id and e.id=p_employee_id
    and e.staff_auth_user_id=(select auth.uid()) and e.active=true
 );
$$;
revoke all on function public.staff_channel_is_employee(uuid,uuid) from public,anon;
grant execute on function public.staff_channel_is_employee(uuid,uuid) to authenticated;

-- A request is a *bounded action*, not an open employee chat.
-- Other PRs can issue tasks/checklists through the same service-owned table.
create table public.staff_communication_requests (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 employee_id uuid not null,
 kind text not null check(kind in ('shift_confirmation','coverage_offer','checklist','task')),
 source_type text not null check(char_length(source_type) between 1 and 70),
 source_id text not null check(char_length(source_id) between 1 and 160),
 source_revision text not null check(char_length(source_revision) between 1 and 100),
 title text not null check(char_length(title) between 1 and 200),
 prompt text not null check(char_length(prompt) between 1 and 2000),
 status text not null default 'open' check(status in ('open','responded','cancelled','closed')),
 due_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(business_id,id),
 -- Messages must reference the exact employee assigned to a request.
 unique(business_id,id,employee_id),
 unique(business_id,employee_id,kind,source_type,source_id,source_revision),
 foreign key(business_id,employee_id) references public.employees(business_id,id) on delete cascade
);
create index staff_communication_requests_worker
 on public.staff_communication_requests(business_id,employee_id,status,created_at desc);
-- Immutability matters: a declined shift is evidence, not a roster update.
create table public.staff_communication_messages (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 employee_id uuid not null,
 request_id uuid,
 actor text not null check(actor in ('employee','supervisor','owner')),
 -- Keep signed original owner ID even after account deletion; never
 -- block user deletion or reattribute a retained historical message.
 author_user_id uuid,
 response_code text not null check(response_code in ('confirm','decline','complete','message','report','owner_message')),
 body text check(body is null or char_length(body) between 1 and 2000),
 channel text not null check(channel in ('web','whatsapp')),
 client_nonce uuid not null,
 provider_event_id text,
 received_at timestamptz not null default now(),
 unique(business_id,id),
 unique(business_id,employee_id,client_nonce),
 unique(channel,provider_event_id),
 foreign key(business_id,employee_id) references public.employees(business_id,id) on delete cascade,
 foreign key(business_id,request_id,employee_id)
  references public.staff_communication_requests(business_id,id,employee_id),
 check(response_code not in ('message','report','owner_message') or body is not null),
 check((response_code='report' and request_id is null and actor='employee') or
       (response_code='owner_message' and request_id is null and actor='owner') or
       (response_code not in ('report','owner_message') and request_id is not null)),
 check((actor='owner' and author_user_id is not null) or
       (actor<>'owner' and author_user_id is null)),
 check((channel='web' and provider_event_id is null) or
       (channel='whatsapp' and provider_event_id is not null))
);

-- Signed Meta text from unknown/ambiguous senders is recorded as unmatched
-- metadata, never guessed to belong to an employee or delivered as an owner task.
create table public.staff_communication_unmatched_inbound (
 provider_event_id text primary key,
 sender_digest text not null check(sender_digest ~ '^[0-9a-f]{64}$'),
 reason text not null check(reason in ('no_opted_in_employee','ambiguous_employee')),
 received_at timestamptz not null default now()
);
-- Reason: this newly created quarantine table must fail closed for anonymous and staff sessions before any insert, with no existing readers.
-- squawk-ignore ban-alter-row-level-security
alter table public.staff_communication_unmatched_inbound enable row level security;
revoke all on public.staff_communication_unmatched_inbound from public,anon,authenticated;
grant all on public.staff_communication_unmatched_inbound to service_role;

create index staff_communication_messages_worker
 on public.staff_communication_messages(business_id,employee_id,received_at desc);

-- Reason: this brand-new staff requests table has no historic clients, and RLS must be enabled before any employee read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.staff_communication_requests enable row level security;
-- Reason: this brand-new free-text employee message table has no historic clients, and isolation RLS must be enabled before any employee read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.staff_communication_messages enable row level security;
create policy "owner reads staff requests" on public.staff_communication_requests
 for select to authenticated using(public.scheduling_is_owner(business_id));
create policy "employee reads own requests" on public.staff_communication_requests
 for select to authenticated using(public.staff_channel_is_employee(business_id,employee_id));
create policy "owner reads staff messages" on public.staff_communication_messages
 for select to authenticated using(public.scheduling_is_owner(business_id));
create policy "employee reads own messages" on public.staff_communication_messages
 for select to authenticated using(public.staff_channel_is_employee(business_id,employee_id));
revoke all on public.staff_communication_requests,public.staff_communication_messages from public,anon,authenticated;
grant select on public.staff_communication_requests,public.staff_communication_messages to authenticated;
grant all on public.staff_communication_requests,public.staff_communication_messages to service_role;

-- Use the existing routine tick and web reads to publish exactly one action
-- for each *current* published shift revision. Cancels stale versions.
create function public.staff_channel_sync_shift_requests(p_business_id uuid)
 returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare today date; inserted integer;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501'; end if;
 select (now() at time zone b.timezone)::date into today
  from public.businesses b where b.id=p_business_id;
 if today is null then raise exception 'missing_timezone' using errcode='22023'; end if;
 insert into public.staff_communication_requests
 (business_id,employee_id,kind,source_type,source_id,source_revision,title,prompt)
 select s.business_id,s.employee_id,'shift_confirmation','scheduled_shift',
  s.id::text,s.updated_at::text,'Confirm your shift',
  to_char(s.local_date,'YYYY-MM-DD')||' '||
  to_char(s.start_local,'HH24:MI')||' – '||to_char(s.end_local,'HH24:MI')||
  case when s.overnight then ' (next day)' else '' end
 from public.scheduled_shifts s
 join public.employees e on e.business_id=s.business_id and e.id=s.employee_id
 where s.business_id=p_business_id and s.status='sent' and s.deleted_at is null
  and s.local_date between today and today+21
  and e.active and e.staff_auth_user_id is not null
 on conflict (business_id,employee_id,kind,source_type,source_id,source_revision) do nothing;
 get diagnostics inserted=row_count;
 update public.staff_communication_requests r set status='cancelled',updated_at=now()
 where r.business_id=p_business_id and r.kind='shift_confirmation'
  and r.source_type='scheduled_shift' and r.status in ('open','responded')
  and not exists(
   select 1 from public.scheduled_shifts s
   where s.business_id=r.business_id and s.id::text=r.source_id
    and s.employee_id=r.employee_id and s.deleted_at is null and s.status='sent'
    and s.updated_at::text=r.source_revision and s.local_date>=today
  );
 return inserted;
end $$;
revoke all on function public.staff_channel_sync_shift_requests(uuid) from public,anon,authenticated;
grant execute on function public.staff_channel_sync_shift_requests(uuid) to service_role;

-- An unanswered imminent published shift creates one durable owner action,
-- not a chat-only reminder. Missing response is NOT a decline or attendance.
create function public.staff_channel_escalate_unanswered(p_business_id uuid)
 returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare today date; count_rows integer;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501'; end if;
 select (now() at time zone b.timezone)::date into today
  from public.businesses b where b.id=p_business_id;
 if today is null then raise exception 'missing_timezone' using errcode='22023'; end if;
 insert into public.operating_tasks
 (business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,
  status,payload,confidence,evidence)
 select r.business_id,'staff-unanswered:'||r.id::text||':'||m.user_id::text,
   m.user_id,'olivia','staff_coverage','scheduled_shift',r.source_id,
   'needs_owner',jsonb_build_object(
    'title','Staff shift confirmation needs follow-up',
    'requestId',r.id,'shiftId',r.source_id,
    'shiftDate',s.local_date,'response','none_verified',
    'nextAction','Investigate the actual shift and request authorized employee follow-up'),
   'high',jsonb_build_array(jsonb_build_object('source','staff_communication_requests',
    'facts',jsonb_build_object('requestId',r.id,'sourceRevision',r.source_revision,
     'status','open','date',s.local_date)))
 from public.staff_communication_requests r
 join public.scheduled_shifts s
  on s.business_id=r.business_id and s.id::text=r.source_id
  and s.employee_id=r.employee_id and s.updated_at::text=r.source_revision
  and s.deleted_at is null and s.status='sent'
 join public.memberships m on m.business_id=r.business_id and m.role='owner'
 where r.business_id=p_business_id and r.kind='shift_confirmation'
  and r.source_type='scheduled_shift' and r.status='open'
  and s.local_date between today and today+1
 on conflict (business_id,id) do nothing;
 get diagnostics count_rows=row_count;
 return count_rows;
end $$;
revoke all on function public.staff_channel_escalate_unanswered(uuid) from public,anon,authenticated;
grant execute on function public.staff_channel_escalate_unanswered(uuid) to service_role;

-- Writes are via a verified authenticated employee's login, never client-supplied
-- business/employee ID. A text-only reply to an assigned request is always allowed.
create function public.staff_channel_submit(
 p_request_id uuid,p_response text,p_body text,p_nonce uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare emp public.employees%rowtype; req public.staff_communication_requests%rowtype;
  previous public.staff_communication_messages%rowtype; created uuid; v_body text;
begin
 if (select auth.uid()) is null then
  raise exception 'login_required' using errcode='42501'; end if;
 select * into emp from public.employees
  where staff_auth_user_id=(select auth.uid()) and active=true for share;
 if not found then raise exception 'staff_login_required' using errcode='42501'; end if;
 if p_nonce is null or p_response not in ('confirm','decline','complete','message','report') then
  raise exception 'invalid_response' using errcode='22023'; end if;
 v_body:=nullif(btrim(coalesce(p_body,'')),'');
 if char_length(coalesce(v_body,''))>2000 or
   (p_response in ('report','message') and v_body is null) then
  raise exception 'invalid_message' using errcode='22023'; end if;
 -- Idempotent retries must succeed EVEN AFTER a prior response closes the
 -- request or the shift changes. Check exact nonce first, then source status.
 select * into previous from public.staff_communication_messages m
  where m.business_id=emp.business_id and m.employee_id=emp.id
    and m.client_nonce=p_nonce;
 if found then
  if previous.request_id is distinct from p_request_id or
     previous.response_code is distinct from p_response or
     previous.body is distinct from v_body or previous.channel<>'web'
  then raise exception 'nonce_conflict' using errcode='40900'; end if;
  return jsonb_build_object('id',previous.id,'replayed',true);
 end if;
 if p_request_id is null then
  if p_response<>'report' then raise exception 'request_required' using errcode='22023'; end if;
 else
  select * into req from public.staff_communication_requests
   where id=p_request_id and business_id=emp.business_id and employee_id=emp.id
   for update;
  if not found or req.status in ('cancelled','closed') then
   raise exception 'unavailable_request' using errcode='42501'; end if;
  if p_response='report' or
    (req.kind in ('shift_confirmation','coverage_offer') and
      p_response not in ('confirm','decline','message')) or
    (req.kind in ('checklist','task') and
      p_response not in ('complete','message')) or
    (req.status='responded' and p_response<>'message') then
   raise exception 'response_not_allowed' using errcode='22023'; end if;
  -- A changed/removed shift cannot be accepted from a stale open tab.
  if req.kind='shift_confirmation' and not exists(
   select 1 from public.scheduled_shifts s
   where s.business_id=emp.business_id and s.id::text=req.source_id
     and s.employee_id=emp.id and s.status='sent' and s.deleted_at is null
     and s.updated_at::text=req.source_revision
  ) then raise exception 'shift_changed' using errcode='40900'; end if;
 end if;

 insert into public.staff_communication_messages
 (business_id,employee_id,request_id,actor,response_code,body,channel,client_nonce)
 values(emp.business_id,emp.id,p_request_id,'employee',p_response,v_body,'web',p_nonce)
 returning id into created;
 if p_response in ('confirm','decline','complete') then
  update public.staff_communication_requests set status='responded',updated_at=now()
   where id=p_request_id and business_id=emp.business_id;
 end if;
 return jsonb_build_object('id',created,'replayed',false);
end $$;
revoke all on function public.staff_channel_submit(uuid,text,text,uuid) from public,anon;
grant execute on function public.staff_channel_submit(uuid,text,text,uuid) to authenticated;

-- An explicit owner Send click writes to the employee's existing private web
-- channel. It is an in-app record, NOT a WhatsApp delivery or read receipt.
-- Future automated sends must use the separate effect gateway, not this RPC.
create function public.staff_channel_owner_send(
 p_employee_id uuid,p_body text,p_nonce uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare emp public.employees%rowtype;
  previous public.staff_communication_messages%rowtype; created uuid;
  v_body text; v_actor uuid;
begin
 v_actor:=(select auth.uid());
 if v_actor is null then raise exception 'login_required' using errcode='42501'; end if;
 select * into emp from public.employees where id=p_employee_id for share;
 if not found or not emp.active or emp.staff_auth_user_id is null or
    not public.scheduling_is_owner(emp.business_id) then
   raise exception 'owner_target_required' using errcode='42501'; end if;
 v_body:=nullif(btrim(coalesce(p_body,'')),'');
 if p_nonce is null or v_body is null or char_length(v_body)>2000 then
   raise exception 'invalid_owner_message' using errcode='22023'; end if;
 select * into previous from public.staff_communication_messages m
  where m.business_id=emp.business_id and m.employee_id=emp.id
    and m.client_nonce=p_nonce;
 if found then
  if previous.actor<>'owner' or previous.author_user_id is distinct from v_actor or
     previous.response_code<>'owner_message' or
     previous.request_id is not null or previous.body is distinct from v_body then
    raise exception 'owner_nonce_conflict' using errcode='40900'; end if;
  return jsonb_build_object('id',previous.id,'replayed',true);
 end if;
 insert into public.staff_communication_messages
 (business_id,employee_id,request_id,actor,author_user_id,
  response_code,body,channel,client_nonce)
 values(emp.business_id,emp.id,null,'owner',v_actor,
  'owner_message',v_body,'web',p_nonce) returning id into created;
 return jsonb_build_object('id',created,'replayed',false);
end $$;
revoke all on function public.staff_channel_owner_send(uuid,text,uuid) from public,anon;
grant execute on function public.staff_channel_owner_send(uuid,text,uuid) to authenticated;

-- Future owner checklist/task PRs share the SAME employee action channel.
-- Only manually owner-approved, in-app assignments are exposed by this RPC;
-- schedule changes and coverage offers remain gated by their own sources.
create unique index staff_communication_owner_request_nonce
 on public.staff_communication_requests(business_id,employee_id,source_id)
 where source_type='owner_manual';
create function public.staff_channel_owner_assign(
 p_employee_id uuid,p_kind text,p_title text,p_prompt text,p_nonce uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare emp public.employees%rowtype; assignment public.staff_communication_requests%rowtype;
 v_title text;v_prompt text;
begin
 select * into emp from public.employees where id=p_employee_id for share;
 if not found or not emp.active or emp.staff_auth_user_id is null or
  not public.scheduling_is_owner(emp.business_id) then
   raise exception 'owner_target_required' using errcode='42501'; end if;
 v_title:=nullif(btrim(coalesce(p_title,'')),'');
 v_prompt:=nullif(btrim(coalesce(p_prompt,'')),'');
 if p_nonce is null or p_kind not in ('checklist','task') or
    v_title is null or char_length(v_title)>200 or
    v_prompt is null or char_length(v_prompt)>2000 then
    raise exception 'invalid_assignment' using errcode='22023'; end if;
 select * into assignment from public.staff_communication_requests r
  where r.business_id=emp.business_id and r.employee_id=emp.id
   and r.source_type='owner_manual' and r.source_id=p_nonce::text for update;
 if found then
   if assignment.kind<>p_kind or assignment.title<>v_title or
      assignment.prompt<>v_prompt then
    raise exception 'assignment_nonce_conflict' using errcode='40900'; end if;
   return jsonb_build_object('id',assignment.id,'replayed',true);
 end if;
 insert into public.staff_communication_requests
  (business_id,employee_id,kind,source_type,source_id,source_revision,title,prompt)
 values (emp.business_id,emp.id,p_kind,'owner_manual',p_nonce::text,'v1',v_title,v_prompt)
 returning * into assignment;
 return jsonb_build_object('id',assignment.id,'replayed',false);
end $$;
revoke all on function public.staff_channel_owner_assign(uuid,text,text,text,uuid) from public,anon;
grant execute on function public.staff_channel_owner_assign(uuid,text,text,text,uuid) to authenticated;

-- Every *new* staff response produces one canonical owner inbox receipt in the
-- SAME transaction. Staff text remains data, not an instruction or approval.
create function public.staff_channel_notice() returns trigger
 language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_row record; v_kind text; v_request_kind text;
begin
 -- Owner replies are visible to employees, never fake new staff events.
 if new.actor<>'employee' then return new; end if;
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
revoke all on function public.staff_channel_notice() from public,anon,authenticated;
create trigger staff_channel_message_notice after insert on public.staff_communication_messages
 for each row execute function public.staff_channel_notice();
