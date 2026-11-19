-- Task 15C: scheduling metadata on the existing durable records, not another queue.
set lock_timeout = '2s';
set statement_timeout = '10s';

alter table public.supervisor_investigations add column last_claimed_at timestamptz;
alter table public.supervisor_runs add column last_dispatched_at timestamptz,
  add column dispatch_after timestamptz;

create or replace function public.supervisor_claim_investigation(p_now timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_token uuid;v_open boolean;
  v_exists boolean;v_status_open boolean;v_scan integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null then raise exception 'Invalid instant' using errcode='22023'; end if;
  -- Serialize only the brief selection transaction, never the investigation.
  -- Concurrent ticks do not all choose a noisy café from the same snapshot.
  if not pg_try_advisory_xact_lock(hashtextextended('supervisor-investigation-dispatch-v1',0))
    then return null; end if;
  -- A stale or revoked row must not hide healthy work elsewhere in the queue.
  -- Bounded cleanup in the SAME transaction; no unbounded worker loop.
  for v_scan in 1..16 loop
  with last_served as (
    select business_id,max(last_claimed_at) as served
      from public.supervisor_investigations group by business_id
  )
  select i.* into v from public.supervisor_investigations i
    join last_served s on s.business_id=i.business_id
    where i.phase in ('collect','investigate','awaiting_owner')
      and i.next_retry_at<=p_now and (i.lease_until is null or i.lease_until<=p_now)
    -- First choose the least recently served café, then preserve that café's
    -- urgency and aging. New incidents do not reset the café's dispatch history.
    order by s.served asc nulls first,
      (i.priority+least(250,greatest(0,
      extract(epoch from (p_now-i.created_at))/3600))::integer) desc,
      i.next_retry_at asc,i.created_at asc,i.business_id asc,i.source_id asc,i.owner_user_id asc
    for update of i skip locked limit 1;
  if not found then return null; end if;
  if not public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    update public.supervisor_investigations set phase='blocked',last_error='authorization_revoked',
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    continue;
  end if;
  -- Missing evidence is NOT verified resolution. Neither is a still-open
  -- owner task reassigned to someone else. Treat these as blocked exceptions.
  if v.source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id) into v_exists;
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id
        and a.status in ('new','seen')) into v_open;
    v_status_open:=v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id) into v_exists;
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response','watching')) into v_status_open;
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=v.owner_user_id)) into v_open;
  end if;
  if not v_open then
    update public.supervisor_investigations set
      phase=case when v_exists and not v_status_open then 'resolved' else 'blocked' end,
      last_error=case when not v_exists then 'source_missing'
        when v_status_open then 'source_reassigned' else 'source_closed' end,
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    -- Deleted/reassigned/closed source data must not leave private,
    -- now-obsolete investigation reports in the owner's active inbox.
    update public.operating_tasks set status='handled',
      resolved_at=coalesce(resolved_at,p_now)
      where business_id=v.business_id and owner_user_id=v.owner_user_id
        and kind='priority_notice' and status in ('needs_owner','needs_response','watching')
        and payload->>'intent'='priority_investigation'
        and payload->>'sourceType'=v.source_type
        and payload->>'sourceId'=v.source_id;
    continue;
  end if;
  v_token:=gen_random_uuid();
  update public.supervisor_investigations set lease_token=v_token,
    lease_until=p_now+interval '3 minutes',last_claimed_at=clock_timestamp(),updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
  return jsonb_build_object('business_id',v.business_id,'owner_user_id',v.owner_user_id,
    'thread_id',v.thread_id,'source_type',v.source_type,'source_id',v.source_id,
    'revision_hash',v.revision_hash,'stable_key',v.stable_key,
    'episode_id',v.episode_id,
    'phase',v.phase,'evidence',v.evidence,'narrative',v.narrative,
    'last_error',v.last_error,'step_version',v.step_version,
    'lease_token',v_token);
  end loop;
  return null;
end $$;
revoke all on function public.supervisor_claim_investigation(timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_claim_investigation(timestamptz)
  to service_role;

-- Select and temporarily reserve a dispatch opportunity. This is not an
-- execution lease and never authorizes an effect: the existing scoped step
-- claim / receipt reconciliation must still succeed before any action.
-- The reservation expires if the process dies before reaching that claim.
create function public.supervisor_select_next_durable_run()
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v public.supervisor_runs; v_recovery boolean; v_now timestamptz:=clock_timestamp();
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('supervisor-run-dispatch-v1',0))
    then return null; end if;
  v_now:=clock_timestamp();
  with last_served as (
    select business_id,max(last_dispatched_at) served
      from public.supervisor_runs group by business_id
  )
  select r.* into v from public.supervisor_runs r
    join last_served s on s.business_id=r.business_id
    where (r.dispatch_after is null or r.dispatch_after<=v_now) and
      ((r.status in ('pending','running') and not exists (
        select 1 from public.supervisor_run_steps t
          where t.business_id=r.business_id and t.run_id=r.id
            and t.status='leased' and t.lease_until>v_now))
      or (r.status='blocked' and exists (
        select 1 from public.supervisor_run_steps t
          where t.business_id=r.business_id and t.run_id=r.id
            and t.status='blocked' and t.step_key='owner_turn' and t.error_code='lease_expired')))
    order by s.served asc nulls first,r.updated_at asc,r.id asc
    for update of r skip locked limit 1;
  if not found then return null; end if;
  v_recovery:=v.status='blocked';
  update public.supervisor_runs
    set last_dispatched_at=v_now,dispatch_after=v_now+interval '2 minutes'
    where id=v.id and business_id=v.business_id;
  return jsonb_build_object('run_id',v.id,'recovery',v_recovery);
