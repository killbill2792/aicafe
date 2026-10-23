-- Additive mirror of POS facts already present in the production database.
-- Do not backfill or overwrite production values in this migration.
alter table public.orders add column if not exists employee_id uuid references public.employees(id);
alter table public.orders add column if not exists dining_option text;
alter table public.orders add column if not exists source_channel text;
alter table public.orders add column if not exists guest_count smallint;
alter table public.order_lines add column if not exists category text;

create table if not exists public.hourly_sales_rollup (
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid references public.locations(id),
  business_date date not null,
  hour_local smallint not null check (hour_local between 0 and 23),
  net_sales_cents bigint not null,
  orders_count integer not null
);

create table if not exists public.employee_sales_rollup (
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  business_date date not null,
  net_sales_cents bigint not null,
  orders_count integer not null
);

create table if not exists public.employee_pay_period_facts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  pay_period_end date not null,
  regular_cents bigint,
  overtime_cents bigint,
  double_overtime_cents bigint,
  gross_cents bigint,
  employee_tax_cents bigint,
  employer_tax_cents bigint,
  net_cents bigint,
  source text
);

create index if not exists hourly_sales_rollup_business_date_idx
  on public.hourly_sales_rollup (business_id, business_date);
create index if not exists employee_sales_rollup_business_date_idx
  on public.employee_sales_rollup (business_id, business_date);
create index if not exists employee_pay_period_facts_business_end_idx
  on public.employee_pay_period_facts (business_id, pay_period_end);

-- Match existing business-scoped tables. Preserve every policy already present:
-- PostgreSQL has no CREATE POLICY IF NOT EXISTS, so use catalog checks.
do $$
declare t text;
begin
  foreach t in array array['hourly_sales_rollup','employee_sales_rollup','employee_pay_period_facts'] loop
    execute format('alter table public.%I enable row level security',t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='members read') then
      execute format('create policy "members read" on public.%I for select using (public.is_member(business_id))',t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='members write') then
      execute format('create policy "members write" on public.%I for all using (public.is_member(business_id)) with check (public.is_member(business_id))',t);
    end if;
  end loop;
end $$;
