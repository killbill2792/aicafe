-- ===== Tenancy ===== (docs/04-data-model.md)
create table if not exists businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Los_Angeles',
  currency text not null default 'USD',
  payroll_tax_rate numeric(5,4) not null default 0.12,
  default_language text not null default 'en' check (default_language in ('en','es','ar')),
  opened_on date,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  business_id uuid not null references businesses on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('owner','manager')),
  can_see_profit boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create index if not exists memberships_user_id_idx on memberships (user_id);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  name text not null,
  pos_location_id text,
  open_hours jsonb
);

create index if not exists locations_business_id_idx on locations (business_id);
