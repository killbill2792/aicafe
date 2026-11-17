-- Task 13D: durable personnel coordination; 13C owns employee authentication and messages.
-- No new scheduler, owner message transport, job board or implicit employment decision.
set lock_timeout = '3s';
set statement_timeout = '30s';

create table public.staff_coordination_cases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  source_kind text not null check (source_kind in ('staff_message','owner_record','coverage_gap','gmail_thread')),
  source_key text not null check (length(source_key) between 1 and 160),
  case_kind text not null check (case_kind in ('intake','leave','recruitment','onboarding')),
  employee_id uuid,
  location_id uuid,
  role_needed text check (role_needed is null or char_length(role_needed) between 1 and 100),
  from_date date,
  to_date date,
  state text not null default 'new' check (state in
    ('new','investigating','needs_owner_decision','approved','declined',
     'in_progress','waiting_evidence','completed','cancelled')),
  decision text check (decision is null or decision in ('approve','decline','defer')),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  revision int not null default 1 check (revision > 0),
  next_check_at timestamptz,
  retention_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id,id),
  unique (business_id,source_kind,source_key),
  foreign key (business_id,employee_id) references public.employees(business_id,id) on delete restrict,
  foreign key (business_id,location_id) references public.locations(business_id,id) on delete restrict,
  check (from_date is null or to_date is null or from_date <= to_date),
  check (case_kind <> 'leave' or (employee_id is not null and from_date is not null and to_date is not null)),
  check (case_kind <> 'onboarding' or employee_id is not null),
  check (decision is null or (decided_by is not null and decided_at is not null)),
  check (decision is not null or (decided_by is null and decided_at is null)),
  check ((state not in ('approved','declined')) or decision in ('approve','decline'))
);
create index staff_coordination_due_idx on public.staff_coordination_cases
  (business_id,next_check_at) where state not in ('completed','cancelled','declined');
create index staff_coordination_employee_idx on public.staff_coordination_cases
  (business_id,employee_id,created_at desc);

create table public.staff_coordination_evidence (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  case_id uuid not null,
  evidence_key text not null check (length(evidence_key) between 1 and 160),
  source_kind text not null check (source_kind in
    ('staff_message','scheduled_shift','availability_exception',
     'coverage_requirement','owner_decision','provider_receipt')),
  source_id text not null check (length(source_id) between 1 and 200),
  source_revision text not null check (length(source_revision) between 1 and 200),
  observed_at timestamptz not null default now(),
  unique (business_id,case_id,evidence_key),
  foreign key (business_id,case_id) references public.staff_coordination_cases(business_id,id)
    on delete cascade
);
create index staff_coordination_evidence_lookup on public.staff_coordination_evidence
  (business_id,case_id,observed_at desc);

-- This is strictly owner-readable; employees use their *own* 13C channel only.
-- Reason: this brand-new owner-only cases table must enable RLS before any grants.
-- squawk-ignore ban-alter-row-level-security
alter table public.staff_coordination_cases enable row level security;
-- Reason: this brand-new minimal source-evidence table must enable RLS before any grants.
-- squawk-ignore ban-alter-row-level-security
alter table public.staff_coordination_evidence enable row level security;
create policy "owners read staff coordination" on public.staff_coordination_cases
  for select to authenticated using(public.scheduling_is_owner(business_id));
create policy "owners read coordination evidence" on public.staff_coordination_evidence
  for select to authenticated using(public.scheduling_is_owner(business_id));
revoke all on public.staff_coordination_cases,public.staff_coordination_evidence
  from public,anon,authenticated;
grant select on public.staff_coordination_cases,public.staff_coordination_evidence to authenticated;
grant all on public.staff_coordination_cases,public.staff_coordination_evidence to service_role;

-- Durable intake of a VERIFIED 13C employee message, exactly once.
-- No free-text keyword classification, AI instructions or automatic approval.
create function public.staff_coordination_from_staff_message()
 returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case uuid;
begin
 if new.actor <> 'employee' or new.response_code not in ('report','message','decline') then
  return new;
 end if;
 insert into public.staff_coordination_cases
  (business_id,source_kind,source_key,case_kind,employee_id,state,next_check_at)
 values (new.business_id,'staff_message',new.id::text,'intake',new.employee_id,
         'new',now())
 on conflict (business_id,source_kind,source_key) do nothing;
 select id into v_case from public.staff_coordination_cases
  where business_id=new.business_id and source_kind='staff_message' and source_key=new.id::text;
 if v_case is null then raise exception 'staff_coordination_case_missing'; end if;
 insert into public.staff_coordination_evidence
  (business_id,case_id,evidence_key,source_kind,source_id,source_revision)
 values(new.business_id,v_case,'original_message','staff_message',new.id::text,
        new.received_at::text)
 on conflict (business_id,case_id,evidence_key) do nothing;
 return new;
