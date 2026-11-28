set lock_timeout = '3s';
set statement_timeout = '30s';

-- A due occurrence retains its runtime and employee across retries, edits and rollback.
alter table public.supervisor_routine_occurrences
  add column engine text not null default 'legacy' check (engine in ('legacy', 'replacement')),
  add column employee_key text,
  add constraint supervisor_routine_engine_employee check ((engine = 'replacement') = (employee_key is not null));

create function luna_internal.pin_routine_engine() returns trigger
language plpgsql set search_path = '' as $$
declare employee text;
begin
  if tg_op = 'UPDATE' then
    if (old.engine, old.employee_key) is distinct from (new.engine, new.employee_key) then
      raise exception 'assignment_identity_is_immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  select t.employee_key into employee
    from public.supervisor_routines r join public.luna_employee_threads t
      on t.business_id = r.business_id and t.owner_user_id = r.owner_user_id and t.thread_id = r.thread_id
    where r.business_id = new.business_id and r.id = new.routine_id and r.execution_mode = 'objective';
  if employee is not null then
    if not exists (select 1 from public.luna_rollouts where business_id = new.business_id and enabled)
      then return null; end if;
    new.engine := 'replacement';
    new.employee_key := employee;
  else
    new.engine := 'legacy';
    new.employee_key := null;
  end if;
  return new;
end $$;

create trigger luna_pin_routine_engine before insert or update of engine, employee_key
  on public.supervisor_routine_occurrences for each row execute function luna_internal.pin_routine_engine();

create function public.u4_due_objective_admission(
  p_now timestamptz,p_limit integer,p_watch_enabled boolean,p_engine text
) returns jsonb language plpgsql stable security definer set search_path=''
as $u4_admission$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or p_now is null or p_limit not between 1 and 12 or p_engine is null or p_engine not in ('all','legacy','replacement')
  then raise exception 'u4_admission_not_authorized' using errcode='42501'; end if;
  with authorized as materialized(
    select r.* from public.supervisor_routines r
      join public.businesses b on b.id=r.business_id
      where not b.is_demo and b.timezone=r.timezone
        and r.status='active'
        and (r.execution_mode='objective' or
          (p_watch_enabled and r.execution_mode='watch'))
        and exists(select 1 from public.memberships m where
          m.business_id=r.business_id and m.user_id=r.owner_user_id and m.role='owner')
        and exists(select 1 from public.ai_threads t where
          t.business_id=r.business_id and t.id=r.thread_id and
          t.owner_user_id=r.owner_user_id)
  ), eligible as (
    select r.business_id,r.id,r.created_at,to_jsonb(r) as routine,
      d.local_date,due.scheduled_for_utc
    from authorized r
    cross join lateral public.supervisor_due_routine_dates(
      r.business_id,r.id,r.revision,p_now) d
    cross join lateral (select coalesce(d.scheduled_for_utc,
      public.u4_first_civil_due(d.local_date,r.local_time,r.timezone))
      as scheduled_for_utc) due
    left join public.luna_employee_threads employee on employee.business_id=r.business_id
      and employee.owner_user_id=r.owner_user_id and employee.thread_id=r.thread_id
    left join public.luna_rollouts rollout on rollout.business_id=r.business_id and rollout.enabled
    left join public.supervisor_routine_occurrences admitted on admitted.business_id=r.business_id
      and admitted.routine_id=r.id and admitted.local_date=d.local_date and admitted.revision=r.revision
    -- Prevent a pre-creation or future occurrence from outranking eligible work.
    where due.scheduled_for_utc is not null
      and due.scheduled_for_utc<=p_now
      and due.scheduled_for_utc>=r.updated_at
      and (r.execution_mode<>'objective' or employee.employee_key is null
        or rollout.business_id is not null or admitted.run_id is not null)
      and (p_engine='all' or p_engine=coalesce(admitted.engine,
        case when r.execution_mode='objective' and employee.employee_key is not null and rollout.business_id is not null
          then 'replacement' else 'legacy' end))
  ), candidates as (
    select e.*,row_number() over(partition by e.business_id
      order by e.scheduled_for_utc,e.created_at,e.id) as cafe_rank
      from eligible e
  ), last_served as(
    select business_id,max(updated_at) as served_at
      from public.supervisor_routine_occurrences
      where state in ('running','completed','failed')
      group by business_id
  ), chosen as (
    select c.*,s.served_at
      from candidates c left join last_served s on s.business_id=c.business_id
      where c.cafe_rank=1
      order by s.served_at asc nulls first,c.local_date,c.business_id
      limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'routine',c.routine,'localDate',c.local_date::text,
    'scheduledForUtc',c.scheduled_for_utc::text)
    order by c.served_at asc nulls first,c.local_date,c.business_id),
    '[]'::jsonb) into result from chosen c;
  return result;
