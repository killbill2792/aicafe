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
