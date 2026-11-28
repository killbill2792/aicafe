-- Both engines rotate over the existing queue. A dispatch opportunity is
-- distinct from an execution lease and carries no authority to perform effects.
set lock_timeout = '3s';
set statement_timeout = '30s';

create function luna_internal.reserve_next(p_engine text)
returns public.supervisor_runs language plpgsql set search_path = '' as $$
declare
  candidate public.supervisor_runs;
  observed_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('supervisor-run-dispatch:' || p_engine, 0)) then
    return null;
  end if;
  observed_at := clock_timestamp();
  with last_served as (
    select business_id, max(last_dispatched_at) as served from public.supervisor_runs
    where engine = p_engine group by business_id
  )
  select r.* into candidate from public.supervisor_runs r
    join last_served s using (business_id)
    where r.engine = p_engine and (r.dispatch_after is null or r.dispatch_after <= observed_at)
      and ((r.status in ('pending', 'running') and not exists (
        select 1 from public.supervisor_run_steps t
        where t.business_id = r.business_id and t.run_id = r.id
          and t.status = 'leased' and t.lease_until > observed_at
      )) or (r.status = 'blocked' and exists (
        select 1 from public.supervisor_run_steps t
        where t.business_id = r.business_id and t.run_id = r.id
          and t.status = 'blocked' and t.step_key = 'owner_turn'
          and t.error_code in ('lease_expired', 'turn_failed')
      )))
    order by s.served asc nulls first, coalesce(r.last_dispatched_at, r.updated_at), r.updated_at, r.id
    for update of r skip locked limit 1;
  if not found then return null; end if;
  update public.supervisor_runs set last_dispatched_at = observed_at,
    dispatch_after = observed_at + interval '2 minutes' where id = candidate.id;
  return candidate;
end $$;

create or replace function public.supervisor_select_next_durable_run()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare candidate public.supervisor_runs;
begin
  candidate := luna_internal.reserve_next('legacy');
  if candidate.id is null then return null; end if;
  return jsonb_build_object('run_id', candidate.id, 'recovery', candidate.status = 'blocked');
end $$;

create function public.luna_claim_next_assignment(p_worker_id uuid, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  candidate public.supervisor_runs;
  step_claim jsonb;
begin
  if p_worker_id is null or p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then
    raise exception 'invalid_lease';
  end if;
  candidate := luna_internal.reserve_next('replacement');
  if candidate.id is null then return null; end if;
  if not public.supervisor_routine_owner_authorized(candidate.business_id, candidate.owner_user_id, candidate.thread_id) then
    perform public.supervisor_stop_durable_run(candidate.business_id, candidate.owner_user_id,
      candidate.thread_id, candidate.id, 'authorization_revoked', null, null);
    step_claim := jsonb_build_object('kind', 'blocked');
  elsif candidate.status = 'blocked' then
    -- The caller may inspect reconciliation evidence. Starting a provider or
    -- effect requires its own valid lease and reservation.
    step_claim := jsonb_build_object('kind', 'recovery');
  else
    step_claim := public.luna_assignment_claim(candidate.business_id, candidate.owner_user_id,
      candidate.thread_id, candidate.id, p_worker_id, p_lease_seconds);
    if step_claim->>'kind' = 'claimed' then
      -- An expired lease itself makes this run eligible after a crash.
      update public.supervisor_runs set dispatch_after = null where id = candidate.id;
    end if;
  end if;
  return jsonb_build_object('run_id', candidate.id, 'business_id', candidate.business_id,
    'owner_user_id', candidate.owner_user_id, 'thread_id', candidate.thread_id, 'claim', step_claim);
end $$;

revoke all on function public.luna_claim_next_assignment(uuid, integer) from public, anon, authenticated;
grant execute on function public.luna_claim_next_assignment(uuid, integer) to service_role;
