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

-- Bound safe step reclaims and prevent renewals after a terminal stop.
create or replace function public.supervisor_run_claim(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_worker_id uuid, p_lease_seconds integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps; v_now timestamptz;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_worker_id is null or p_lease_seconds is null or p_lease_seconds not between 1 and 3600
    then raise exception 'invalid_lease'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if r.status = 'completed' then
    return jsonb_build_object('kind', 'completed'); end if;
  if r.status = 'blocked' then
    return jsonb_build_object('kind', 'blocked'); end if;
  select * into s from public.supervisor_run_steps
    where business_id = p_business_id and run_id = p_run_id and status <> 'completed'
    order by step_index limit 1 for update;
  if not found then return jsonb_build_object('kind', 'ready_for_report'); end if;
  v_now:=clock_timestamp();
  if s.status = 'blocked' then return jsonb_build_object('kind', 'blocked'); end if;
  if s.status = 'leased' and s.lease_until > v_now then
    return jsonb_build_object('kind', 'busy'); end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile' then
    update public.supervisor_run_steps set status = 'blocked', error_code = 'lease_expired',
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if s.retry_mode='idempotent' and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, updated_at = v_now
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;

create or replace function public.supervisor_run_renew(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare updated_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600
    then raise exception 'invalid_lease'; end if;
  update public.supervisor_run_steps set
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
  where business_id = p_business_id and run_id = p_run_id and step_key = p_step_key
    and claim_token = p_claim_token and status = 'leased' and lease_until > clock_timestamp()
    and exists (select 1 from public.supervisor_runs r where r.business_id = p_business_id
      and r.id = p_run_id and r.owner_user_id = p_owner_user_id
      and r.thread_id = p_thread_id and r.status='running');
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end $$;

-- Retain existing data-health checks and append Supervisor recovery evidence.
create or replace function public.run_data_health_check(p_plan_bytes bigint,p_days integer default 30)
returns public.data_health_checks
language plpgsql security definer set search_path=public as $health$
declare
 v_today date:=(now() at time zone 'utc')::date;
 v_bytes bigint:=pg_database_size(current_database());
 v_prev bigint; v_tables jsonb; v_findings jsonb:='[]'::jsonb; v_row public.data_health_checks;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if p_plan_bytes is null or p_plan_bytes<=0 or p_days not between 1 and 366
 then raise exception 'invalid health check settings'; end if;

 select coalesce(jsonb_agg(jsonb_build_object('table',t.relname,'bytes',t.bytes) order by t.bytes desc),'[]')
 into v_tables
 from (select c.relname,pg_total_relation_size(c.oid) bytes from pg_class c
  join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  where c.relkind='r' order by 2 desc limit 8) t;

 if v_bytes>p_plan_bytes*0.7 then
  v_findings:=v_findings||jsonb_build_object('kind','database_near_limit',
   'database_bytes',v_bytes,'plan_bytes',p_plan_bytes);
 end if;

 select h.database_bytes into v_prev from public.data_health_checks h
 where h.checked_on<v_today order by h.checked_on desc limit 1;
 if v_prev is not null and v_bytes-v_prev>greatest(50*1024*1024,v_prev*0.2) then
  v_findings:=v_findings||jsonb_build_object('kind','sudden_growth',
   'database_bytes',v_bytes,'previous_bytes',v_prev);
 end if;

 v_findings:=v_findings||coalesce((
  select jsonb_agg(jsonb_build_object('kind','repeated_pos_records','business_id',x.business_id,
    'entity',x.entity,'objects',x.objects,'extra_rows',x.extra_rows) order by x.business_id,x.entity)
  from (select g.business_id,g.entity,count(*) objects,sum(g.n-1) extra_rows
   from (select r.business_id,r.entity,count(*) n from public.toast_raw_records r
    where r.entity_guid is not null and coalesce(r.capture_key,'') not like 'stage:%:key:%'
    group by r.business_id,r.restaurant_guid,r.entity,r.entity_guid,r.business_date
    having count(*)>1) g
   group by g.business_id,g.entity) x),'[]'::jsonb);

 v_findings:=v_findings||coalesce((
  select jsonb_agg(jsonb_build_object('kind','total_mismatch','business_id',m.business_id,
    'business_date',m.business_date,'import_net_cents',m.import_net,'stored_net_cents',m.stored_net,
    'toast_net_cents',m.toast_net) order by m.business_id,m.business_date)
  from (select d.business_id,d.business_date,sum(d.net_sales_cents) import_net,
    case when count(d.toast_net_sales_cents)=count(*) then sum(d.toast_net_sales_cents) end toast_net,
    (select coalesce(sum(o.net_sales_cents),0) from public.orders o
     where o.business_id=d.business_id and o.business_date=d.business_date and not o.toast_excluded
      and o.pos_order_id like 'toast:%') stored_net
   from public.toast_day_status d join public.businesses b on b.id=d.business_id and not b.is_demo
   where d.import_state='imported' and d.business_date>=v_today-p_days
   group by d.business_id,d.business_date
  ) m
  where m.stored_net is distinct from m.import_net
   or (m.toast_net is not null and m.toast_net is distinct from m.import_net)),'[]'::jsonb);

 -- Use the existing daily operational health record. Counts only, no owner,
 -- source, prompt, effect or connector payloads. Only unresolved/live revisions
 -- are examined; a recovered work item disappears on the next check.
 v_findings:=v_findings||coalesce((
  select jsonb_agg(jsonb_build_object('kind','supervisor_work_recovery',
    'business_id',x.business_id,'expired_leases',x.expired_leases,
    'blocked_runs',x.blocked_runs,'retrying_investigations',x.retrying_investigations,
    'failed_routines',x.failed_routines,'stalled_runs',x.stalled_runs) order by x.business_id)
  from (
    select work.business_id,count(*) filter(where work.problem='expired_lease') expired_leases,
      count(*) filter(where work.problem='blocked_run') blocked_runs,
      count(*) filter(where work.problem='investigation_retry') retrying_investigations,
      count(*) filter(where work.problem='routine_failed') failed_routines,
      count(*) filter(where work.problem='stalled_run') stalled_runs
    from (
      select s.business_id,'expired_lease' problem from public.supervisor_run_steps s
        join public.supervisor_runs r on r.id=s.run_id and r.business_id=s.business_id
        where r.status='running' and s.status='leased' and s.lease_until<=now()
      union all select r.business_id,'blocked_run' from public.supervisor_runs r
        where r.status='blocked' and exists(select 1 from public.supervisor_run_steps s
          where s.business_id=r.business_id and s.run_id=r.id and s.status='blocked'
            and coalesce(s.error_code,'unknown') not in ('authorization_revoked','cancelled'))
      union all select r.business_id,'stalled_run' from public.supervisor_runs r
        where r.status in ('pending','running') and r.updated_at<now()-interval '30 minutes'
          and not exists(select 1 from public.supervisor_run_steps s where s.business_id=r.business_id
            and s.run_id=r.id and s.status='leased' and s.lease_until>now())
      union all select i.business_id,'expired_lease' from public.supervisor_investigations i
        where i.phase in ('collect','investigate','awaiting_owner') and i.lease_until<=now()
      union all select i.business_id,'investigation_retry' from public.supervisor_investigations i
        where i.phase in ('collect','investigate','awaiting_owner') and i.failure_count>0
          and i.last_error not in ('authorization_revoked','owner_quota_reached')
      union all select o.business_id,case when o.state='failed' then 'routine_failed' else 'expired_lease' end
        from public.supervisor_routine_occurrences o join public.supervisor_routines r
          on r.business_id=o.business_id and r.id=o.routine_id and r.revision=o.revision
        where r.status='active' and (o.state='failed' or (o.state='running' and o.lease_until<=now()))
    ) work join public.businesses b on b.id=work.business_id and not b.is_demo
    group by work.business_id
  ) x),'[]'::jsonb);

 insert into public.data_health_checks(checked_on,checked_at,database_bytes,plan_bytes,largest_tables,findings)
 values(v_today,now(),v_bytes,p_plan_bytes,v_tables,v_findings)
 on conflict(checked_on) do update set checked_at=excluded.checked_at,
  database_bytes=excluded.database_bytes,plan_bytes=excluded.plan_bytes,
  largest_tables=excluded.largest_tables,findings=excluded.findings
 returning * into v_row;
 return v_row;
end $health$;
revoke all on function public.run_data_health_check(bigint,integer) from public,anon,authenticated;
grant execute on function public.run_data_health_check(bigint,integer) to service_role;

-- Durable owner work reserves in the existing system-attempt ledger, BEFORE
-- transport. Ordinary owner-turn summary telemetry is retained; its already
-- reserved calls are excluded only from the joint UTC quota calculation.
alter table public.supervisor_system_usage_events
  drop constraint supervisor_system_usage_events_source_type_check,
  add constraint supervisor_system_usage_events_source_type_check
    check (source_type in ('alert','operating_task','durable_run')),
  add column owner_message_id uuid references public.ai_messages(id) on delete cascade,
  add column reserved_cost_micros bigint check (reserved_cost_micros>=0),
  add column accounted_at timestamptz,
  add constraint supervisor_system_durable_attempt_scope
    check ((source_type='durable_run')=(owner_message_id is not null)
      and (source_type<>'durable_run' or reserved_cost_micros is not null));
alter table public.ai_usage_events add column reserved_model_call_count bigint not null default 0
  check (reserved_model_call_count between 0 and model_call_count);
create index supervisor_system_usage_run_idx on public.supervisor_system_usage_events
  (business_id,owner_user_id,source_id) where source_type='durable_run';

create function public.supervisor_reserve_durable_model_call(
  p_attempt_id uuid,p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_run_id uuid,p_owner_message_id uuid,p_job_id uuid,p_claim_token uuid,
  p_model text,p_input_upper integer,p_output_cap integer,p_cost_upper bigint,
  p_max_calls integer,p_max_input_upper bigint,p_max_output_cap bigint,
  p_max_cost bigint,p_owner_daily_cap integer
) returns void language plpgsql security definer set search_path=public as $$
declare r public.supervisor_runs;v_day date;v_prior bigint;v_system bigint;
  v_calls bigint;v_input bigint;v_output bigint;v_cost bigint;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_attempt_id is null
    or p_claim_token is null or length(coalesce(p_model,'')) not between 1 and 80
    or p_input_upper is null or p_input_upper not between 1 and 272000
    or p_output_cap is null or p_output_cap not between 1 and 1200
    or p_cost_upper is null or p_cost_upper<1
    or p_max_calls is null or p_max_calls not between 1 and 1000
    or p_max_input_upper is null or p_max_input_upper<1
    or p_max_output_cap is null or p_max_output_cap<1
    or p_max_cost is null or p_max_cost<1
    or p_owner_daily_cap is null or p_owner_daily_cap not between 1 and 1000000
    then raise exception 'durable_reservation_invalid' using errcode='42501'; end if;
  -- Same run-then-step lock order as claim/finish/stop. A replaced worker
  -- cannot buy another provider call, even with a previously valid token.
  select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
    and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
  if not found or r.status<>'running' then
    raise exception 'durable_reservation_not_authorized' using errcode='42501'; end if;
  perform 1 from public.supervisor_run_steps s where s.business_id=p_business_id
    and s.run_id=p_run_id and s.step_key='owner_turn' and s.status='leased'
    and s.claim_token=p_claim_token and s.lease_until>clock_timestamp() for update;
  if not found or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id=p_owner_message_id
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id
      and m.thread_id=p_thread_id and m.role='owner')
    or not exists(select 1 from public.ai_agent_jobs j where j.id=p_job_id
      and j.business_id=p_business_id and j.owner_user_id=p_owner_user_id
      and j.thread_id=p_thread_id and j.owner_message_id=p_owner_message_id
      and j.status='running' and j.heartbeat_at>clock_timestamp()-interval '180 seconds')
    then raise exception 'durable_reservation_not_authorized' using errcode='42501'; end if;
  v_day:=(clock_timestamp() at time zone 'UTC')::date;
  -- Share the existing investigation owner/day lock, not a new job pipeline.
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text||':'||p_owner_user_id::text||':'||v_day::text,0));
  select coalesce(sum(e.model_call_count-e.reserved_model_call_count),0) into v_prior
    from public.ai_usage_events e where e.business_id=p_business_id
      and e.owner_user_id=p_owner_user_id and e.attempt_day=v_day;
  select count(*) into v_system from public.supervisor_system_usage_events e
    where e.business_id=p_business_id and e.owner_user_id=p_owner_user_id and e.attempt_day=v_day;
  if v_prior+v_system>=p_owner_daily_cap then
    raise exception 'owner_usage_limit_reached' using errcode='P0001'; end if;
  select count(*),coalesce(sum(e.reserved_input_upper),0),
    coalesce(sum(e.reserved_output_cap),0),coalesce(sum(e.reserved_cost_micros),0)
    into v_calls,v_input,v_output,v_cost from public.supervisor_system_usage_events e
    where e.business_id=p_business_id and e.owner_user_id=p_owner_user_id
      and e.source_type='durable_run' and e.source_id=p_run_id::text;
  -- A completed or abandoned attempt consumes the reservation for the whole
  -- durable run, even after restart or a UTC rollover. Never refund uncertainty.
  if v_calls+1>p_max_calls or v_input+p_input_upper>p_max_input_upper
    or v_output+p_output_cap>p_max_output_cap or v_cost+p_cost_upper>p_max_cost then
    raise exception 'durable_provider_budget_exhausted' using errcode='P0001'; end if;
  if not exists(select 1 from public.supervisor_run_steps s where s.business_id=p_business_id
    and s.run_id=p_run_id and s.step_key='owner_turn' and s.claim_token=p_claim_token
    and s.status='leased' and s.lease_until>clock_timestamp())
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then raise exception 'durable_reservation_not_authorized' using errcode='42501'; end if;
  insert into public.supervisor_system_usage_events(
    attempt_id,business_id,owner_user_id,thread_id,source_type,source_id,owner_message_id,
    model,attempt_day,reserved_input_upper,reserved_output_cap,reserved_cost_micros)
  values(p_attempt_id,p_business_id,p_owner_user_id,p_thread_id,'durable_run',p_run_id::text,
    p_owner_message_id,p_model,v_day,p_input_upper,p_output_cap,p_cost_upper);
