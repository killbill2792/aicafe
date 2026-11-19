-- Task 6 / 15C: additive v2 owner-run admission and fenced checkpoint primitives.
-- Existing version-1 runs retain the original reconcile-only behavior.
-- No new scheduler, queue, provider transport, or production activation.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.supervisor_runs
  add column execution_version bigint not null default 1 check(execution_version in (1,2)),
  add column input_locale text check(input_locale in ('en','es','ar')),
  add column input_attachment_ids uuid[] not null default '{}' check(cardinality(input_attachment_ids)<=3);

alter table public.supervisor_run_steps
  add column checkpoint_seq bigint not null default 0 check(checkpoint_seq>=0),
  add column checkpoint_phase text not null default 'ready'
    check(checkpoint_phase in ('ready','provider_pending','read_pending','effect_pending')),
  add column checkpoint_operation uuid,
  add column checkpoint_tool text check(checkpoint_tool ~ '^[a-z][a-z0-9_]{0,79}$'),
  add column checkpoint_receipts jsonb not null default '[]'::jsonb
    check(jsonb_typeof(checkpoint_receipts)='array' and jsonb_array_length(checkpoint_receipts)<=256
      and octet_length(checkpoint_receipts::text)<=65536),
  add column next_retry_at timestamptz,
  add column checkpoint_retry_count bigint not null default 0 check(checkpoint_retry_count>=0),
  add column checkpoint_progress_count bigint not null default 0 check(checkpoint_progress_count>=0),
  add column checkpoint_slice_progress bigint not null default 0 check(checkpoint_slice_progress>=0),
  add constraint supervisor_checkpoint_pending_identity check(
    (checkpoint_phase='ready' and checkpoint_operation is null and checkpoint_tool is null)
    or (checkpoint_phase='provider_pending' and checkpoint_operation is not null and checkpoint_tool is null)
    or (checkpoint_phase in ('read_pending','effect_pending') and checkpoint_operation is not null
      and checkpoint_tool is not null)) not valid;

-- The work projection may read nonsecret progress, not selected input or
-- checkpoint receipts. Existing RLS still scopes every owner-readable row.
revoke select on public.supervisor_runs,public.supervisor_run_steps from authenticated;
grant select(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status,final_report_ref,
  created_at,updated_at,finished_at,last_dispatched_at,dispatch_after,execution_version)
  on public.supervisor_runs to authenticated;
grant select(id,business_id,run_id,step_key,step_index,retry_mode,status,worker_id,claim_token,
  lease_until,attempts,result_ref,error_code,completed_at,created_at,updated_at,
  checkpoint_seq,checkpoint_phase,next_retry_at)
  on public.supervisor_run_steps to authenticated;

-- Admission uses the original owner message ID as the immutable request key.
-- Only the trusted caller supplies the fixed plan hash; never model or browser.
create function public.supervisor_admit_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_plan_hash text,p_locale text,p_attachment_ids uuid[]
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs; v_started jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then raise exception 'owner_run_admission_denied' using errcode='42501'; end if;
  if p_locale is null or p_locale not in ('en','es','ar') or p_attachment_ids is null
    or cardinality(p_attachment_ids)>3
    or (select count(distinct x) from unnest(p_attachment_ids) x)<>cardinality(p_attachment_ids)
    or not exists(select 1 from public.ai_messages m where m.id=p_owner_message_id
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id
      and m.thread_id=p_thread_id and m.role='owner' and m.content_type='text'
      and coalesce(m.grounding->>'sourceChannel','web')='web')
    or (select count(*) from public.ai_attachments a where a.id=any(p_attachment_ids)
      and a.business_id=p_business_id and a.owner_user_id=p_owner_user_id
      and a.thread_id=p_thread_id)<>cardinality(p_attachment_ids)
    then raise exception 'owner_run_input_unavailable' using errcode='42501'; end if;
  -- Serialize admission with the existing one-running-thread job entrypoint.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
  -- Same advisory lock as supervisor_run_start. An existing legacy run
  -- is never converted under an ambiguous receipt or a conflicting replay.
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor_run:'||p_business_id::text||':'||p_owner_user_id::text||':'||p_owner_message_id::text,0));
  select * into r from public.supervisor_runs where business_id=p_business_id
    and owner_user_id=p_owner_user_id and request_key=p_owner_message_id for update;
  if found then
    if r.execution_version<>2 or r.thread_id<>p_thread_id
      or r.plan_hash is distinct from p_plan_hash or r.input_locale is distinct from p_locale
      or r.input_attachment_ids is distinct from p_attachment_ids
      then raise exception 'owner_run_input_conflict' using errcode='23505'; end if;
    return to_jsonb(r);
  end if;
  if exists(select 1 from public.ai_agent_jobs j where j.owner_message_id=p_owner_message_id)
    or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
      and x.owner_user_id=p_owner_user_id and p_owner_message_id=any(x.owner_answer_ids))
    then raise exception 'owner_run_input_conflict' using errcode='23505'; end if;
  v_started:=public.supervisor_run_start(p_business_id,p_owner_user_id,p_thread_id,
    p_owner_message_id,p_plan_hash,
    '[{"key":"authorize_owner","retry":"idempotent"},{"key":"owner_turn","retry":"reconcile"},{"key":"verify_report","retry":"idempotent"}]'::jsonb);
  update public.supervisor_runs set execution_version=2,input_locale=p_locale,
    input_attachment_ids=p_attachment_ids where id=(v_started->>'id')::uuid returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.supervisor_admit_owner_run_v2(uuid,uuid,uuid,uuid,text,text,uuid[]) from public,anon,authenticated;
grant execute on function public.supervisor_admit_owner_run_v2(uuid,uuid,uuid,uuid,text,text,uuid[]) to service_role;

-- Only a live scoped lease can advance a checkpoint. A receipt is a compact
-- canonical reference, not a prompt, tool output blob, credential or raw file.
-- Trusted server callers must classify reads and verify effect receipts through
-- the existing effect gateway BEFORE marking an operation complete.
create function public.supervisor_checkpoint_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_operation uuid,p_action text,p_tool text,p_receipt_ref text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_phase text;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_operation is null or p_expected_seq is null
    or p_action is null or p_action not in ('begin_provider','begin_read','begin_effect','complete')
    then raise exception 'checkpoint_invalid' using errcode='42501'; end if;
  select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
    and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
  if not found or r.execution_version<>2 or r.status<>'running'
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then raise exception 'checkpoint_run_unavailable' using errcode='42501'; end if;
  select * into s from public.supervisor_run_steps where business_id=p_business_id
    and run_id=p_run_id and step_key='owner_turn' for update;
  v_now:=clock_timestamp();
  if not found or s.status<>'leased' or s.lease_until<=v_now
    or s.claim_token is distinct from p_claim_token or s.checkpoint_seq<>p_expected_seq
    then raise exception 'checkpoint_claim_conflict' using errcode='40001'; end if;
  if p_action='complete' then
    if s.checkpoint_phase='ready' or s.checkpoint_operation is distinct from p_operation
      or p_tool is not null or p_receipt_ref is null
      or (p_receipt_ref !~ '^[a-z][a-z0-9_]{0,39}:[a-zA-Z0-9_:-]{1,160}$'
        and p_receipt_ref !~ '^purchase_batch:[a-f0-9-]{36}(,[a-f0-9-]{36}){0,9}$')
      then raise exception 'checkpoint_receipt_invalid' using errcode='22023'; end if;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_progress_count=checkpoint_progress_count+case
        when checkpoint_phase='effect_pending' then 1
        when checkpoint_phase='read_pending' and p_receipt_ref ~ '^read:[a-f0-9]{32}_[a-f0-9]{64}$'
          and not exists(select 1 from jsonb_array_elements(checkpoint_receipts) e
             where e->>'phase'='read_pending' and split_part(e->>'receipt','_',1)=split_part(p_receipt_ref,'_',1)) then 1
        else 0 end,
      checkpoint_receipts=checkpoint_receipts||jsonb_build_array(jsonb_build_object(
        'operation',p_operation,'phase',checkpoint_phase,'tool',checkpoint_tool,'receipt',p_receipt_ref)),
      checkpoint_phase='ready',checkpoint_operation=null,checkpoint_tool=null,updated_at=v_now
      where id=s.id returning * into s;
  else
    if s.checkpoint_phase<>'ready' or p_receipt_ref is not null
      or (p_action='begin_provider' and p_tool is not null)
      or (p_action<>'begin_provider' and (p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,79}$'))
      or exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
        where e->>'operation'=p_operation::text)
      then raise exception 'checkpoint_operation_conflict' using errcode='22023'; end if;
    v_phase:=case p_action when 'begin_provider' then 'provider_pending'
      when 'begin_read' then 'read_pending' else 'effect_pending' end;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_phase=v_phase,checkpoint_operation=p_operation,checkpoint_tool=p_tool,updated_at=v_now
      where id=s.id returning * into s;
  end if;
  update public.supervisor_runs set updated_at=v_now where id=r.id;
  return to_jsonb(s);
end $$;
revoke all on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;

-- Yield only a non-effect/verified boundary. Retain the exact pending operation
-- for replacement workers; an unknown effect must remain in reconciliation.
create function public.supervisor_yield_owner_run_v2(
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
      when p_yield_kind='technical' and checkpoint_progress_count>checkpoint_slice_progress then 0
      else checkpoint_retry_count end where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) to service_role;

-- Replace only the active claim function, retaining version-1 behavior.
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
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and s.checkpoint_phase in ('ready','provider_pending','read_pending')) then
    update public.supervisor_run_steps set status = 'blocked', error_code = case when r.execution_version=2 and s.checkpoint_phase='effect_pending' then 'effect_uncertain' else 'lease_expired' end,
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if (r.execution_version=2 and s.step_key='owner_turn' and s.checkpoint_retry_count>=5)
    or ((r.execution_version<>2 or s.step_key<>'owner_turn') and s.retry_mode='idempotent' and s.attempts>=5) then
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


