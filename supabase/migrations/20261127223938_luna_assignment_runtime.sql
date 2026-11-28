-- A rollout affects new admissions only. Existing assignments, steps, request
-- keys and effect reservations keep their original identities on rollback.
set lock_timeout = '3s';
set statement_timeout = '30s';

create schema luna_internal;
revoke all on schema luna_internal from public, anon, authenticated, service_role;

create table public.luna_rollouts (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  enabled boolean not null default false
);
-- Reason: this newly created rollout table has no clients and must start private.
-- squawk-ignore ban-alter-row-level-security
alter table public.luna_rollouts enable row level security;
revoke all on public.luna_rollouts from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.luna_rollouts to service_role;

alter table public.supervisor_runs
  add column engine text not null default 'legacy' check (engine in ('legacy', 'replacement'));

create function luna_internal.pin_run_engine() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.engine := case when exists (
      select 1 from public.luna_rollouts where business_id = new.business_id and enabled
    ) then 'replacement' else 'legacy' end;
  elsif (new.engine, new.id, new.business_id, new.owner_user_id, new.thread_id, new.request_key)
    is distinct from (old.engine, old.id, old.business_id, old.owner_user_id, old.thread_id, old.request_key) then
    raise exception 'assignment_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger luna_pin_run_engine before insert or update of
  engine, id, business_id, owner_user_id, thread_id, request_key on public.supervisor_runs
  for each row execute function luna_internal.pin_run_engine();

-- Keep the mature lease, retry and reconciliation implementation behind both
-- public entries. Its old signature and response shapes remain the legacy API.
-- Reason: this transaction restores the original RPC signature and restricts the shared lease implementation to the two engine-specific entries.
-- squawk-ignore ban-set-schema
alter function public.supervisor_run_claim(uuid, uuid, uuid, uuid, uuid, integer) set schema luna_internal;
revoke all on function luna_internal.supervisor_run_claim(uuid, uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;

create function luna_internal.claim_for_engine(
  p_engine text, p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_run_id uuid, p_worker_id uuid, p_lease_seconds integer
) returns jsonb language plpgsql set search_path = '' as $$
declare pinned text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_only'; end if;
  select engine into pinned from public.supervisor_runs
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and thread_id = p_thread_id and id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if pinned <> p_engine then return jsonb_build_object('kind', 'busy'); end if;
  if pinned = 'replacement' and not public.supervisor_routine_owner_authorized(
    p_business_id, p_owner_user_id, p_thread_id
  ) then raise exception 'run_owner_required' using errcode = '42501'; end if;
  return luna_internal.supervisor_run_claim(
    p_business_id, p_owner_user_id, p_thread_id, p_run_id, p_worker_id, p_lease_seconds
  );
end $$;

create function public.supervisor_run_claim(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid,
  p_worker_id uuid, p_lease_seconds integer
) returns jsonb language sql security definer set search_path = '' as $$
  select luna_internal.claim_for_engine('legacy', $1, $2, $3, $4, $5, $6);
$$;

create function public.luna_assignment_claim(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid,
  p_worker_id uuid, p_lease_seconds integer
) returns jsonb language sql security definer set search_path = '' as $$
  select luna_internal.claim_for_engine('replacement', $1, $2, $3, $4, $5, $6);
$$;

revoke all on function public.supervisor_run_claim(uuid, uuid, uuid, uuid, uuid, integer),
  public.luna_assignment_claim(uuid, uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.supervisor_run_claim(uuid, uuid, uuid, uuid, uuid, integer),
  public.luna_assignment_claim(uuid, uuid, uuid, uuid, uuid, integer) to service_role;
