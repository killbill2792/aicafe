-- Additive operational workflow records. Apply before deploying code that writes these tables.
create table if not exists operating_tasks (
  id text primary key,
  business_id uuid not null references businesses on delete cascade,
  agent_id text not null check (agent_id in ('alex', 'olivia', 'maya', 'leo')),
  kind text not null,
  entity_type text,
  entity_id text,
  status text not null check (status in ('watching', 'needs_response', 'needs_owner', 'handled', 'expired')),
  payload jsonb not null default '{}'::jsonb,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists operating_tasks_business_status_idx on operating_tasks (business_id, status, created_at desc);

create table if not exists operating_task_responses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  task_id text not null references operating_tasks on delete cascade,
  employee_id uuid references employees on delete set null,
  respondent_name text,
  response_code text not null,
  short_text text,
  responded_at timestamptz not null default now()
);
create index if not exists operating_task_responses_task_idx on operating_task_responses (task_id, responded_at);

alter table operating_tasks enable row level security;
alter table operating_task_responses enable row level security;
create policy "members read" on operating_tasks for select using (is_member(business_id));
create policy "members write" on operating_tasks for all using (is_member(business_id)) with check (is_member(business_id));
create policy "members read" on operating_task_responses for select using (is_member(business_id));
create policy "members write" on operating_task_responses for all using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on operating_tasks, operating_task_responses to authenticated;