end $$;
revoke all on function public.staff_coordination_from_staff_message() from public,anon,authenticated;
create trigger staff_coordination_intake after insert on public.staff_communication_messages
 for each row execute function public.staff_coordination_from_staff_message();

-- Create an owner-recorded request with explicit attribution. This is NOT
-- proof of worker approval/consent or any real external vacancy/application.
create function public.staff_coordination_open(
 p_business_id uuid,p_nonce uuid,p_kind text,p_employee_id uuid,
 p_location_id uuid,p_from date,p_to date,p_role text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.staff_coordination_cases%rowtype; v_active boolean;
begin
 if (select auth.uid()) is null or not public.scheduling_is_owner(p_business_id) then
  raise exception 'staff_owner_required' using errcode='42501';
 end if;
 if p_nonce is null or p_kind not in ('leave','recruitment','onboarding') or
    p_from is not null and p_to is not null and p_to<p_from or
    p_role is not null and (char_length(btrim(p_role)) not between 1 and 100) then
  raise exception 'invalid_case' using errcode='22023';
 end if;
 if p_kind in ('leave','onboarding') and p_employee_id is null then
  raise exception 'employee_required' using errcode='22023';
 end if;
 if p_kind='leave' and (p_from is null or p_to is null or p_to-p_from>31) then
  raise exception 'leave_dates_invalid' using errcode='22023';
 end if;
 if p_kind='recruitment' and p_employee_id is not null then
  raise exception 'recruitment_not_employee' using errcode='22023';
 end if;
 if p_employee_id is not null then
  select e.active into v_active from public.employees e
   where e.business_id=p_business_id and e.id=p_employee_id;
  if v_active is distinct from true then
   raise exception 'employee_not_active' using errcode='22023';
  end if;
 end if;
 if p_location_id is not null and not exists(
  select 1 from public.locations l where l.business_id=p_business_id and l.id=p_location_id
 ) then raise exception 'location_not_found' using errcode='22023'; end if;
 insert into public.staff_coordination_cases
  (business_id,source_kind,source_key,case_kind,employee_id,location_id,
   from_date,to_date,role_needed,state,next_check_at,retention_at,created_by)
 values(p_business_id,'owner_record',p_nonce::text,p_kind,p_employee_id,p_location_id,
   p_from,p_to,nullif(btrim(p_role),''),
   'needs_owner_decision',now(),
   case when p_kind='recruitment' then now()+interval '90 days' else null end,
   (select auth.uid()))
 on conflict (business_id,source_kind,source_key) do nothing
 returning * into v_case;
 if not found then
  select * into v_case from public.staff_coordination_cases
   where business_id=p_business_id and source_kind='owner_record' and source_key=p_nonce::text;
  if v_case.case_kind is distinct from p_kind or
     v_case.employee_id is distinct from p_employee_id or
     v_case.location_id is distinct from p_location_id or
     v_case.from_date is distinct from p_from or v_case.to_date is distinct from p_to or
     v_case.role_needed is distinct from nullif(btrim(p_role),'') then
   raise exception 'nonce_conflict' using errcode='40900';
  end if;
 end if;
 return jsonb_build_object('id',v_case.id,'revision',v_case.revision,'state',v_case.state);
end $$;
revoke all on function public.staff_coordination_open(uuid,uuid,text,uuid,uuid,date,date,text)
 from public,anon;
grant execute on function public.staff_coordination_open(uuid,uuid,text,uuid,uuid,date,date,text)
 to authenticated;

-- Records OWNER decision only: it cannot hire, reject, authorize a message,
-- mutate a shift or directly grant leave. The effect gateway remains separate.
create function public.staff_coordination_decide(
 p_business_id uuid,p_case_id uuid,p_revision int,p_choice text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.staff_coordination_cases%rowtype; v_status text;
begin
 if (select auth.uid()) is null or not public.scheduling_is_owner(p_business_id) then
  raise exception 'staff_owner_required' using errcode='42501'; end if;
 if p_choice not in ('approve','decline','defer') or p_revision is null then
  raise exception 'decision_invalid' using errcode='22023'; end if;
 select * into v_case from public.staff_coordination_cases
  where business_id=p_business_id and id=p_case_id for update;
 if not found then raise exception 'case_not_found' using errcode='22023'; end if;
 if v_case.revision<>p_revision then
  raise exception 'stale_case' using errcode='40900'; end if;
 if v_case.state in ('completed','cancelled') or
    (v_case.decision is not null and p_choice <> v_case.decision) then
  raise exception 'case_not_decidable' using errcode='40900'; end if;
 if v_case.retention_at is not null and v_case.retention_at<=now() then
  raise exception 'candidate_reference_expired' using errcode='40900'; end if;
 v_status:=case p_choice when 'approve' then 'approved'
                         when 'decline' then 'declined'
                         else 'needs_owner_decision' end;
 update public.staff_coordination_cases set
   decision=case when p_choice='defer' then null else p_choice end,
   decided_by=case when p_choice='defer' then null else (select auth.uid()) end,
   decided_at=case when p_choice='defer' then null else now() end,
   state=v_status,revision=revision+1,updated_at=now(),
   next_check_at=case when p_choice='approve' then now() else null end
 where business_id=p_business_id and id=p_case_id
 returning * into v_case;
 insert into public.staff_coordination_evidence
   (business_id,case_id,evidence_key,source_kind,source_id,source_revision)
 values(p_business_id,p_case_id,'owner_decision:'||v_case.revision::text,
        'owner_decision',(select auth.uid())::text,v_case.revision::text);
 return jsonb_build_object('id',v_case.id,'state',v_case.state,
                           'revision',v_case.revision,'effectApplied',false);
end $$;
revoke all on function public.staff_coordination_decide(uuid,uuid,int,text)
 from public,anon;
grant execute on function public.staff_coordination_decide(uuid,uuid,int,text)
 to authenticated;

-- SERVICE-ONLY source recheck. An owner approving a leave *request* is not
-- sufficient to close it; only all matching, confirmed dated leave rows close.
-- Other kinds stay open until independently verified source evidence is added.
create function public.staff_coordination_reconcile(p_business_id uuid)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.staff_coordination_cases%rowtype;
 v_days int; v_verified int; v_completed int:=0; v_expired int:=0;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501'; end if;
 -- Candidate identifiers are never duplicated here. Retain only a minimal
 -- non-identifying audit after expiration; clear external reference & evidence.
 for v_case in select * from public.staff_coordination_cases
  where business_id=p_business_id and case_kind='recruitment'
    and retention_at<=now() for update loop
  delete from public.staff_coordination_evidence
   where business_id=p_business_id and case_id=v_case.id;
  update public.staff_coordination_cases set source_kind='owner_record',
    source_key='expired:'||id::text, state='cancelled',
    decision=null,decided_by=null,decided_at=null,revision=revision+1,
    next_check_at=null,retention_at=null,updated_at=now()
   where business_id=p_business_id and id=v_case.id;
  v_expired:=v_expired+1;
 end loop;
 for v_case in select * from public.staff_coordination_cases
   where business_id=p_business_id and case_kind='leave'
     and state in ('approved','in_progress','waiting_evidence','completed')
     and decision='approve'
     and (next_check_at<=now() or state='completed') for update loop
  v_days:=v_case.to_date-v_case.from_date+1;
  select count(distinct a.local_date) into v_verified
   from public.staff_availability_exceptions a
   where a.business_id=v_case.business_id and a.employee_id=v_case.employee_id
     and a.exception_type='approved_leave' and a.confirmation='owner_confirmed'
     -- An old unrelated leave row cannot certify that this owner decision was applied.
     and a.confirmed_at>=v_case.decided_at
     and a.local_date between v_case.from_date and v_case.to_date;
  if v_days>0 and v_verified=v_days then
   if v_case.state='completed' then continue; end if;
   update public.staff_coordination_cases set state='completed',
     next_check_at=null,revision=revision+1,updated_at=now()
    where business_id=p_business_id and id=v_case.id;
   insert into public.staff_coordination_evidence
     (business_id,case_id,evidence_key,source_kind,source_id,source_revision)
    values(p_business_id,v_case.id,'verified_leave','availability_exception',
      v_case.employee_id::text,
      'confirmed_days:'||v_verified::text||':'||v_case.from_date::text||':'||v_case.to_date::text)
    on conflict(business_id,case_id,evidence_key) do update
      set source_revision=excluded.source_revision,observed_at=now();
   v_completed:=v_completed+1;
  else
   update public.staff_coordination_cases
    set state='waiting_evidence',revision=revision+1,updated_at=now(),
       next_check_at=now()+interval '1 hour'
    where business_id=p_business_id and id=v_case.id;
  end if;
 end loop;
 return jsonb_build_object('completed',v_completed,'expired',v_expired);
end $$;
revoke all on function public.staff_coordination_reconcile(uuid)
 from public,anon,authenticated;
grant execute on function public.staff_coordination_reconcile(uuid)
 to service_role;