end $$;
revoke all on function public.supervisor_reserve_durable_model_call(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,bigint,integer,bigint,bigint,bigint,integer)
  from public,anon,authenticated;
grant execute on function public.supervisor_reserve_durable_model_call(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,integer,integer,bigint,integer,bigint,bigint,bigint,integer)
  to service_role;

-- Keep the existing per-owner-message telemetry and dedupe only its quota
-- contribution. The exact attempt IDs, not a model assertion or a count
-- supplied by a browser, prove which calls were already reserved.
create function public.supervisor_record_durable_usage_increment(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_run_id uuid,p_attempt_ids uuid[],p_model text,p_input_tokens integer,p_output_tokens integer,
  p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint
) returns void language plpgsql security definer set search_path=public as $$
declare v_count integer;v_day date;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_attempt_ids is null
    or cardinality(p_attempt_ids) not between 1 and 8
    or p_model_call_count is distinct from cardinality(p_attempt_ids)
    then raise exception 'durable_usage_invalid' using errcode='42501'; end if;
  v_day:=(statement_timestamp() at time zone 'UTC')::date;
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text||':'||p_owner_user_id::text||':'||v_day::text,0));
  perform 1 from public.supervisor_system_usage_events e
    where e.attempt_id=any(p_attempt_ids) and e.business_id=p_business_id
      and e.owner_user_id=p_owner_user_id and e.thread_id=p_thread_id
      and e.owner_message_id=p_owner_message_id and e.source_type='durable_run'
      and e.source_id=p_run_id::text and e.accounted_at is null
    order by e.attempt_id for update;
  get diagnostics v_count=row_count;
  if v_count<>cardinality(p_attempt_ids)
    then raise exception 'durable_usage_scope_or_replay' using errcode='42501'; end if;
  perform public.record_supervisor_usage_increment(p_business_id,p_owner_user_id,p_thread_id,
    p_owner_message_id,p_model,p_input_tokens,p_output_tokens,p_model_call_count,
    p_tool_call_count,p_estimated_cost_micros);
  update public.ai_usage_events set reserved_model_call_count=reserved_model_call_count+v_count
    where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
      and owner_message_id=p_owner_message_id and attempt_day=v_day;
  if not found then raise exception 'durable_usage_summary_missing'; end if;
  update public.supervisor_system_usage_events set accounted_at=clock_timestamp()
    where attempt_id=any(p_attempt_ids);