-- Do not acknowledge a final owner turn while a checkpoint operation is open.
create or replace function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_result_ref is null or char_length(p_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status in ('completed', 'blocked') then raise exception 'run_unavailable'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.claim_token is distinct from p_claim_token
    then raise exception 'step_claim_conflict'; end if;
  if r.execution_version=2 and p_step_key='owner_turn' and
    (s.checkpoint_phase<>'ready' or
     not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) or
     not exists(select 1 from public.ai_messages m where m.id::text=p_result_ref
       and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
       and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
       and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= clock_timestamp()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_verified_result_ref is null or char_length(p_verified_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status <> 'blocked' then raise exception 'run_not_blocked'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.status <> 'blocked' or s.retry_mode <> 'reconcile'
    then raise exception 'step_not_reconcilable'; end if;
  if r.execution_version=2 and s.checkpoint_phase<>'ready'
    then raise exception 'checkpoint_operation_unreconciled'; end if;
  -- Canonical owner turns may recover only an uncertain result and only with
  -- the exact persisted scoped reply. A reply never proves an external effect.
  if p_step_key='owner_turn' and (s.error_code is null or s.error_code not in ('lease_expired','turn_failed')
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id::text=p_verified_result_ref
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
      and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
      and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- Use the same job table and its existing unique running-thread index. The
-- v2 job lease belongs to the scoped owner_turn step, not to an untrusted
-- browser or a second worker. Old job RPCs cannot finish/restart its row.
alter table public.ai_agent_jobs add column durable_run_id uuid,
 add column durable_claim_token uuid;
-- New private column is not returned to the browser by the existing job API.
-- Owner-facing readers need the linked run ID, not the execution credential.
revoke select on public.ai_agent_jobs from authenticated;
grant select(id,business_id,owner_user_id,thread_id,owner_message_id,status,attempt,
 error_code,reply_message_id,progress,inbox,consumed,heartbeat_at,created_at,
 updated_at,finished_at,durable_run_id) on public.ai_agent_jobs to authenticated;

create function public.supervisor_owner_job_fence_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns boolean language sql security invoker set search_path=public as $$
 select coalesce(auth.role(),'')='service_role'
  and public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  and exists(select 1 from public.supervisor_runs r join public.supervisor_run_steps s
    on s.business_id=r.business_id and s.run_id=r.id
    where r.id=p_run_id and r.business_id=p_business_id
     and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
     and r.execution_version=2 and r.status='running' and s.step_key='owner_turn'
     and s.status='leased' and s.claim_token=p_claim_token and s.lease_until>clock_timestamp());
$$;
revoke all on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.supervisor_start_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;other public.ai_agent_jobs;v_attempt bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select attempts into v_attempt from public.supervisor_run_steps where run_id=r.id
   and business_id=r.business_id and step_key='owner_turn' for update;
 -- Strict ordering between durable owner messages in this thread.
 if exists(select 1 from public.supervisor_runs earlier where earlier.business_id=r.business_id
   and earlier.owner_user_id=r.owner_user_id and earlier.thread_id=r.thread_id
   and earlier.execution_version=2 and earlier.status in ('pending','running')
   and (earlier.created_at,earlier.id)<(r.created_at,r.id)) then return null; end if;
 select * into j from public.ai_agent_jobs where owner_message_id=r.request_key for update;
 if found and (j.durable_run_id is distinct from r.id or j.business_id<>r.business_id
   or j.owner_user_id<>r.owner_user_id or j.thread_id<>r.thread_id)
   then raise exception 'durable_job_conflict'; end if;
 if j.status='done' then return to_jsonb(j)-'durable_claim_token'; end if;
 select * into other from public.ai_agent_jobs where thread_id=r.thread_id and status='running'
   and id is distinct from j.id for update;
 if found then
   -- Do not absorb another owner's message or revive an uncertain legacy turn.
   if other.durable_run_id is not null then
     if exists(select 1 from public.supervisor_runs other_run where other_run.id=other.durable_run_id
       and other_run.business_id=r.business_id and other_run.owner_user_id=r.owner_user_id
       and other_run.thread_id=r.thread_id and other_run.status in ('pending','running'))
       then return null; end if;
   elsif other.heartbeat_at>=clock_timestamp()-interval '180 seconds' then return null; end if;
   update public.ai_agent_jobs set status='failed',error_code='timeout',finished_at=clock_timestamp(),
     updated_at=clock_timestamp() where id=other.id;
 end if;
 if j.id is null then
   insert into public.ai_agent_jobs(business_id,owner_user_id,thread_id,owner_message_id,durable_run_id,durable_claim_token)
     values(r.business_id,r.owner_user_id,r.thread_id,r.request_key,r.id,p_claim_token)
     returning * into j;
 else
   update public.ai_agent_jobs set status='running',attempt=least(5,greatest(attempt,v_attempt)),
     durable_claim_token=p_claim_token,error_code=null,finished_at=null,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
     where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'durable_claim_token';
end $$;
revoke all on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Single fenced status/progress writer. An expired worker cannot change the
-- replacement job. Terminal success checks a canonical scoped reply, not text.
create function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=case when jsonb_array_length(progress)<12
     then progress||jsonb_build_array(p_step) else progress end where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
end $$;
revoke all on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) to service_role;

create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and r.request_key=p_owner_message_id and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running' and durable_run_id is null;
end $$;
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' or j.durable_run_id is not null then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text,
  p_absorbed_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.durable_run_id is not null then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  -- Only IDs observed by a completed model response and persisted to the reply
  -- are acknowledged. A timed-out inbox RPC or model failure cannot claim them.
  if p_status = 'done' and (
      cardinality(coalesce(p_absorbed_ids, '{}'::uuid[])) > 5 or
      not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)
  ) then raise exception 'invalid_absorbed_ids'; end if;
  update public.ai_agent_jobs
     set consumed = case when p_status = 'done'
                         then coalesce(p_absorbed_ids, '{}'::uuid[])
                         else '{}'::uuid[] end,
         status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

-- Final reply and job completion are one scoped transaction. A process killed
-- after the insert cannot leave a canonical answer with an orphan job. Do not
-- allow incomplete or ungrounded slices to occupy the immutable final reply.
create function public.supervisor_publish_owner_reply_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or coalesce(p_grounding->>'status','') not in ('verified','partial','unavailable','insufficient_evidence','estimated')
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
 -- A completed attempt may have honestly reported missing evidence. Save
 -- that report, but do not acknowledge successful completion or re-spend
 -- tokens indefinitely seeking data which does not exist.
 if m.grounding->>'status'<>'verified' then
   update public.supervisor_run_steps set status='blocked',error_code='report_incomplete',
     claim_token=null,worker_id=null,lease_until=null,updated_at=clock_timestamp() where id=s.id;
   update public.supervisor_runs set status='blocked',updated_at=clock_timestamp() where id=r.id;
 end if;
 return to_jsonb(m);
end $$;
revoke all on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- A clarification is an intermediate receipt, not the final canonical reply.
-- Only an authenticated, explicitly matched answer can wake the same run.
alter table public.supervisor_runs add column awaiting_question_id uuid,
  add column answered_question_ids uuid[] not null default '{}',
  add column owner_answer_ids uuid[] not null default '{}';
create function public.supervisor_publish_owner_question_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
end $$;
revoke all on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.supervisor_answer_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;q public.ai_messages;a public.ai_messages;v_index integer;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
   and grounding->>'status'='requires_owner_input' and grounding->>'durableQuestionId'=id::text;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner' and content_type='text'
   and created_at>=q.created_at;
 if not found then raise exception 'owner_answer_unavailable' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id::text=q.grounding->>'durableRunId'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and execution_version=2 and request_key::text=q.grounding->>'ownerMessageId' for update;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 v_index:=array_position(r.answered_question_ids,p_question_id);
 if v_index is not null then
   if r.owner_answer_ids[v_index] is distinct from p_answer_id then
     raise exception 'owner_question_already_answered' using errcode='23505'; end if;
   return to_jsonb(r);
 end if;
 if r.status<>'blocked' or r.awaiting_question_id is distinct from p_question_id
   or cardinality(r.owner_answer_ids)>=20 or p_answer_id=any(r.owner_answer_ids)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
     and x.owner_user_id=p_owner_user_id and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
   then raise exception 'owner_question_stale' using errcode='23505'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and step_key='owner_turn' for update;
 if not found or s.status<>'blocked' or s.error_code is distinct from 'awaiting_owner'
   or s.checkpoint_phase<>'ready' then raise exception 'owner_question_stale' using errcode='23505'; end if;
 update public.supervisor_run_steps set status='pending',error_code=null,next_retry_at=null,
   checkpoint_retry_count=0,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='pending',awaiting_question_id=null,
   answered_question_ids=answered_question_ids||p_question_id,owner_answer_ids=owner_answer_ids||p_answer_id,
   dispatch_after=null,updated_at=clock_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

        and p_receipt_ref !~ '^purchase_batch:[a-f0-9-]{36}(,[a-f0-9-]{36}){0,9}
      then raise exception 'checkpoint_receipt_invalid' using errcode='22023'; end if;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_receipts=checkpoint_receipts||jsonb_build_array(jsonb_build_object(
        'operation',p_operation,'phase',checkpoint_phase,'tool',checkpoint_tool,'receipt',p_receipt_ref)),
      checkpoint_phase='ready',checkpoint_operation=null,checkpoint_tool=null,updated_at=v_now
      where id=s.id returning * into s;
  else
    if s.checkpoint_phase<>'ready' or p_receipt_ref is not null
      or (p_action='begin_provider' and p_tool is not null)
      or (p_action<>'begin_provider' and (p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,79}$'))
      or exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
        where e->>'operation'=p_operation::text)
      then raise exception 'checkpoint_operation_conflict' using errcode='22023'; end if;
    v_phase:=case p_action when 'begin_provider' then 'provider_pending'
      when 'begin_read' then 'read_pending' else 'effect_pending' end;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_phase=v_phase,checkpoint_operation=p_operation,checkpoint_tool=p_tool,updated_at=v_now
      where id=s.id returning * into s;
  end if;
  update public.supervisor_runs set updated_at=v_now where id=r.id;
  return to_jsonb(s);
end $$;
revoke all on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;

-- Yield only a non-effect/verified boundary. Retain the exact pending operation
-- for replacement workers; an unknown effect must remain in reconciliation.
create function public.supervisor_yield_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_delay_seconds integer
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_due timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_delay_seconds is null
    or p_delay_seconds not between 15 and 900 or p_expected_seq is null
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
    lease_until=null,next_retry_at=v_due,updated_at=v_now where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) to service_role;

-- Replace only the active claim function, retaining version-1 behavior.
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
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and s.checkpoint_phase in ('ready','provider_pending','read_pending')) then
    update public.supervisor_run_steps set status = 'blocked', error_code = 'lease_expired',
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if (s.retry_mode='idempotent' or r.execution_version=2) and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, next_retry_at=null, updated_at = v_now
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;