end $$;
revoke all on function public.supervisor_select_next_durable_run() from public,anon,authenticated;
grant execute on function public.supervisor_select_next_durable_run() to service_role;

-- Candidate dates are derived from the current authorized routine revision and
-- existing occurrence primary keys. Older dates are not reported as if a
-- source check actually happened then; the worker reads current data at retry.
-- Limit the returned backlog so a long outage cannot monopolize a cron tick.
create function public.supervisor_due_routine_dates(
  p_business_id uuid,p_routine_id uuid,p_revision bigint,p_now timestamptz
) returns table(local_date date,scheduled_for_utc timestamptz)
language plpgsql security invoker set search_path=public as $$
declare v public.supervisor_routines;v_today date;v_start date;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null then raise exception 'Invalid instant' using errcode='22023'; end if;
  select * into v from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id and revision=p_revision
      and status='active';
  if not found then return; end if;
  if not public.supervisor_routine_owner_authorized(v.business_id,v.owner_user_id,v.thread_id)
    then raise exception 'Routine owner lost access' using errcode='42501'; end if;
  v_today:=(p_now at time zone v.timezone)::date;
  v_start:=(v.updated_at at time zone v.timezone)::date;
  return query
    select dates.candidate_date,dates.candidate_due from (
      -- Existing retry identity survives; use its original scheduled instant.
      select o.local_date as candidate_date,o.scheduled_for_utc as candidate_due
        from public.supervisor_routine_occurrences o
        where o.business_id=v.business_id and o.routine_id=v.id
          and o.revision=v.revision and o.scheduled_for_utc<=p_now
          and o.state in ('pending','running')
          and (o.lease_until is null or o.lease_until<=p_now)
          and (o.next_retry_at is null or o.next_retry_at<=p_now)
      union all
      -- Include all unmaterialized eligible days after the revision began,
      -- including holes from an earlier outage before a later successful tick.
      -- TS uses the existing DST-aware civil-time resolver for new dates.
      select d.civil_date::date,null::timestamptz
        from generate_series(v_start::timestamp,v_today::timestamp,interval '1 day') as d(civil_date)
        where (v.cadence='daily' or extract(isodow from d.civil_date)=any(v.weekdays))
          and not exists (
            select 1 from public.supervisor_routine_occurrences o
              where o.business_id=v.business_id and o.routine_id=v.id and o.local_date=d.civil_date::date)
    ) as dates order by dates.candidate_date asc limit 5;
