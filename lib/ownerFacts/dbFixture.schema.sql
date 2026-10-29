-- Disposable PostgreSQL 16 contract for migration 110; never production.
create extension if not exists pgcrypto;
create schema if not exists auth;
do $$ begin
 if not exists (select 1 from pg_roles where rolname='authenticated') then
   create role authenticated nologin;
 end if;
 if not exists (select 1 from pg_roles where rolname='anon') then
   create role anon nologin;
 end if;
end $$;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table public.businesses (
 id uuid primary key, timezone text not null,
 owner_monthly_payroll_extras_cents bigint,
 owner_monthly_payroll_extras_updated_at timestamptz
);
create table public.memberships (
 business_id uuid not null references public.businesses(id),
 user_id uuid not null references auth.users(id),
 role text not null, primary key(business_id,user_id)
);
create table public.recurring_costs (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id),
 category_code text not null, label text not null,
 amount_cents bigint not null, frequency text not null,
 is_estimate boolean not null default false,
 active_from date not null, active_to date
);
create table public.processing_fee_rate_plans (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id),
 effective_from date not null, effective_to date,
 processor_label text not null,
 processed_sales_share_bps integer,
 processed_transaction_share_bps integer,
 average_processed_ticket_cents bigint,
 rules jsonb not null,
 confirmed_by uuid, confirmed_at timestamptz,
 updated_at timestamptz default now(),
 unique(business_id,effective_from)
);
grant usage on schema public,auth to authenticated;
grant select on public.memberships to authenticated;
create table public._owner_fact_test_ids (
 business_a uuid, business_b uuid, user_a uuid, user_b uuid
);
insert into public._owner_fact_test_ids
select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid();
insert into auth.users(id)
select user_a from public._owner_fact_test_ids
union all select user_b from public._owner_fact_test_ids;
insert into public.businesses(id,timezone)
select business_a,'Etc/UTC' from public._owner_fact_test_ids
union all select business_b,'Etc/UTC' from public._owner_fact_test_ids;
insert into public.memberships(business_id,user_id,role)
select business_a,user_a,'owner' from public._owner_fact_test_ids
union all select business_b,user_b,'owner' from public._owner_fact_test_ids;
grant select on public._owner_fact_test_ids to authenticated;
insert into public.recurring_costs(business_id,category_code,label,amount_cents,frequency,is_estimate,active_from)
select business_a,'rent','Recorded rent',3000,'monthly',false,current_date
from public._owner_fact_test_ids;