-- Do not acknowledge a final owner turn while a checkpoint operation is open.
create or replace function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_result_ref is null or char_length(p_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status in ('completed', 'blocked') then raise exception 'run_unavailable'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.claim_token is distinct from p_claim_token
    then raise exception 'step_claim_conflict'; end if;
  if r.execution_version=2 and p_step_key='owner_turn' and
    (s.checkpoint_phase<>'ready' or
     not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) or
     not exists(select 1 from public.ai_messages m where m.id::text=p_result_ref
       and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
       and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
       and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= clock_timestamp()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_verified_result_ref is null or char_length(p_verified_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status <> 'blocked' then raise exception 'run_not_blocked'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.status <> 'blocked' or s.retry_mode <> 'reconcile'
    then raise exception 'step_not_reconcilable'; end if;
  if r.execution_version=2 and s.checkpoint_phase<>'ready'
    then raise exception 'checkpoint_operation_unreconciled'; end if;
  -- Canonical owner turns may recover only an uncertain result and only with
  -- the exact persisted scoped reply. A reply never proves an external effect.
  if p_step_key='owner_turn' and (s.error_code is null or s.error_code not in ('lease_expired','turn_failed')
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id::text=p_verified_result_ref
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
      and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
      and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- Use the same job table and its existing unique running-thread index. The
-- v2 job lease belongs to the scoped owner_turn step, not to an untrusted
-- browser or a second worker. Old job RPCs cannot finish/restart its row.
alter table public.ai_agent_jobs add column durable_run_id uuid,
 add column durable_claim_token uuid;
-- New private column is not returned to the browser by the existing job API.
-- Owner-facing readers need the linked run ID, not the execution credential.
revoke select on public.ai_agent_jobs from authenticated;
grant select(id,business_id,owner_user_id,thread_id,owner_message_id,status,attempt,
 error_code,reply_message_id,progress,inbox,consumed,heartbeat_at,created_at,
 updated_at,finished_at,durable_run_id) on public.ai_agent_jobs to authenticated;

create function public.supervisor_owner_job_fence_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns boolean language sql security invoker set search_path=public as $$
 select coalesce(auth.role(),'')='service_role'
  and public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  and exists(select 1 from public.supervisor_runs r join public.supervisor_run_steps s
    on s.business_id=r.business_id and s.run_id=r.id
    where r.id=p_run_id and r.business_id=p_business_id
     and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
     and r.execution_version=2 and r.status='running' and s.step_key='owner_turn'
     and s.status='leased' and s.claim_token=p_claim_token and s.lease_until>clock_timestamp());
$$;
revoke all on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.supervisor_start_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;other public.ai_agent_jobs;v_attempt bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select attempts into v_attempt from public.supervisor_run_steps where run_id=r.id
   and business_id=r.business_id and step_key='owner_turn' for update;
 -- Strict ordering between durable owner messages in this thread.
 if exists(select 1 from public.supervisor_runs earlier where earlier.business_id=r.business_id
   and earlier.owner_user_id=r.owner_user_id and earlier.thread_id=r.thread_id
   and earlier.execution_version=2 and earlier.status in ('pending','running')
   and (earlier.created_at,earlier.id)<(r.created_at,r.id)) then return null; end if;
 select * into j from public.ai_agent_jobs where owner_message_id=r.request_key for update;
 if found and (j.durable_run_id is distinct from r.id or j.business_id<>r.business_id
   or j.owner_user_id<>r.owner_user_id or j.thread_id<>r.thread_id)
   then raise exception 'durable_job_conflict'; end if;
 if j.status='done' then return to_jsonb(j)-'durable_claim_token'; end if;
 select * into other from public.ai_agent_jobs where thread_id=r.thread_id and status='running'
   and id is distinct from j.id for update;
 if found then
   -- Do not absorb another owner's message or revive an uncertain legacy turn.
   if other.durable_run_id is not null then
     if exists(select 1 from public.supervisor_runs other_run where other_run.id=other.durable_run_id
       and other_run.business_id=r.business_id and other_run.owner_user_id=r.owner_user_id
       and other_run.thread_id=r.thread_id and other_run.status in ('pending','running'))
       then return null; end if;
   elsif other.heartbeat_at>=clock_timestamp()-interval '180 seconds' then return null; end if;
   update public.ai_agent_jobs set status='failed',error_code='timeout',finished_at=clock_timestamp(),
     updated_at=clock_timestamp() where id=other.id;
 end if;
 if j.id is null then
   insert into public.ai_agent_jobs(business_id,owner_user_id,thread_id,owner_message_id,durable_run_id,durable_claim_token)
     values(r.business_id,r.owner_user_id,r.thread_id,r.request_key,r.id,p_claim_token)
     returning * into j;
 else
   update public.ai_agent_jobs set status='running',attempt=least(5,greatest(attempt,v_attempt)),
     durable_claim_token=p_claim_token,error_code=null,finished_at=null,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
     where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'durable_claim_token';
end $$;
revoke all on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Single fenced status/progress writer. An expired worker cannot change the
-- replacement job. Terminal success checks a canonical scoped reply, not text.
create function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=case when jsonb_array_length(progress)<12
     then progress||jsonb_build_array(p_step) else progress end where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
end $$;
revoke all on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) to service_role;

create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and r.request_key=p_owner_message_id and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running' and durable_run_id is null;
end $$;
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' or j.durable_run_id is not null then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text,
  p_absorbed_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.durable_run_id is not null then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  -- Only IDs observed by a completed model response and persisted to the reply
  -- are acknowledged. A timed-out inbox RPC or model failure cannot claim them.
  if p_status = 'done' and (
      cardinality(coalesce(p_absorbed_ids, '{}'::uuid[])) > 5 or
      not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)
  ) then raise exception 'invalid_absorbed_ids'; end if;
  update public.ai_agent_jobs
     set consumed = case when p_status = 'done'
                         then coalesce(p_absorbed_ids, '{}'::uuid[])
                         else '{}'::uuid[] end,
         status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

-- Final reply and job completion are one scoped transaction. A process killed
-- after the insert cannot leave a canonical answer with an orphan job. Do not
-- allow incomplete or ungrounded slices to occupy the immutable final reply.
create function public.supervisor_publish_owner_reply_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or p_grounding->>'status' is distinct from 'verified'
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'='verified'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 return to_jsonb(m);
end $$;
revoke all on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- A clarification is an intermediate receipt, not the final canonical reply.
-- Only an authenticated, explicitly matched answer can wake the same run.
alter table public.supervisor_runs add column awaiting_question_id uuid,
  add column answered_question_ids uuid[] not null default '{}',
  add column owner_answer_ids uuid[] not null default '{}';
create function public.supervisor_publish_owner_question_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
end $$;
revoke all on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.supervisor_answer_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;q public.ai_messages;a public.ai_messages;v_index integer;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501'; end if;
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
   and grounding->>'status'='requires_owner_input' and grounding->>'durableQuestionId'=id::text;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner' and content_type='text'
   and created_at>=q.created_at;
 if not found then raise exception 'owner_answer_unavailable' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id::text=q.grounding->>'durableRunId'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and execution_version=2 and request_key::text=q.grounding->>'ownerMessageId' for update;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 v_index:=array_position(r.answered_question_ids,p_question_id);
 if v_index is not null then
   if r.owner_answer_ids[v_index] is distinct from p_answer_id then
     raise exception 'owner_question_already_answered' using errcode='23505'; end if;
   return to_jsonb(r);
 end if;
 if r.status<>'blocked' or r.awaiting_question_id is distinct from p_question_id
   or cardinality(r.owner_answer_ids)>=20 or p_answer_id=any(r.owner_answer_ids)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
     and x.owner_user_id=p_owner_user_id and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
   then raise exception 'owner_question_stale' using errcode='23505'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and step_key='owner_turn' for update;
 if not found or s.status<>'blocked' or s.error_code is distinct from 'awaiting_owner'
   or s.checkpoint_phase<>'ready' then raise exception 'owner_question_stale' using errcode='23505'; end if;
 update public.supervisor_run_steps set status='pending',error_code=null,next_retry_at=null,
   attempts=0,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='pending',awaiting_question_id=null,
   answered_question_ids=answered_question_ids||p_question_id,owner_answer_ids=owner_answer_ids||p_answer_id,
   dispatch_after=null,updated_at=clock_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) to service_role;
)
      then raise exception 'checkpoint_receipt_invalid' using errcode='22023'; end if;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_receipts=checkpoint_receipts||jsonb_build_array(jsonb_build_object(
        'operation',p_operation,'phase',checkpoint_phase,'tool',checkpoint_tool,'receipt',p_receipt_ref)),
      checkpoint_phase='ready',checkpoint_operation=null,checkpoint_tool=null,updated_at=v_now
      where id=s.id returning * into s;
  else
    if s.checkpoint_phase<>'ready' or p_receipt_ref is not null
      or (p_action='begin_provider' and p_tool is not null)
      or (p_action<>'begin_provider' and (p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,79}$'))
      or exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
        where e->>'operation'=p_operation::text)
      then raise exception 'checkpoint_operation_conflict' using errcode='22023'; end if;
    v_phase:=case p_action when 'begin_provider' then 'provider_pending'
      when 'begin_read' then 'read_pending' else 'effect_pending' end;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_phase=v_phase,checkpoint_operation=p_operation,checkpoint_tool=p_tool,updated_at=v_now
      where id=s.id returning * into s;
  end if;
  update public.supervisor_runs set updated_at=v_now where id=r.id;
  return to_jsonb(s);
