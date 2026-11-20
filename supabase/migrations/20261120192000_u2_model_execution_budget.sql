set lock_timeout = '1s';
set statement_timeout = '5s';

-- U2: no new queue, role, ledger, ownership, paid grant or commercial limit.
-- A service-only capability read gates rolling deployments on actual schema.
create function public.supervisor_model_execution_cap(p_model text)
returns integer language sql immutable security invoker set search_path=public as $$
  select case when p_model='gpt-6-luna' then 8192 else 1200 end
$$;
revoke all on function public.supervisor_model_execution_cap(text) from public,anon,authenticated;
grant execute on function public.supervisor_model_execution_cap(text) to service_role;

alter table public.supervisor_system_usage_events add constraint supervisor_system_output_cap_v2
  check (reserved_output_cap between 1 and case when model='gpt-6-luna' then 8192 else 1200 end) not valid;
-- Reason: a stricter model-specific replacement already exists; the previous
-- unconditional ceiling prevents model-directed research and final synthesis.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_system_usage_events drop constraint supervisor_system_usage_events_reserved_output_cap_check;

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
    or p_output_cap is null or p_output_cap not between 1 and public.supervisor_model_execution_cap(p_model)
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
  v_slice:=r.execution_version=2;
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
      and (not v_slice or (j.durable_run_id=p_run_id and j.durable_claim_token=p_claim_token
        and public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token))))
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
  select count(*) filter(where not v_slice or e.durable_claim_token=p_claim_token),
    coalesce(sum(case when v_slice and p_model='gpt-6-luna' and e.status='completed' and e.input_tokens between 0 and e.reserved_input_upper then e.input_tokens else e.reserved_input_upper end) filter(where not v_slice or e.durable_claim_token=p_claim_token),0),
    coalesce(sum(case when v_slice and p_model='gpt-6-luna' and e.status='completed' and e.output_tokens between 0 and e.reserved_output_cap then e.output_tokens else e.reserved_output_cap end) filter(where not v_slice or e.durable_claim_token=p_claim_token),0),coalesce(sum(e.reserved_cost_micros),0)
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
    or (v_slice and not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token))
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
    or p_output_cap is null or p_output_cap not between 1 and public.supervisor_model_execution_cap(p_model)
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

create or replace function public.supervisor_complete_investigation_model_call(
  p_attempt_id uuid,p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_model text,p_input_tokens integer,p_output_tokens integer,
  p_estimated_cost_micros bigint
) returns void language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role'
     or p_attempt_id is null or p_business_id is null or p_owner_user_id is null
     or p_thread_id is null or length(coalesce(p_model,'')) not between 1 and 80
     or (p_input_tokens is not null and p_input_tokens<0)
     or (p_output_tokens is not null and p_output_tokens<0)
     or (p_estimated_cost_micros is not null and p_estimated_cost_micros<0)
  then raise exception 'invalid_system_usage_completion' using errcode='42501';
  end if;
  update public.supervisor_system_usage_events e set
    model=p_model,input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    estimated_cost_micros=p_estimated_cost_micros,
    status='completed',completed_at=statement_timestamp()
    where e.attempt_id=p_attempt_id and e.business_id=p_business_id
      and e.owner_user_id=p_owner_user_id and e.thread_id=p_thread_id
      and e.status='attempted'
      and (p_input_tokens is null or p_input_tokens<=e.reserved_input_upper)
      and (p_output_tokens is null or p_output_tokens<=e.reserved_output_cap)
      and (e.reserved_output_cap<=1200 or e.model=p_model);
  if not found then
    raise exception 'system_usage_missing_or_already_completed' using errcode='P0001';
  end if;
end $$;

reset lock_timeout;
reset statement_timeout;
