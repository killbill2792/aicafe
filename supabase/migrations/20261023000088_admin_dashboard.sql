-- Internal operations telemetry. No browser or authenticated PostgREST access.
-- No policies: service_role is the only reader/writer (including owner feedback routed
-- through an authenticated, owner-scoped server endpoint).
create table if not exists public.agent_turn_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  owner_message_id uuid not null references public.ai_messages(id) on delete cascade,
  message_id uuid references public.ai_messages(id) on delete set null,
  question text not null,
  final_answer text,
  status text not null check (status in ('ok','failed','timeout','cancelled')),
  error_text text,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_ms integer not null check (duration_ms >= 0),
  model text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_usd numeric(12,6) check (cost_usd is null or cost_usd >= 0),
  retry_of uuid references public.agent_turn_logs(id) on delete set null,
  owner_feedback text check (owner_feedback is null or owner_feedback in ('up','down')),
  owner_feedback_comment text check (owner_feedback_comment is null or char_length(owner_feedback_comment) <= 1000),
  created_at timestamptz not null default now(),
  foreign key (business_id, thread_id, owner_user_id)
    references public.ai_threads (business_id, id, owner_user_id) on delete cascade
);
create index if not exists agent_turn_logs_recent on public.agent_turn_logs (started_at desc, id desc);
create index if not exists agent_turn_logs_business_recent on public.agent_turn_logs (business_id, started_at desc);
create index if not exists agent_turn_logs_owner_message on public.agent_turn_logs (owner_message_id, started_at desc);
create unique index if not exists agent_turn_logs_message_unique
  on public.agent_turn_logs (message_id) where message_id is not null;

create table if not exists public.agent_turn_steps (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.agent_turn_logs(id) on delete cascade,
  step_order integer not null check (step_order > 0),
  kind text not null check (kind in ('model_call','tool_call','approval_card','memory')),
  tool_name text,
  input_summary text,
  output_summary text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  error text,
  unique (turn_id, step_order)
);
create index if not exists agent_turn_steps_timeline on public.agent_turn_steps (turn_id, step_order);

alter table public.agent_turn_logs enable row level security;
alter table public.agent_turn_steps enable row level security;
revoke all on public.agent_turn_logs from public, anon, authenticated;
revoke all on public.agent_turn_steps from public, anon, authenticated;
grant select, insert, update, delete on public.agent_turn_logs to service_role;
grant select, insert, update, delete on public.agent_turn_steps to service_role;
