-- Task13B staff standing mandate: reuse the Task10 owner-phone-MFA ledger and
-- existing staff effect gateway. Never grant general staff-writing permission.
set lock_timeout='3s';
set statement_timeout='30s';
-- Existing goal rows have null week; the new capability is a single future week.
alter table public.supervisor_mandates add column staff_week_start date;
alter table public.supervisor_mandate_challenges add column staff_week_start date;
-- Reason: expand exact capability-id check to one narrowly scoped staff send capability.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandates drop constraint supervisor_mandates_capability_id_check;
-- Reason: expand exact capability-version check from 1 to strict {goal:1,staff:2}.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandates drop constraint supervisor_mandates_capability_version_check;
-- Reason: a staff mandate counts recipients, not five goal events.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandates drop constraint supervisor_mandates_limit_value_check;
-- Reason: staff_week is the only added period; goal remains cafe_day.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandates drop constraint supervisor_mandates_period_kind_check;
-- Reason: expand exact capability-id check in phone challenge ledger only.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandate_challenges drop constraint supervisor_mandate_challenges_capability_id_check;
-- Reason: phone challenge staff version must be exactly v2.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandate_challenges drop constraint supervisor_mandate_challenges_capability_version_check;
-- Reason: staff challenge recipient limit is 1..30, not five goal actions.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandate_challenges drop constraint supervisor_mandate_challenges_limit_value_check;
-- Reason: challenge period is staff_week only for this staff capability.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_mandate_challenges drop constraint supervisor_mandate_challenges_period_kind_check;
-- New NOT VALID constraints enforce all new writes without scanning old rows
-- under the migration lock. Old goal rows already met the original checks.
alter table public.supervisor_mandates add constraint supervisor_mandates_capability_scope_check
 check ((capability_id='leo.goal.v1' and capability_version=1 and
   limit_value=5 and period_kind='cafe_day' and staff_week_start is null)
   or (capability_id='olivia.staff_propose_send_schedule.v2' and
   capability_version=2 and limit_value between 1 and 30 and
   period_kind='staff_week' and staff_week_start is not null and
   extract(isodow from staff_week_start)=1)) not valid;
alter table public.supervisor_mandate_challenges add constraint supervisor_mandate_challenges_capability_scope_check
 check ((capability_id='leo.goal.v1' and capability_version=1 and
   limit_value=5 and period_kind='cafe_day' and staff_week_start is null)
   or (capability_id='olivia.staff_propose_send_schedule.v2' and
   capability_version=2 and limit_value between 1 and 30 and
   period_kind='staff_week' and staff_week_start is not null and
   extract(isodow from staff_week_start)=1)) not valid;

