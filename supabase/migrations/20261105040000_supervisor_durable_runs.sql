-- Durable multi-step Supervisor work, distinct from 180-second chat turns.
-- Only trusted server code writes; proposal approval and effect execution remain elsewhere.
create table public.supervisor_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null,
  thread_id uuid not null,
  request_key uuid not null,
  plan_hash text not null check (plan_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'blocked', 'completed')),
  final_report_ref text check (char_length(final_report_ref) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (business_id, owner_user_id, request_key),
  unique (business_id, id),
  foreign key (business_id, thread_id, owner_user_id)
    references public.ai_threads (business_id, id, owner_user_id) on delete cascade,
  check ((status = 'completed') = (finished_at is not null)),
  check ((status = 'completed') = (final_report_ref is not null))
);

create table public.supervisor_run_steps (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  run_id uuid not null,
  step_key text not null check (step_key ~ '^[a-z][a-z0-9_:-]{0,79}$'),
  step_index integer not null check (step_index between 1 and 32),
  retry_mode text not null check (retry_mode in ('idempotent', 'reconcile')),
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'blocked', 'completed')),
  worker_id uuid,
  claim_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  result_ref text check (char_length(result_ref) between 1 and 256),
  error_code text check (error_code ~ '^[a-z_]{1,60}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, run_id)
    references public.supervisor_runs (business_id, id) on delete cascade,
  unique (business_id, run_id, step_key),
  unique (business_id, run_id, step_index),
  check (status <> 'leased' or
    (worker_id is not null and claim_token is not null and lease_until is not null)),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'completed') = (result_ref is not null))
);
create index supervisor_run_steps_unfinished
  on public.supervisor_run_steps (business_id, run_id, step_index)
  where status <> 'completed';

alter table public.supervisor_runs enable row level security;
alter table public.supervisor_run_steps enable row level security;
create policy "supervisor runs owner read" on public.supervisor_runs for select to authenticated
  using (owner_user_id = (select auth.uid()) and exists (
    select 1 from public.memberships m
    where m.business_id = supervisor_runs.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy "supervisor steps owner read" on public.supervisor_run_steps for select to authenticated
  using (exists (
    select 1 from public.supervisor_runs r
    join public.memberships m on m.business_id = r.business_id
    where r.id = supervisor_run_steps.run_id
      and r.business_id = supervisor_run_steps.business_id
      and r.owner_user_id = (select auth.uid())
      and m.user_id = (select auth.uid()) and m.role = 'owner'));
revoke all on public.supervisor_runs, public.supervisor_run_steps from public, anon, authenticated;
grant select on public.supervisor_runs, public.supervisor_run_steps to authenticated;
grant all on public.supervisor_runs, public.supervisor_run_steps to service_role;

-- The plan and its ordered step keys are created in ONE transaction.
-- A retry with the same request key must have precisely the same scoped plan.
create function public.supervisor_run_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_request_key uuid, p_plan_hash text, p_steps jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; existing_steps jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_plan_hash is null or p_plan_hash !~ '^[a-f0-9]{64}$'
    then raise exception 'invalid_plan_hash'; end if;
  if jsonb_typeof(p_steps) is distinct from 'array' then raise exception 'invalid_steps'; end if;
  if jsonb_array_length(p_steps) not between 1 and 32
    or exists (
      select 1 from jsonb_array_elements(p_steps) s
      where jsonb_typeof(s) <> 'object'
        or (s->>'key') is null or (s->>'key') !~ '^[a-z][a-z0-9_:-]{0,79}$'
        or (s->>'retry') not in ('idempotent', 'reconcile')
        or (select count(*) from jsonb_object_keys(s)) <> 2)
    or (select count(distinct s->>'key') from jsonb_array_elements(p_steps) s)
       <> jsonb_array_length(p_steps)
  then raise exception 'invalid_steps'; end if;
  if not exists (select 1 from public.memberships m where
    m.business_id = p_business_id and m.user_id = p_owner_user_id and m.role = 'owner')
  then raise exception 'run_owner_required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor_run:' || p_business_id::text || ':' || p_owner_user_id::text ||
      ':' || p_request_key::text, 0));
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and request_key = p_request_key;
  if found then
    select coalesce(jsonb_agg(jsonb_build_object('key', s.step_key, 'retry', s.retry_mode)
      order by s.step_index), '[]'::jsonb) into existing_steps
      from public.supervisor_run_steps s where s.business_id = r.business_id and s.run_id = r.id;
    if r.thread_id <> p_thread_id or r.plan_hash <> p_plan_hash or existing_steps <> p_steps
      then raise exception 'run_request_conflict'; end if;
    return to_jsonb(r);
  end if;

  insert into public.supervisor_runs
    (business_id, owner_user_id, thread_id, request_key, plan_hash)
    values (p_business_id, p_owner_user_id, p_thread_id, p_request_key, p_plan_hash)
    returning * into r;
  insert into public.supervisor_run_steps
    (business_id, run_id, step_key, step_index, retry_mode)
    select p_business_id, r.id, s.value->>'key', s.ordinality::int,
      s.value->>'retry'
    from jsonb_array_elements(p_steps) with ordinality as s(value, ordinality);
  return to_jsonb(r);
