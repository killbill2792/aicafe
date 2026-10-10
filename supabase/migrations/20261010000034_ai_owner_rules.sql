-- Phase 5: owner-approved AI Team operating instructions and immutable audit.
-- Additive only. This DOES NOT grant AI agents permission to execute business writes.
-- Apply after migration 33, using a reconciled migration history. Never blanket db push.

create table if not exists ai_team_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  agent_id text not null check (agent_id in ('supervisor','alex','olivia','maya','leo')),
  instruction text not null check (char_length(btrim(instruction)) between 5 and 1000),
  status text not null default 'draft' check (status in ('draft','active','paused','rejected')),
  version integer not null default 1 check (version >= 1),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  check ((status = 'draft' and reviewed_by is null and reviewed_at is null)
    or (status <> 'draft' and reviewed_by is not null and reviewed_at is not null))
);

create index if not exists ai_team_rules_business_agent_created_idx
  on ai_team_rules (business_id, agent_id, created_at desc, id desc);

create table if not exists ai_rule_events (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  rule_id uuid not null,
  actor_user_id uuid not null references auth.users(id),
  agent_id text not null,
  instruction_snapshot text not null,
  previous_status text,
  new_status text not null,
  version integer not null,
  created_at timestamptz not null default now(),
  foreign key (business_id, rule_id)
    references ai_team_rules (business_id, id) on delete cascade
);
create index if not exists ai_rule_events_business_recent_idx
  on ai_rule_events (business_id, created_at desc, id desc);

alter table ai_team_rules enable row level security;
alter table ai_rule_events enable row level security;

create policy "owner read AI Team rules" on ai_team_rules
  for select to authenticated
  using (exists (
    select 1 from memberships m
    where m.business_id = ai_team_rules.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'
  ));

create policy "owner draft AI Team rule" on ai_team_rules
  for insert to authenticated
  with check (
    created_by = (select auth.uid()) and status = 'draft'
    and version = 1 and reviewed_by is null and reviewed_at is null
    and exists (
      select 1 from memberships m
      where m.business_id = ai_team_rules.business_id
        and m.user_id = (select auth.uid()) and m.role = 'owner'
    )
  );

create policy "owner review AI Team rule" on ai_team_rules
  for update to authenticated
  using (exists (
    select 1 from memberships m
    where m.business_id = ai_team_rules.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'
  ))
  with check (exists (
    select 1 from memberships m
    where m.business_id = ai_team_rules.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'
  ));

create policy "owner read AI rule audit" on ai_rule_events
  for select to authenticated
  using (exists (
    select 1 from memberships m
    where m.business_id = ai_rule_events.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'
  ));

-- An update must represent exactly one safe transition. Rule text and identity
-- are immutable after creation; changing instructions means drafting a new rule.
-- A browser cannot bypass approval with direct PostgREST updates.
create or replace function guard_ai_team_rule_update()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.business_id is distinct from old.business_id
    or new.created_by is distinct from old.created_by
    or new.agent_id is distinct from old.agent_id
    or new.instruction is distinct from old.instruction
    or new.created_at is distinct from old.created_at then
    raise exception 'AI Team rule identity and instruction are immutable'
      using errcode = '23514';
  end if;

  if not (
    (old.status = 'draft' and new.status in ('active', 'rejected'))
    or (old.status = 'active' and new.status = 'paused')
    or (old.status = 'paused' and new.status = 'active')
  ) then
    raise exception 'Invalid AI Team rule transition'
      using errcode = '23514';
  end if;

  new.version := old.version + 1;
  new.reviewed_by := auth.uid();
  if new.reviewed_by is null then
    raise exception 'Authenticated owner review required' using errcode = '42501';
  end if;
  new.reviewed_at := now();
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function guard_ai_team_rule_update() from public;

create or replace function record_ai_team_rule_event()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into ai_rule_events (
    business_id, rule_id, actor_user_id, agent_id,
    instruction_snapshot, previous_status, new_status, version
  ) values (
    new.business_id, new.id,
    case when tg_op = 'INSERT' then new.created_by else new.reviewed_by end,
    new.agent_id, new.instruction,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status, new.version
  );
  return new;
end;
$$;
revoke all on function record_ai_team_rule_event() from public;

drop trigger if exists ai_team_rules_guard_update on ai_team_rules;
create trigger ai_team_rules_guard_update
  before update on ai_team_rules
  for each row execute function guard_ai_team_rule_update();

drop trigger if exists ai_team_rules_record_event on ai_team_rules;
create trigger ai_team_rules_record_event
  after insert or update on ai_team_rules
  for each row execute function record_ai_team_rule_event();

grant select, insert, update on ai_team_rules to authenticated;
grant select on ai_rule_events to authenticated;
revoke delete on ai_team_rules, ai_rule_events from authenticated;
revoke insert, update, delete on ai_rule_events from authenticated;
