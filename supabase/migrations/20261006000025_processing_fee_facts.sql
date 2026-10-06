-- Provider-neutral processing-fee provenance and deterministic daily source selection.
-- Existing numeric zeroes remain conservative `missing`; no historical zero is promoted to actual.
alter table orders add column if not exists processing_fee_status text not null default 'missing';
alter table orders add column if not exists processing_fee_provider text;
alter table orders drop constraint if exists orders_processing_fee_status_check;
alter table orders add constraint orders_processing_fee_status_check
  check (processing_fee_status in ('actual', 'estimated', 'missing'));

alter table daily_rollups add column if not exists card_fees_status text not null default 'missing';
alter table daily_rollups drop constraint if exists daily_rollups_card_fees_status_check;
alter table daily_rollups add constraint daily_rollups_card_fees_status_check
  check (card_fees_status in ('actual', 'estimated', 'missing'));

-- Keep source candidates independently so a temporarily incomplete higher-priority source can
-- fall back to a still-valid lower-priority source instead of leaving stale "actual" economics.
create table if not exists processing_fee_daily_candidates (
  business_id uuid not null references businesses on delete cascade,
  business_date date not null,
  source_type text not null check (source_type in (
    'connected_pos_actual', 'manual_actual', 'owner_confirmed_estimate', 'temporary_estimate'
  )),
  provider text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null check (status in ('actual', 'estimated')),
  source_reference text,
  metadata jsonb not null default '{}'::jsonb,
  eligible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, business_date, source_type, provider),
  check (
    (status = 'actual' and source_type in ('connected_pos_actual', 'manual_actual')) or
    (status = 'estimated' and source_type in ('owner_confirmed_estimate', 'temporary_estimate'))
  )
);

-- Sole selected economic fact consumed by rollups/pricing. No row means processing cost is missing.
create table if not exists processing_fee_daily_facts (
  business_id uuid not null references businesses on delete cascade,
  business_date date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null check (status in ('actual', 'estimated')),
  source_type text not null check (source_type in (
    'connected_pos_actual', 'manual_actual', 'owner_confirmed_estimate', 'temporary_estimate'
  )),
  provider text not null,
  source_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, business_date),
  check (
    (status = 'actual' and source_type in ('connected_pos_actual', 'manual_actual')) or
    (status = 'estimated' and source_type in ('owner_confirmed_estimate', 'temporary_estimate'))
  )
);

alter table processing_fee_daily_candidates enable row level security;
alter table processing_fee_daily_facts enable row level security;
drop policy if exists "members read" on processing_fee_daily_candidates;
drop policy if exists "members write" on processing_fee_daily_candidates;
drop policy if exists "members read" on processing_fee_daily_facts;
drop policy if exists "members write" on processing_fee_daily_facts;
create policy "members read" on processing_fee_daily_candidates for select using (is_member(business_id));
create policy "members write" on processing_fee_daily_candidates for all
  using (is_member(business_id)) with check (is_member(business_id));
create policy "members read" on processing_fee_daily_facts for select using (is_member(business_id));
create policy "members write" on processing_fee_daily_facts for all
  using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on processing_fee_daily_candidates to authenticated;
grant select, insert, update, delete on processing_fee_daily_facts to authenticated;

-- Re-select the best currently-eligible candidate. Higher-quality actual sources win; within the
-- same source class the most recently updated candidate wins deterministically.
create or replace function refresh_processing_fee_daily_fact(
  p_business_id uuid,
  p_business_date date
) returns processing_fee_daily_facts
language plpgsql
security invoker
set search_path = public
as $$
declare
  candidate processing_fee_daily_candidates;
  selected processing_fee_daily_facts;
begin
  select * into candidate
  from processing_fee_daily_candidates
  where business_id = p_business_id
    and business_date = p_business_date
    and eligible = true
  order by
    case source_type
      when 'connected_pos_actual' then 4
      when 'manual_actual' then 3
      when 'owner_confirmed_estimate' then 2
      when 'temporary_estimate' then 1
      else 0
    end desc,
    updated_at desc,
    provider asc
  limit 1;

  if candidate is null then
    delete from processing_fee_daily_facts
    where business_id = p_business_id and business_date = p_business_date;
    return null;
  end if;

  insert into processing_fee_daily_facts (
    business_id, business_date, amount_cents, status, source_type, provider,
    source_reference, metadata, created_at, updated_at
  ) values (
    candidate.business_id, candidate.business_date, candidate.amount_cents, candidate.status,
    candidate.source_type, candidate.provider, candidate.source_reference, candidate.metadata,
    candidate.created_at, now()
  )
  on conflict (business_id, business_date) do update set
    amount_cents = excluded.amount_cents,
    status = excluded.status,
    source_type = excluded.source_type,
    provider = excluded.provider,
    source_reference = excluded.source_reference,
    metadata = excluded.metadata,
    updated_at = now()
  returning * into selected;

  return selected;
end;
$$;

create or replace function upsert_processing_fee_daily_candidate(
  p_business_id uuid,
  p_business_date date,
  p_amount_cents bigint,
  p_status text,
  p_source_type text,
  p_provider text,
  p_source_reference text default null,
  p_metadata jsonb default '{}'::jsonb
) returns processing_fee_daily_facts
language plpgsql
security invoker
set search_path = public
as $$
declare
  selected processing_fee_daily_facts;
begin
  insert into processing_fee_daily_candidates (
    business_id, business_date, source_type, provider, amount_cents, status,
    source_reference, metadata, eligible
  ) values (
    p_business_id, p_business_date, p_source_type, p_provider, p_amount_cents, p_status,
    p_source_reference, coalesce(p_metadata, '{}'::jsonb), true
  )
  on conflict (business_id, business_date, source_type, provider) do update set
    amount_cents = excluded.amount_cents,
    status = excluded.status,
    source_reference = excluded.source_reference,
    metadata = excluded.metadata,
    eligible = true,
    updated_at = now();

  selected := refresh_processing_fee_daily_fact(p_business_id, p_business_date);
  return selected;
end;
$$;

create or replace function set_processing_fee_candidate_eligibility(
  p_business_id uuid,
  p_business_date date,
  p_source_type text,
  p_provider text,
  p_eligible boolean
) returns processing_fee_daily_facts
language plpgsql
security invoker
set search_path = public
as $$
declare
  selected processing_fee_daily_facts;
begin
  update processing_fee_daily_candidates
  set eligible = p_eligible, updated_at = now()
  where business_id = p_business_id
    and business_date = p_business_date
    and source_type = p_source_type
    and provider = p_provider;

  selected := refresh_processing_fee_daily_fact(p_business_id, p_business_date);
  return selected;
end;
$$;

grant execute on function refresh_processing_fee_daily_fact(uuid,date) to authenticated;
grant execute on function upsert_processing_fee_daily_candidate(uuid,date,bigint,text,text,text,text,jsonb) to authenticated;
grant execute on function set_processing_fee_candidate_eligibility(uuid,date,text,text,boolean) to authenticated;

alter table csv_import_mappings drop constraint if exists csv_import_mappings_kind_check;
alter table csv_import_mappings add constraint csv_import_mappings_kind_check
  check (kind in ('sales', 'labor', 'ingredients', 'processing_fees'));

alter table uploads drop constraint if exists uploads_kind_check;
alter table uploads add constraint uploads_kind_check check (kind in (
  'statement', 'receipt', 'pos_csv', 'sales_csv', 'labor_csv', 'ingredients_csv',
  'processing_fees_csv'
));