end
$u4_admission$;

revoke all on function public.u4_due_objective_admission(timestamptz,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.u4_due_objective_admission(timestamptz,integer,boolean,text) to service_role;

create or replace function public.u4_due_objective_admission(
  p_now timestamptz,p_limit integer default 6,p_watch_enabled boolean default false
) returns jsonb language sql stable security invoker set search_path='' as $$
  select public.u4_due_objective_admission(p_now,p_limit,p_watch_enabled,'legacy');
$$;

create function public.supervisor_claim_current_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_revision bigint,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz,p_engine text
) returns jsonb language plpgsql security invoker set search_path=public as $claim$
declare r public.supervisor_routines;v_global integer;v_cafe integer; v_claim jsonb; v_engine text; v_employee text;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_engine is null or p_engine not in ('all','legacy','replacement') then
    raise exception 'Service role required' using errcode='42501'; end if;
  select * into r from public.supervisor_routines where business_id=p_business_id
    and id=p_routine_id and revision=p_revision and status='active' for update;
  if not found then return null; end if;
  if p_engine<>'all' then
    select coalesce(admitted.engine,case
      when r.execution_mode='objective' and employee.employee_key is not null and rollout.enabled then 'replacement'
      when r.execution_mode='objective' and employee.employee_key is not null then null
      else 'legacy' end) into v_engine
    from public.supervisor_routines candidate
    left join public.luna_employee_threads employee on employee.business_id=r.business_id
      and employee.owner_user_id=r.owner_user_id and employee.thread_id=r.thread_id
    left join public.luna_rollouts rollout on rollout.business_id=r.business_id
    left join public.supervisor_routine_occurrences admitted on admitted.business_id=r.business_id
      and admitted.routine_id=r.id and admitted.local_date=p_local_date and admitted.revision=r.revision
    where candidate.business_id=r.business_id and candidate.id=r.id;
    if v_engine is distinct from p_engine then return null; end if;
  end if;
  if r.execution_mode in ('objective','watch') then
    -- One fast global claim semaphore. Transaction-scoped advisory locking
    -- prevents two independent minute ticks from racing the capacity check.
    perform pg_advisory_xact_lock(55720261122);
    select count(*)::integer into v_global
      from public.supervisor_routine_occurrences o
      join public.supervisor_routines s
        on s.business_id=o.business_id and s.id=o.routine_id
      where o.state='running' and o.lease_until>p_now
        and s.execution_mode in ('objective','watch');
    select count(*)::integer into v_cafe
      from public.supervisor_routine_occurrences o
      join public.supervisor_routines s
        on s.business_id=o.business_id and s.id=o.routine_id
      where o.business_id=p_business_id and o.state='running'
        and o.lease_until>p_now
        and s.execution_mode in ('objective','watch');
    if v_global>=12 or v_cafe>=1 then return null; end if;
  end if;
  v_claim:=public.claim_supervisor_routine_occurrence(
    p_business_id,p_routine_id,p_local_date,p_scheduled_for_utc,p_now);
  if v_claim->>'run_id' is null then return null; end if;
  select o.engine, o.employee_key into strict v_engine, v_employee
    from public.supervisor_routine_occurrences o
    where o.business_id=p_business_id and o.routine_id=p_routine_id
      and o.run_id=(v_claim->>'run_id')::uuid;
  if p_engine<>'all' and p_engine is distinct from v_engine then
    raise exception 'luna_routine_engine_changed' using errcode='40001'; end if;
  return v_claim || jsonb_build_object('engine', v_engine, 'employee_key', v_employee);
end $claim$;

revoke all on function public.supervisor_claim_current_routine_occurrence(uuid,uuid,bigint,date,timestamptz,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.supervisor_claim_current_routine_occurrence(uuid,uuid,bigint,date,timestamptz,timestamptz,text)
  to service_role;

create or replace function public.supervisor_claim_current_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_revision bigint,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz
) returns jsonb language sql security invoker set search_path='' as $$
  select public.supervisor_claim_current_routine_occurrence(
    p_business_id,p_routine_id,p_revision,p_local_date,p_scheduled_for_utc,p_now,'all');
$$;
