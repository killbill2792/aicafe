-- Task 13B: ONE approved Supervisor schedule publication and independently verifiable worker delivery.
-- This migration is additive. Roster remains scheduled_shifts; no second scheduling writer.
set lock_timeout = '3s';
set statement_timeout = '30s';

create table public.staff_schedule_publications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  proposal_id uuid not null,
  publication_revision bigint not null default 1 check (publication_revision>0),
  owner_user_id uuid not null references auth.users(id),
  week_start date not null check (extract(isodow from week_start)=1),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='array' and jsonb_array_length(snapshot)>0),
  status text not null default 'published' check (status in ('published','cancelled')),
  published_at timestamptz not null default now(),
  cancelled_at timestamptz,
  unique (business_id,proposal_id),
  unique (business_id,week_start,publication_revision),
  unique (id,business_id),
  foreign key (business_id,proposal_id)
    references public.supervisor_proposals(business_id,id) on delete cascade
);
create unique index staff_schedule_one_published_week
  on public.staff_schedule_publications(business_id,week_start)
  where status='published';
create index staff_schedule_publications_owner_week
  on public.staff_schedule_publications(business_id,owner_user_id,week_start desc);
-- Reason: This is a brand-new service-owned publication table; RLS must be enabled before owner-select policy and grants.
-- squawk-ignore ban-alter-row-level-security
alter table public.staff_schedule_publications enable row level security;
create policy "owner read schedule publications" on public.staff_schedule_publications
  for select to authenticated using (
    owner_user_id=(select auth.uid()) and public.scheduling_is_owner(business_id));
revoke all on public.staff_schedule_publications from public,anon,authenticated;
grant select on public.staff_schedule_publications to authenticated;
grant all on public.staff_schedule_publications to service_role;

-- Existing prepared per-proposal recipients are the only outbound queue; never copy
-- contact information into the publication record.
alter table public.staff_schedule_deliveries
  add column if not exists publication_id uuid,
  add column if not exists attempt_token uuid,
  add column if not exists attempted_at timestamptz,
  add column if not exists delivered_at timestamptz;
-- This is an additive composite FK; existing rows have null publication_id.
-- Reason: Existing prepared worker rows have null publication_id; this additive composite FK is validated on future real publication links only.
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
alter table public.staff_schedule_deliveries add constraint staff_delivery_publication_fk
  foreign key (publication_id,business_id)
  references public.staff_schedule_publications(id,business_id);
-- Reason: Expand the existing status-only constraint for provider-uncertain/read states, preserving all legacy states.
-- squawk-ignore ban-drop-constraint
alter table public.staff_schedule_deliveries
  drop constraint staff_schedule_deliveries_status_check;
alter table public.staff_schedule_deliveries add constraint staff_schedule_deliveries_status_check
  check (status in ('prepared','sending','sent','failed','uncertain','delivered','read','sent_by_owner')) not valid;
alter table public.staff_schedule_deliveries validate constraint staff_schedule_deliveries_status_check;
create unique index staff_schedule_delivery_provider_wamid
  on public.staff_schedule_deliveries(meta_message_id)
  where meta_message_id is not null;
create index staff_schedule_delivery_queued
  on public.staff_schedule_deliveries(publication_id,status)
  where publication_id is not null;