end $$;
revoke all on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;

-- Yield only a non-effect/verified boundary. Retain the exact pending operation
-- for replacement workers; an unknown effect must remain in reconciliation.
create function public.supervisor_yield_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_delay_seconds integer
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_due timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_delay_seconds is null
    or p_delay_seconds not between 15 and 900 or p_expected_seq is null
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
    lease_until=null,next_retry_at=v_due,updated_at=v_now where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) to service_role;

-- Replace only the active claim function, retaining version-1 behavior.
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
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and s.checkpoint_phase in ('ready','provider_pending','read_pending')) then
    update public.supervisor_run_steps set status = 'blocked', error_code = 'lease_expired',
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if (s.retry_mode='idempotent' or r.execution_version=2) and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, next_retry_at=null, updated_at = v_now
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;


-- Do not acknowledge a final owner turn while a checkpoint operation is open.
create or replace function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_result_ref is null or char_length(p_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status in ('completed', 'blocked') then raise exception 'run_unavailable'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.claim_token is distinct from p_claim_token
    then raise exception 'step_claim_conflict'; end if;
  if r.execution_version=2 and p_step_key='owner_turn' and
    (s.checkpoint_phase<>'ready' or
     not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) or
     not exists(select 1 from public.ai_messages m where m.id::text=p_result_ref
       and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
       and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
       and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= clock_timestamp()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_verified_result_ref is null or char_length(p_verified_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status <> 'blocked' then raise exception 'run_not_blocked'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.status <> 'blocked' or s.retry_mode <> 'reconcile'
    then raise exception 'step_not_reconcilable'; end if;
  if r.execution_version=2 and s.checkpoint_phase<>'ready'
    then raise exception 'checkpoint_operation_unreconciled'; end if;
  -- Canonical owner turns may recover only an uncertain result and only with
  -- the exact persisted scoped reply. A reply never proves an external effect.
  if p_step_key='owner_turn' and (s.error_code is null or s.error_code not in ('lease_expired','turn_failed')
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id::text=p_verified_result_ref
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
      and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
      and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- Use the same job table and its existing unique running-thread index. The
-- v2 job lease belongs to the scoped owner_turn step, not to an untrusted
-- browser or a second worker. Old job RPCs cannot finish/restart its row.
alter table public.ai_agent_jobs add column durable_run_id uuid,
 add column durable_claim_token uuid;
-- New private column is not returned to the browser by the existing job API.
-- Owner-facing readers need the linked run ID, not the execution credential.
revoke select on public.ai_agent_jobs from authenticated;
grant select(id,business_id,owner_user_id,thread_id,owner_message_id,status,attempt,
 error_code,reply_message_id,progress,inbox,consumed,heartbeat_at,created_at,
 updated_at,finished_at,durable_run_id) on public.ai_agent_jobs to authenticated;

create function public.supervisor_owner_job_fence_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns boolean language sql security invoker set search_path=public as $$
 select coalesce(auth.role(),'')='service_role'
  and public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  and exists(select 1 from public.supervisor_runs r join public.supervisor_run_steps s
    on s.business_id=r.business_id and s.run_id=r.id
    where r.id=p_run_id and r.business_id=p_business_id
     and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
     and r.execution_version=2 and r.status='running' and s.step_key='owner_turn'
     and s.status='leased' and s.claim_token=p_claim_token and s.lease_until>clock_timestamp());
$$;
revoke all on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.supervisor_start_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;other public.ai_agent_jobs;v_attempt bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select attempts into v_attempt from public.supervisor_run_steps where run_id=r.id
   and business_id=r.business_id and step_key='owner_turn' for update;
 -- Strict ordering between durable owner messages in this thread.
 if exists(select 1 from public.supervisor_runs earlier where earlier.business_id=r.business_id
   and earlier.owner_user_id=r.owner_user_id and earlier.thread_id=r.thread_id
   and earlier.execution_version=2 and earlier.status in ('pending','running')
   and (earlier.created_at,earlier.id)<(r.created_at,r.id)) then return null; end if;
 select * into j from public.ai_agent_jobs where owner_message_id=r.request_key for update;
 if found and (j.durable_run_id is distinct from r.id or j.business_id<>r.business_id
   or j.owner_user_id<>r.owner_user_id or j.thread_id<>r.thread_id)
   then raise exception 'durable_job_conflict'; end if;
 if j.status='done' then return to_jsonb(j)-'durable_claim_token'; end if;
 select * into other from public.ai_agent_jobs where thread_id=r.thread_id and status='running'
   and id is distinct from j.id for update;
 if found then
   -- Do not absorb another owner's message or revive an uncertain legacy turn.
   if other.durable_run_id is not null then
     if exists(select 1 from public.supervisor_runs other_run where other_run.id=other.durable_run_id
       and other_run.business_id=r.business_id and other_run.owner_user_id=r.owner_user_id
       and other_run.thread_id=r.thread_id and other_run.status in ('pending','running'))
       then return null; end if;
   elsif other.heartbeat_at>=clock_timestamp()-interval '180 seconds' then return null; end if;
   update public.ai_agent_jobs set status='failed',error_code='timeout',finished_at=clock_timestamp(),
     updated_at=clock_timestamp() where id=other.id;
 end if;
 if j.id is null then
   insert into public.ai_agent_jobs(business_id,owner_user_id,thread_id,owner_message_id,durable_run_id,durable_claim_token)
     values(r.business_id,r.owner_user_id,r.thread_id,r.request_key,r.id,p_claim_token)
     returning * into j;
 else
   update public.ai_agent_jobs set status='running',attempt=least(5,greatest(attempt,v_attempt)),
     durable_claim_token=p_claim_token,error_code=null,finished_at=null,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
     where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'durable_claim_token';
end $$;
revoke all on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Single fenced status/progress writer. An expired worker cannot change the
-- replacement job. Terminal success checks a canonical scoped reply, not text.
create function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=case when jsonb_array_length(progress)<12
     then progress||jsonb_build_array(p_step) else progress end where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
end $$;
revoke all on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) to service_role;

create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and r.request_key=p_owner_message_id and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running' and durable_run_id is null;
end $$;
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' or j.durable_run_id is not null then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text,
  p_absorbed_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.durable_run_id is not null then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  -- Only IDs observed by a completed model response and persisted to the reply
  -- are acknowledged. A timed-out inbox RPC or model failure cannot claim them.
  if p_status = 'done' and (
      cardinality(coalesce(p_absorbed_ids, '{}'::uuid[])) > 5 or
      not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)
  ) then raise exception 'invalid_absorbed_ids'; end if;
  update public.ai_agent_jobs
     set consumed = case when p_status = 'done'
                         then coalesce(p_absorbed_ids, '{}'::uuid[])
                         else '{}'::uuid[] end,
         status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

-- Final reply and job completion are one scoped transaction. A process killed
-- after the insert cannot leave a canonical answer with an orphan job. Do not
-- allow incomplete or ungrounded slices to occupy the immutable final reply.
create function public.supervisor_publish_owner_reply_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or p_grounding->>'status' is distinct from 'verified'
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'='verified'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 return to_jsonb(m);
end $$;
revoke all on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- A clarification is an intermediate receipt, not the final canonical reply.
-- Only an authenticated, explicitly matched answer can wake the same run.
alter table public.supervisor_runs add column awaiting_question_id uuid,
  add column answered_question_ids uuid[] not null default '{}',
  add column owner_answer_ids uuid[] not null default '{}';
create function public.supervisor_publish_owner_question_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
end $$;
revoke all on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.supervisor_answer_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;q public.ai_messages;a public.ai_messages;v_index integer;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501'; end if;
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
   and grounding->>'status'='requires_owner_input' and grounding->>'durableQuestionId'=id::text;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner' and content_type='text'
   and created_at>=q.created_at;
 if not found then raise exception 'owner_answer_unavailable' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id::text=q.grounding->>'durableRunId'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and execution_version=2 and request_key::text=q.grounding->>'ownerMessageId' for update;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 v_index:=array_position(r.answered_question_ids,p_question_id);
 if v_index is not null then
   if r.owner_answer_ids[v_index] is distinct from p_answer_id then
     raise exception 'owner_question_already_answered' using errcode='23505'; end if;
   return to_jsonb(r);
 end if;
 if r.status<>'blocked' or r.awaiting_question_id is distinct from p_question_id
   or cardinality(r.owner_answer_ids)>=20 or p_answer_id=any(r.owner_answer_ids)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
     and x.owner_user_id=p_owner_user_id and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
   then raise exception 'owner_question_stale' using errcode='23505'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and step_key='owner_turn' for update;
 if not found or s.status<>'blocked' or s.error_code is distinct from 'awaiting_owner'
   or s.checkpoint_phase<>'ready' then raise exception 'owner_question_stale' using errcode='23505'; end if;
 update public.supervisor_run_steps set status='pending',error_code=null,next_retry_at=null,
   attempts=0,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='pending',awaiting_question_id=null,
   answered_question_ids=answered_question_ids||p_question_id,owner_answer_ids=owner_answer_ids||p_answer_id,
   dispatch_after=null,updated_at=clock_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Explicit authenticated owner cancellation uses the existing run/step locks.
-- It is deliberately not the worker's token-based stop RPC: an owner may
-- stop a live worker, but cannot claim an in-flight effect was undone.
create function public.supervisor_cancel_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid
) returns text language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_code text;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_run_cancel_denied' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and execution_version=2 for update;
 if not found then return 'not_found'; end if;
 if r.status='completed' or exists(select 1 from public.ai_agent_jobs j
   where j.durable_run_id=r.id and j.business_id=r.business_id and j.owner_user_id=r.owner_user_id
    and j.thread_id=r.thread_id and j.status='done' and j.reply_message_id is not null)
    then return 'completed'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and status<>'completed' order by step_index limit 1 for update;
 if not found then return 'completed'; end if;
 if r.status='blocked' and s.error_code not in ('awaiting_owner','cancelled','cancelled_effect_uncertain','effect_uncertain','lease_expired','turn_failed')
   then return 'blocked'; end if;
 v_code:=case when s.checkpoint_phase='effect_pending' or s.error_code in ('effect_uncertain','cancelled_effect_uncertain')
   then 'cancelled_effect_uncertain' else 'cancelled' end;
 v_now:=clock_timestamp();
 update public.supervisor_run_steps set status='blocked',error_code=v_code,worker_id=null,
   claim_token=null,lease_until=null,next_retry_at=null,updated_at=v_now where id=s.id;
 update public.supervisor_runs set status='blocked',awaiting_question_id=null,
   dispatch_after=null,updated_at=v_now where id=r.id;
 update public.ai_agent_jobs set status='failed',error_code=v_code,finished_at=v_now,
   updated_at=v_now,durable_claim_token=null where durable_run_id=r.id
   and business_id=r.business_id and owner_user_id=r.owner_user_id and thread_id=r.thread_id
   and status='running';
 return case when v_code='cancelled' then 'cancelled' else 'uncertain' end;
end $$;
revoke all on function public.supervisor_cancel_owner_run_v2(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_cancel_owner_run_v2(uuid,uuid,uuid,uuid) to service_role;

          and not exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
            where e->>'phase'='read_pending' and split_part(e->>'receipt','_',1)=split_part(p_receipt_ref,'_',1)) then 1
        else 0 end,
      checkpoint_receipts=checkpoint_receipts||jsonb_build_array(jsonb_build_object(
        'operation',p_operation,'phase',checkpoint_phase,'tool',checkpoint_tool,'receipt',p_receipt_ref)),
      checkpoint_phase='ready',checkpoint_operation=null,checkpoint_tool=null,updated_at=v_now
      where id=s.id returning * into s;
  else
    if s.checkpoint_phase<>'ready' or p_receipt_ref is not null
      or (p_action='begin_provider' and p_tool is not null)
      or (p_action<>'begin_provider' and (p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,79}$'))
      or exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
        where e->>'operation'=p_operation::text)
      then raise exception 'checkpoint_operation_conflict' using errcode='22023'; end if;
    v_phase:=case p_action when 'begin_provider' then 'provider_pending'
      when 'begin_read' then 'read_pending' else 'effect_pending' end;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_phase=v_phase,checkpoint_operation=p_operation,checkpoint_tool=p_tool,updated_at=v_now
      where id=s.id returning * into s;
  end if;
  update public.supervisor_runs set updated_at=v_now where id=r.id;
  return to_jsonb(s);
end $$;
revoke all on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;

-- Yield only a non-effect/verified boundary. Retain the exact pending operation
-- for replacement workers; an unknown effect must remain in reconciliation.
create function public.supervisor_yield_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_delay_seconds integer
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_due timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_delay_seconds is null
    or p_delay_seconds not between 15 and 900 or p_expected_seq is null
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
    lease_until=null,next_retry_at=v_due,updated_at=v_now where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) to service_role;

