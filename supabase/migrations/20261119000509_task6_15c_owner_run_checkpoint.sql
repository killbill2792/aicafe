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
      or p_receipt_ref !~ '^[a-z][a-z0-9_]{0,39}:[a-zA-Z0-9_-]{1,160}$'
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
revoke all on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.supervisor_yield_owner_run_v2(uuid,uuid,uuid,uuid,uuid,integer,integer) to service_role;

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
