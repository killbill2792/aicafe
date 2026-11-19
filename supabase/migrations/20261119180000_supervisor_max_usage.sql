set lock_timeout = '1s';
set statement_timeout = '5s';
-- Max has no commercial ceiling. v2 continuations get an independent technical claim slice.
alter table public.supervisor_system_usage_events add column if not exists durable_claim_token uuid;
alter table public.supervisor_system_usage_events add constraint supervisor_durable_claim_scope check (durable_claim_token is null or source_type='durable_run') not valid;
-- Max has no commercial ceiling. Existing service-only RPC signatures,
-- leases, attempt identities, unit ceilings and grants remain unchanged.
alter table public.supervisor_system_usage_events add constraint supervisor_system_durable_attempt_scope_v2
  check ((source_type='durable_run')=(owner_message_id is not null)
    and (reserved_cost_micros is null or reserved_cost_micros>=0)) not valid;
-- Reason: the replacement above enforces the existing scope and nonnegative cost checks; only the obsolete requirement to invent a cost when pricing is unknown is relaxed.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_system_usage_events drop constraint supervisor_system_durable_attempt_scope;

create or replace function public.supervisor_reserve_durable_model_call(
  p_attempt_id uuid,p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_run_id uuid,p_owner_message_id uuid,p_job_id uuid,p_claim_token uuid,
  p_model text,p_input_upper integer,p_output_cap integer,p_cost_upper bigint,
  p_max_calls integer,p_max_input_upper bigint,p_max_output_cap bigint,
  p_max_cost bigint,p_owner_daily_cap integer
) returns void language plpgsql security definer set search_path=public as $$
declare r public.supervisor_runs;v_day date;v_prior bigint;v_system bigint;
  v_calls bigint;v_input bigint;v_output bigint;v_cost bigint;v_slice boolean;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_attempt_id is null
    or p_claim_token is null or length(coalesce(p_model,'')) not between 1 and 80
    or p_input_upper is null or p_input_upper not between 1 and 272000
    or p_output_cap is null or p_output_cap not between 1 and 1200
    or (p_cost_upper is not null and p_cost_upper<0)
    or (p_max_cost is not null and (p_cost_upper is null or p_cost_upper<1))
    or p_max_calls is null or p_max_calls not between 1 and 1000
    or p_max_input_upper is null or p_max_input_upper<1
    or p_max_output_cap is null or p_max_output_cap<1
    or (p_max_cost is not null and p_max_cost<1)
    or (p_owner_daily_cap is not null and p_owner_daily_cap not between 1 and 1000000)
    then raise exception 'durable_reservation_invalid' using errcode='42501'; end if;
  -- Same run-then-step lock order as claim/finish/stop. A replaced worker
  -- cannot buy another provider call, even with a previously valid token.
  select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
    and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
  if not found or r.status<>'running' then
    raise exception 'durable_reservation_not_authorized' using errcode='42501'; end if;
  v_slice:=coalesce(to_jsonb(r)->>'execution_version'='2',false);
  if v_slice and r.request_key is distinct from p_owner_message_id then
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
      and j.status='running' and j.heartbeat_at>clock_timestamp()-interval '180 seconds'
      and (not v_slice or (to_jsonb(j)->>'durable_run_id'=p_run_id::text and to_jsonb(j)->>'durable_claim_token'=p_claim_token::text
        and not (r.input_attachment_version_hash is distinct from public.supervisor_owner_attachment_fingerprint_v2(r.business_id,r.owner_user_id,r.thread_id,r.input_attachment_ids)))))
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
  if p_owner_daily_cap is not null and v_prior+v_system>=p_owner_daily_cap then
    raise exception 'owner_usage_limit_reached' using errcode='P0001'; end if;
  -- The JSON lookup preserves compatibility until #536's version column exists.
  v_slice:=coalesce(to_jsonb(r)->>'execution_version'='2',false);
  select count(*) filter(where not v_slice or e.durable_claim_token=p_claim_token),
    coalesce(sum(e.reserved_input_upper) filter(where not v_slice or e.durable_claim_token=p_claim_token),0),
    coalesce(sum(e.reserved_output_cap) filter(where not v_slice or e.durable_claim_token=p_claim_token),0),coalesce(sum(e.reserved_cost_micros),0)
    into v_calls,v_input,v_output,v_cost from public.supervisor_system_usage_events e
    where e.business_id=p_business_id and e.owner_user_id=p_owner_user_id
      and e.source_type='durable_run' and e.source_id=p_run_id::text;
  -- Legacy v1 limits remain run-wide; v2 technical limits are claim-local.
  -- All attempts remain in the owner-day and lifetime cost ledger, including lost ACKs.
  if v_calls+1>p_max_calls or v_input+p_input_upper>p_max_input_upper
    or v_output+p_output_cap>p_max_output_cap or (p_max_cost is not null and (v_cost+p_cost_upper>p_max_cost or exists (
      select 1 from public.supervisor_system_usage_events e where e.business_id=p_business_id
        and e.owner_user_id=p_owner_user_id and e.source_type='durable_run' and e.source_id=p_run_id::text
        and e.reserved_cost_micros is null))) then
    raise exception 'durable_provider_budget_exhausted' using errcode='P0001'; end if;
  if not exists(select 1 from public.supervisor_run_steps s where s.business_id=p_business_id
    and s.run_id=p_run_id and s.step_key='owner_turn' and s.claim_token=p_claim_token
    and s.status='leased' and s.lease_until>clock_timestamp())
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then raise exception 'durable_reservation_not_authorized' using errcode='42501'; end if;
  insert into public.supervisor_system_usage_events(
    attempt_id,business_id,owner_user_id,thread_id,source_type,source_id,owner_message_id,
    model,attempt_day,reserved_input_upper,reserved_output_cap,reserved_cost_micros,durable_claim_token)
  values(p_attempt_id,p_business_id,p_owner_user_id,p_thread_id,'durable_run',p_run_id::text,
    p_owner_message_id,p_model,v_day,p_input_upper,p_output_cap,p_cost_upper,p_claim_token);
