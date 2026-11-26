-- Owner-approved unrestricted Luna research. Keep the existing authorization,
-- receipt fencing, read-only SQL role and measured usage ledger.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Only the research RPC, never a global service/owner role setting.
alter function public.supervisor_research_sql(uuid,uuid,text) set statement_timeout = 0;
notify pgrst, 'reload schema';

-- Actual item/day totals do not need the optional Toast metadata or JSON
-- reconstruction used by the detailed item view. The old metadata join has
-- unique order identity, and the needs_match branch was excluded by status.
create or replace view public.cv_item_sales_daily with (security_invoker=true) as
 select o.business_id,'item-day:'||o.business_date::text||':'||l.menu_item_id::text as source_ref,
 'actual'::text as status,o.business_date,l.menu_item_id,
 sum(l.quantity) as quantity,sum(l.net_sales_cents) as net_sales_cents
 from public.order_lines l join public.orders o on o.id=l.order_id
 where o.toast_excluded is not true and o.superseded_by is null and l.voided=false and l.menu_item_id is not null
 group by o.business_id,o.business_date,l.menu_item_id;

-- Private continuation of the existing owner run, not a second queue.
-- Only the live service worker can read/write it. The browser and Luna
-- cannot call this RPC or read the table. Never log raw contents.
create table public.supervisor_research_continuations (
 run_id uuid primary key references public.supervisor_runs(id) on delete cascade,
 state jsonb not null check(jsonb_typeof(state)='object'),
 updated_at timestamptz not null default clock_timestamp()
);
alter table public.supervisor_research_continuations enable row level security;
revoke all on public.supervisor_research_continuations from public,anon,authenticated;
grant select,insert,update,delete on public.supervisor_research_continuations to service_role;

