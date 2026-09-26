# 04 — Data model (Supabase Postgres)

Principles
- Money = `bigint` cents. Quantities of ingredients = `numeric(12,4)` in a base unit (g, ml, each).
- Every business-owned table has `business_id` and RLS: a user can access rows only if they are a member of that business.
- POS data is stored at the order-line level for the last 13 months, plus daily rollups for speed.
- **One expenses table for every non-POS cost**, whatever its source. Future QuickBooks/Plaid imports write here too.

```sql
-- ===== Tenancy =====
create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Los_Angeles',
  currency text not null default 'USD',
  payroll_tax_rate numeric(5,4) not null default 0.12,   -- employer burden on wages
  default_language text not null default 'en',           -- en | es | ar
  opened_on date,                                          -- for new cafés
  created_at timestamptz not null default now()
);

create table memberships (
  business_id uuid references businesses on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role text not null check (role in ('owner','manager')),
  can_see_profit boolean not null default true,
  primary key (business_id, user_id)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  name text not null,
  pos_location_id text,            -- Square location id
  open_hours jsonb                 -- {mon:[["06:00","18:00"]], ...}
);

-- ===== POS connection =====
create table pos_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  provider text not null check (provider in ('square','toast','csv')),
  merchant_id text,
  access_token_enc text,           -- encrypted (pgsodium / app-level AES-GCM)
  refresh_token_enc text,
  token_expires_at timestamptz,
  status text not null default 'active',  -- active | needs_reconnect | disconnected
  last_synced_at timestamptz,
  backfill_completed_at timestamptz
);

-- ===== Catalog & recipes =====
create table menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  pos_item_id text,                -- Square catalog item variation id
  name text not null,
  price_cents bigint,
  category text,
  prep_seconds int not null default 60,   -- staff time weight
  is_active boolean not null default true,
  unique (business_id, pos_item_id)
);

create table ingredients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  name text not null,              -- "Whole milk"
  base_unit text not null check (base_unit in ('g','ml','each')),
  icon text                        -- 'milk' | 'beans' | 'cup' ...
);

create table ingredient_prices (   -- price history, powers "milk up 70¢"
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients on delete cascade,
  effective_from date not null,
  cost_per_base_unit_micros bigint not null,  -- micro-cents per g/ml/each (precision for tiny amounts)
  source text not null check (source in ('manual','receipt','statement','invoice')),
  source_expense_line_id uuid
);

create table recipe_lines (
  menu_item_id uuid references menu_items on delete cascade,
  ingredient_id uuid references ingredients on delete cascade,
  quantity numeric(12,4) not null,  -- in ingredient base unit
  primary key (menu_item_id, ingredient_id)
);

create table modifier_recipes (     -- oat milk swap, extra shot
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  pos_modifier_id text,
  name text not null,
  ingredient_id uuid references ingredients,
  quantity_delta numeric(12,4) not null default 0,
  replaces_ingredient_id uuid references ingredients
);

-- ===== POS facts =====
create table orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  location_id uuid references locations,
  pos_order_id text not null,
  closed_at timestamptz not null,
  business_date date not null,      -- in business timezone
  gross_sales_cents bigint not null,
  discounts_cents bigint not null default 0,
  refunds_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  tip_cents bigint not null default 0,
  processing_fee_cents bigint not null default 0,
  net_sales_cents bigint not null,  -- gross - discounts - refunds (excl. tax & tips)
  customer_ref text,                -- hashed, for repeat-visit features later
  unique (business_id, pos_order_id)
);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,
  menu_item_id uuid references menu_items,
  pos_item_id text,
  name text not null,
  quantity numeric(10,2) not null,
  net_sales_cents bigint not null,
  modifiers jsonb not null default '[]'::jsonb,  -- [{pos_modifier_id, name}]
  voided boolean not null default false,
  voided_by text
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  pos_team_member_id text,
  display_name text not null,
  role text,
  unique (business_id, pos_team_member_id)
);

create table timecards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  employee_id uuid references employees,
  pos_timecard_id text,
  clock_in timestamptz not null,
  clock_out timestamptz,            -- null = on shift now
  hourly_wage_cents bigint not null,
  breaks jsonb not null default '[]'::jsonb,  -- [{start,end,paid}]
  unique (business_id, pos_timecard_id)
);

-- ===== Expenses (everything not in the POS) =====
create table expense_categories (   -- fixed list, seeded
  code text primary key,            -- 'rent','utilities_power','water','internet','insurance','loan','software','supplies','repairs','ingredients','other'
  qb_account_type text not null,    -- mapping for future QuickBooks sync
  icon text not null,
  is_running_cost boolean not null  -- true = rent & bills bucket; false = ingredients (goes to cost of drinks)
);

create table recurring_costs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  category_code text not null references expense_categories,
  label text not null,
  amount_cents bigint not null,
  frequency text not null check (frequency in ('monthly','weekly','quarterly','yearly')),
  due_day int,                      -- day of month
  is_estimate boolean not null default false,
  active_from date not null default current_date,
  active_to date
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  spent_on date not null,
  amount_cents bigint not null,
  vendor text,
  category_code text not null references expense_categories,
  source text not null check (source in ('manual','recurring','receipt','statement','voice','quickbooks','bank_feed')),
  status text not null check (status in ('estimated','actual')),
  recurring_cost_id uuid references recurring_costs,  -- when this is the actual for a recurring bill
  confidence numeric(3,2),          -- AI categorizing confidence
  reason text,                      -- "Matched vendor name PG&E"
  attachment_path text,             -- storage path to receipt/statement
  dedupe_key text not null,         -- sha256(business_id|spent_on|amount_cents|normalized_vendor)
  created_at timestamptz not null default now(),
  unique (business_id, dedupe_key)
);

create table expense_lines (         -- line items from receipts/invoices
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses on delete cascade,
  description text not null,        -- raw "SFWY ORG WHL MLK GAL"
  quantity numeric(12,4),
  unit text,
  amount_cents bigint not null,
  ingredient_id uuid references ingredients   -- after owner confirms mapping
);

create table vendor_rules (          -- learned from owner corrections
  business_id uuid references businesses on delete cascade,
  normalized_vendor text,
  category_code text not null references expense_categories,
  primary key (business_id, normalized_vendor)
);

create table uploads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  kind text not null check (kind in ('statement','receipt','pos_csv')),
  storage_path text not null,
  status text not null default 'processing',  -- processing | needs_review | done | failed
  summary jsonb,                    -- {lines: 84, opening, closing, balance_ok: true}
  created_at timestamptz not null default now()
);

-- ===== Cost recovery order =====
create table recovery_order (
  business_id uuid references businesses on delete cascade,
  bucket_code text not null,        -- expense category code, or 'staff' if owner moves staff into buckets
  position int not null,
  primary key (business_id, bucket_code)
);

-- ===== Rollups (materialized by a job after each sync) =====
create table daily_rollups (
  business_id uuid references businesses on delete cascade,
  business_date date,
  net_sales_cents bigint not null,
  orders_count int not null,
  drinks_count int not null,
  ingredients_cents bigint not null,     -- theoretical from recipes
  staff_wages_cents bigint not null,
  staff_tax_cents bigint not null,
  card_fees_cents bigint not null,
  voids_cents bigint not null,
  primary key (business_id, business_date)
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  kind text not null,               -- 'missing_bill','voids','meal_break','early_clockin','underpriced','overstaffed','covered_milestone'
  impact_cents bigint,
  payload jsonb not null,
  status text not null default 'new', -- new | seen | resolved | dismissed
  created_at timestamptz not null default now()
);
```

## Seed
`expense_categories` seeded with the list above and these QuickBooks mappings:
rent → "Rent or Lease of Buildings", utilities_power/water/internet → "Utilities", insurance → "Insurance",
loan → "Interest Paid" (principal is not an expense; show loan payments in cost recovery but flag for the accountant),
software → "Dues & Subscriptions", supplies → "Supplies & Materials", repairs → "Repair & Maintenance",
ingredients → "Supplies & Materials - COGS", other → "Other Business Expenses".

`npm run db:reset` seeds the **demo café** from `05-calculations.md` so every screen has realistic data.

## RLS pattern (apply to every business-owned table)
```sql
alter table expenses enable row level security;
create policy "members read" on expenses for select
  using (exists (select 1 from memberships m where m.business_id = expenses.business_id and m.user_id = auth.uid()));
create policy "members write" on expenses for all
  using (exists (select 1 from memberships m where m.business_id = expenses.business_id and m.user_id = auth.uid()))
  with check (exists (select 1 from memberships m where m.business_id = expenses.business_id and m.user_id = auth.uid()));
```
Managers with `can_see_profit = false` get profit screens hidden in the UI **and** blocked by a server check on the profit API.