-- Replace only the active claim function, retaining version-1 behavior.
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
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and s.checkpoint_phase in ('ready','provider_pending','read_pending')) then
    update public.supervisor_run_steps set status = 'blocked', error_code = case when r.execution_version=2 and s.checkpoint_phase='effect_pending' then 'effect_uncertain' else 'lease_expired' end,
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if (s.retry_mode='idempotent' or r.execution_version=2) and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, next_retry_at=null, updated_at = v_now
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;


-- Do not acknowledge a final owner turn while a checkpoint operation is open.
create or replace function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_result_ref is null or char_length(p_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status in ('completed', 'blocked') then raise exception 'run_unavailable'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.claim_token is distinct from p_claim_token
    then raise exception 'step_claim_conflict'; end if;
  if r.execution_version=2 and p_step_key='owner_turn' and
    (s.checkpoint_phase<>'ready' or
     not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) or
     not exists(select 1 from public.ai_messages m where m.id::text=p_result_ref
       and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
       and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
       and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= clock_timestamp()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_verified_result_ref is null or char_length(p_verified_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status <> 'blocked' then raise exception 'run_not_blocked'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.status <> 'blocked' or s.retry_mode <> 'reconcile'
    then raise exception 'step_not_reconcilable'; end if;
  if r.execution_version=2 and s.checkpoint_phase<>'ready'
    then raise exception 'checkpoint_operation_unreconciled'; end if;
  -- Canonical owner turns may recover only an uncertain result and only with
  -- the exact persisted scoped reply. A reply never proves an external effect.
  if p_step_key='owner_turn' and (s.error_code is null or s.error_code not in ('lease_expired','turn_failed')
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id::text=p_verified_result_ref
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
      and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
      and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- Use the same job table and its existing unique running-thread index. The
-- v2 job lease belongs to the scoped owner_turn step, not to an untrusted
-- browser or a second worker. Old job RPCs cannot finish/restart its row.
alter table public.ai_agent_jobs add column durable_run_id uuid,
 add column durable_claim_token uuid;
-- New private column is not returned to the browser by the existing job API.
-- Owner-facing readers need the linked run ID, not the execution credential.
revoke select on public.ai_agent_jobs from authenticated;
grant select(id,business_id,owner_user_id,thread_id,owner_message_id,status,attempt,
 error_code,reply_message_id,progress,inbox,consumed,heartbeat_at,created_at,
 updated_at,finished_at,durable_run_id) on public.ai_agent_jobs to authenticated;

create function public.supervisor_owner_job_fence_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns boolean language sql security invoker set search_path=public as $$
 select coalesce(auth.role(),'')='service_role'
  and public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  and exists(select 1 from public.supervisor_runs r join public.supervisor_run_steps s
    on s.business_id=r.business_id and s.run_id=r.id
    where r.id=p_run_id and r.business_id=p_business_id
     and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
     and r.execution_version=2 and r.status='running' and s.step_key='owner_turn'
     and s.status='leased' and s.claim_token=p_claim_token and s.lease_until>clock_timestamp());
$$;
revoke all on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.supervisor_start_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;other public.ai_agent_jobs;v_attempt bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select attempts into v_attempt from public.supervisor_run_steps where run_id=r.id
   and business_id=r.business_id and step_key='owner_turn' for update;
 -- Strict ordering between durable owner messages in this thread.
 if exists(select 1 from public.supervisor_runs earlier where earlier.business_id=r.business_id
   and earlier.owner_user_id=r.owner_user_id and earlier.thread_id=r.thread_id
   and earlier.execution_version=2 and earlier.status in ('pending','running')
   and (earlier.created_at,earlier.id)<(r.created_at,r.id)) then return null; end if;
 select * into j from public.ai_agent_jobs where owner_message_id=r.request_key for update;
 if found and (j.durable_run_id is distinct from r.id or j.business_id<>r.business_id
   or j.owner_user_id<>r.owner_user_id or j.thread_id<>r.thread_id)
   then raise exception 'durable_job_conflict'; end if;
 if j.status='done' then return to_jsonb(j)-'durable_claim_token'; end if;
 select * into other from public.ai_agent_jobs where thread_id=r.thread_id and status='running'
   and id is distinct from j.id for update;
 if found then
   -- Do not absorb another owner's message or revive an uncertain legacy turn.
   if other.durable_run_id is not null then
     if exists(select 1 from public.supervisor_runs other_run where other_run.id=other.durable_run_id
       and other_run.business_id=r.business_id and other_run.owner_user_id=r.owner_user_id
       and other_run.thread_id=r.thread_id and other_run.status in ('pending','running'))
       then return null; end if;
   elsif other.heartbeat_at>=clock_timestamp()-interval '180 seconds' then return null; end if;
   update public.ai_agent_jobs set status='failed',error_code='timeout',finished_at=clock_timestamp(),
     updated_at=clock_timestamp() where id=other.id;
 end if;
 if j.id is null then
   insert into public.ai_agent_jobs(business_id,owner_user_id,thread_id,owner_message_id,durable_run_id,durable_claim_token)
     values(r.business_id,r.owner_user_id,r.thread_id,r.request_key,r.id,p_claim_token)
     returning * into j;
 else
   update public.ai_agent_jobs set status='running',attempt=least(5,greatest(attempt,v_attempt)),
     durable_claim_token=p_claim_token,error_code=null,finished_at=null,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
     where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'durable_claim_token';
end $$;
revoke all on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Single fenced status/progress writer. An expired worker cannot change the
-- replacement job. Terminal success checks a canonical scoped reply, not text.
create function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=case when jsonb_array_length(progress)<12
     then progress||jsonb_build_array(p_step) else progress end where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
end $$;
revoke all on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) to service_role;

create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and r.request_key=p_owner_message_id and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running' and durable_run_id is null;
end $$;
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' or j.durable_run_id is not null then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text,
  p_absorbed_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.durable_run_id is not null then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  -- Only IDs observed by a completed model response and persisted to the reply
  -- are acknowledged. A timed-out inbox RPC or model failure cannot claim them.
  if p_status = 'done' and (
      cardinality(coalesce(p_absorbed_ids, '{}'::uuid[])) > 5 or
      not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)
  ) then raise exception 'invalid_absorbed_ids'; end if;
  update public.ai_agent_jobs
     set consumed = case when p_status = 'done'
                         then coalesce(p_absorbed_ids, '{}'::uuid[])
                         else '{}'::uuid[] end,
         status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

-- Final reply and job completion are one scoped transaction. A process killed
-- after the insert cannot leave a canonical answer with an orphan job. Do not
-- allow incomplete or ungrounded slices to occupy the immutable final reply.
create function public.supervisor_publish_owner_reply_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or p_grounding->>'status' is distinct from 'verified'
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'='verified'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 return to_jsonb(m);
end $$;
revoke all on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- A clarification is an intermediate receipt, not the final canonical reply.
-- Only an authenticated, explicitly matched answer can wake the same run.
alter table public.supervisor_runs add column awaiting_question_id uuid,
  add column answered_question_ids uuid[] not null default '{}',
  add column owner_answer_ids uuid[] not null default '{}';
create function public.supervisor_publish_owner_question_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
end $$;
revoke all on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.supervisor_answer_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;q public.ai_messages;a public.ai_messages;v_index integer;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501'; end if;
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
   and grounding->>'status'='requires_owner_input' and grounding->>'durableQuestionId'=id::text;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner' and content_type='text'
   and created_at>=q.created_at;
 if not found then raise exception 'owner_answer_unavailable' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id::text=q.grounding->>'durableRunId'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and execution_version=2 and request_key::text=q.grounding->>'ownerMessageId' for update;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 v_index:=array_position(r.answered_question_ids,p_question_id);
 if v_index is not null then
   if r.owner_answer_ids[v_index] is distinct from p_answer_id then
     raise exception 'owner_question_already_answered' using errcode='23505'; end if;
   return to_jsonb(r);
 end if;
 if r.status<>'blocked' or r.awaiting_question_id is distinct from p_question_id
   or cardinality(r.owner_answer_ids)>=20 or p_answer_id=any(r.owner_answer_ids)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
     and x.owner_user_id=p_owner_user_id and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
   then raise exception 'owner_question_stale' using errcode='23505'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and step_key='owner_turn' for update;
 if not found or s.status<>'blocked' or s.error_code is distinct from 'awaiting_owner'
   or s.checkpoint_phase<>'ready' then raise exception 'owner_question_stale' using errcode='23505'; end if;
 update public.supervisor_run_steps set status='pending',error_code=null,next_retry_at=null,
   attempts=0,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='pending',awaiting_question_id=null,
   answered_question_ids=answered_question_ids||p_question_id,owner_answer_ids=owner_answer_ids||p_answer_id,
   dispatch_after=null,updated_at=clock_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

        and p_receipt_ref !~ '^purchase_batch:[a-f0-9-]{36}(,[a-f0-9-]{36}){0,9}
      then raise exception 'checkpoint_receipt_invalid' using errcode='22023'; end if;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_receipts=checkpoint_receipts||jsonb_build_array(jsonb_build_object(
        'operation',p_operation,'phase',checkpoint_phase,'tool',checkpoint_tool,'receipt',p_receipt_ref)),
      checkpoint_phase='ready',checkpoint_operation=null,checkpoint_tool=null,updated_at=v_now
      where id=s.id returning * into s;
  else
    if s.checkpoint_phase<>'ready' or p_receipt_ref is not null
      or (p_action='begin_provider' and p_tool is not null)
      or (p_action<>'begin_provider' and (p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,79}$'))
      or exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
        where e->>'operation'=p_operation::text)
      then raise exception 'checkpoint_operation_conflict' using errcode='22023'; end if;
    v_phase:=case p_action when 'begin_provider' then 'provider_pending'
      when 'begin_read' then 'read_pending' else 'effect_pending' end;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_phase=v_phase,checkpoint_operation=p_operation,checkpoint_tool=p_tool,updated_at=v_now
      where id=s.id returning * into s;
  end if;
  update public.supervisor_runs set updated_at=v_now where id=r.id;
  return to_jsonb(s);
end $$;
revoke all on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;

-- Yield only a non-effect/verified boundary. Retain the exact pending operation
-- for replacement workers; an unknown effect must remain in reconciliation.
create function public.supervisor_yield_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_delay_seconds integer
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_due timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_delay_seconds is null
    or p_delay_seconds not between 15 and 900 or p_expected_seq is null
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
    lease_until=null,next_retry_at=v_due,updated_at=v_now where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) to service_role;

-- Replace only the active claim function, retaining version-1 behavior.
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
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and s.checkpoint_phase in ('ready','provider_pending','read_pending')) then
    update public.supervisor_run_steps set status = 'blocked', error_code = 'lease_expired',
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if (s.retry_mode='idempotent' or r.execution_version=2) and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, next_retry_at=null, updated_at = v_now
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;