create function public.supervisor_research_checkpoint_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_expected_seq integer,p_write boolean,p_state jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_state jsonb; v_seq integer;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_write is null or p_expected_seq is null
   then raise exception 'checkpoint_research_denied' using errcode='42501'; end if;
 perform 1 from public.supervisor_runs r where r.id=p_run_id and r.business_id=p_business_id
   and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id for update;
 if not found then raise exception 'checkpoint_research_denied' using errcode='42501'; end if;
 select checkpoint_seq into v_seq from public.supervisor_run_steps where run_id=p_run_id
   and business_id=p_business_id and step_key='owner_turn' for update;
 if not found or v_seq<>p_expected_seq or not public.supervisor_owner_job_fence_v2(
   p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'checkpoint_research_lease_lost' using errcode='42501'; end if;
 if not p_write then
   select state into v_state from public.supervisor_research_continuations where run_id=p_run_id;
   return v_state;
 end if;
 if jsonb_typeof(p_state) is distinct from 'object' then raise exception 'checkpoint_research_invalid'; end if;
 insert into public.supervisor_research_continuations(run_id,state) values(p_run_id,p_state)
 on conflict(run_id) do update set state=excluded.state,updated_at=clock_timestamp();
 return 'true'::jsonb;
end $$;
revoke all on function public.supervisor_research_checkpoint_v2(uuid,uuid,uuid,uuid,uuid,integer,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_research_checkpoint_v2(uuid,uuid,uuid,uuid,uuid,integer,boolean,jsonb) to service_role;

create function public.supervisor_clear_research_continuation()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if new.status in ('completed','blocked') then
   delete from public.supervisor_research_continuations where run_id=new.id;
 end if;
 return new;
end $$;
revoke all on function public.supervisor_clear_research_continuation() from public,anon,authenticated;
grant execute on function public.supervisor_clear_research_continuation() to service_role;
create trigger supervisor_clear_research_continuation after update of status on public.supervisor_runs
 for each row when (old.status is distinct from new.status) execute function public.supervisor_clear_research_continuation();

-- Remove artificial cumulative receipt caps; receipts still validate their shape.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_run_steps drop constraint supervisor_run_steps_checkpoint_receipts_check;
alter table public.supervisor_run_steps add constraint supervisor_research_receipts_array check(jsonb_typeof(checkpoint_receipts)='array') not valid;

-- NULL output reservation means the provider chooses the output. Old explicit
-- bounded acceptance reservations remain compatible.
-- squawk-ignore ban-drop-not-null
alter table public.supervisor_system_usage_events alter column reserved_output_cap drop not null;
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_system_usage_events drop constraint supervisor_system_usage_events_reserved_input_upper_check;
alter table public.supervisor_system_usage_events add constraint supervisor_system_input_positive check(reserved_input_upper>=1) not valid;

create or replace function public.supervisor_reserve_durable_model_call(
  p_attempt_id uuid,p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_run_id uuid,p_owner_message_id uuid,p_job_id uuid,p_claim_token uuid,
  p_model text,p_input_upper integer,p_output_cap integer,p_cost_upper bigint,
  p_max_calls integer,p_max_input_upper bigint,p_max_output_cap bigint,
  p_max_cost bigint,p_owner_daily_cap integer
) returns void language plpgsql security definer set search_path=public as $$
declare r public.supervisor_runs;v_day date;v_prior bigint;v_system bigint;
  v_calls bigint;v_input bigint;v_output bigint;v_cost bigint;v_slice boolean;
  v_unrestricted boolean := p_max_calls is null and p_max_input_upper is null and p_max_output_cap is null and p_max_cost is null;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_attempt_id is null
    or p_claim_token is null or length(coalesce(p_model,'')) not between 1 and 80
    or p_input_upper is null or p_input_upper<1
    or (not v_unrestricted and p_input_upper>272000)
    or (not v_unrestricted and p_output_cap is null)
    or (p_output_cap is not null and p_output_cap not between 1 and public.supervisor_model_execution_cap(p_model))
    or (p_cost_upper is not null and p_cost_upper<0)
    or (p_max_cost is not null and (p_cost_upper is null or p_cost_upper<1))
    or (not v_unrestricted and (p_max_calls is null or p_max_calls not between 1 and 1000
    or p_max_input_upper is null or p_max_input_upper<1
    or p_max_output_cap is null or p_max_output_cap<1))
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
  if v_unrestricted and not v_slice then raise exception 'durable_reservation_not_authorized' using errcode='42501'; end if;
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
  if not v_unrestricted and (v_calls+1>p_max_calls or v_input+p_input_upper>p_max_input_upper
    or v_output+p_output_cap>p_max_output_cap or (p_max_cost is not null and (v_cost+p_cost_upper>p_max_cost or exists (
      select 1 from public.supervisor_system_usage_events e where e.business_id=p_business_id
        and e.owner_user_id=p_owner_user_id and e.source_type='durable_run' and e.source_id=p_run_id::text
        and e.reserved_cost_micros is null)))) then
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
) returns void language plpgsql security definer set search_path='public'
as $u4_reserve$
declare v_day date;v_prior bigint;v_system bigint;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or p_attempt_id is null or p_business_id is null or p_owner_user_id is null
    or p_thread_id is null or p_lease_token is null
    or p_source_type not in ('alert','operating_task','routine')
    or length(coalesce(p_source_id,'')) not between 1 and 160
    or length(coalesce(p_model,'')) not between 1 and 80
    or p_input_upper is null or p_input_upper<1
    or (p_output_cap is not null and (p_input_upper>2000000 or p_output_cap not between 1 and public.supervisor_model_execution_cap(p_model)))
    or (p_owner_daily_cap is not null and p_owner_daily_cap not between 1 and 1000000)
    or not public.supervisor_routine_owner_authorized(
      p_business_id,p_owner_user_id,p_thread_id)
    or (p_source_type='routine' and not exists(
      select 1 from public.supervisor_routine_occurrences o
      join public.supervisor_routines r on r.business_id=o.business_id
        and r.id=o.routine_id
      where o.business_id=p_business_id and r.owner_user_id=p_owner_user_id
        and r.thread_id=p_thread_id and o.run_id::text=p_source_id
        and o.lease_token=p_lease_token and o.lease_until>statement_timestamp()
        and o.state='running' and r.status='active' and r.revision=o.revision
        and r.execution_mode in ('objective','watch')
    ))
    or (p_source_type in ('alert','operating_task') and not exists (
      select 1 from public.supervisor_investigations i
      where i.business_id=p_business_id and i.owner_user_id=p_owner_user_id
        and i.thread_id=p_thread_id and i.source_type=p_source_type
        and i.source_id=p_source_id and i.lease_token=p_lease_token
        and i.lease_until>statement_timestamp()
        and i.phase in ('investigate','awaiting_owner')
    ))
  then raise exception 'system_model_attempt_not_authorized' using errcode='42501'; end if;
  v_day:=(statement_timestamp() at time zone 'UTC')::date;
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text||':'||p_owner_user_id::text||':'||v_day::text,0));
  select coalesce(sum(e.model_call_count-e.reserved_model_call_count),0) into v_prior
    from public.ai_usage_events e where e.business_id=p_business_id
      and e.owner_user_id=p_owner_user_id and e.attempt_day=v_day;
  select count(*) into v_system from public.supervisor_system_usage_events e
    where e.business_id=p_business_id and e.owner_user_id=p_owner_user_id
      and e.attempt_day=v_day;
  if p_owner_daily_cap is not null and v_prior+v_system>=p_owner_daily_cap
    then raise exception 'owner_usage_limit_reached' using errcode='P0001'; end if;
  insert into public.supervisor_system_usage_events(
    attempt_id,business_id,owner_user_id,thread_id,source_type,source_id,
    model,attempt_day,reserved_input_upper,reserved_output_cap,status)
  values(p_attempt_id,p_business_id,p_owner_user_id,p_thread_id,
    p_source_type,p_source_id,p_model,v_day,p_input_upper,p_output_cap,'attempted');