-- Only a committed, approved v2 SEND proposal publishes a roster.
-- The existing staff gateway produced the immutable snapshot under source locks.
-- Publication rechecks it under the very same advisory/table locks before writing.
create function public.staff_schedule_publish(
  p_business_id uuid,p_owner_user_id uuid,p_proposal_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $
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
  perform pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  lock table public.employees,public.scheduled_shifts in share row exclusive mode;
  select * into p from public.supervisor_proposals
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and id=p_proposal_id and capability_id='olivia.staff_propose_send_schedule.v2'
      and capability_version=2 and status='committed' for share;
  if not found or p.canonical_effect_payload->>'operation' is distinct from 'propose_send_schedule'
    or p.canonical_effect_payload->'payload'->>'publish_and_notify' is distinct from 'true'
    then raise exception 'committed_send_approval_required' using errcode='42501'; end if;
  if not exists(select 1 from public.supervisor_approvals a
    where a.business_id=p_business_id and a.proposal_id=p.id
      and a.owner_user_id=p_owner_user_id and a.effect_hash=p.effect_hash
      and a.authorization_kind='click') then
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
revoke all on function public.staff_schedule_publish(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.staff_schedule_publish(uuid,uuid,uuid) to service_role;

-- The worker cannot supply a recipient number or message. Each claim performs
-- a fresh phone/opt-in/roster/revocation-of-approval check in the DB transaction.
-- PREPARED is claimable exactly once; timed-out sending is NEVER auto-replayed.
create function public.staff_schedule_claim_delivery(
  p_publication_id uuid,p_employee_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $
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
    or not exists(select 1 from public.supervisor_approvals a
       where a.business_id=pub.business_id and a.proposal_id=pub.proposal_id
         and a.owner_user_id=pub.owner_user_id and a.authorization_kind='click')
    or not exists(select 1 from public.memberships
       where business_id=pub.business_id and user_id=pub.owner_user_id and role='owner')
    then raise exception 'publication_authorization_or_roster_revoked' using errcode='42501'; end if;
  select * into d from public.staff_schedule_deliveries
    where publication_id=pub.id and business_id=pub.business_id
      and employee_id=p_employee_id for update;
  if not found or d.status<>'prepared' then return null; end if;
  select * into e from public.employees
    where business_id=pub.business_id and id=p_employee_id and active for share;
  if not found or e.phone_e164 is distinct from d.recipient_e164
    or e.phone_e164 !~ '^\+[1-9][0-9]{1,14}$'
    or e.whatsapp_opt_in is distinct from true then
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
revoke all on function public.staff_schedule_claim_delivery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.staff_schedule_claim_delivery(uuid,uuid) to service_role;

create function public.staff_schedule_finish_delivery(
  p_delivery_id uuid,p_attempt_token uuid,p_state text,p_wamid text default null,
  p_error text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $
declare d public.staff_schedule_deliveries%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  if p_state not in ('sent','failed','uncertain')
    or (p_state='sent') is distinct from (p_wamid is not null)
    or (p_wamid is not null and p_wamid !~ '^wamid\.[A-Za-z0-9_.:-]{1,240}={0,2}$')
    or length(coalesce(p_error,''))>120 then
    raise exception 'invalid_delivery_result' using errcode='22023'; end if;
  select * into d from public.staff_schedule_deliveries
    where id=p_delivery_id and attempt_token=p_attempt_token and status='sending'
      and publication_id is not null for update;
  if not found then return false; end if;
  update public.staff_schedule_deliveries
    set status=p_state,meta_message_id=p_wamid,error_code=p_error,
      sent_at=case when p_state='sent' then now() else null end,updated_at=now()
    where id=d.id;
  return true;
end $$;
revoke all on function public.staff_schedule_finish_delivery(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.staff_schedule_finish_delivery(uuid,uuid,text,text,text) to service_role;

-- Called only AFTER the existing webhook's HMAC verification. Duplicated and
-- out-of-order Meta events cannot demote a delivered/read receipt.
create function public.staff_schedule_record_provider_status(p_wamid text,p_status text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $
declare d public.staff_schedule_deliveries%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  if p_status not in ('sent','delivered','read','failed') then return false; end if;
  select * into d from public.staff_schedule_deliveries
    where meta_message_id=p_wamid and publication_id is not null for update;
  if not found then return false; end if;
  if d.status in ('read','delivered') and p_status in ('sent','failed')
    or d.status='read' and p_status='delivered' then return true; end if;
  if d.status in ('sent','delivered','read') then
    update public.staff_schedule_deliveries
      set status=p_status,delivered_at=case when p_status in ('delivered','read')
        then coalesce(delivered_at,now()) else delivered_at end,
      updated_at=now() where id=d.id;
  end if;
  return true;
end $$;
revoke all on function public.staff_schedule_record_provider_status(text,text) from public,anon,authenticated;
grant execute on function public.staff_schedule_record_provider_status(text,text) to service_role;

-- An explicit owner cancellation is one more service-only effect. It prevents
-- all new send claims; messages already accepted by Meta cannot be unsent.
-- A later corrected roster needs a NEW owner approval and publication revision.
create function public.staff_schedule_cancel_publication(
  p_business_id uuid,p_owner_user_id uuid,p_publication_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $
declare pub public.staff_schedule_publications%rowtype;
  in_flight integer;accepted integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  if not exists(select 1 from public.memberships m join public.businesses b
     on b.id=m.business_id where m.business_id=p_business_id
      and m.user_id=p_owner_user_id and m.role='owner' and b.is_demo=false) then
    raise exception 'staff_owner_required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  select * into pub from public.staff_schedule_publications
    where id=p_publication_id and business_id=p_business_id
      and owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'publication_not_owned' using errcode='42501'; end if;
  select count(*) filter(where status in ('sending','uncertain')),
     count(*) filter(where status in ('sent','delivered','read','sent_by_owner'))
    into in_flight,accepted from public.staff_schedule_deliveries
    where publication_id=pub.id and business_id=pub.business_id;
  if pub.status='published' then
    update public.staff_schedule_publications
      set status='cancelled',cancelled_at=now() where id=pub.id;
    update public.staff_schedule_deliveries
      set status='failed',error_code='publication_cancelled',updated_at=now()
      where business_id=pub.business_id and publication_id=pub.id
        and status='prepared';
    if in_flight=0 and accepted=0 and
      pub.snapshot=public.staff_handoff_week_shifts(pub.business_id,pub.week_start) then
      update public.scheduled_shifts set status='draft',updated_at=now()
        where business_id=pub.business_id and status='sent' and deleted_at is null
          and local_date between pub.week_start and pub.week_start+6;
    end if;
  end if;
  return jsonb_build_object('state','cancelled','publicationId',pub.id,
    'revision',pub.publication_revision,'inFlight',in_flight,'alreadyAccepted',accepted);
end $$;
revoke all on function public.staff_schedule_cancel_publication(uuid,uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.staff_schedule_cancel_publication(uuid,uuid,uuid)
 to service_role;

-- In-flight attempts require a LAST-MOMENT authorization check just before
-- the network call. This cannot retract packets already sent to Meta, but
-- cancellation/opt-out between claim and request must prevent a new request.
create function public.staff_schedule_can_send(
 p_delivery_id uuid,p_attempt_token uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $
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
    and e.active and e.whatsapp_opt_in
    and e.phone_e164=d.recipient_e164);
end $$;
revoke all on function public.staff_schedule_can_send(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.staff_schedule_can_send(uuid,uuid) to service_role;
