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

-- Preserve message shape and owner authorization; remove arbitrary answer size ceilings.
alter table public.ai_messages drop constraint ai_messages_supervisor_content_check;
alter table public.ai_messages add constraint ai_messages_supervisor_content_check CHECK ((((role = 'owner'::text) AND (author_user_id IS NOT NULL) AND (author_user_id = owner_user_id) AND (content_type = 'text'::text) AND (text_content IS NOT NULL) AND ((char_length(btrim(text_content)) >= 1) AND (char_length(btrim(text_content)) <= 4000)) AND (structured_content IS NULL) AND ((grounding IS NULL) OR COALESCE(
CASE
    WHEN ((jsonb_typeof(grounding) = 'object'::text) AND (jsonb_typeof((grounding -> 'attachmentIds'::text)) = 'array'::text) AND (jsonb_typeof((grounding -> 'receivedAt'::text)) = 'string'::text)) THEN (((grounding ->> 'sourceChannel'::text) = 'whatsapp'::text) AND ((char_length((grounding ->> 'receivedAt'::text)) >= 20) AND (char_length((grounding ->> 'receivedAt'::text)) <= 40)) AND (jsonb_array_length((grounding -> 'attachmentIds'::text)) <= 3) AND ((((grounding - 'sourceChannel'::text) - 'receivedAt'::text) - 'attachmentIds'::text) = '{}'::jsonb))
    ELSE false
END, false)) AND (client_message_id IS NOT NULL)) OR ((role = 'supervisor'::text) AND (author_user_id IS NULL) AND (content_type = 'blocks'::text) AND (text_content IS NULL) AND (structured_content IS NOT NULL) AND (grounding IS NOT NULL) AND
CASE
    WHEN (jsonb_typeof(structured_content) = 'array'::text) THEN ((jsonb_array_length(structured_content) >= 1))
    ELSE false
END AND (jsonb_typeof(grounding) = 'object'::text) AND (COALESCE((grounding ->> 'status'::text), ''::text) = ANY (ARRAY['verified'::text, 'estimated'::text, 'partial'::text, 'unavailable'::text, 'insufficient_evidence'::text, 'requires_owner_input'::text])) AND ((COALESCE((grounding ->> 'status'::text), ''::text) <> 'requires_owner_input'::text) OR (jsonb_typeof((grounding -> 'ownerInput'::text)) = 'object'::text))))) not valid;

CREATE OR REPLACE FUNCTION public.supervisor_publish_owner_question_v2(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_claim_token uuid, p_job_id uuid, p_reply_id uuid, p_blocks jsonb, p_grounding jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks)<1
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
 if r.input_attachment_version_hash is distinct from public.supervisor_owner_attachment_fingerprint_v2(r.business_id,r.owner_user_id,r.thread_id,r.input_attachment_ids) then raise exception 'owner_run_attachment_changed' using errcode='42501'; end if;
 select * into s from public.supervisor_run_steps where business_id=r.business_id and run_id=r.id
   and step_key='owner_turn' for update;
 if not found or s.status<>'leased' or s.claim_token is distinct from p_claim_token
   or s.lease_until<=clock_timestamp() or s.checkpoint_phase<>'ready'
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and durable_claim_token=p_claim_token and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and owner_message_id=r.request_key and status='running' for update;
 if not found then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 insert into public.ai_messages(id,business_id,owner_user_id,thread_id,role,content_type,structured_content,grounding)
 values(p_reply_id,r.business_id,r.owner_user_id,r.thread_id,'supervisor','blocks',p_blocks,p_grounding)
 returning * into m;
 update public.ai_agent_jobs set status='failed',error_code='awaiting_owner',finished_at=clock_timestamp(),
   updated_at=clock_timestamp(),heartbeat_at=clock_timestamp() where id=j.id;
 update public.supervisor_run_steps set status='blocked',error_code='awaiting_owner',
   claim_token=null,worker_id=null,lease_until=null,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='blocked',awaiting_question_id=p_reply_id,updated_at=clock_timestamp()
   where id=r.id;
 return to_jsonb(m);
end $function$;

