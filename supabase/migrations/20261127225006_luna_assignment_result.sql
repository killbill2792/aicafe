set lock_timeout = '3s';
set statement_timeout = '30s';

-- Publish the verified in-app result, job receipt and terminal run state as
-- one commit. An external delivery has its own authorization and receipt.
create function public.luna_commit_assignment_result(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid,
  p_claim_token uuid, p_job_id uuid, p_expected_seq bigint, p_provider_operation uuid,
  p_reply_id uuid, p_blocks jsonb, p_grounding jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  assignment public.supervisor_runs;
  turn public.supervisor_run_steps;
  message public.ai_messages;
  verification jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_only'; end if;
  -- Same lock order as admission and the canonical reply writer.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));
  select * into assignment from public.supervisor_runs where id = p_run_id and business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id and engine = 'replacement' for update;
  if not found or not public.supervisor_routine_owner_authorized(p_business_id, p_owner_user_id, p_thread_id)
    then raise exception 'assignment_result_denied' using errcode = '42501'; end if;
  if coalesce(p_grounding#>'{agentMetadata,absorbedOwnerMessageIds}', '[]'::jsonb) <> '[]'::jsonb then
    raise exception 'result_must_belong_to_one_assignment';
  end if;
  if assignment.status = 'completed' then
    -- A lost commit acknowledgement is recoverable after the lease ends.
    if assignment.final_report_ref is distinct from p_reply_id::text or not exists (
      select 1 from public.ai_agent_jobs j join public.ai_messages m on m.id = j.reply_message_id
      where j.id = p_job_id and j.durable_run_id = assignment.id and j.status = 'done'
        and m.id = p_reply_id and m.business_id = p_business_id and m.thread_id = p_thread_id
        and m.owner_user_id = p_owner_user_id and m.structured_content = p_blocks and m.grounding = p_grounding
    ) then raise exception 'assignment_result_conflict' using errcode = '23505'; end if;
    return p_reply_id;
  end if;
  select * into turn from public.supervisor_run_steps where run_id = p_run_id and step_key = 'owner_turn' for update;
  if not found or turn.status <> 'leased' or turn.claim_token is distinct from p_claim_token
    or turn.lease_until <= clock_timestamp() or turn.checkpoint_phase <> 'ready'
    or turn.checkpoint_seq is distinct from p_expected_seq or p_provider_operation is null
    or turn.checkpoint_receipts->-1->>'phase' is distinct from 'provider_pending'
    or turn.checkpoint_receipts->-1->>'operation' is distinct from p_provider_operation::text
    or turn.checkpoint_receipts->-1->>'receipt' is distinct from 'provider:' || p_provider_operation::text
    then raise exception 'assignment_result_checkpoint_conflict' using errcode = '40001'; end if;
  if exists (select 1 from luna_internal.assignment_inputs where run_id = p_run_id and provider_operation is null)
    then raise exception 'assignment_has_new_input' using errcode = '40001'; end if;
  perform public.supervisor_publish_owner_reply_v2(p_business_id, p_owner_user_id, p_thread_id, p_run_id,
    p_claim_token, p_job_id, p_reply_id, p_blocks, p_grounding);
  select * into strict message from public.ai_messages where id = p_reply_id;
  if message.structured_content is distinct from p_blocks or message.grounding is distinct from p_grounding
    then raise exception 'assignment_result_conflict' using errcode = '23505'; end if;
  perform public.supervisor_run_complete_step(p_business_id, p_owner_user_id, p_thread_id, p_run_id,
    'owner_turn', p_claim_token, message.id::text);
  verification := public.luna_assignment_claim(p_business_id, p_owner_user_id, p_thread_id, p_run_id,
    turn.worker_id, greatest(1, least(3600, ceil(extract(epoch from turn.lease_until - clock_timestamp()))::integer)));
  if verification->>'kind' is distinct from 'claimed' or verification#>>'{step,step_key}' is distinct from 'verify_report'
    then raise exception 'assignment_result_verification_unavailable' using errcode = '40001'; end if;
  perform public.supervisor_run_complete_step(p_business_id, p_owner_user_id, p_thread_id, p_run_id,
    'verify_report', (verification#>>'{step,claim_token}')::uuid, message.id::text);
  perform public.supervisor_run_finish(p_business_id, p_owner_user_id, p_thread_id, p_run_id, message.id::text);
  return message.id;
end $$;

revoke all on function public.luna_commit_assignment_result(uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.luna_commit_assignment_result(uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, jsonb, jsonb)
  to service_role;