end
$u4_reserve$;

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
      and (e.reserved_output_cap is null or e.source_type<>'durable_run' or p_input_tokens is null or p_input_tokens<=e.reserved_input_upper)
      and (e.reserved_output_cap is null or p_output_tokens is null or p_output_tokens<=e.reserved_output_cap)
      and (e.model=p_model or e.reserved_output_cap<=1200);
  if not found then
    raise exception 'system_usage_missing_or_already_completed' using errcode='P0001';
  end if;
end $$;

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
  if r.execution_version=2 then
    if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) then
      update public.supervisor_run_steps set status='blocked',error_code='authorization_revoked',
        worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
      update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
      return jsonb_build_object('kind','blocked');
    end if;
    if r.input_attachment_version_hash is distinct from public.supervisor_owner_attachment_fingerprint_v2(r.business_id,r.owner_user_id,r.thread_id,r.input_attachment_ids) and s.step_key<>'verify_report' then
      update public.supervisor_run_steps set status='blocked',error_code=case when s.checkpoint_phase='effect_pending' then 'effect_uncertain' else 'attachment_changed' end,
        worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
      update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
      return jsonb_build_object('kind','blocked');
    end if;
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and (s.checkpoint_phase in ('ready','provider_pending','read_pending')
        or (s.checkpoint_phase='effect_pending'
          and s.checkpoint_tool='record_staff_question_owner_answer'
          -- Only the one independently recorded, owner-attributed report can
          -- justify a claim after a lost checkpoint ACK. The Node journal
          -- must still validate exact proposal, original message, operation
          -- key, owner, café and absence of employee contact before unblocking.
          and exists(select 1 from public.operating_tasks evidence
            where evidence.business_id=r.business_id
              and evidence.owner_user_id=r.owner_user_id
              and evidence.kind='data_quality'
              and evidence.entity_type='staff_question_answer'
              and evidence.evidence @> jsonb_build_array(jsonb_build_object(
                'source','owner_report','facts',jsonb_build_object(
                  'ownerMessageId',r.request_key))))))) then
    update public.supervisor_run_steps set status = 'blocked', error_code = case when r.execution_version=2 and s.checkpoint_phase='effect_pending' then 'effect_uncertain' else 'lease_expired' end,
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- An owner research execution window is resumable, not a terminal retry budget.
  -- Uncertain effects still require the independent receipt check above.
  if (r.execution_version<>2 or s.step_key<>'owner_turn') and s.retry_mode='idempotent' and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, next_retry_at=null, updated_at = v_now,
      checkpoint_retry_count=case when r.execution_version=2 and s.step_key='owner_turn' then checkpoint_retry_count+1 else checkpoint_retry_count end,
      checkpoint_slice_progress=checkpoint_progress_count
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;