CREATE OR REPLACE FUNCTION public.supervisor_publish_owner_reply_v2(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_claim_token uuid, p_job_id uuid, p_reply_id uuid, p_blocks jsonb, p_grounding jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks)<1
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or coalesce(p_grounding->>'status','') not in ('verified','partial','unavailable','insufficient_evidence','estimated')
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
 if r.input_attachment_version_hash is distinct from public.supervisor_owner_attachment_fingerprint_v2(r.business_id,r.owner_user_id,r.thread_id,r.input_attachment_ids) then raise exception 'owner_run_attachment_changed' using errcode='42501'; end if;
 select * into s from public.supervisor_run_steps where business_id=r.business_id and run_id=r.id
   and step_key='owner_turn' for update;
 if not found or s.status<>'leased' or s.claim_token is distinct from p_claim_token
   or s.lease_until<=clock_timestamp() or s.checkpoint_phase<>'ready'
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and durable_claim_token=p_claim_token and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and owner_message_id=r.request_key for update;
 if not found then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 if j.status='done' and j.reply_message_id is distinct from p_reply_id then
   raise exception 'durable_reply_conflict'; end if;
 if j.status not in ('running','done') then raise exception 'durable_job_lease_lost'; end if;
 insert into public.ai_messages(id,business_id,owner_user_id,thread_id,role,content_type,
   structured_content,grounding)
 values(p_reply_id,r.business_id,r.owner_user_id,r.thread_id,'supervisor','blocks',p_blocks,p_grounding)
 on conflict(id) do nothing;
 select * into m from public.ai_messages where id=p_reply_id and business_id=r.business_id
   and owner_user_id=r.owner_user_id and thread_id=r.thread_id and role='supervisor'
   and grounding->>'ownerMessageId'=r.request_key::text
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'=p_grounding->>'status'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 -- The final persisted answer may honestly describe incomplete data.
 -- Completion is proved by the scoped reply and endReason, not confidence.
 return to_jsonb(m);
end $function$;

-- Dedicated direct research login may be granted this role by the deployment operator.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='supervisor_research_transport') then
    create role supervisor_research_transport nologin;
  end if;
end $$;
grant usage on schema public to supervisor_research_transport;
grant execute on function public.supervisor_research_sql(uuid,uuid,text) to supervisor_research_transport;

-- Autonomous research uses the same resumable transcript contract, but its
-- authority comes from the existing routine/incident lease, not a chat run.
create table public.supervisor_background_research_continuations (
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null,
  source_type text not null check (source_type in ('routine','alert','operating_task')),
  source_id text not null,
  revision text not null,
  state jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (business_id,owner_user_id,source_type,source_id)
);
alter table public.supervisor_background_research_continuations enable row level security;
revoke all on public.supervisor_background_research_continuations from public,anon,authenticated;
grant select,insert,update,delete on public.supervisor_background_research_continuations to service_role;

