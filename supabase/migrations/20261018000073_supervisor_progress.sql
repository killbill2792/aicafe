-- Additive migration for owner review; reconcile and apply in staging before production rollout.
-- Live "Supervisor is thinking" status for the chat composer. One row per owner turn,
-- keyed by the client-generated message id so the browser can poll before the owner's
-- POST (which only resolves once the whole investigation finishes) has returned.
-- Best-effort UI nicety only: never read for grounding, never written by the
-- authenticated role, and carries no café data -- only a bounded enum pair.
create table if not exists ai_supervisor_progress (
  thread_id uuid not null,
  client_message_id uuid not null,
  business_id uuid not null,
  owner_user_id uuid not null,
  agent text not null check (agent in ('alex', 'olivia', 'leo', 'maya', 'supervisor')),
  stage text not null check (stage in ('reading', 'answering', 'done', 'limited')),
  -- Monotonic per-attempt sequence, not a wall-clock timestamp: these writes
  -- are fire-and-forget (never awaited on the owner's actual turn), so a
  -- slower earlier round can otherwise complete after a faster later one and
  -- silently revert the status to a stale agent/stage. The writer RPC below
  -- rejects a same-attempt write whose step is not strictly newer than the
  -- stored one.
  step integer not null default 0,
  -- A fresh id generated once per owner-message POST invocation, not per
  -- browser retry click: a retried turn reuses the same client_message_id
  -- (and so this same row) but must not have its step comparison blocked by
  -- the previous, failed attempt's leftover step count. A write whose
  -- attempt differs from the stored one always wins, regardless of step.
  attempt uuid not null,
  updated_at timestamptz not null default now(),
  primary key (thread_id, client_message_id),
  foreign key (business_id, thread_id, owner_user_id)
    references ai_threads (business_id, id, owner_user_id) on delete cascade
);

alter table ai_supervisor_progress enable row level security;

create policy "ai supervisor progress owner read" on ai_supervisor_progress
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = ai_supervisor_progress.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- No authenticated insert/update/delete policy: only the server-authorized
-- investigation loop (service role) writes progress, exactly like Supervisor's
-- own replies.
grant select on ai_supervisor_progress to authenticated;
revoke insert, update, delete on ai_supervisor_progress from authenticated;

-- Service-role-only, step-ordered upsert. Fire-and-forget callers race each
-- other in flight; this keeps whichever write carries the highest step
-- within the same attempt, never an older one that merely finished later.
-- A write from a new attempt (a retried turn reusing the same
-- client_message_id) always wins immediately, instead of being blocked
-- until its own step count happens to exceed the previous attempt's.
create or replace function public.record_supervisor_progress(
  p_thread_id uuid, p_client_message_id uuid, p_business_id uuid, p_owner_user_id uuid,
  p_agent text, p_stage text, p_step integer, p_attempt uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_agent not in ('alex', 'olivia', 'leo', 'maya', 'supervisor')
    or p_stage not in ('reading', 'answering', 'done', 'limited')
    or p_step is null or p_step < 0 or p_attempt is null
  then raise exception 'Invalid supervisor progress write'; end if;

  insert into public.ai_supervisor_progress as progress (
    thread_id, client_message_id, business_id, owner_user_id, agent, stage, step, attempt, updated_at)
  values (p_thread_id, p_client_message_id, p_business_id, p_owner_user_id, p_agent, p_stage, p_step, p_attempt, now())
  on conflict (thread_id, client_message_id) do update set
    agent = excluded.agent, stage = excluded.stage, step = excluded.step,
    attempt = excluded.attempt, updated_at = excluded.updated_at
  where excluded.attempt <> progress.attempt or excluded.step > progress.step;
end;
$$;
revoke all on function public.record_supervisor_progress(
  uuid, uuid, uuid, uuid, text, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.record_supervisor_progress(
  uuid, uuid, uuid, uuid, text, text, integer, uuid) to service_role;
