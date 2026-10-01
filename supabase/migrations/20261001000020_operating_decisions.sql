-- Auditable recommendation lifecycle and before/after evidence. Financial truth remains in the
-- domain tables/calculation engines; these snapshots record why a recommendation was made.
create table if not exists cafe_decisions (
  id text primary key,
  business_id uuid not null references businesses on delete cascade,
  type text not null,
  entity_type text,
  entity_id text,
  recommendation jsonb not null,
  supporting_signal_ids jsonb not null default '[]'::jsonb,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  expected_impact jsonb,
  status text not null check (status in ('recommended', 'accepted', 'rejected', 'executed', 'dismissed', 'review_later')),
  autonomy_level smallint not null default 2 check (autonomy_level between 1 and 4),
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cafe_decisions_business_created_idx on cafe_decisions (business_id, created_at desc);

create table if not exists decision_outcomes (
  id text primary key,
  business_id uuid not null references businesses on delete cascade,
  decision_id text not null references cafe_decisions on delete cascade,
  period_from date not null,
  period_to date not null,
  metrics jsonb not null default '[]'::jsonb,
  notes text,
  recorded_at timestamptz not null default now(),
  check (period_to >= period_from)
);
create index if not exists decision_outcomes_decision_idx on decision_outcomes (decision_id, recorded_at desc);

alter table cafe_decisions enable row level security;
alter table decision_outcomes enable row level security;
drop policy if exists "members read" on cafe_decisions;
drop policy if exists "members write" on cafe_decisions;
create policy "members read" on cafe_decisions for select using (is_member(business_id));
create policy "members write" on cafe_decisions for all using (is_member(business_id)) with check (is_member(business_id));
drop policy if exists "members read" on decision_outcomes;
drop policy if exists "members write" on decision_outcomes;
create policy "members read" on decision_outcomes for select using (is_member(business_id));
create policy "members write" on decision_outcomes for all using (is_member(business_id)) with check (is_member(business_id));

-- Existing installations use this explicit table list for grants/RLS expectations.
grant select, insert, update, delete on cafe_decisions, decision_outcomes to authenticated;

-- Existing category values are generalized once; the column is already unconstrained text.
update menu_items set category = 'ESPRESSO_DRINK' where category = 'drink';
update menu_items set category = 'FOOD' where category = 'food';