create function public.supervisor_background_research_checkpoint(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_source_type text,
  p_source_id text,p_revision text,p_lease_token uuid,p_operation text,p_state jsonb default null
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare expiry timestamptz; saved jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_operation not in ('load','save','yield') or
    not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'background_research_unauthorized' using errcode='42501'; end if;
  if p_source_type='routine' then
    perform 1 from public.supervisor_routines r join public.supervisor_routine_occurrences o
      on o.business_id=r.business_id and o.routine_id=r.id
      where r.business_id=p_business_id and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
        and o.run_id::text=p_source_id and r.status='active' and r.revision=o.revision
        and r.execution_mode in ('objective','watch') for update of r;
    if not found then raise exception 'background_research_lease_lost' using errcode='40001'; end if;
    select o.lease_until into expiry from public.supervisor_routine_occurrences o
      where o.business_id=p_business_id and o.run_id::text=p_source_id and o.revision::text=p_revision
        and o.state='running' and o.lease_token=p_lease_token for update;
  else
    select i.lease_until into expiry from public.supervisor_investigations i
      where i.business_id=p_business_id and i.owner_user_id=p_owner_user_id and i.thread_id=p_thread_id
        and i.source_type=p_source_type and i.source_id=p_source_id and i.lease_token=p_lease_token
        and i.phase in ('investigate','awaiting_owner')
        and i.episode_id::text||':'||i.revision_hash||':'||i.step_version::text=p_revision for update;
  end if;
  if expiry is null or expiry<=clock_timestamp() then
    raise exception 'background_research_lease_lost' using errcode='40001'; end if;
  if p_operation='load' then
    select c.state into saved from public.supervisor_background_research_continuations c
      where c.business_id=p_business_id and c.owner_user_id=p_owner_user_id
        and c.source_type=p_source_type and c.source_id=p_source_id and c.revision=p_revision;
    return jsonb_build_object('state',saved,'lease_until',expiry);
  elsif p_operation='save' then
    if jsonb_typeof(p_state) is distinct from 'object' then raise exception 'invalid_research_state'; end if;
    insert into public.supervisor_background_research_continuations
      (business_id,owner_user_id,source_type,source_id,revision,state)
    values(p_business_id,p_owner_user_id,p_source_type,p_source_id,p_revision,p_state)
    on conflict(business_id,owner_user_id,source_type,source_id) do update set
      state=excluded.state,revision=excluded.revision,updated_at=clock_timestamp();
  elsif p_source_type='routine' then
    update public.supervisor_routine_occurrences set state='pending',lease_token=null,lease_until=null,
      attempts=greatest(0,attempts-1),next_retry_at=clock_timestamp(),updated_at=clock_timestamp()
      where business_id=p_business_id and run_id::text=p_source_id and lease_token=p_lease_token;
  else
    update public.supervisor_investigations set lease_token=null,lease_until=null,
      next_retry_at=clock_timestamp(),updated_at=clock_timestamp()
      where business_id=p_business_id and owner_user_id=p_owner_user_id and source_type=p_source_type
        and source_id=p_source_id and lease_token=p_lease_token;
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.supervisor_background_research_checkpoint(uuid,uuid,uuid,text,text,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_background_research_checkpoint(uuid,uuid,uuid,text,text,text,uuid,text,jsonb) to service_role;

create function public.supervisor_clear_background_research() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if tg_table_name='supervisor_routine_occurrences' then
    if new.state in ('completed','failed') or new.revision is distinct from old.revision then
      delete from public.supervisor_background_research_continuations where business_id=new.business_id
        and source_type='routine' and source_id=new.run_id::text;
    end if;
  else
    if new.phase in ('resolved','blocked') or new.step_version is distinct from old.step_version
      or new.episode_id is distinct from old.episode_id or new.revision_hash is distinct from old.revision_hash then
      delete from public.supervisor_background_research_continuations where business_id=new.business_id
        and owner_user_id=new.owner_user_id and source_type=new.source_type and source_id=new.source_id;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.supervisor_clear_background_research() from public,anon,authenticated;
create trigger clear_routine_research after update on public.supervisor_routine_occurrences
for each row execute function public.supervisor_clear_background_research();
create trigger clear_incident_research after update on public.supervisor_investigations
for each row execute function public.supervisor_clear_background_research();

-- Scheduled reports use the same model-selected answer length.
CREATE OR REPLACE FUNCTION public.u4_publish_objective_report(p_business_id uuid, p_routine_id uuid, p_run_id uuid, p_lease_token uuid, p_report text, p_attention text, p_proof jsonb, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.supervisor_routines;o public.supervisor_routine_occurrences;
        msg uuid; blocks jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_now is null
   or p_attention not in ('attention','none')
   or length(btrim(coalesce(p_report,'')))<1
   or p_proof is null or jsonb_typeof(p_proof)<>'object'
   or jsonb_typeof(p_proof->'sources')<>'array'
   or jsonb_array_length(p_proof->'sources')<1
   or jsonb_typeof(p_proof->'sourceCount')<>'number'
   or coalesce((p_proof->>'sourceCount')::integer,0)<1
   or p_proof->>'externalEffects'<>'not_attempted'
   or p_proof->>'quality' not in ('verified','partial') then
   raise exception 'u4_report_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_routines
   where business_id=p_business_id and id=p_routine_id for update;
 if not found or r.execution_mode not in ('objective','watch') or r.status<>'active'
   or not public.supervisor_routine_owner_authorized(
       r.business_id,r.owner_user_id,r.thread_id) then
   return false; end if;
 select * into o from public.supervisor_routine_occurrences
   where business_id=p_business_id and routine_id=p_routine_id
     and run_id=p_run_id for update;
 if not found or o.state<>'running' or o.lease_token is distinct from p_lease_token
   or o.lease_until<=greatest(p_now,statement_timestamp())
   or o.revision<>r.revision then return false; end if;
 if r.execution_mode='objective' or p_attention='attention' then
   -- One owner-private Work/Operations Inbox pointer per completed occurrence.
   insert into public.operating_tasks(
     business_id,id,owner_user_id,agent_id,kind,status,confidence,payload,
     evidence,entity_type,entity_id,dedupe_key,created_at)
   values(r.business_id,'u4:'||p_run_id::text,r.owner_user_id,
     'leo','u4_report','watching',
     case when p_proof->>'quality'='verified' then 'high' else 'medium' end,
     jsonb_build_object('title',r.title,'threadId',r.thread_id::text,
       'routineId',r.id::text,'runId',p_run_id::text,
       'localDate',o.local_date::text,'asOf',p_now::text),
     '[]'::jsonb,'u4_routine',r.id::text,'u4:'||p_run_id::text,p_now)
   on conflict(business_id,id) do nothing;
   if not exists(select 1 from public.operating_tasks t
     where t.business_id=r.business_id and t.id='u4:'||p_run_id::text
       and t.kind='u4_report' and t.owner_user_id=r.owner_user_id
       and t.payload->>'runId'=p_run_id::text
       and t.payload->>'routineId'=r.id::text)
   then raise exception 'u4_report_task_identity_conflict' using errcode='23505'; end if;
   -- Queue ONLY devices that actively consented before this one report.
   -- This is not a Luna job; the same minute cron sends generic PWA notices.
   insert into public.u4_push_receipts(
     business_id,owner_user_id,device_hash,run_id)
   select s.business_id,s.owner_user_id,s.device_hash,p_run_id
     from public.u4_push_subscriptions s
     where s.business_id=r.business_id and s.owner_user_id=r.owner_user_id
       and s.revoked_at is null
   on conflict do nothing;
   msg:=md5('u4-objective-report:'||p_run_id::text)::uuid;
   -- Full evidence-backed output lives ONCE on the occurrence. The chat
   -- is a short, idempotent pointer and does not duplicate that report.
   blocks:=jsonb_build_array(
     jsonb_build_object('type','text',
       'text','Luna review finished. Open Work to read the report.'),
     jsonb_build_object('type','task_card','agent','leo',
       'title',r.title,'status','watching',
       'href','/operations?agent=leo&status=watching&task=u4:'||p_run_id::text));
   insert into public.ai_messages(
     id,business_id,thread_id,owner_user_id,role,
     content_type,structured_content,grounding)
   values(msg,r.business_id,r.thread_id,r.owner_user_id,'supervisor',
     'blocks',blocks,
     jsonb_build_object('status',p_proof->>'quality','intent','operating_tasks',
       'evidence',p_proof->'sources',
       'agentMetadata',jsonb_build_object('runId',p_run_id::text,
          'routineId',r.id::text,'revision',r.revision,
          'u4Kind',case when r.execution_mode='watch' then 'watch' else 'routine' end,
          'externalEffects','not_attempted')))
   on conflict(id) do nothing;
   if not exists(select 1 from public.ai_messages m
     where m.id=msg and m.business_id=r.business_id
       and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id
       and m.role='supervisor'
       and m.grounding->'agentMetadata'->>'runId'=p_run_id::text)
     then raise exception 'u4_report_identity_conflict' using errcode='23505'; end if;
 end if;
 if not public.finish_supervisor_routine_occurrence(
   p_business_id,p_routine_id,p_run_id,p_lease_token,true,'u4-verified:'||p_run_id::text,
   greatest(p_now,statement_timestamp())) then
   raise exception 'u4_lease_lost' using errcode='40001'; end if;
 update public.supervisor_routine_occurrences set
   u4_result=jsonb_build_object('attention',p_attention,
     'summary',btrim(p_report),'proof',p_proof,'reviewedAt',p_now::text)
   where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id;
 return true;
end
$function$;
