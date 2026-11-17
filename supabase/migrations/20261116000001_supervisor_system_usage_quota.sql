set lock_timeout = '1s';
set statement_timeout = '5s';
-- Task15A: billable system-initiated Supervisor calls are NOT owner messages.
-- Keep them in their own private, append-only-per-attempt ledger, while charging
-- the SAME owner UTC daily model-call quota enforced for conversation turns.
create table public.supervisor_system_usage_events (
  attempt_id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.ai_threads(id) on delete cascade,
  source_type text not null check (source_type in ('alert','operating_task')),
  source_id text not null check (length(source_id) between 1 and 160),
  model text not null check (length(model) between 1 and 80),
  attempt_day date not null default (statement_timestamp() at time zone 'UTC')::date,
  model_call_count bigint not null default 1 check (model_call_count=1),
  reserved_input_upper bigint not null check (reserved_input_upper between 1 and 2000000),
  reserved_output_cap bigint not null check (reserved_output_cap between 1 and 1200),
  input_tokens bigint null check (input_tokens>=0),
  output_tokens bigint null check (output_tokens>=0),
  estimated_cost_micros bigint null check (estimated_cost_micros>=0),
  status text not null default 'attempted' check (status in ('attempted','completed')),
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz null
);
create index supervisor_system_usage_owner_day_idx
  on public.supervisor_system_usage_events(business_id,owner_user_id,attempt_day);
-- Reason: the new service-only system-attempt ledger MUST enforce owner RLS from creation.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_system_usage_events enable row level security;
revoke all on public.supervisor_system_usage_events from public,anon,authenticated;
grant select on public.supervisor_system_usage_events to authenticated;
grant select,insert,update,delete on public.supervisor_system_usage_events to service_role;
create policy supervisor_system_usage_owner_read
  on public.supervisor_system_usage_events for select to authenticated
  using (owner_user_id=auth.uid() and exists (
    select 1 from public.memberships m
      where m.business_id=supervisor_system_usage_events.business_id
        and m.user_id=auth.uid() and m.role='owner'
  ));

-- Reserve ONE model call before its provider request (successful, failed,
-- timed-out and incomplete calls all spend one daily call). Advisory locking
-- makes simultaneous scheduled attempts for this owner/day atomic.
-- Consequential approval or fabricated owner-message permissions are NEVER
-- created by this service-only accounting function.
create function public.supervisor_reserve_investigation_model_call(
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
  select coalesce(sum(e.model_call_count),0) into v_prior
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

-- A response may finish after a failed or partially billed attempt. Only
-- genuine completed provider usage is recorded as completed; a failed attempt
-- stays 'attempted' and still counts toward the daily owner quota.
create function public.supervisor_complete_investigation_model_call(
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
      and e.status='attempted';
  if not found then
    raise exception 'system_usage_missing_or_already_completed' using errcode='P0001';
  end if;
end $$;
revoke all on function public.supervisor_complete_investigation_model_call(
  uuid,uuid,uuid,uuid,text,integer,integer,bigint)
  from public,anon,authenticated;
grant execute on function public.supervisor_complete_investigation_model_call(
  uuid,uuid,uuid,uuid,text,integer,integer,bigint)
  to service_role;

-- An owner who has reached the shared paid quota is not 'provider down'.
-- Preserve the investigation and resume on the next UTC quota day, without
-- charging further calls or incrementing the five-real-failure escalation.
create or replace function public.supervisor_fail_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_source_type text,p_source_id text,
  p_lease_token uuid,p_error text,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_count integer;v_hash text;v_msg uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_error not in ('source_unavailable','provider_unavailable','owner_quota_reached','model_incomplete',
    'evidence_incomplete','authorization_revoked','time_exceeded','storage_failed')
  then raise exception 'Invalid investigation error code' using errcode='22023'; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.lease_token is distinct from p_lease_token
    or v.lease_until<=p_now then return false; end if;
  v_count:=case when p_error='owner_quota_reached' then v.failure_count
    else least(5,v.failure_count+1) end;
  update public.supervisor_investigations set
    -- A transient provider failure cannot permanently abandon owner work.
    -- Retry with a long cooldown after the first five attempts; keep the
    -- investigation visible until verified recovery or source resolution.
    failure_count=v_count,
    last_error=p_error,lease_token=null,lease_until=null,
    next_retry_at=case when p_error='owner_quota_reached'
      then (date_trunc('day',p_now at time zone 'UTC')+interval '1 day') at time zone 'UTC'
      when v_count=5 then p_now+interval '6 hours'
      else p_now+(interval '1 minute'*least(60,power(2,v_count)::integer)) end,
    updated_at=p_now
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and source_type=p_source_type and source_id=p_source_id;
  -- Repeated failure is owner-visible, not silently abandoned. No message is
  -- attempted after membership/thread revocation, and no effect is retried.
  if v_count=5 and v.failure_count<5 and public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    v_hash:=md5('investigation-blocked:'||v.business_id::text||':'||v.owner_user_id::text||
      ':'||v.source_type||':'||v.source_id||':'||v.revision_hash||':'||v.episode_id::text);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,v.business_id,v.thread_id,v.owner_user_id,'supervisor','blocks',
      jsonb_build_array(jsonb_build_object('type','text','text',
        'Investigation update: I could not verify the café issue after repeated checks. I have slowed automatic retries to every six hours; the original attention item remains available. No external action was taken. I will re-examine new source evidence sooner.')),
      jsonb_build_object('status','verified','intent','priority_investigation_exception',
        'evidence',jsonb_build_array(jsonb_build_object('source',v.source_type,
          'identifier',v.source_id,'asOf',p_now::text))))
    on conflict(id) do nothing;
  end if;
  return true;
end $$;
revoke all on function public.supervisor_fail_investigation(uuid,uuid,text,text,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_fail_investigation(uuid,uuid,text,text,uuid,text,timestamptz)
  to service_role;
