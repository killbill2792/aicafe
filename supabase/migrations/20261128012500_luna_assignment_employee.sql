set lock_timeout = '3s';
set statement_timeout = '30s';

-- Existing replacement assignments were admitted for the general manager.
-- Profile names and titles can change independently of the pinned key.
alter table public.supervisor_runs add column employee_key text;
update public.supervisor_runs set employee_key = 'general_manager' where engine = 'replacement';
alter table public.supervisor_runs add constraint supervisor_runs_employee_key_check check (
  (engine = 'legacy' and employee_key is null) or
  (engine = 'replacement' and employee_key is not null and
    employee_key in ('general_manager', 'growth', 'finance', 'operations', 'staffing'))
) not valid;

create or replace function luna_internal.pin_run_engine() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.engine := case when exists (
      select 1 from public.luna_rollouts where business_id = new.business_id and enabled
    ) then 'replacement' else 'legacy' end;
    new.employee_key := case when new.engine = 'replacement' then coalesce(new.employee_key, 'general_manager') end;
  elsif (new.engine, new.id, new.business_id, new.owner_user_id, new.thread_id, new.request_key, new.employee_key)
    is distinct from (old.engine, old.id, old.business_id, old.owner_user_id, old.thread_id, old.request_key, old.employee_key) then
    raise exception 'assignment_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace trigger luna_pin_run_engine before insert or update of
  engine, id, business_id, owner_user_id, thread_id, request_key, employee_key on public.supervisor_runs
  for each row execute function luna_internal.pin_run_engine();

create or replace function public.luna_open_assignment_provider(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_claim_token uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare job jsonb; assignment public.supervisor_runs;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'luna_assignment_provider_denied' using errcode='42501';
  end if;
  select * into assignment from public.supervisor_runs
    where id=p_run_id and business_id=p_business_id and owner_user_id=p_owner_user_id
      and thread_id=p_thread_id and engine='replacement';
  if not found then raise exception 'luna_assignment_provider_denied' using errcode='42501'; end if;

  job := public.supervisor_start_owner_job_v2(p_business_id, p_owner_user_id, p_thread_id, p_run_id, p_claim_token);
  if job is null then return null; end if;
  return (select jsonb_build_object('job',job,'employeeKey',assignment.employee_key,'phase',s.checkpoint_phase,
    'sequence',s.checkpoint_seq,'operation',s.checkpoint_operation,'lastReceipt',s.checkpoint_receipts->-1->>'receipt',
    'originalInput',jsonb_build_object('text',m.text_content,'receivedAt',m.created_at,
      'locale',assignment.input_locale,'attachmentIds',assignment.input_attachment_ids))
    from public.supervisor_run_steps s join public.ai_messages m on m.id=assignment.request_key
      and m.business_id=assignment.business_id and m.owner_user_id=assignment.owner_user_id
      and m.thread_id=assignment.thread_id and m.role='owner'
    where s.business_id=p_business_id and s.run_id=p_run_id and s.step_key='owner_turn' and s.claim_token=p_claim_token);
end $$;
