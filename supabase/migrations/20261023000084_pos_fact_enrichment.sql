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

-- The requested data-only-if-absent DDL above is unchanged. One additive RPC
-- is required to rebuild the two existing rollup tables transactionally.
-- Defining the routine does not recalculate or write any production fact.
-- Read-only source: canonical orders. RLS stays effective (SECURITY INVOKER).
create or replace function public.pos_rebuild_sales_fact_rollups_v1(
  p_business_id uuid,
  p_business_date date
) returns void
language plpgsql security invoker set search_path = public
as $$
declare
  v_timezone text;
begin
  if p_business_id is null or p_business_date is null then
    raise exception 'Business and date required';
  end if;
  if auth.role() is distinct from 'service_role' and not public.is_member(p_business_id) then
    raise exception 'Not authorized to rebuild sales facts';
  end if;
  select b.timezone into v_timezone from public.businesses b where b.id = p_business_id;
  if v_timezone is null then
    raise exception 'Business timezone unavailable';
  end if;

  -- A single Postgres transaction covers both tables. The advisory lock
  -- serializes even concurrent guarded Toast promotions for the same date.
  perform pg_advisory_xact_lock(hashtextextended(
    'pos-sales-rollup:' || p_business_id::text || ':' || p_business_date::text, 0
  ));

  delete from public.hourly_sales_rollup
    where business_id = p_business_id and business_date = p_business_date;
  insert into public.hourly_sales_rollup (
    business_id, location_id, business_date, hour_local, net_sales_cents, orders_count
  )
  select o.business_id, o.location_id, o.business_date,
    extract(hour from o.closed_at at time zone v_timezone)::smallint,
    sum(o.net_sales_cents)::bigint, count(*)::integer
  from public.orders o
  where o.business_id = p_business_id and o.business_date = p_business_date
    and o.pos_order_id not like 'csv-%'
  group by o.business_id, o.location_id, o.business_date,
    extract(hour from o.closed_at at time zone v_timezone)::smallint;

  delete from public.employee_sales_rollup
    where business_id = p_business_id and business_date = p_business_date;
  insert into public.employee_sales_rollup (
    business_id, employee_id, business_date, net_sales_cents, orders_count
  )
  select o.business_id, o.employee_id, o.business_date,
    sum(o.net_sales_cents)::bigint, count(*)::integer
  from public.orders o
  join public.employees e on e.id = o.employee_id and e.business_id = o.business_id
  where o.business_id = p_business_id and o.business_date = p_business_date
  group by o.business_id, o.employee_id, o.business_date;
end;
$$;
revoke all on function public.pos_rebuild_sales_fact_rollups_v1(uuid,date) from public, anon;
grant execute on function public.pos_rebuild_sales_fact_rollups_v1(uuid,date) to authenticated, service_role;
