set lock_timeout = '3s';
set statement_timeout = '30s';

-- Enter the existing fenced owner job and checkpoint store only through the
-- replacement engine. A worker never changes the engine of an admitted run.
create function public.luna_open_assignment_provider(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare job jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' or not exists (
    select 1 from public.supervisor_runs where id=p_run_id and business_id=p_business_id
      and owner_user_id=p_owner_user_id and thread_id=p_thread_id and engine='replacement'
  ) then raise exception 'luna_assignment_provider_denied' using errcode='42501'; end if;

  job := public.supervisor_start_owner_job_v2(p_business_id, p_owner_user_id, p_thread_id, p_run_id, p_claim_token);
  if job is null then return null; end if;
  return (select jsonb_build_object('job',job,'phase',s.checkpoint_phase,'sequence',s.checkpoint_seq,
    'operation',s.checkpoint_operation,'lastReceipt',s.checkpoint_receipts->-1->>'receipt')
    from public.supervisor_run_steps s where s.business_id=p_business_id and s.run_id=p_run_id
      and s.step_key='owner_turn' and s.claim_token=p_claim_token);
end $$;

revoke all on function public.luna_open_assignment_provider(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.luna_open_assignment_provider(uuid,uuid,uuid,uuid,uuid) to service_role;
