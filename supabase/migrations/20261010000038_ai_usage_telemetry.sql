-- Supervisor Experience: additive, privacy-preserving owner/café AI consumption ledger.
-- REVIEW and reconcile migration history in staging; never apply automatically in production.
-- Stores token counts and estimated cost, never messages, prompts, responses or API secrets.
create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  owner_message_id uuid not null unique,
  provider text not null check (provider = 'openai'),
  model text not null check (char_length(model) between 1 and 80),
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  estimated_cost_micros bigint check (estimated_cost_micros is null or estimated_cost_micros >= 0),
  created_at timestamptz not null default now(),
  foreign key (business_id, thread_id, owner_user_id)
    references ai_threads (business_id, id, owner_user_id) on delete cascade,
  foreign key (owner_message_id) references ai_messages(id) on delete cascade
);
create index if not exists ai_usage_business_recent_idx
  on ai_usage_events (business_id, owner_user_id, created_at desc);
alter table ai_usage_events enable row level security;
create policy "ai usage owner read" on ai_usage_events
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (
      select 1 from memberships m
      where m.business_id = ai_usage_events.business_id
        and m.user_id = (select auth.uid()) and m.role = 'owner'
    )
  );
grant select on ai_usage_events to authenticated;
revoke insert, update, delete on ai_usage_events from authenticated;
-- Server service role writes a single event per persisted owner message.
