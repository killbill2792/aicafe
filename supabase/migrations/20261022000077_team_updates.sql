-- M0: persisted owner-scoped team updates; no UI or model-side writer.
create table if not exists team_updates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null check (agent_id in ('alex','olivia','maya','leo')),
  domain text not null check (domain in ('menu_pricing','labor','supplies','money')),
  kind text not null,
  severity text not null check (severity in ('info','attention','action')),
  subject_type text not null,
  subject_id uuid,
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  text text not null check (char_length(text) <= 600),
  locale text not null,
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  status text not null default 'new' check (status in ('new','seen','acted','dismissed')),
  dedupe_key text not null,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, dedupe_key)
);
create index if not exists team_updates_owner_recent_idx
  on team_updates (business_id, owner_user_id, created_at desc, id desc);
alter table team_updates enable row level security;

-- As in migration 20261010000036, only the row's owner with an owner membership can read it.
create policy "team updates owner read" on team_updates
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = team_updates.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );
create policy "team updates owner change status" on team_updates
  for update to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = team_updates.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  )
  with check (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = team_updates.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );
-- RLS controls rows, column privileges ensure only the status field can be changed.
revoke all on team_updates from public, anon, authenticated;
grant select, update (status) on team_updates to authenticated;
grant all on team_updates to service_role;
