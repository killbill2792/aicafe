-- Additive operational workflow records. Apply before deploying code that writes these tables.
create table if not exists operating_tasks (
  id text not null,
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
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create index if not exists operating_tasks_business_status_idx on operating_tasks (business_id, status, created_at desc);

-- Supports a tenant-consistent employee reference from responses. The existing global employee
-- primary key remains unchanged; this additionally proves that the supplied employee belongs to
-- the response's business at the database boundary.
create unique index if not exists employees_business_id_id_idx on employees (business_id, id);

create table if not exists operating_task_responses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  task_id text not null,
  actor_type text not null check (actor_type in ('employee', 'owner')),
  employee_id uuid,
  respondent_name text,
  response_code text not null,
  short_text text,
  responded_at timestamptz not null default now(),
  check ((actor_type = 'employee' and employee_id is not null) or (actor_type = 'owner' and employee_id is null)),
  foreign key (business_id, task_id) references operating_tasks (business_id, id) on delete cascade,
  foreign key (business_id, employee_id) references employees (business_id, id) on delete restrict
);
create index if not exists operating_task_responses_task_idx on operating_task_responses (business_id, task_id, responded_at);

alter table operating_tasks enable row level security;
alter table operating_task_responses enable row level security;
create policy "members read" on operating_tasks for select using (is_member(business_id));
create policy "members write" on operating_tasks for all using (is_member(business_id)) with check (is_member(business_id));
create policy "members read" on operating_task_responses for select using (is_member(business_id));
create policy "members write" on operating_task_responses for all using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on operating_tasks, operating_task_responses to authenticated;