end $$;

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
    or (p_owner_daily_cap is not null and p_owner_daily_cap not between 1 and 1000000)
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
  if p_owner_daily_cap is not null and v_prior+v_system>=p_owner_daily_cap
    then raise exception 'owner_usage_limit_reached' using errcode='P0001';
  end if;
  insert into public.supervisor_system_usage_events(
    attempt_id,business_id,owner_user_id,thread_id,source_type,source_id,
    model,attempt_day,reserved_input_upper,reserved_output_cap,status)
  values(p_attempt_id,p_business_id,p_owner_user_id,p_thread_id,
    p_source_type,p_source_id,p_model,v_day,p_input_upper,p_output_cap,'attempted');
end $$;


-- Owner sees only activity counts, not raw model names, tokens or costs.
-- UTC month matches the existing attempt-day ledger; RLS and explicit ownership
-- apply before the aggregate. Distinct request IDs include unaccounted attempts.
create function public.supervisor_owner_usage_summary(p_business_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare v_start date := date_trunc('month',statement_timestamp() at time zone 'UTC')::date;
begin
  if auth.uid() is null or not exists(select 1 from public.memberships
    where business_id=p_business_id and user_id=auth.uid() and role='owner')
    then raise exception 'owner_access_required' using errcode='42501'; end if;
  return jsonb_build_object(
    'periodStart',v_start,
    'ownerRequests',(select count(*) from (
      select owner_message_id from public.ai_usage_events where business_id=p_business_id
        and owner_user_id=auth.uid() and attempt_day>=v_start
      union
      select owner_message_id from public.supervisor_system_usage_events where business_id=p_business_id
        and owner_user_id=auth.uid() and attempt_day>=v_start and source_type='durable_run'
    ) requests),
    'proactiveItems',(select count(distinct (source_type,source_id)) from public.supervisor_system_usage_events
      where business_id=p_business_id and owner_user_id=auth.uid() and attempt_day>=v_start
      and source_type in ('alert','operating_task')));
end $$;
revoke all on function public.supervisor_owner_usage_summary(uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_usage_summary(uuid) to authenticated;

-- Supplement the legacy turn-log dashboard; never add the overlapping logs.
-- Durable reservations are authoritative per attempt. An interactive aggregate
-- containing both reserved and nonreserved calls has no separable cost/tokens;
-- count residual calls but label those amounts unknown rather than double bill.
create function public.admin_supervisor_usage_rollup()
returns jsonb language sql stable security invoker set search_path=public as $$
  with bounds as (
    select date_trunc('month',statement_timestamp() at time zone 'UTC')::date as since
  ), entries as (
    select e.business_id,'owner_requested'::text as channel,
      e.model_call_count-e.reserved_model_call_count as calls,
      case when e.reserved_model_call_count=0 then e.input_tokens end as input_tokens,
      case when e.reserved_model_call_count=0 then e.output_tokens end as output_tokens,
      case when e.reserved_model_call_count=0 then e.estimated_cost_micros end as cost
    from public.ai_usage_events e,bounds where e.attempt_day>=bounds.since
      and e.model_call_count>e.reserved_model_call_count
    union all
    select e.business_id,case when e.source_type='durable_run' then 'owner_requested' else 'proactive' end,
      e.model_call_count,e.input_tokens,e.output_tokens,e.estimated_cost_micros
    from public.supervisor_system_usage_events e,bounds where e.attempt_day>=bounds.since
  ), grouped as (
    select e.business_id,b.name,e.channel,sum(e.calls) as calls,
      coalesce(sum(e.input_tokens),0) as known_input_tokens,
      coalesce(sum(e.output_tokens),0) as known_output_tokens,
      coalesce(sum(e.calls) filter(where e.input_tokens is null or e.output_tokens is null),0) as unknown_token_calls,
      coalesce(sum(e.cost),0) as known_cost_micros,
      coalesce(sum(e.calls) filter(where e.cost is null),0) as unpriced_calls
    from entries e join public.businesses b on b.id=e.business_id
    group by e.business_id,b.name,e.channel
  )
  select jsonb_build_object('periodStart',(select since from bounds),
    'rows',coalesce((select jsonb_agg(to_jsonb(g) order by g.name,g.channel,g.business_id) from grouped g),'[]'::jsonb))
$$;
revoke all on function public.admin_supervisor_usage_rollup() from public,anon,authenticated;
grant execute on function public.admin_supervisor_usage_rollup() to service_role;
