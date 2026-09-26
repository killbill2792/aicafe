-- ===== Expenses (everything not in the POS) ===== (docs/04-data-model.md)
create table if not exists expense_categories (
  code text primary key,
  qb_account_type text not null,
  icon text not null,
  is_running_cost boolean not null
);

create table if not exists recurring_costs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  category_code text not null references expense_categories,
  label text not null,
  amount_cents bigint not null,
  frequency text not null check (frequency in ('monthly','weekly','quarterly','yearly')),
  due_day int,
  is_estimate boolean not null default false,
  active_from date not null default current_date,
  active_to date
);

create index if not exists recurring_costs_business_id_idx on recurring_costs (business_id);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  spent_on date not null,
  amount_cents bigint not null,
  vendor text,
  category_code text not null references expense_categories,
  source text not null check (source in ('manual','recurring','receipt','statement','voice','quickbooks','bank_feed')),
  status text not null check (status in ('estimated','actual')),
  recurring_cost_id uuid references recurring_costs,
  confidence numeric(3,2),
  reason text,
  attachment_path text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (business_id, dedupe_key)
);

create index if not exists expenses_business_id_spent_on_idx on expenses (business_id, spent_on);
create index if not exists expenses_category_code_idx on expenses (category_code);

create table if not exists expense_lines (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses on delete cascade,
  description text not null,
  quantity numeric(12,4),
  unit text,
  amount_cents bigint not null,
  ingredient_id uuid references ingredients
);

create index if not exists expense_lines_expense_id_idx on expense_lines (expense_id);

create table if not exists vendor_rules (
  business_id uuid not null references businesses on delete cascade,
  normalized_vendor text not null,
  category_code text not null references expense_categories,
  primary key (business_id, normalized_vendor)
);

create table if not exists uploads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  kind text not null check (kind in ('statement','receipt','pos_csv')),
  storage_path text not null,
  status text not null default 'processing' check (status in ('processing','needs_review','done','failed')),
  summary jsonb,
  created_at timestamptz not null default now()
);

create index if not exists uploads_business_id_idx on uploads (business_id);

-- Seed: fixed reference list, not business data. Safe to re-run.
insert into expense_categories (code, qb_account_type, icon, is_running_cost) values
  ('rent', 'Rent or Lease of Buildings', 'rent', true),
  ('utilities_power', 'Utilities', 'electricity', true),
  ('water', 'Utilities', 'water', true),
  ('internet', 'Utilities', 'wifi', true),
  ('insurance', 'Insurance', 'insurance', true),
  ('loan', 'Interest Paid', 'loan', true),
  ('software', 'Dues & Subscriptions', 'software', true),
  ('supplies', 'Supplies & Materials', 'supplies', true),
  ('repairs', 'Repair & Maintenance', 'repairs', true),
  ('ingredients', 'Supplies & Materials - COGS', 'ingredients', false),
  ('other', 'Other Business Expenses', 'other', true)
on conflict (code) do update set
  qb_account_type = excluded.qb_account_type,
  icon = excluded.icon,
  is_running_cost = excluded.is_running_cost;