end $$;
revoke all on function public.supervisor_due_routine_dates(uuid,uuid,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.supervisor_due_routine_dates(uuid,uuid,bigint,timestamptz) to service_role;

create or replace function public.claim_supervisor_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_r public.supervisor_routines;v_o public.supervisor_routine_occurrences;
        v_token uuid;v_day integer;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null or p_scheduled_for_utc is null or p_local_date is null
    or p_scheduled_for_utc>p_now then return null; end if;
  select * into v_r from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id for update;
  if not found or v_r.status<>'active' then return null; end if;
  if not public.supervisor_routine_owner_authorized(v_r.business_id,v_r.owner_user_id,v_r.thread_id)
    then raise exception 'Routine owner lost access' using errcode='42501'; end if;
  -- No missed pre-creation or pre-resume backlog, even on a late cron.
  if p_scheduled_for_utc<v_r.updated_at then return null; end if;
  if (p_scheduled_for_utc at time zone v_r.timezone)::date<>p_local_date then
    raise exception 'Routine timezone mismatch' using errcode='22023'; end if;
  v_day:=extract(isodow from p_local_date);
  if v_r.cadence='weekly' and not v_day=any(v_r.weekdays) then return null; end if;
  insert into public.supervisor_routine_occurrences
    (business_id,routine_id,local_date,revision,scheduled_for_utc)
  values(p_business_id,p_routine_id,p_local_date,v_r.revision,p_scheduled_for_utc)
  on conflict do nothing;
  select * into v_o from public.supervisor_routine_occurrences
    where business_id=p_business_id and routine_id=p_routine_id
      and local_date=p_local_date for update;
  -- A fifth worker death must reach a truthful terminal state instead of
  -- preserving an expired running occurrence indefinitely.
  if v_o.revision=v_r.revision and v_o.state='running'
    and v_o.attempts>=5 and v_o.lease_until<=p_now then
    update public.supervisor_routine_occurrences set
      state='failed',lease_token=null,lease_until=null,next_retry_at=null,
      last_error='lease_expired',updated_at=p_now
    where business_id=p_business_id and routine_id=p_routine_id and local_date=p_local_date;
    return null;
  end if;
  if v_o.revision<>v_r.revision or v_o.state in ('completed','failed')
    or v_o.attempts>=5 or (v_o.state='running' and v_o.lease_until>p_now)
    or (v_o.next_retry_at is not null and v_o.next_retry_at>p_now) then return null; end if;
  v_token:=gen_random_uuid();
  update public.supervisor_routine_occurrences set
    state='running',attempts=attempts+1,lease_token=v_token,
    lease_until=p_now+interval '4 minutes',next_retry_at=null,updated_at=p_now
    where business_id=p_business_id and routine_id=p_routine_id
      and local_date=p_local_date returning * into v_o;
  return jsonb_build_object('run_id',v_o.run_id,'lease_token',v_token,'revision',v_o.revision);
end $$;
revoke all on function public.claim_supervisor_routine_occurrence(uuid,uuid,date,timestamptz,timestamptz)
  from public,anon,authenticated;
grant execute on function public.claim_supervisor_routine_occurrence(uuid,uuid,date,timestamptz,timestamptz)
  to service_role;

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
      else p_now+(interval '1 minute' * least(30,power(2,v_o.attempts)::integer)) end,
    receipt_ref=case when p_success then p_receipt_ref else null end,
    last_error=case when p_success then null else left(p_receipt_ref,160) end,
    updated_at=p_now where business_id=p_business_id and routine_id=p_routine_id
      and run_id=p_run_id;
  return true;
end $$;
revoke all on function public.finish_supervisor_routine_occurrence(uuid,uuid,uuid,uuid,boolean,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.finish_supervisor_routine_occurrence(uuid,uuid,uuid,uuid,boolean,text,timestamptz)
  to service_role;

-- The current dispatcher pins the revision across date selection and claim;
-- retain the original RPC during rollout, but delegate to the single existing
-- claim transaction after taking the same routine row lock.
create function public.supervisor_claim_current_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_revision bigint,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  perform 1 from public.supervisor_routines where business_id=p_business_id
    and id=p_routine_id and revision=p_revision and status='active' for update;
  if not found then return null; end if;
  return public.claim_supervisor_routine_occurrence(
    p_business_id,p_routine_id,p_local_date,p_scheduled_for_utc,p_now);
end $$;
revoke all on function public.supervisor_claim_current_routine_occurrence(uuid,uuid,bigint,date,timestamptz,timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_claim_current_routine_occurrence(uuid,uuid,bigint,date,timestamptz,timestamptz)
  to service_role;

-- Stop and its reason are one transaction. Never let an old process block a
-- newer worker's live lease or leave a blocked run with a still-running step.
create function public.supervisor_stop_durable_run(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,
  p_error_code text,p_step_key text,p_claim_token uuid
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' or
    ((p_step_key is null)<>(p_claim_token is null)) then
    raise exception 'Invalid stop identity' using errcode='22023'; end if;
  select * into r from public.supervisor_runs where business_id=p_business_id
    and owner_user_id=p_owner_user_id and thread_id=p_thread_id and id=p_run_id for update;
  if not found or r.status not in ('pending','running') then return false; end if;
  select * into s from public.supervisor_run_steps
    where business_id=p_business_id and run_id=p_run_id and status<>'completed'
    order by step_index limit 1 for update;
  if not found then return false; end if;
  v_now:=clock_timestamp();
  if p_claim_token is not null then
    if s.step_key<>p_step_key or s.status<>'leased'
      or s.claim_token is distinct from p_claim_token or s.lease_until<=v_now
      then return false; end if;
  elsif s.status='leased' and s.lease_until>v_now then
    return false;
  end if;
  -- Preserve uncertain effects when an untokened worker finds an expired
  -- reconcile step. Only explicit revocation/cancellation is terminal.
  if p_claim_token is null and s.status='leased' and s.retry_mode='reconcile'
    and p_error_code not in ('authorization_revoked','cancelled') then
    return false;
  end if;
  update public.supervisor_run_steps set status='blocked',error_code=p_error_code,
    worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
  update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_stop_durable_run(uuid,uuid,uuid,uuid,text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.supervisor_stop_durable_run(uuid,uuid,uuid,uuid,text,text,uuid)
  to service_role;
