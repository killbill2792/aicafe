set lock_timeout = '3s';
set statement_timeout = '30s';

-- The pilot opts the café into workforce mode. Full-runtime rollout remains
-- available to disposable integration fixtures and the eventual cutover.
alter table public.luna_rollouts add column scope text not null default 'all'
  check (scope in ('all', 'workforce'));

create or replace function luna_internal.pin_run_engine() returns trigger
language plpgsql set search_path = '' as $$
declare thread_employee text;
begin
  if tg_op = 'INSERT' then
    select employee_key into thread_employee from public.luna_employee_threads
      where business_id = new.business_id and owner_user_id = new.owner_user_id and thread_id = new.thread_id;
    new.engine := case when exists (
      select 1 from public.luna_rollouts
      where business_id = new.business_id and enabled
        and (scope = 'all' or thread_employee is not null)
    ) then 'replacement' else 'legacy' end;
    if thread_employee is not null and new.engine <> 'replacement'
      then raise exception 'luna_employee_thread_disabled' using errcode = '55000'; end if;
    new.employee_key := case when new.engine = 'replacement' then
      coalesce(thread_employee, new.employee_key, 'general_manager') end;
  elsif (new.engine, new.id, new.business_id, new.owner_user_id, new.thread_id, new.request_key, new.employee_key)
    is distinct from (old.engine, old.id, old.business_id, old.owner_user_id, old.thread_id, old.request_key, old.employee_key) then
    raise exception 'assignment_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end $$;