-- Only the verified owner-phone-MFA challenge flow may request this service-only
-- insertion; no direct authenticated GRANT / INSERT is possible.
create function public.supervisor_create_staff_mandate_challenge(
 p_business_id uuid,p_owner_user_id uuid,p_challenge_id uuid,
 p_action text,p_mandate_id uuid,p_mandate_revision bigint,
 p_policy_hash text,p_limit_value integer,p_week_start date,
 p_mandate_expires_at timestamptz,p_factor_id text,
 p_provider_challenge_id text,p_challenge_expires_at timestamptz
) returns public.supervisor_mandate_challenges
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.supervisor_mandate_challenges%rowtype;
  local_day date;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501'; end if;
 select (now() at time zone b.timezone)::date into local_day
  from public.businesses b join public.memberships m
   on m.business_id=b.id and m.user_id=p_owner_user_id and m.role='owner'
  where b.id=p_business_id and b.is_demo=false;
 if local_day is null then raise exception 'mandate_owner_required' using errcode='42501'; end if;
 if p_limit_value not between 1 and 30 or p_week_start is null
  or extract(isodow from p_week_start)<>1
  or p_week_start<local_day or p_week_start>local_day+28
  or p_mandate_expires_at<=now() or
    p_mandate_expires_at>p_week_start+interval '7 days'
  or p_policy_hash !~ '^[a-f0-9]{64}$'
  or p_challenge_expires_at<=now() or p_challenge_expires_at>now()+interval '10 minutes'
  or length(coalesce(p_factor_id,'')) not between 1 and 200
  or length(coalesce(p_provider_challenge_id,'')) not between 1 and 200 then
  raise exception 'invalid_staff_mandate_scope' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(
   'supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||
   ':olivia.staff_propose_send_schedule.v2',0));
 if p_action='grant' then
  if p_mandate_revision<>0 or exists(select 1 from public.supervisor_mandates
   where business_id=p_business_id and owner_user_id=p_owner_user_id
    and capability_id='olivia.staff_propose_send_schedule.v2'
    and superseded_at is null and revoked_at is null and expires_at>now())
   then raise exception 'active_staff_mandate_exists' using errcode='P0001'; end if;
 elsif p_action='revise' then
  if not exists(select 1 from public.supervisor_mandates
    where id=p_mandate_id and revision=p_mandate_revision
     and business_id=p_business_id and owner_user_id=p_owner_user_id
     and capability_id='olivia.staff_propose_send_schedule.v2'
     and superseded_at is null and revoked_at is null and expires_at>now())
   then raise exception 'staff_mandate_revision_conflict' using errcode='P0001'; end if;
 else raise exception 'invalid_mandate_action' using errcode='22023'; end if;
 insert into public.supervisor_mandate_challenges(
  id,business_id,owner_user_id,action,mandate_id,mandate_revision,
  capability_id,capability_version,policy_hash,limit_value,period_kind,
  staff_week_start,mandate_expires_at,factor_id,provider_challenge_id,expires_at
 ) values (
  p_challenge_id,p_business_id,p_owner_user_id,p_action,p_mandate_id,p_mandate_revision,
  'olivia.staff_propose_send_schedule.v2',2,p_policy_hash,p_limit_value,'staff_week',
  p_week_start,p_mandate_expires_at,p_factor_id,p_provider_challenge_id,p_challenge_expires_at
 ) returning * into c;
 return c;
end $$;
revoke all on function public.supervisor_create_staff_mandate_challenge(
 uuid,uuid,uuid,text,uuid,bigint,text,integer,date,timestamptz,text,text,timestamptz)
 from public,anon,authenticated;
grant execute on function public.supervisor_create_staff_mandate_challenge(
 uuid,uuid,uuid,text,uuid,bigint,text,integer,date,timestamptz,text,text,timestamptz)
 to service_role;


