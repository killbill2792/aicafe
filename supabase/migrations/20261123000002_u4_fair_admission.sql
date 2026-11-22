-- PR #557: fair multi-café U4 admission with global/per-café claim caps.
-- No parallel worker or scheduler. This migration is NOT applied to production.
set lock_timeout='3s';
set statement_timeout='30s';
create index if not exists supervisor_u4_active_objectives_idx
  on public.supervisor_routines(business_id,status,execution_mode)
  where status='active' and execution_mode in ('objective','watch');
create index if not exists supervisor_u4_occurrences_fairness_idx
  on public.supervisor_routine_occurrences(business_id,updated_at desc);
-- First eligible DST-correct civil minute. Normal days take one timezone
-- conversion; only transition dates scan the bounded eight-hour window.
create function public.u4_first_civil_due(
  p_date date,p_time time,p_timezone text
) returns timestamptz language plpgsql stable security invoker set search_path=''
as $civil_due$
declare nominal timestamptz;prior_offset interval;current_offset interval;
        candidate timestamptz;
begin
  -- Each timezone already comes from an authorized persisted café routine.
  -- AT TIME ZONE independently rejects an invalid zone; repeatedly scanning
  -- pg_timezone_names for every due row would turn a 500-café batch into
  -- thousands of expensive timezone-catalog enumerations.
  if p_date is null or p_time is null or p_timezone is null
  then raise exception 'u4_civil_due_invalid' using errcode='22023';end if;
  nominal:=(p_date+p_time) at time zone p_timezone;
  prior_offset:=((nominal-interval '4 hours') at time zone p_timezone)-
    ((nominal-interval '4 hours') at time zone 'UTC');
  current_offset:=(nominal at time zone p_timezone)-
    (nominal at time zone 'UTC');
  if prior_offset=current_offset and
    (nominal at time zone p_timezone)::date=p_date and
    (nominal at time zone p_timezone)::time=p_time then return nominal;end if;
  select min(c.instant) into candidate from generate_series(
    nominal-interval '4 hours',nominal+interval '4 hours',
    interval '1 minute') as c(instant)
    where (c.instant at time zone p_timezone)::date=p_date
      and (c.instant at time zone p_timezone)::time>=p_time;
  return candidate;
end
$civil_due$;
revoke all on function public.u4_first_civil_due(date,time,text)
  from public,anon,authenticated;
grant execute on function public.u4_first_civil_due(date,time,text)
  to service_role;

-- Same U4 executor and occurrence ledger; only SELECT due work.
-- Service-only, bounded, one eligible owner objective per café. Date selection
-- reuses the existing source-scoped and recovery-aware SQL RPC.
create function public.u4_due_objective_admission(
  p_now timestamptz,p_limit integer default 6,p_watch_enabled boolean default false
) returns jsonb language plpgsql stable security definer set search_path=''
as $u4_admission$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or p_now is null or p_limit not between 1 and 12
  then raise exception 'u4_admission_not_authorized' using errcode='42501'; end if;
  with authorized as materialized(
    select r.* from public.supervisor_routines r
      join public.businesses b on b.id=r.business_id
      where not b.is_demo and b.timezone=r.timezone
        and r.status='active'
        and (r.execution_mode='objective' or
          (p_watch_enabled and r.execution_mode='watch'))
        and exists(select 1 from public.memberships m where
          m.business_id=r.business_id and m.user_id=r.owner_user_id and m.role='owner')
        and exists(select 1 from public.ai_threads t where
          t.business_id=r.business_id and t.id=r.thread_id and
          t.owner_user_id=r.owner_user_id)
  ), eligible as (
    select r.business_id,r.id,r.created_at,to_jsonb(r) as routine,
      d.local_date,due.scheduled_for_utc
    from authorized r
    cross join lateral public.supervisor_due_routine_dates(
      r.business_id,r.id,r.revision,p_now) d
    cross join lateral (select coalesce(d.scheduled_for_utc,
      public.u4_first_civil_due(d.local_date,r.local_time,r.timezone))
      as scheduled_for_utc) due
    -- Prevent a pre-creation or future occurrence from outranking eligible work.
    where due.scheduled_for_utc is not null
      and due.scheduled_for_utc<=p_now
      and due.scheduled_for_utc>=r.updated_at
  ), candidates as (
    select e.*,row_number() over(partition by e.business_id
      order by e.scheduled_for_utc,e.created_at,e.id) as cafe_rank
      from eligible e
  ), last_served as(
    select business_id,max(updated_at) as served_at
      from public.supervisor_routine_occurrences
      where state in ('running','completed','failed')
      group by business_id
  ), chosen as (
    select c.*,s.served_at
      from candidates c left join last_served s on s.business_id=c.business_id
      where c.cafe_rank=1
      order by s.served_at asc nulls first,c.local_date,c.business_id
      limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'routine',c.routine,'localDate',c.local_date::text,
    'scheduledForUtc',c.scheduled_for_utc::text)
    order by c.served_at asc nulls first,c.local_date,c.business_id),
    '[]'::jsonb) into result from chosen c;
  return result;
