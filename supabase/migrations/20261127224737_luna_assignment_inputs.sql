set lock_timeout = '3s';
set statement_timeout = '30s';

-- Keep the text in the canonical conversation. The private association records
-- the run, its acceptance order and the provider operation that observed it.
create table luna_internal.assignment_inputs (
  run_id uuid not null references public.supervisor_runs(id) on delete cascade,
  position bigint not null check (position > 0),
  message_id uuid not null unique references public.ai_messages(id) deferrable initially deferred,
  provider_operation uuid,
  primary key (run_id, position)
);
-- Reason: the new internal table is accessed only through scoped functions.
-- squawk-ignore ban-alter-row-level-security
alter table luna_internal.assignment_inputs enable row level security;
revoke all on luna_internal.assignment_inputs from public, anon, authenticated, service_role;

-- A saved steering message already belongs to a run. Retrying it through
-- ordinary durable admission must never turn it into a second assignment.
create function luna_internal.reject_steering_readmission() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from luna_internal.assignment_inputs where message_id = new.request_key) then
    raise exception 'message_already_steers_assignment' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger luna_reject_steering_readmission before insert on public.supervisor_runs
  for each row execute function luna_internal.reject_steering_readmission();

create function public.luna_steer_assignment(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid,
  p_client_message_id uuid, p_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  assignment public.supervisor_runs;
  message uuid;
  sequence_number bigint;
  original_text text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into assignment from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id and id = p_run_id
    and engine = 'replacement' for update;
  if not found or not public.supervisor_routine_owner_authorized(p_business_id, p_owner_user_id, p_thread_id)
    then raise exception 'assignment_input_denied' using errcode = '42501'; end if;
  if p_text is null or length(btrim(p_text)) = 0 or length(p_text) > 4000 or p_client_message_id is null then
    raise exception 'invalid_assignment_input' using errcode = '22023';
  end if;
  select i.position, m.id, m.text_content into sequence_number, message, original_text
    from luna_internal.assignment_inputs i join public.ai_messages m on m.id = i.message_id
    where i.run_id = p_run_id and m.thread_id = p_thread_id and m.client_message_id = p_client_message_id;
  if found then
    if original_text <> p_text then raise exception 'input_request_conflict' using errcode = '23505'; end if;
  else
    if assignment.status not in ('pending', 'running') or not exists (
      select 1 from public.supervisor_run_steps where run_id = p_run_id
        and step_key = 'owner_turn' and status in ('pending', 'leased')
    ) or exists (
      select 1 from public.ai_agent_jobs where durable_run_id = p_run_id and reply_message_id is not null and status = 'done'
    ) then raise exception 'assignment_closed_to_steering' using errcode = '55000'; end if;

    insert into public.ai_messages(business_id, owner_user_id, thread_id, author_user_id,
      role, content_type, text_content, client_message_id)
    values (p_business_id, p_owner_user_id, p_thread_id, p_owner_user_id, 'owner', 'text', p_text, p_client_message_id)
    on conflict (thread_id, client_message_id) do nothing returning id into message;
    if not found then raise exception 'input_request_conflict' using errcode = '23505'; end if;
    select coalesce(max(position), 0) + 1 into sequence_number
      from luna_internal.assignment_inputs where run_id = p_run_id;
    insert into luna_internal.assignment_inputs(run_id, position, message_id)
      values (p_run_id, sequence_number, message);
  end if;
  return jsonb_build_object('position', sequence_number, 'message_id', message);
end $$;

-- A provider begin and its ordered input snapshot commit under the existing
-- run lock. Later inputs wait for the next boundary. Abandoned attempts make
-- their inputs available again in the original order.
create function luna_internal.bind_provider_inputs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.checkpoint_phase = 'provider_pending' then
    update luna_internal.assignment_inputs set provider_operation = new.checkpoint_operation
      where run_id = new.run_id and provider_operation is null;
  elsif old.checkpoint_phase = 'provider_pending' and (
    new.checkpoint_receipts->-1->>'operation' is distinct from old.checkpoint_operation::text
    or new.checkpoint_receipts->-1->>'receipt' is distinct from 'provider:' || old.checkpoint_operation::text
  ) then
    update luna_internal.assignment_inputs set provider_operation = null
      where run_id = new.run_id and provider_operation = old.checkpoint_operation;
  end if;
  return new;
end $$;

create trigger luna_bind_provider_inputs after update of checkpoint_phase on public.supervisor_run_steps
  for each row when (new.step_key = 'owner_turn' and new.checkpoint_phase <> old.checkpoint_phase)
  execute function luna_internal.bind_provider_inputs();

create function public.luna_provider_inputs(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid,
  p_claim_token uuid, p_operation uuid, p_after bigint, p_limit integer
) returns table("position" bigint, message_id uuid, content text)
language plpgsql security definer set search_path = '' as $$
declare assignment public.supervisor_runs; step public.supervisor_run_steps;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_after is null or p_after < 0 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_input_page' using errcode = '22023';
  end if;
  select * into assignment from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id and id = p_run_id
    and engine = 'replacement' and status = 'running' for share;
  if not found or not public.supervisor_routine_owner_authorized(p_business_id, p_owner_user_id, p_thread_id)
    or assignment.input_attachment_version_hash is distinct from
    public.supervisor_owner_attachment_fingerprint_v2(p_business_id, p_owner_user_id, p_thread_id, assignment.input_attachment_ids)
    then raise exception 'assignment_input_denied' using errcode = '42501'; end if;
  select * into step from public.supervisor_run_steps where run_id = p_run_id
    and step_key = 'owner_turn' for share;
  if not found or step.status <> 'leased' or step.lease_until <= clock_timestamp()
    or step.claim_token is distinct from p_claim_token or step.checkpoint_phase <> 'provider_pending'
    or step.checkpoint_operation is distinct from p_operation then
    raise exception 'input_claim_conflict' using errcode = '40001';
  end if;
  return query select i.position, i.message_id, m.text_content from luna_internal.assignment_inputs i
    join public.ai_messages m on m.id = i.message_id where i.run_id = p_run_id
    and i.provider_operation = p_operation and i.position > p_after order by i.position limit p_limit;
end $$;

revoke all on function public.luna_steer_assignment(uuid, uuid, uuid, uuid, uuid, text),
  public.luna_provider_inputs(uuid, uuid, uuid, uuid, uuid, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.luna_steer_assignment(uuid, uuid, uuid, uuid, uuid, text),
  public.luna_provider_inputs(uuid, uuid, uuid, uuid, uuid, uuid, bigint, integer) to service_role;