end $$;
revoke all on function public.supervisor_record_durable_usage_increment(
  uuid,uuid,uuid,uuid,uuid,uuid[],text,integer,integer,integer,integer,bigint)
  from public,anon,authenticated;
grant execute on function public.supervisor_record_durable_usage_increment(
  uuid,uuid,uuid,uuid,uuid,uuid[],text,integer,integer,integer,integer,bigint)
  to service_role;

-- Existing investigation reservations share the same deduplicated owner quota.
create or replace function public.supervisor_reserve_investigation_model_call(
  p_attempt_id uuid,p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_lease_token uuid,p_model text,
  p_input_upper integer,p_output_cap integer,p_owner_daily_cap integer
) returns void language plpgsql security definer set search_path=public as $$
declare v_day date;v_prior bigint;v_system bigint;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or p_attempt_id is null or p_business_id is null or p_owner_user_id is null
    or p_thread_id is null or p_lease_token is null
    or p_source_type not in ('alert','operating_task')
    or length(coalesce(p_source_id,'')) not between 1 and 160
    or length(coalesce(p_model,'')) not between 1 and 80
    or p_input_upper not between 1 and 2000000
    or p_output_cap not between 1 and 1200
    or p_owner_daily_cap not between 1 and 1000000
    or not public.supervisor_routine_owner_authorized(
      p_business_id,p_owner_user_id,p_thread_id)
    or not exists (
      select 1 from public.supervisor_investigations i
       where i.business_id=p_business_id and i.owner_user_id=p_owner_user_id
         and i.thread_id=p_thread_id and i.source_type=p_source_type
         and i.source_id=p_source_id and i.lease_token=p_lease_token
         and i.lease_until>statement_timestamp()
         and i.phase in ('investigate','awaiting_owner')
    )
  then raise exception 'system_model_attempt_not_authorized' using errcode='42501';
  end if;
  v_day:=(statement_timestamp() at time zone 'UTC')::date;
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text||':'||p_owner_user_id::text||':'||v_day::text,0));
  select coalesce(sum(e.model_call_count-e.reserved_model_call_count),0) into v_prior
    from public.ai_usage_events e where e.business_id=p_business_id
      and e.owner_user_id=p_owner_user_id and e.attempt_day=v_day;
  select count(*) into v_system
    from public.supervisor_system_usage_events e
    where e.business_id=p_business_id and e.owner_user_id=p_owner_user_id
      and e.attempt_day=v_day;
  if v_prior+v_system>=p_owner_daily_cap
    then raise exception 'owner_usage_limit_reached' using errcode='P0001';
  end if;
  insert into public.supervisor_system_usage_events(
    attempt_id,business_id,owner_user_id,thread_id,source_type,source_id,
    model,attempt_day,reserved_input_upper,reserved_output_cap,status)
  values(p_attempt_id,p_business_id,p_owner_user_id,p_thread_id,
    p_source_type,p_source_id,p_model,v_day,p_input_upper,p_output_cap,'attempted');
end $$;
revoke all on function public.supervisor_reserve_investigation_model_call(
  uuid,uuid,uuid,uuid,text,text,uuid,text,integer,integer,integer)
  from public,anon,authenticated;
grant execute on function public.supervisor_reserve_investigation_model_call(
  uuid,uuid,uuid,uuid,text,text,uuid,text,integer,integer,integer)
  to service_role;
