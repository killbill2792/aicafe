-- ===== POS facts ===== (docs/04-data-model.md)
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  location_id uuid references locations,
  pos_order_id text not null,
  closed_at timestamptz not null,
  business_date date not null,
  gross_sales_cents bigint not null,
  discounts_cents bigint not null default 0,
  refunds_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  tip_cents bigint not null default 0,
  processing_fee_cents bigint not null default 0,
  net_sales_cents bigint not null,
  customer_ref text,
  unique (business_id, pos_order_id)
);

create index if not exists orders_business_date_idx on orders (business_id, business_date);

create table if not exists order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,
  menu_item_id uuid references menu_items,
  pos_item_id text,
  name text not null,
  quantity numeric(10,2) not null,
  net_sales_cents bigint not null,
  modifiers jsonb not null default '[]'::jsonb,
  voided boolean not null default false,
  voided_by text
);

create index if not exists order_lines_order_id_idx on order_lines (order_id);
create index if not exists order_lines_menu_item_id_idx on order_lines (menu_item_id);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  pos_team_member_id text,
  display_name text not null,
  role text,
  unique (business_id, pos_team_member_id)
);

create index if not exists employees_business_id_idx on employees (business_id);

create table if not exists timecards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  employee_id uuid references employees,
  pos_timecard_id text,
  clock_in timestamptz not null,
  clock_out timestamptz,
  hourly_wage_cents bigint not null,
  breaks jsonb not null default '[]'::jsonb,
  unique (business_id, pos_timecard_id)
);

create index if not exists timecards_business_id_idx on timecards (business_id, clock_in);
create index if not exists timecards_employee_id_idx on timecards (employee_id);
