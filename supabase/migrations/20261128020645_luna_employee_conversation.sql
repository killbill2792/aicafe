set lock_timeout = '3s';
set statement_timeout = '30s';

-- A direct conversation uses the existing private thread and message store.
-- Bind the employee to the thread once, independently of profile edits.
create table public.luna_employee_threads (
  business_id uuid not null,
  owner_user_id uuid not null,
  employee_key text not null check (employee_key in ('general_manager', 'growth', 'finance', 'operations', 'staffing')),
  thread_id uuid not null unique,
  primary key (business_id, owner_user_id, employee_key),
  foreign key (business_id, thread_id, owner_user_id) references public.ai_threads(business_id, id, owner_user_id) on delete cascade
);

-- Reason: only the scoped server admission service needs to read or write the binding.
-- squawk-ignore ban-alter-row-level-security
alter table public.luna_employee_threads enable row level security;
revoke all on public.luna_employee_threads from public, anon, authenticated, service_role;
grant select, insert on public.luna_employee_threads to service_role;

create function public.luna_open_employee_thread(p_business_id uuid, p_owner_user_id uuid, p_employee_key text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare selected_thread uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_employee_key is null
    or p_employee_key not in ('general_manager', 'growth', 'finance', 'operations', 'staffing')
    then raise exception 'luna_employee_thread_denied' using errcode = '42501'; end if;
  perform 1 from public.memberships
    where business_id = p_business_id and user_id = p_owner_user_id and role = 'owner' for share;
  if not found then raise exception 'luna_employee_thread_denied' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('luna_employee_thread:' || p_business_id::text || ':' || p_owner_user_id::text || ':' || p_employee_key, 0));
  select thread_id into selected_thread from public.luna_employee_threads
    where business_id = p_business_id and owner_user_id = p_owner_user_id and employee_key = p_employee_key;
  if found then return selected_thread; end if;
  perform 1 from public.luna_rollouts where business_id = p_business_id and enabled for share;
  if not found then raise exception 'luna_employee_thread_disabled' using errcode = '55000'; end if;
  insert into public.ai_threads(business_id, owner_user_id, client_request_id)
    values (p_business_id, p_owner_user_id, gen_random_uuid()) returning id into selected_thread;
  insert into public.luna_employee_threads(business_id, owner_user_id, employee_key, thread_id)
    values (p_business_id, p_owner_user_id, p_employee_key, selected_thread);
  return selected_thread;
end $$;

revoke all on function public.luna_open_employee_thread(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.luna_open_employee_thread(uuid, uuid, text) to service_role;

create or replace function luna_internal.pin_run_engine() returns trigger
language plpgsql set search_path = '' as $$
declare thread_employee text;
begin
  if tg_op = 'INSERT' then
    new.engine := case when exists (
      select 1 from public.luna_rollouts where business_id = new.business_id and enabled
    ) then 'replacement' else 'legacy' end;
    select employee_key into thread_employee from public.luna_employee_threads
      where business_id = new.business_id and owner_user_id = new.owner_user_id and thread_id = new.thread_id;
    if thread_employee is not null and new.engine <> 'replacement'
      then raise exception 'luna_employee_thread_disabled' using errcode = '55000'; end if;
    new.employee_key := case when new.engine = 'replacement' then coalesce(thread_employee, new.employee_key, 'general_manager') end;
  elsif (new.engine, new.id, new.business_id, new.owner_user_id, new.thread_id, new.request_key, new.employee_key)
    is distinct from (old.engine, old.id, old.business_id, old.owner_user_id, old.thread_id, old.request_key, old.employee_key) then
    raise exception 'assignment_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end $$;
