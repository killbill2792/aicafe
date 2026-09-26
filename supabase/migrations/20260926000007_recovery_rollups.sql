-- ===== Cost recovery order, rollups, alerts ===== (docs/04-data-model.md)
create table if not exists recovery_order (
  business_id uuid not null references businesses on delete cascade,
  bucket_code text not null,
  position int not null,
  primary key (business_id, bucket_code)
);

create table if not exists daily_rollups (
  business_id uuid not null references businesses on delete cascade,
  business_date date not null,
  net_sales_cents bigint not null,
  orders_count int not null,
  drinks_count int not null,
  ingredients_cents bigint not null,
  staff_wages_cents bigint not null,
  staff_tax_cents bigint not null,
  card_fees_cents bigint not null,
  voids_cents bigint not null,
  primary key (business_id, business_date)
);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  kind text not null check (kind in ('missing_bill','voids','meal_break','early_clockin','underpriced','overstaffed','covered_milestone')),
  impact_cents bigint,
  payload jsonb not null,
  status text not null default 'new' check (status in ('new','seen','resolved','dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists alerts_business_id_idx on alerts (business_id, status);