end $$;

-- Lock the run FIRST, then the first unfinished step. A competing worker
-- cannot skip the locked first step or race ahead into a later action.
create function public.supervisor_run_claim(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_worker_id uuid, p_lease_seconds integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
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
  if s.status = 'blocked' then return jsonb_build_object('kind', 'blocked'); end if;
  if s.status = 'leased' and s.lease_until > now() then
    return jsonb_build_object('kind', 'busy'); end if;
  if s.status = 'leased' and s.retry_mode = 'reconcile' then
    update public.supervisor_run_steps set status = 'blocked', error_code = 'lease_expired',
      worker_id = null, claim_token = null, lease_until = null, updated_at = now()
      where id = s.id;
    update public.supervisor_runs set status = 'blocked', updated_at = now() where id = r.id;
    return jsonb_build_object('kind', 'blocked');
  end if;
  update public.supervisor_run_steps
    set status = 'leased', worker_id = p_worker_id, claim_token = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1, error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return jsonb_build_object('kind', 'claimed', 'step', to_jsonb(s),
    'idempotency_key', s.run_id::text || ':' || s.step_key);
end $$;

-- Only the live lease token may extend or complete a step. An expired worker
-- cannot acknowledge a later worker's result.
create function public.supervisor_run_renew(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare updated_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600
    then raise exception 'invalid_lease'; end if;
  update public.supervisor_run_steps set
    lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where business_id = p_business_id and run_id = p_run_id and step_key = p_step_key
    and claim_token = p_claim_token and status = 'leased' and lease_until > now()
    and exists (select 1 from public.supervisor_runs r where r.business_id = p_business_id
      and r.id = p_run_id and r.owner_user_id = p_owner_user_id
      and r.thread_id = p_thread_id);
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end $$;

create function public.supervisor_run_complete_step(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text,
  p_claim_token uuid, p_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
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
  if s.status = 'completed' then
    if s.result_ref <> p_result_ref then raise exception 'step_result_conflict'; end if;
    return to_jsonb(s);
  end if;
  if s.status <> 'leased' or s.lease_until <= now()
    then raise exception 'step_lease_expired'; end if;
  update public.supervisor_run_steps set status = 'completed', result_ref = p_result_ref,
    completed_at = now(), lease_until = null, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

-- A blocked non-idempotent action needs an independently verified receipt.
-- This does NOT grant approval or execute an effect; server code must verify
-- the receipt in the existing canonical action/approval ledger first.
create function public.supervisor_run_reconcile(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_step_key text, p_verified_result_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs; s public.supervisor_run_steps;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
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
  update public.supervisor_run_steps set status = 'completed', result_ref = p_verified_result_ref,
    completed_at = now(), error_code = null, updated_at = now()
    where id = s.id returning * into s;
  update public.supervisor_runs set status = 'running', updated_at = now() where id = r.id;
  return to_jsonb(s);
end $$;

-- The run row IS the single durable final-report record: a short reference to
-- the canonical report, not a second copy of owner/customer/model content.
create function public.supervisor_run_finish(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_run_id uuid, p_final_report_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.supervisor_runs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_final_report_ref is null or char_length(p_final_report_ref) not between 1 and 256
    then raise exception 'invalid_report_ref'; end if;
  select * into r from public.supervisor_runs where business_id = p_business_id
    and owner_user_id = p_owner_user_id and thread_id = p_thread_id
    and id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if r.status = 'completed' then
    if r.final_report_ref <> p_final_report_ref then raise exception 'report_conflict'; end if;
    return to_jsonb(r);
  end if;
  if r.status = 'blocked' or exists (select 1 from public.supervisor_run_steps s
    where s.business_id = p_business_id and s.run_id = p_run_id and s.status <> 'completed')
  then raise exception 'run_not_finished'; end if;
  update public.supervisor_runs set status = 'completed',
    final_report_ref = p_final_report_ref, finished_at = now(), updated_at = now()
    where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

revoke all on function public.supervisor_run_start(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.supervisor_run_claim(uuid,uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.supervisor_run_renew(uuid,uuid,uuid,uuid,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.supervisor_run_complete_step(uuid,uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
revoke all on function public.supervisor_run_reconcile(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.supervisor_run_finish(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_run_start(uuid,uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.supervisor_run_claim(uuid,uuid,uuid,uuid,uuid,integer) to service_role;
grant execute on function public.supervisor_run_renew(uuid,uuid,uuid,uuid,text,uuid,integer) to service_role;
grant execute on function public.supervisor_run_complete_step(uuid,uuid,uuid,uuid,text,uuid,text) to service_role;
grant execute on function public.supervisor_run_reconcile(uuid,uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.supervisor_run_finish(uuid,uuid,uuid,uuid,text) to service_role;