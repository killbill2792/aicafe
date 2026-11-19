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