-- Do not acknowledge a final owner turn while a checkpoint operation is open.
create or replace function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_result_ref is null or char_length(p_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status in ('completed', 'blocked') then raise exception 'run_unavailable'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.claim_token is distinct from p_claim_token
    then raise exception 'step_claim_conflict'; end if;
  if r.execution_version=2 and p_step_key='owner_turn' and
    (s.checkpoint_phase<>'ready' or
     not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) or
     not exists(select 1 from public.ai_messages m where m.id::text=p_result_ref
       and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
       and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
       and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= clock_timestamp()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_verified_result_ref is null or char_length(p_verified_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status <> 'blocked' then raise exception 'run_not_blocked'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.status <> 'blocked' or s.retry_mode <> 'reconcile'
    then raise exception 'step_not_reconcilable'; end if;
  if r.execution_version=2 and s.checkpoint_phase<>'ready'
    then raise exception 'checkpoint_operation_unreconciled'; end if;
  -- Canonical owner turns may recover only an uncertain result and only with
  -- the exact persisted scoped reply. A reply never proves an external effect.
  if p_step_key='owner_turn' and (s.error_code is null or s.error_code not in ('lease_expired','turn_failed')
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id::text=p_verified_result_ref
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
      and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
      and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- Use the same job table and its existing unique running-thread index. The
-- v2 job lease belongs to the scoped owner_turn step, not to an untrusted
-- browser or a second worker. Old job RPCs cannot finish/restart its row.
alter table public.ai_agent_jobs add column durable_run_id uuid,
 add column durable_claim_token uuid;
-- New private column is not returned to the browser by the existing job API.
-- Owner-facing readers need the linked run ID, not the execution credential.
revoke select on public.ai_agent_jobs from authenticated;
grant select(id,business_id,owner_user_id,thread_id,owner_message_id,status,attempt,
 error_code,reply_message_id,progress,inbox,consumed,heartbeat_at,created_at,
 updated_at,finished_at,durable_run_id) on public.ai_agent_jobs to authenticated;

create function public.supervisor_owner_job_fence_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns boolean language sql security invoker set search_path=public as $$
 select coalesce(auth.role(),'')='service_role'
  and public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  and exists(select 1 from public.supervisor_runs r join public.supervisor_run_steps s
    on s.business_id=r.business_id and s.run_id=r.id
    where r.id=p_run_id and r.business_id=p_business_id
     and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
     and r.execution_version=2 and r.status='running' and s.step_key='owner_turn'
     and s.status='leased' and s.claim_token=p_claim_token and s.lease_until>clock_timestamp());
$$;
revoke all on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.supervisor_start_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;other public.ai_agent_jobs;v_attempt bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select attempts into v_attempt from public.supervisor_run_steps where run_id=r.id
   and business_id=r.business_id and step_key='owner_turn' for update;
 -- Strict ordering between durable owner messages in this thread.
 if exists(select 1 from public.supervisor_runs earlier where earlier.business_id=r.business_id
   and earlier.owner_user_id=r.owner_user_id and earlier.thread_id=r.thread_id
   and earlier.execution_version=2 and earlier.status in ('pending','running')
   and (earlier.created_at,earlier.id)<(r.created_at,r.id)) then return null; end if;
 select * into j from public.ai_agent_jobs where owner_message_id=r.request_key for update;
 if found and (j.durable_run_id is distinct from r.id or j.business_id<>r.business_id
   or j.owner_user_id<>r.owner_user_id or j.thread_id<>r.thread_id)
   then raise exception 'durable_job_conflict'; end if;
 if j.status='done' then return to_jsonb(j)-'durable_claim_token'; end if;
 select * into other from public.ai_agent_jobs where thread_id=r.thread_id and status='running'
   and id is distinct from j.id for update;
 if found then
   -- Do not absorb another owner's message or revive an uncertain legacy turn.
   if other.durable_run_id is not null then
     if exists(select 1 from public.supervisor_runs other_run where other_run.id=other.durable_run_id
       and other_run.business_id=r.business_id and other_run.owner_user_id=r.owner_user_id
       and other_run.thread_id=r.thread_id and other_run.status in ('pending','running'))
       then return null; end if;
   elsif other.heartbeat_at>=clock_timestamp()-interval '180 seconds' then return null; end if;
   update public.ai_agent_jobs set status='failed',error_code='timeout',finished_at=clock_timestamp(),
     updated_at=clock_timestamp() where id=other.id;
 end if;
 if j.id is null then
   insert into public.ai_agent_jobs(business_id,owner_user_id,thread_id,owner_message_id,durable_run_id,durable_claim_token)
     values(r.business_id,r.owner_user_id,r.thread_id,r.request_key,r.id,p_claim_token)
     returning * into j;
 else
   update public.ai_agent_jobs set status='running',attempt=least(5,greatest(attempt,v_attempt)),
     durable_claim_token=p_claim_token,error_code=null,finished_at=null,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
     where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'durable_claim_token';
end $$;
revoke all on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Single fenced status/progress writer. An expired worker cannot change the
-- replacement job. Terminal success checks a canonical scoped reply, not text.
create function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=case when jsonb_array_length(progress)<12
     then progress||jsonb_build_array(p_step) else progress end where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
end $$;
revoke all on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) to service_role;

create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and r.request_key=p_owner_message_id and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running' and durable_run_id is null;
end $$;
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' or j.durable_run_id is not null then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text,
  p_absorbed_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.durable_run_id is not null then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  -- Only IDs observed by a completed model response and persisted to the reply
  -- are acknowledged. A timed-out inbox RPC or model failure cannot claim them.
  if p_status = 'done' and (
      cardinality(coalesce(p_absorbed_ids, '{}'::uuid[])) > 5 or
      not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)
  ) then raise exception 'invalid_absorbed_ids'; end if;
  update public.ai_agent_jobs
     set consumed = case when p_status = 'done'
                         then coalesce(p_absorbed_ids, '{}'::uuid[])
                         else '{}'::uuid[] end,
         status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

-- Final reply and job completion are one scoped transaction. A process killed
-- after the insert cannot leave a canonical answer with an orphan job. Do not
-- allow incomplete or ungrounded slices to occupy the immutable final reply.
create function public.supervisor_publish_owner_reply_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or p_grounding->>'status' is distinct from 'verified'
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'='verified'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 return to_jsonb(m);
end $$;
revoke all on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- A clarification is an intermediate receipt, not the final canonical reply.
-- Only an authenticated, explicitly matched answer can wake the same run.
alter table public.supervisor_runs add column awaiting_question_id uuid,
  add column answered_question_ids uuid[] not null default '{}',
  add column owner_answer_ids uuid[] not null default '{}';
create function public.supervisor_publish_owner_question_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
end $$;
revoke all on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.supervisor_answer_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;q public.ai_messages;a public.ai_messages;v_index integer;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501'; end if;
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
   and grounding->>'status'='requires_owner_input' and grounding->>'durableQuestionId'=id::text;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner' and content_type='text'
   and created_at>=q.created_at;
 if not found then raise exception 'owner_answer_unavailable' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id::text=q.grounding->>'durableRunId'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and execution_version=2 and request_key::text=q.grounding->>'ownerMessageId' for update;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 v_index:=array_position(r.answered_question_ids,p_question_id);
 if v_index is not null then
   if r.owner_answer_ids[v_index] is distinct from p_answer_id then
     raise exception 'owner_question_already_answered' using errcode='23505'; end if;
   return to_jsonb(r);
 end if;
 if r.status<>'blocked' or r.awaiting_question_id is distinct from p_question_id
   or cardinality(r.owner_answer_ids)>=20 or p_answer_id=any(r.owner_answer_ids)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
     and x.owner_user_id=p_owner_user_id and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
   then raise exception 'owner_question_stale' using errcode='23505'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and step_key='owner_turn' for update;
 if not found or s.status<>'blocked' or s.error_code is distinct from 'awaiting_owner'
   or s.checkpoint_phase<>'ready' then raise exception 'owner_question_stale' using errcode='23505'; end if;
 update public.supervisor_run_steps set status='pending',error_code=null,next_retry_at=null,
   attempts=0,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='pending',awaiting_question_id=null,
   answered_question_ids=answered_question_ids||p_question_id,owner_answer_ids=owner_answer_ids||p_answer_id,
   dispatch_after=null,updated_at=clock_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) to service_role;
)
      then raise exception 'checkpoint_receipt_invalid' using errcode='22023'; end if;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_receipts=checkpoint_receipts||jsonb_build_array(jsonb_build_object(
        'operation',p_operation,'phase',checkpoint_phase,'tool',checkpoint_tool,'receipt',p_receipt_ref)),
      checkpoint_phase='ready',checkpoint_operation=null,checkpoint_tool=null,updated_at=v_now
      where id=s.id returning * into s;
  else
    if s.checkpoint_phase<>'ready' or p_receipt_ref is not null
      or (p_action='begin_provider' and p_tool is not null)
      or (p_action<>'begin_provider' and (p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,79}$'))
      or exists(select 1 from jsonb_array_elements(s.checkpoint_receipts) e
        where e->>'operation'=p_operation::text)
      then raise exception 'checkpoint_operation_conflict' using errcode='22023'; end if;
    v_phase:=case p_action when 'begin_provider' then 'provider_pending'
      when 'begin_read' then 'read_pending' else 'effect_pending' end;
    update public.supervisor_run_steps set checkpoint_seq=checkpoint_seq+1,
      checkpoint_phase=v_phase,checkpoint_operation=p_operation,checkpoint_tool=p_tool,updated_at=v_now
      where id=s.id returning * into s;
  end if;
  update public.supervisor_runs set updated_at=v_now where id=r.id;
  return to_jsonb(s);
end $$;
revoke all on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.supervisor_checkpoint_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;

-- Yield only a non-effect/verified boundary. Retain the exact pending operation
-- for replacement workers; an unknown effect must remain in reconciliation.
create function public.supervisor_yield_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
  p_expected_seq integer,p_delay_seconds integer
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_due timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_delay_seconds is null
    or p_delay_seconds not between 15 and 900 or p_expected_seq is null
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
    lease_until=null,next_retry_at=v_due,updated_at=v_now where id=s.id;
  update public.supervisor_runs set status='pending',dispatch_after=v_due,updated_at=v_now where id=r.id;
  return true;
end $$;
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer,text) to service_role;