create or replace function public.supervisor_complete_mandate_challenge(
  p_business_id uuid, p_owner_user_id uuid, p_challenge_id uuid,
  p_factor_id text, p_provider_challenge_id text
) returns public.supervisor_mandates
language plpgsql security definer set search_path = public as $$
declare c public.supervisor_mandate_challenges; old_m public.supervisor_mandates;
  result_m public.supervisor_mandates; next_revision integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':leo.goal.v1',0));
  perform pg_advisory_xact_lock(hashtextextended('supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':olivia.staff_propose_send_schedule.v2',0));
  select * into c from public.supervisor_mandate_challenges
    where id = p_challenge_id and business_id = p_business_id
      and owner_user_id = p_owner_user_id for update;
  if c.id is null or c.consumed_at is not null or c.expires_at <= now()
    or c.factor_id is distinct from p_factor_id
    or c.provider_challenge_id is distinct from p_provider_challenge_id
  then raise exception 'mandate_challenge_expired_or_consumed' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
    join public.businesses b on b.id = m.business_id
    where m.business_id = p_business_id and m.user_id = p_owner_user_id
      and m.role = 'owner' and b.is_demo = false)
  then raise exception 'mandate_owner_required' using errcode = '42501'; end if;
  if (c.capability_id='leo.goal.v1' and c.staff_week_start is not null)
    or (c.capability_id='olivia.staff_propose_send_schedule.v2' and (c.staff_week_start is null or extract(isodow from c.staff_week_start)<>1))
    or c.mandate_expires_at <= now() then raise exception 'mandate_expired' using errcode = 'P0001'; end if;
  if c.action = 'grant' then
    if exists (select 1 from public.supervisor_mandates m
      where m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.capability_id = c.capability_id and m.superseded_at is null
        and m.revoked_at is null and m.expires_at > now())
    then raise exception 'active_mandate_exists' using errcode = 'P0001'; end if;
    next_revision := 1;
  else
    select * into old_m from public.supervisor_mandates
      where id = c.mandate_id and revision = c.mandate_revision
        and business_id = p_business_id and owner_user_id = p_owner_user_id
        and superseded_at is null and revoked_at is null for update;
    if old_m.id is null or old_m.expires_at <= now() or old_m.capability_id is distinct from c.capability_id
    then raise exception 'mandate_revision_conflict' using errcode = 'P0001'; end if;
    update public.supervisor_mandates set superseded_at = now()
      where id = old_m.id and revision = old_m.revision;
    next_revision := old_m.revision + 1;
  end if;
  update public.supervisor_mandate_challenges set consumed_at = now()
    where id = c.id and consumed_at is null;
  insert into public.supervisor_mandates(
    id,revision,business_id,owner_user_id,capability_id,capability_version,
    policy_hash,limit_kind,limit_value,currency,period_kind,expires_at,verified_at,staff_week_start
  ) values (
    c.mandate_id,next_revision,c.business_id,c.owner_user_id,c.capability_id,c.capability_version,
    c.policy_hash,'count',c.limit_value,null,c.period_kind,c.mandate_expires_at,now(),c.staff_week_start
  ) returning * into result_m;
  return result_m;
end $$;

create or replace function public.supervisor_revoke_mandate(
  p_business_id uuid, p_owner_user_id uuid, p_mandate_id uuid, p_revision integer
) returns public.supervisor_mandates
language plpgsql security definer set search_path = public as $$
declare old_m public.supervisor_mandates; result_m public.supervisor_mandates;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':leo.goal.v1',0));
  perform pg_advisory_xact_lock(hashtextextended('supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':olivia.staff_propose_send_schedule.v2',0));
  if not exists (select 1 from public.memberships m
    where m.business_id = p_business_id and m.user_id = p_owner_user_id and m.role = 'owner')
  then raise exception 'mandate_owner_required' using errcode = '42501'; end if;
  select * into old_m from public.supervisor_mandates
    where id = p_mandate_id and business_id = p_business_id
      and owner_user_id = p_owner_user_id and revision = p_revision
      and superseded_at is null and revoked_at is null for update;
  if old_m.id is null then raise exception 'mandate_revision_conflict' using errcode = 'P0001'; end if;
  update public.supervisor_mandates set superseded_at = now()
    where id = old_m.id and revision = old_m.revision;
  insert into public.supervisor_mandates(
    id,revision,business_id,owner_user_id,capability_id,capability_version,
    policy_hash,limit_kind,limit_value,currency,period_kind,expires_at,
    revoked_at,verified_at,staff_week_start
  ) values (
    old_m.id,old_m.revision+1,old_m.business_id,old_m.owner_user_id,
    old_m.capability_id,old_m.capability_version,old_m.policy_hash,
    old_m.limit_kind,old_m.limit_value,old_m.currency,old_m.period_kind,
    old_m.expires_at,now(),old_m.verified_at,old_m.staff_week_start
  ) returning * into result_m;
  return result_m;
end $$;


-- A publication is authorized by the original individual owner-click OR
-- one still-active verified-phone-MFA staff mandate scoped to the exact week,
-- café, owner, source hash and maximum distinct recipients. Revocation and
-- expiration invalidate ALL outstanding send claims immediately.
create function public.supervisor_staff_send_authorized(
 p_business_id uuid,p_owner_user_id uuid,p_proposal_id uuid
) returns boolean language sql stable security definer
set search_path=public,pg_temp as $$
select exists (
 select 1 from public.supervisor_proposals p
 join public.supervisor_approvals a on a.business_id=p.business_id and
      a.proposal_id=p.id and a.owner_user_id=p.owner_user_id and
      a.effect_hash=p.effect_hash
 join public.staff_schedule_handoff_snapshots s on s.business_id=p.business_id
     and s.proposal_id=p.id and
     s.week_start=(p.canonical_effect_payload->'payload'->>'week_start')::date
 where p.business_id=p_business_id and p.owner_user_id=p_owner_user_id
   and p.id=p_proposal_id and p.status='committed'
   and p.capability_id='olivia.staff_propose_send_schedule.v2'
   and p.capability_version=2
   and p.canonical_effect_payload->'payload'->>'publish_and_notify'='true'
   and (
     (a.authorization_kind='click' and a.mandate_id is null and a.mandate_revision is null)
     or (a.authorization_kind='mandate' and exists (
       select 1 from public.supervisor_mandates m
       where m.id=a.mandate_id and m.revision=a.mandate_revision
        and m.business_id=p.business_id and m.owner_user_id=p.owner_user_id
        and m.capability_id='olivia.staff_propose_send_schedule.v2'
        and m.capability_version=2 and m.staff_week_start=s.week_start
        and m.verified_at is not null and m.revoked_at is null
        and m.superseded_at is null and m.expires_at>now()
        and (select count(distinct x->>'employee_id')
          from jsonb_array_elements(s.shifts) x)<=m.limit_value
     ))
   )
);
$$;
revoke all on function public.supervisor_staff_send_authorized(uuid,uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.supervisor_staff_send_authorized(uuid,uuid,uuid)
 to service_role;

-- Same underlying staff RPC/attempt/approval ledger, not a second executor.
-- The verified mandate may approve only an existing, source-validated
-- publish-and-notify proposal for the specific week: never staff additions,
-- arbitrary shift edits, labor rules or a different week/recipient ceiling.
create function public.supervisor_gateway_commit_staff_mandate(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
 p_proposal_id uuid,p_revision integer
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals%rowtype; m public.supervisor_mandates%rowtype;
  payload jsonb; week date; used_count integer; attempt_id uuid;
  local_day date; outcome jsonb;
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'service_role_only' using errcode='42501'; end if;
 select (now() at time zone b.timezone)::date into local_day
  from public.businesses b join public.memberships own
    on own.business_id=b.id and own.user_id=p_owner_user_id and own.role='owner'
  where b.id=p_business_id and b.is_demo=false;
 if local_day is null then raise exception 'staff_owner_required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
 select * into p from public.supervisor_proposals
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and thread_id=p_thread_id and id=p_proposal_id and revision=p_revision
   and status='draft' and capability_id='olivia.staff_propose_send_schedule.v2'
   and capability_version=2 for update;
 if not found or p.canonical_effect_payload->>'operation'<>'propose_send_schedule'
   or p.canonical_effect_payload->'payload'->>'publish_and_notify' is distinct from 'true'
   then raise exception 'staff_mandate_proposal_not_eligible' using errcode='42501'; end if;
 payload:=p.canonical_effect_payload->'payload';
 week:=(payload->>'week_start')::date;
 select * into m from public.supervisor_mandates
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and capability_id='olivia.staff_propose_send_schedule.v2' and capability_version=2
   and staff_week_start=week and revoked_at is null and superseded_at is null
   and expires_at>now() and verified_at is not null
  order by revision desc limit 1 for update;
 if not found then raise exception 'staff_standing_mandate_required' using errcode='42501'; end if;
 -- The immutable source token and full roster are still verified in the existing
 -- supervisor_commit_staff_proposal transaction. Cap recipients BEFORE approval.
 select count(distinct x->>'employee_id') into used_count
   from jsonb_array_elements(public.staff_handoff_week_shifts(p_business_id,week)) x;
 if used_count<1 or used_count>m.limit_value then
   raise exception 'staff_mandate_recipient_limit' using errcode='42501'; end if;
 if exists(select 1 from public.supervisor_effect_attempts a
  join public.supervisor_mandates history on history.id=a.mandate_id
   and history.revision=a.mandate_revision
  where a.business_id=p_business_id and a.authorization_kind='mandate'
   and history.capability_id=m.capability_id and
       history.staff_week_start=week and a.state in ('reserved','executing','verified','uncertain'))
 then raise exception 'staff_week_mandate_already_used' using errcode='42501'; end if;
 insert into public.supervisor_approvals(
  business_id,proposal_id,owner_user_id,approved_revision,effect_hash,
  authorization_kind,mandate_id,mandate_revision
 ) values(p_business_id,p.id,p_owner_user_id,p.revision,p.effect_hash,
  'mandate',m.id,m.revision);
 update public.supervisor_proposals set status='approved',approved_at=now(),
  approved_by=p_owner_user_id,revision=revision+1,updated_at=now()
  where id=p.id returning * into p;
 attempt_id:=gen_random_uuid();
 insert into public.supervisor_effect_attempts(
  attempt_key,business_id,proposal_id,effect_hash,authorization_kind,
  mandate_id,mandate_revision,business_date,state
 ) values(attempt_id,p_business_id,p.id,p.effect_hash,'mandate',
  m.id,m.revision,local_day,'reserved');
 outcome:=public.supervisor_commit_staff_proposal(
  p_business_id,p_owner_user_id,p_thread_id,p_proposal_id,p.revision);
 update public.supervisor_effect_attempts set
  state=case when outcome->>'state'='applied' then 'verified' else 'stale' end,
  receipt_ref=case when outcome->>'state'='applied' then attempt_id::text else null end,
  verified_at=case when outcome->>'state'='applied' then now() else null end
  where attempt_key=attempt_id;
 return outcome || jsonb_build_object('attempt_key',attempt_id,
  'authorization_kind','mandate','mandate_id',m.id,'mandate_revision',m.revision);
end $$;
revoke all on function public.supervisor_gateway_commit_staff_mandate(
 uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.supervisor_gateway_commit_staff_mandate(
 uuid,uuid,uuid,uuid,integer) to service_role;


create or replace function public.staff_schedule_publish(
  p_business_id uuid,p_owner_user_id uuid,p_proposal_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals%rowtype;
  s public.staff_schedule_handoff_snapshots%rowtype;
  pub public.staff_schedule_publications%rowtype;
  expected_count integer; prepared_count integer; next_revision integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  if not exists (select 1 from public.memberships m join public.businesses b on b.id=m.business_id
    where m.business_id=p_business_id and m.user_id=p_owner_user_id
      and m.role='owner' and b.is_demo=false) then
    raise exception 'staff_owner_required' using errcode='42501'; end if;
  -- Owner identity for the existing provenance/audit triggers, bound only
  -- after independently verifying this service-side owner membership.
  perform set_config('request.jwt.claim.sub',p_owner_user_id::text,true);
  perform pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  lock table public.employees,public.scheduled_shifts in share row exclusive mode;
  select * into p from public.supervisor_proposals
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and id=p_proposal_id and capability_id='olivia.staff_propose_send_schedule.v2'
      and capability_version=2 and status='committed' for share;
  if not found or p.canonical_effect_payload->>'operation' is distinct from 'propose_send_schedule'
    or p.canonical_effect_payload->'payload'->>'publish_and_notify' is distinct from 'true'
    then raise exception 'committed_send_approval_required' using errcode='42501'; end if;
  if not public.supervisor_staff_send_authorized(p_business_id,p_owner_user_id,p.id) then
    raise exception 'explicit_click_approval_required' using errcode='42501'; end if;
  select * into s from public.staff_schedule_handoff_snapshots
    where business_id=p_business_id and proposal_id=p.id for share;
  if not found or s.week_start is distinct from (p.canonical_effect_payload->'payload'->>'week_start')::date
    or s.shifts is distinct from public.staff_handoff_week_shifts(p_business_id,s.week_start)
    or jsonb_array_length(s.shifts)=0 then
    raise exception 'schedule_source_changed' using errcode='P0001'; end if;
  select * into pub from public.staff_schedule_publications
    where business_id=p_business_id and proposal_id=p.id for update;
  if found then
    if pub.snapshot is distinct from s.shifts or pub.status<>'published' then
      raise exception 'publication_changed' using errcode='P0001'; end if;
    return jsonb_build_object('id',pub.id,'week',pub.week_start,
      'state','published','replayed',true);
  end if;
  if exists(select 1 from public.staff_schedule_publications
     where business_id=p_business_id and week_start=s.week_start and status='published') then
    raise exception 'already_published_different_approval' using errcode='P0001'; end if;
  select coalesce(max(publication_revision),0)+1 into next_revision
    from public.staff_schedule_publications
    where business_id=p_business_id and week_start=s.week_start;
  -- The same transaction that issues the publication receipt changes the
  -- canonical dated roster from draft to published legacy status. No attendance
  -- records or duplicate schedules are created. The immutable snapshot omits
  -- this display-only status so the source CAS remains valid.
  update public.scheduled_shifts set status='sent',updated_at=now()
    where business_id=p_business_id and deleted_at is null
      and local_date between s.week_start and s.week_start+6 and status='draft';
  insert into public.staff_schedule_publications
    (business_id,proposal_id,owner_user_id,week_start,snapshot,publication_revision)
    values (p_business_id,p.id,p_owner_user_id,s.week_start,s.shifts,next_revision) returning * into pub;
  update public.staff_schedule_deliveries set publication_id=pub.id,updated_at=now()
    where business_id=p_business_id and proposal_id=p.id and publication_id is null
      and status='prepared';
  select count(distinct x->>'employee_id') into expected_count
    from jsonb_array_elements(s.shifts) x;
  select count(*) into prepared_count from public.staff_schedule_deliveries
    where publication_id=pub.id and business_id=p_business_id;
  return jsonb_build_object('id',pub.id,'week',pub.week_start,'state','published',
    'replayed',false,'expectedRecipients',expected_count,'eligibleRecipients',prepared_count);
end $$;

create or replace function public.staff_schedule_claim_delivery(
  p_publication_id uuid,p_employee_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare pub public.staff_schedule_publications%rowtype;
  d public.staff_schedule_deliveries%rowtype;
  e public.employees%rowtype; token uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  select * into pub from public.staff_schedule_publications
    where id=p_publication_id and status='published';
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('olivia-'||pub.business_id::text,0));
  select * into pub from public.staff_schedule_publications
    where id=p_publication_id and status='published' for share;
  if not found then return null; end if;
  lock table public.employees,public.scheduled_shifts in share mode;
  if pub.snapshot is distinct from public.staff_handoff_week_shifts(pub.business_id,pub.week_start)
    or not exists(select 1 from public.supervisor_proposals p
       where p.business_id=pub.business_id and p.id=pub.proposal_id
         and p.owner_user_id=pub.owner_user_id and p.status='committed')
    or not public.supervisor_staff_send_authorized(pub.business_id,pub.owner_user_id,pub.proposal_id)
    or not exists(select 1 from public.memberships
       where business_id=pub.business_id and user_id=pub.owner_user_id and role='owner')
    then raise exception 'publication_authorization_or_roster_revoked' using errcode='42501'; end if;
  select * into d from public.staff_schedule_deliveries
    where publication_id=pub.id and business_id=pub.business_id
      and employee_id=p_employee_id for update;
  if not found or d.status<>'prepared' or d.retry_count>=5 or
     (d.retry_after is not null and d.retry_after>now()) then return null; end if;
  select * into e from public.employees
    where business_id=pub.business_id and id=p_employee_id and active for share;
  if not found or e.phone_e164 is distinct from d.recipient_e164
    or e.phone_e164 !~ '^\+[1-9][0-9]{1,14}$'
    or e.whatsapp_opt_in is distinct from true
    or e.preferred_schedule_channel is distinct from 'whatsapp'
    or d.channel is distinct from 'whatsapp'
    or e.preferred_language not in ('en') then
    update public.staff_schedule_deliveries set status='failed',error_code='recipient_revoked',
      updated_at=now() where id=d.id;
    return null;
  end if;
  token:=gen_random_uuid();
  update public.staff_schedule_deliveries
    set status='sending',attempt_token=token,attempted_at=now(),updated_at=now()
    where id=d.id;
  return jsonb_build_object('deliveryId',d.id,'attemptToken',token,
    'to',e.phone_e164,'employeeId',e.id,'week',pub.week_start);
end $$;

create or replace function public.staff_schedule_can_send(
 p_delivery_id uuid,p_attempt_token uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.staff_schedule_deliveries%rowtype;
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'service_role_only' using errcode='42501'; end if;
 select * into d from public.staff_schedule_deliveries
   where id=p_delivery_id and attempt_token=p_attempt_token and status='sending';
 if not found then return false; end if;
 return exists(select 1 from public.staff_schedule_publications pub
   join public.supervisor_proposals prop
     on prop.business_id=pub.business_id and prop.id=pub.proposal_id
   join public.memberships owner
     on owner.business_id=pub.business_id and owner.user_id=pub.owner_user_id
   join public.employees e
     on e.business_id=d.business_id and e.id=d.employee_id
   where pub.id=d.publication_id and pub.status='published'
    and prop.status='committed' and owner.role='owner'
    and prop.canonical_effect_payload->'payload'->>'publish_and_notify'='true'
    and pub.snapshot=public.staff_handoff_week_shifts(pub.business_id,pub.week_start)
    and public.supervisor_staff_send_authorized(pub.business_id,pub.owner_user_id,pub.proposal_id)
    and e.active and e.whatsapp_opt_in
    and e.preferred_schedule_channel='whatsapp' and d.channel='whatsapp'
    and (e.preferred_language is null or e.preferred_language='en')
    and e.phone_e164=d.recipient_e164);
end $$;
