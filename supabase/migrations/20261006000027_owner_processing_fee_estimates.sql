-- Phase 3B: owner-confirmed processing-fee rate plans.
-- These are fallback assumptions only; canonical actual processing-fee facts continue to outrank
-- owner estimates through the precedence model introduced in migration 25.
create table if not exists processing_fee_rate_plans (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  effective_from date not null,
  effective_to date,
  processor_label text not null,
  processed_sales_share_bps integer not null check (processed_sales_share_bps between 0 and 10000),
  processed_transaction_share_bps integer not null check (processed_transaction_share_bps between 0 and 10000),
  average_processed_ticket_cents bigint check (average_processed_ticket_cents is null or average_processed_ticket_cents > 0),
  rules jsonb not null,
  confirmed_by uuid,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, effective_from),
  check (effective_to is null or effective_to >= effective_from),
  check (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) > 0)
);

create index if not exists processing_fee_rate_plans_business_dates_idx
  on processing_fee_rate_plans (business_id, effective_from, effective_to);

alter table processing_fee_rate_plans enable row level security;
drop policy if exists "members read" on processing_fee_rate_plans;
drop policy if exists "members write" on processing_fee_rate_plans;
create policy "members read" on processing_fee_rate_plans
  for select using (is_member(business_id));
create policy "members write" on processing_fee_rate_plans
  for all using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on processing_fee_rate_plans to authenticated;