-- Replace only the active claim function, retaining version-1 behavior.
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
    if s.next_retry_at>v_now then return jsonb_build_object('kind','busy'); end if;
    if s.step_key='owner_turn' and exists(select 1 from public.supervisor_runs earlier
       where earlier.business_id=r.business_id and earlier.owner_user_id=r.owner_user_id
         and earlier.thread_id=r.thread_id and earlier.execution_version=2
         and earlier.status in ('pending','running') and (earlier.created_at,earlier.id)<(r.created_at,r.id))
       then return jsonb_build_object('kind','busy'); end if;
  end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile'
    and not (r.execution_version=2 and s.step_key='owner_turn'
      and s.checkpoint_phase in ('ready','provider_pending','read_pending')) then
    update public.supervisor_run_steps set status = 'blocked', error_code = 'lease_expired',
      worker_id = null, claim_token = null, lease_until = null, updated_at = v_now
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = v_now where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  -- A repeatedly abandoned read/verification step cannot retry forever.
  -- Uncertain effect steps retain their independent-receipt-only branch above.
  if (s.retry_mode='idempotent' or r.execution_version=2) and s.attempts>=5 then
    update public.supervisor_run_steps set status='blocked',error_code='retry_exhausted',
      worker_id=null,claim_token=null,lease_until=null,updated_at=v_now where id=s.id;
    update public.supervisor_runs set status='blocked',updated_at=v_now where id=r.id;
    return jsonb_build_object('kind','blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, next_retry_at=null, updated_at = v_now
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = v_now where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;


-- Do not acknowledge a final owner turn while a checkpoint operation is open.
create or replace function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_result_ref is null or char_length(p_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status in ('completed', 'blocked') then raise exception 'run_unavailable'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.claim_token is distinct from p_claim_token
    then raise exception 'step_claim_conflict'; end if;
  if r.execution_version=2 and p_step_key='owner_turn' and
    (s.checkpoint_phase<>'ready' or
     not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id) or
     not exists(select 1 from public.ai_messages m where m.id::text=p_result_ref
       and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
       and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
       and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= clock_timestamp()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_verified_result_ref is null or char_length(p_verified_result_ref) not between 1 and 256
    then raise exception 'invalid_result_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found or r.status <> 'blocked' then raise exception 'run_not_blocked'; end if;
  select * into s from public.supervisor_run_steps where business_id = p_business_id
    and run_id = p_run_id and step_key = p_step_key for update;
  if not found or s.status <> 'blocked' or s.retry_mode <> 'reconcile'
    then raise exception 'step_not_reconcilable'; end if;
  if r.execution_version=2 and s.checkpoint_phase<>'ready'
    then raise exception 'checkpoint_operation_unreconciled'; end if;
  -- Canonical owner turns may recover only an uncertain result and only with
  -- the exact persisted scoped reply. A reply never proves an external effect.
  if p_step_key='owner_turn' and (s.error_code is null or s.error_code not in ('lease_expired','turn_failed')
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or not exists(select 1 from public.ai_messages m where m.id::text=p_verified_result_ref
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
      and m.role='supervisor' and m.grounding->>'ownerMessageId'=r.request_key::text
      and m.grounding->>'status'='verified' and m.grounding#>>'{agentMetadata,endReason}'='complete'))
    then raise exception 'owner_turn_receipt_not_verified'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- Use the same job table and its existing unique running-thread index. The
-- v2 job lease belongs to the scoped owner_turn step, not to an untrusted
-- browser or a second worker. Old job RPCs cannot finish/restart its row.
alter table public.ai_agent_jobs add column durable_run_id uuid,
 add column durable_claim_token uuid;
-- New private column is not returned to the browser by the existing job API.
-- Owner-facing readers need the linked run ID, not the execution credential.
revoke select on public.ai_agent_jobs from authenticated;
grant select(id,business_id,owner_user_id,thread_id,owner_message_id,status,attempt,
 error_code,reply_message_id,progress,inbox,consumed,heartbeat_at,created_at,
 updated_at,finished_at,durable_run_id) on public.ai_agent_jobs to authenticated;

create function public.supervisor_owner_job_fence_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns boolean language sql security invoker set search_path=public as $$
 select coalesce(auth.role(),'')='service_role'
  and public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  and exists(select 1 from public.supervisor_runs r join public.supervisor_run_steps s
    on s.business_id=r.business_id and s.run_id=r.id
    where r.id=p_run_id and r.business_id=p_business_id
     and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
     and r.execution_version=2 and r.status='running' and s.step_key='owner_turn'
     and s.status='leased' and s.claim_token=p_claim_token and s.lease_until>clock_timestamp());
$$;
revoke all on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_owner_job_fence_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.supervisor_start_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;other public.ai_agent_jobs;v_attempt bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then raise exception 'durable_job_lease_lost' using errcode='40001'; end if;
 select attempts into v_attempt from public.supervisor_run_steps where run_id=r.id
   and business_id=r.business_id and step_key='owner_turn' for update;
 -- Strict ordering between durable owner messages in this thread.
 if exists(select 1 from public.supervisor_runs earlier where earlier.business_id=r.business_id
   and earlier.owner_user_id=r.owner_user_id and earlier.thread_id=r.thread_id
   and earlier.execution_version=2 and earlier.status in ('pending','running')
   and (earlier.created_at,earlier.id)<(r.created_at,r.id)) then return null; end if;
 select * into j from public.ai_agent_jobs where owner_message_id=r.request_key for update;
 if found and (j.durable_run_id is distinct from r.id or j.business_id<>r.business_id
   or j.owner_user_id<>r.owner_user_id or j.thread_id<>r.thread_id)
   then raise exception 'durable_job_conflict'; end if;
 if j.status='done' then return to_jsonb(j)-'durable_claim_token'; end if;
 select * into other from public.ai_agent_jobs where thread_id=r.thread_id and status='running'
   and id is distinct from j.id for update;
 if found then
   -- Do not absorb another owner's message or revive an uncertain legacy turn.
   if other.durable_run_id is not null then
     if exists(select 1 from public.supervisor_runs other_run where other_run.id=other.durable_run_id
       and other_run.business_id=r.business_id and other_run.owner_user_id=r.owner_user_id
       and other_run.thread_id=r.thread_id and other_run.status in ('pending','running'))
       then return null; end if;
   elsif other.heartbeat_at>=clock_timestamp()-interval '180 seconds' then return null; end if;
   update public.ai_agent_jobs set status='failed',error_code='timeout',finished_at=clock_timestamp(),
     updated_at=clock_timestamp() where id=other.id;
 end if;
 if j.id is null then
   insert into public.ai_agent_jobs(business_id,owner_user_id,thread_id,owner_message_id,durable_run_id,durable_claim_token)
     values(r.business_id,r.owner_user_id,r.thread_id,r.request_key,r.id,p_claim_token)
     returning * into j;
 else
   update public.ai_agent_jobs set status='running',attempt=least(5,greatest(attempt,v_attempt)),
     durable_claim_token=p_claim_token,error_code=null,finished_at=null,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
     where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'durable_claim_token';
end $$;
revoke all on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_start_owner_job_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Single fenced status/progress writer. An expired worker cannot change the
-- replacement job. Terminal success checks a canonical scoped reply, not text.
create function public.supervisor_update_owner_job_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_action text,p_step jsonb,p_reply_id uuid,p_error_code text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;j public.ai_agent_jobs;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_action is null
   or p_action not in ('progress','done','failed','heartbeat') then raise exception 'invalid_durable_job_update'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or not public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
   then return false; end if;
 perform 1 from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id and step_key='owner_turn' for update;
 select * into j from public.ai_agent_jobs where id=p_job_id and durable_run_id=r.id
   and owner_message_id=r.request_key and business_id=r.business_id and owner_user_id=r.owner_user_id
   and thread_id=r.thread_id and durable_claim_token=p_claim_token and status='running' for update;
 if not found then return false; end if;
 if p_action='progress' then
   if p_step is null or jsonb_typeof(p_step)<>'object' or octet_length(p_step::text)>200
     then raise exception 'invalid_job_step'; end if;
   update public.ai_agent_jobs set progress=case when jsonb_array_length(progress)<12
     then progress||jsonb_build_array(p_step) else progress end where id=j.id;
 elsif p_action='done' then
   if not exists(select 1 from public.ai_messages m where m.id=p_reply_id and m.business_id=r.business_id
     and m.thread_id=r.thread_id and m.owner_user_id=r.owner_user_id and m.role='supervisor'
     and m.grounding->>'ownerMessageId'=r.request_key::text
     and m.grounding#>>'{agentMetadata,endReason}'='complete')
     then raise exception 'owner_turn_receipt_not_verified'; end if;
   update public.ai_agent_jobs set status='done',reply_message_id=p_reply_id,finished_at=clock_timestamp() where id=j.id;
 elsif p_action='failed' then
   if p_error_code is null or p_error_code !~ '^[a-z_]{1,60}$' then raise exception 'invalid_job_error'; end if;
   update public.ai_agent_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=j.id;
 end if;
 update public.ai_agent_jobs set heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 return true;
end $$;
revoke all on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_update_owner_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,text) to service_role;

create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and r.request_key=p_owner_message_id and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running' and durable_run_id is null;
end $$;
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' or j.durable_run_id is not null then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text,
  p_absorbed_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.durable_run_id is not null then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  -- Only IDs observed by a completed model response and persisted to the reply
  -- are acknowledged. A timed-out inbox RPC or model failure cannot claim them.
  if p_status = 'done' and (
      cardinality(coalesce(p_absorbed_ids, '{}'::uuid[])) > 5 or
      not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)
  ) then raise exception 'invalid_absorbed_ids'; end if;
  update public.ai_agent_jobs
     set consumed = case when p_status = 'done'
                         then coalesce(p_absorbed_ids, '{}'::uuid[])
                         else '{}'::uuid[] end,
         status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

-- Final reply and job completion are one scoped transaction. A process killed
-- after the insert cannot leave a canonical answer with an orphan job. Do not
-- allow incomplete or ungrounded slices to occupy the immutable final reply.
create function public.supervisor_publish_owner_reply_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or jsonb_typeof(p_grounding) is distinct from 'object'
   or p_grounding->>'status' is distinct from 'verified'
   or p_grounding#>>'{agentMetadata,endReason}' is distinct from 'complete'
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_reply_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
   and grounding->>'durableRunId'=r.id::text and grounding->>'status'='verified'
   and grounding#>>'{agentMetadata,endReason}'='complete';
 if not found then raise exception 'durable_reply_conflict'; end if;
 update public.ai_agent_jobs set status='done',reply_message_id=m.id,error_code=null,
   finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   where id=j.id;
 return to_jsonb(m);
end $$;
revoke all on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_reply_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- A clarification is an intermediate receipt, not the final canonical reply.
-- Only an authenticated, explicitly matched answer can wake the same run.
alter table public.supervisor_runs add column awaiting_question_id uuid,
  add column answered_question_ids uuid[] not null default '{}',
  add column owner_answer_ids uuid[] not null default '{}';
create function public.supervisor_publish_owner_question_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_job_id uuid,p_reply_id uuid,p_blocks jsonb,p_grounding jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;j public.ai_agent_jobs;m public.ai_messages;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_reply_id is null
   or jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) not between 1 and 30
   or p_grounding->>'status' is distinct from 'requires_owner_input'
   or p_grounding->>'durableQuestionId' is distinct from p_reply_id::text
   or not exists(select 1 from jsonb_array_elements(p_blocks) b where b->>'type'='clarify')
   or octet_length(p_blocks::text)>150000 or octet_length(p_grounding::text)>150000
   then raise exception 'durable_question_invalid' using errcode='22023'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if not found or r.execution_version<>2 or r.status<>'running'
   or p_grounding->>'ownerMessageId' is distinct from r.request_key::text
   or p_grounding->>'durableRunId' is distinct from r.id::text
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'durable_reply_scope_mismatch' using errcode='42501'; end if;
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
end $$;
revoke all on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_publish_owner_question_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.supervisor_answer_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;q public.ai_messages;a public.ai_messages;v_index integer;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501'; end if;
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
   and grounding->>'status'='requires_owner_input' and grounding->>'durableQuestionId'=id::text;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner' and content_type='text'
   and created_at>=q.created_at;
 if not found then raise exception 'owner_answer_unavailable' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id::text=q.grounding->>'durableRunId'
   and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and execution_version=2 and request_key::text=q.grounding->>'ownerMessageId' for update;
 if not found then raise exception 'owner_question_unavailable' using errcode='42501'; end if;
 v_index:=array_position(r.answered_question_ids,p_question_id);
 if v_index is not null then
   if r.owner_answer_ids[v_index] is distinct from p_answer_id then
     raise exception 'owner_question_already_answered' using errcode='23505'; end if;
   return to_jsonb(r);
 end if;
 if r.status<>'blocked' or r.awaiting_question_id is distinct from p_question_id
   or cardinality(r.owner_answer_ids)>=20 or p_answer_id=any(r.owner_answer_ids)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
     and x.owner_user_id=p_owner_user_id and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
   then raise exception 'owner_question_stale' using errcode='23505'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and step_key='owner_turn' for update;
 if not found or s.status<>'blocked' or s.error_code is distinct from 'awaiting_owner'
   or s.checkpoint_phase<>'ready' then raise exception 'owner_question_stale' using errcode='23505'; end if;
 update public.supervisor_run_steps set status='pending',error_code=null,next_retry_at=null,
   attempts=0,updated_at=clock_timestamp() where id=s.id;
 update public.supervisor_runs set status='pending',awaiting_question_id=null,
   answered_question_ids=answered_question_ids||p_question_id,owner_answer_ids=owner_answer_ids||p_answer_id,
   dispatch_after=null,updated_at=clock_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_answer_owner_run_v2(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Explicit authenticated owner cancellation uses the existing run/step locks.
-- It is deliberately not the worker's token-based stop RPC: an owner may
-- stop a live worker, but cannot claim an in-flight effect was undone.
create function public.supervisor_cancel_owner_run_v2(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid
) returns text language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs;s public.supervisor_run_steps;v_now timestamptz;v_code text;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_run_cancel_denied' using errcode='42501'; end if;
 select * into r from public.supervisor_runs where id=p_run_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id and execution_version=2 for update;
 if not found then return 'not_found'; end if;
 if r.status='completed' or exists(select 1 from public.ai_agent_jobs j
   where j.durable_run_id=r.id and j.business_id=r.business_id and j.owner_user_id=r.owner_user_id
    and j.thread_id=r.thread_id and j.status='done' and j.reply_message_id is not null)
    then return 'completed'; end if;
 select * into s from public.supervisor_run_steps where run_id=r.id and business_id=r.business_id
   and status<>'completed' order by step_index limit 1 for update;
 if not found then return 'completed'; end if;
 if r.status='blocked' and s.error_code not in ('awaiting_owner','cancelled','cancelled_effect_uncertain','effect_uncertain','lease_expired','turn_failed')
   then return 'blocked'; end if;
 v_code:=case when s.checkpoint_phase='effect_pending' or s.error_code in ('effect_uncertain','cancelled_effect_uncertain')
   then 'cancelled_effect_uncertain' else 'cancelled' end;
 v_now:=clock_timestamp();
 update public.supervisor_run_steps set status='blocked',error_code=v_code,worker_id=null,
   claim_token=null,lease_until=null,next_retry_at=null,updated_at=v_now where id=s.id;
 update public.supervisor_runs set status='blocked',awaiting_question_id=null,
   dispatch_after=null,updated_at=v_now where id=r.id;
 update public.ai_agent_jobs set status='failed',error_code=v_code,finished_at=v_now,
   updated_at=v_now,durable_claim_token=null where durable_run_id=r.id
   and business_id=r.business_id and owner_user_id=r.owner_user_id and thread_id=r.thread_id
   and status='running';
 return case when v_code='cancelled' then 'cancelled' else 'uncertain' end;
end $$;
revoke all on function public.supervisor_cancel_owner_run_v2(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_cancel_owner_run_v2(uuid,uuid,uuid,uuid) to service_role;