create or replace function public.supervisor_yield_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_delay_seconds integer,p_yield_kind text default 'retry'
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_due timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_delay_seconds is null
    or p_delay_seconds not between 15 and 900 or p_expected_seq is null
    or p_yield_kind is null or p_yield_kind not in ('retry','technical','contended')
    then raise exception 'checkpoint_yield_invalid' using errcode='42501'; end if;
  select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
    and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
  if not found or r.execution_version<>2 or r.status<>'running'
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then return false; end if;
  select * into s from public.supervisor_run_steps where business_id=p_business_id
    and run_id=p_run_id and step_key='owner_turn' for update;
  v_now:=clock_timestamp();
  if not found or s.status<>'leased' or s.claim_token is distinct from p_claim_token
    or s.lease_until<=v_now or s.checkpoint_seq<>p_expected_seq or s.checkpoint_phase='effect_pending'
    then return false; end if;
  v_due:=v_now+make_interval(secs=>p_delay_seconds);
  update public.supervisor_run_steps set status='pending',worker_id=null,claim_token=null,
    lease_until=null,next_retry_at=v_due,updated_at=v_now,
    checkpoint_retry_count=case when p_yield_kind='contended' then greatest(0,checkpoint_retry_count-1)
      when p_yield_kind='technical' then 0
      else checkpoint_retry_count end where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;