end
$u4_admission$;
revoke all on function public.u4_due_objective_admission(timestamptz,integer,boolean)
  from public,anon,authenticated;
grant execute on function public.u4_due_objective_admission(timestamptz,integer,boolean)
  to service_role;

create or replace function public.supervisor_claim_current_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_revision bigint,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path=public as $claim$
declare r public.supervisor_routines;v_global integer;v_cafe integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  select * into r from public.supervisor_routines where business_id=p_business_id
    and id=p_routine_id and revision=p_revision and status='active' for update;
  if not found then return null; end if;
  if r.execution_mode in ('objective','watch') then
    -- One fast global claim semaphore. Transaction-scoped advisory locking
    -- prevents two independent minute ticks from racing the capacity check.
    perform pg_advisory_xact_lock(55720261122);
    select count(*)::integer into v_global
      from public.supervisor_routine_occurrences o
      join public.supervisor_routines s
        on s.business_id=o.business_id and s.id=o.routine_id
      where o.state='running' and o.lease_until>p_now
        and s.execution_mode in ('objective','watch');
    select count(*)::integer into v_cafe
      from public.supervisor_routine_occurrences o
      join public.supervisor_routines s
        on s.business_id=o.business_id and s.id=o.routine_id
      where o.business_id=p_business_id and o.state='running'
        and o.lease_until>p_now
        and s.execution_mode in ('objective','watch');
    if v_global>=12 or v_cafe>=1 then return null; end if;
  end if;
  return public.claim_supervisor_routine_occurrence(
    p_business_id,p_routine_id,p_local_date,p_scheduled_for_utc,p_now);
end $claim$;

-- Existing 15-minute derived admission is based on persisted timestamps
-- and source-wake versions, never on the wall-clock minute of a cron tick.
create or replace function public.supervisor_list_derived_refresh_businesses()
returns table(id uuid,timezone text,is_demo boolean)
language plpgsql stable security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'derived refresh unauthorized' using errcode='42501';end if;
  return query select b.id,b.timezone,b.is_demo from public.businesses b
    left join public.supervisor_derived_refresh_state s on s.business_id=b.id
    where not b.is_demo
      and (s.lease_until is null or s.lease_until<=statement_timestamp())
      and (s.business_id is null or s.last_started_at is null
        or s.last_started_at<=statement_timestamp()-interval '15 minutes'
        or s.requested_version>s.completed_version)
    order by s.last_started_at asc nulls first,b.id limit 100;
end $$;
revoke all on function public.supervisor_list_derived_refresh_businesses()
  from public,anon,authenticated;
grant execute on function public.supervisor_list_derived_refresh_businesses()
  to service_role;
-- Existing U4 occurrence retry has bounded exponential delay plus stable
-- 0..30-second per-run jitter to prevent a fleet-wide provider outage from
-- flooding the same recovery tick. Legacy priority schedules remain unchanged.
create or replace function public.finish_supervisor_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,
  p_success boolean,p_receipt_ref text,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_o public.supervisor_routine_occurrences;v_r public.supervisor_routines;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  -- Match the claim's lock order, so a concurrent claim/finish cannot
  -- deadlock by taking the same routine and occurrence in opposite order.
  select * into v_r from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id for update;
  if not found then return false; end if;
  select * into v_o from public.supervisor_routine_occurrences
    where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id
      for update;
  if not found or v_o.state<>'running' or v_o.lease_token is distinct from p_lease_token
    or v_o.lease_until<=p_now then return false; end if;
  if p_success and not public.supervisor_routine_owner_authorized(
    v_r.business_id,v_r.owner_user_id,v_r.thread_id) then return false; end if;
  if p_success and (v_r.status<>'active' or v_r.revision<>v_o.revision)
  then return false; end if;
  if p_success and (p_receipt_ref is null or length(p_receipt_ref) not between 1 and 160)
  then raise exception 'Routine receipt required' using errcode='22023'; end if;
  update public.supervisor_routine_occurrences set
    state=case when p_success then 'completed'
      when v_o.attempts>=5 then 'failed' else 'pending' end,
    lease_token=null,lease_until=null,
    next_retry_at=case when p_success or v_o.attempts>=5 then null
      else p_now+(interval '1 minute' * least(30,power(2,v_o.attempts)::integer))
        +case when v_r.execution_mode in ('objective','watch') then
          (interval '1 second' *
            (abs(hashtext(v_o.run_id::text||':'||v_o.attempts::text)::bigint) % 31))
          else interval '0 seconds' end end,
    receipt_ref=case when p_success then p_receipt_ref else null end,
    last_error=case when p_success then null else left(p_receipt_ref,160) end,
    updated_at=p_now where business_id=p_business_id and routine_id=p_routine_id
      and run_id=p_run_id;
  return true;
end $$;

revoke all on function public.finish_supervisor_routine_occurrence(
  uuid,uuid,uuid,uuid,boolean,text,timestamptz) from public,anon,authenticated;
grant execute on function public.finish_supervisor_routine_occurrence(
  uuid,uuid,uuid,uuid,boolean,text,timestamptz) to service_role;
