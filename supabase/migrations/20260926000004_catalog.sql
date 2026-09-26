-- ===== Catalog & recipes ===== (docs/04-data-model.md)
create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  pos_item_id text,
  name text not null,
  price_cents bigint,
  category text,
  prep_seconds int not null default 60,
  is_active boolean not null default true,
  unique (business_id, pos_item_id)
);

create index if not exists menu_items_business_id_idx on menu_items (business_id);

create table if not exists ingredients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  name text not null,
  base_unit text not null check (base_unit in ('g','ml','each')),
  icon text
);

create index if not exists ingredients_business_id_idx on ingredients (business_id);

create table if not exists ingredient_prices (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients on delete cascade,
  effective_from date not null,
  cost_per_base_unit_micros bigint not null,
  source text not null check (source in ('manual','receipt','statement','invoice')),
  source_expense_line_id uuid
);

create index if not exists ingredient_prices_ingredient_id_idx on ingredient_prices (ingredient_id, effective_from desc);

create table if not exists recipe_lines (
  menu_item_id uuid not null references menu_items on delete cascade,
  ingredient_id uuid not null references ingredients on delete cascade,
  quantity numeric(12,4) not null,
  primary key (menu_item_id, ingredient_id)
);

create table if not exists modifier_recipes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  pos_modifier_id text,
  name text not null,
  ingredient_id uuid references ingredients,
  quantity_delta numeric(12,4) not null default 0,
  replaces_ingredient_id uuid references ingredients
);

create index if not exists modifier_recipes_business_id_idx on modifier_recipes (business_id);