-- Usage increment size is not a research limit.
CREATE OR REPLACE FUNCTION public.record_supervisor_usage_increment(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid, p_model text, p_input_tokens integer, p_output_tokens integer, p_model_call_count integer, p_tool_call_count integer, p_estimated_cost_micros bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_model_call_count IS NULL
    OR p_tool_call_count IS NULL OR p_model IS NULL OR p_input_tokens<0 OR p_output_tokens<0 OR p_model_call_count<0 OR p_tool_call_count<0
    OR p_tool_call_count>5 OR
    p_estimated_cost_micros<0 OR length(p_model) NOT BETWEEN 1 AND 80 OR
    NOT EXISTS (SELECT 1 FROM public.ai_messages m
      WHERE m.id=p_owner_message_id AND m.thread_id=p_thread_id
      AND m.business_id=p_business_id AND m.owner_user_id=p_owner_user_id
      AND m.role='owner')
  THEN RAISE EXCEPTION 'Invalid or unauthorized usage increment'; END IF;

  INSERT INTO public.ai_usage_events AS usage (
    business_id,owner_user_id,thread_id,owner_message_id,provider,model,
    input_tokens,output_tokens,model_call_count,tool_call_count,estimated_cost_micros,attempt_day)
  VALUES (p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
    'openai',p_model,p_input_tokens,p_output_tokens,
    p_model_call_count,p_tool_call_count,p_estimated_cost_micros,
    (statement_timestamp() AT TIME ZONE 'UTC')::date)
  ON CONFLICT (owner_message_id, attempt_day) DO UPDATE SET
    model=EXCLUDED.model,
    input_tokens=usage.input_tokens+EXCLUDED.input_tokens,
    output_tokens=usage.output_tokens+EXCLUDED.output_tokens,
    model_call_count=usage.model_call_count+EXCLUDED.model_call_count,
    tool_call_count=usage.tool_call_count+EXCLUDED.tool_call_count,
    estimated_cost_micros=CASE
      WHEN usage.estimated_cost_micros IS NULL OR EXCLUDED.estimated_cost_micros IS NULL
      THEN NULL ELSE usage.estimated_cost_micros+EXCLUDED.estimated_cost_micros END
  WHERE usage.business_id=EXCLUDED.business_id AND usage.owner_user_id=EXCLUDED.owner_user_id
    AND usage.thread_id=EXCLUDED.thread_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Usage owner scope mismatch'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.supervisor_record_durable_usage_increment(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid, p_run_id uuid, p_attempt_ids uuid[], p_model text, p_input_tokens integer, p_output_tokens integer, p_model_call_count integer, p_tool_call_count integer, p_estimated_cost_micros bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count integer;v_day date;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_attempt_ids is null
    or cardinality(p_attempt_ids)<1
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
end $function$;

create or replace function public.record_supervisor_usage_increment(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
 p_model text,p_input_tokens integer,p_output_tokens integer,
 p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint,
 p_execution_metrics jsonb
) returns void language plpgsql security invoker set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role'
   or jsonb_typeof(p_execution_metrics) is distinct from 'object'
   or jsonb_typeof(p_execution_metrics->'requests') is distinct from 'array'
   or jsonb_typeof(p_execution_metrics->'tools') is distinct from 'array'
 then raise exception 'execution_metrics_invalid' using errcode='42501'; end if;
 if jsonb_array_length(p_execution_metrics->'requests')<>p_model_call_count
 then raise exception 'execution_metrics_count_invalid' using errcode='22023'; end if;
 perform public.record_supervisor_usage_increment(p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
   p_model,p_input_tokens,p_output_tokens,p_model_call_count,p_tool_call_count,p_estimated_cost_micros);
 update public.ai_usage_events set execution_metrics=coalesce(execution_metrics,'[]'::jsonb)||jsonb_build_array(p_execution_metrics)
 where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and owner_message_id=p_owner_message_id and attempt_day=(statement_timestamp() at time zone 'UTC')::date;
 if not found then raise exception 'execution_metrics_scope_mismatch' using errcode='42501'; end if;
end $$;

create or replace function public.supervisor_record_durable_usage_increment(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
 p_run_id uuid,p_attempt_ids uuid[],p_model text,p_input_tokens integer,p_output_tokens integer,
 p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint,p_execution_metrics jsonb
) returns void language plpgsql security invoker set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role'
   or jsonb_typeof(p_execution_metrics) is distinct from 'object'
   or jsonb_typeof(p_execution_metrics->'requests') is distinct from 'array'
   or jsonb_typeof(p_execution_metrics->'tools') is distinct from 'array'
 then raise exception 'execution_metrics_invalid' using errcode='42501'; end if;
 if jsonb_array_length(p_execution_metrics->'requests')<>p_model_call_count
 then raise exception 'execution_metrics_count_invalid' using errcode='22023'; end if;
 perform public.supervisor_record_durable_usage_increment(p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
   p_run_id,p_attempt_ids,p_model,p_input_tokens,p_output_tokens,p_model_call_count,p_tool_call_count,p_estimated_cost_micros);
 update public.ai_usage_events set execution_metrics=coalesce(execution_metrics,'[]'::jsonb)||jsonb_build_array(p_execution_metrics)
 where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and owner_message_id=p_owner_message_id and attempt_day=(statement_timestamp() at time zone 'UTC')::date;
 if not found then raise exception 'execution_metrics_scope_mismatch' using errcode='42501'; end if;
 update public.supervisor_system_usage_events e set execution_metrics=coalesce(e.execution_metrics,p_execution_metrics->'requests'->((a.ordinality-1)::integer))
 from unnest(p_attempt_ids) with ordinality a(id,ordinality)
 where e.attempt_id=a.id and e.business_id=p_business_id and e.owner_user_id=p_owner_user_id
   and e.thread_id=p_thread_id and e.source_type='durable_run' and e.source_id=p_run_id::text
   and e.owner_message_id=p_owner_message_id;
end $$;
