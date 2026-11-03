-- LDI E. Additive staging migration 138; NEVER apply to production without owner approval.
-- Extends A's public place facts and source-coverage ledger; no second event store.
-- A's event aliases, cafe_events UUIDs, RLS policies and Supervisor history remain unchanged.

alter table public.city_places
  add column visitor_info_url text,
  add column visitor_approach text,
  add column visitor_approach_source_url text,
  add column entrance text,
  add column entrance_source_url text,
  add column source_status text,
  add column source_checked_at timestamptz;
alter table public.city_places
  add constraint ldi_visitor_info_url_https check
    (visitor_info_url is null or
      (length(visitor_info_url) <= 2000 and visitor_info_url ~ '^https://')),
  add constraint ldi_visitor_approach_length check
    (visitor_approach is null or length(visitor_approach) <= 180),
  add constraint ldi_visitor_approach_url_https check
    (visitor_approach_source_url is null or
      (length(visitor_approach_source_url) <= 2000 and visitor_approach_source_url ~ '^https://')),
  add constraint ldi_entrance_length check
    (entrance is null or length(entrance) <= 120),
  add constraint ldi_entrance_url_https check
    (entrance_source_url is null or
      (length(entrance_source_url) <= 2000 and entrance_source_url ~ '^https://')),
  add constraint ldi_city_place_source_status check
    (source_status is null or source_status = 'cited_public_page');

-- Missing event hours remain NULL. These fields only accept page-cited
-- enrichments of A's canonical city_events rows, never speculative schedules.
alter table public.city_events
  add column start_time text check
    (start_time is null or start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]
-- Explicit unsearched versus attempted state persists across failed cron runs.
alter table public.city_source_coverage
  add column scan_from date,
  add column scan_to date,
  add column window_reason text not null default 'initial',
  add column search_attempted boolean not null default true,
  add column is_scan_root boolean not null default false,
  add column failure_category text;
update public.city_source_coverage
set scan_from = window_from, scan_to = window_to
where scan_from is null or scan_to is null;
alter table public.city_source_coverage
  alter column scan_from set not null,
  alter column scan_to set not null;
alter table public.city_source_coverage
  add constraint ldi_coverage_scan_window check (scan_to >= scan_from),
  add constraint ldi_coverage_window_reason check (window_reason in ('initial','weekly','new_day')),
  add constraint ldi_coverage_failure_length check
    (failure_category is null or length(failure_category) <= 80);
create index city_source_coverage_pending_window
  on public.city_source_coverage(city_key,scan_to,scan_from,status);

-- Migration 137's coverage RPC must insert valid scan bounds now that they
-- are NOT NULL; PostgreSQL checks them before ON CONFLICT can update a queued
-- root row. Split/child attempts create non-root rows with their true dates.
create or replace function public.ldi_record_city_coverage(
  p_city_key text, p_source_key text, p_from date, p_to date,
  p_status text, p_checked_at timestamptz
) returns void language plpgsql security invoker set search_path=public as $
begin
  insert into public.city_source_coverage(
    city_key,source_key,window_from,window_to,scan_from,scan_to,
    status,search_attempted,is_scan_root,last_checked_at,last_completed_at)
  values (
    p_city_key,p_source_key,p_from,p_to,p_from,p_to,
    p_status,true,false,p_checked_at,
    case when p_status in ('found','none_found') then p_checked_at else null end)
  on conflict (city_key,source_key,window_from,window_to) do update set
    status=case when excluded.last_checked_at>=city_source_coverage.last_checked_at
      then excluded.status else city_source_coverage.status end,
    search_attempted=case when excluded.last_checked_at>=city_source_coverage.last_checked_at
      then true else city_source_coverage.search_attempted end,
    last_checked_at=greatest(city_source_coverage.last_checked_at,excluded.last_checked_at),
    last_completed_at=case
      when excluded.last_completed_at is null then city_source_coverage.last_completed_at
      else greatest(city_source_coverage.last_completed_at,excluded.last_completed_at) end;
end $;
-- Retain migration 137's revoked public/authenticated execute privileges;
-- CREATE OR REPLACE changes the body, not function identity/ACL.
revoke all on function public.ldi_record_city_coverage(
  text,text,date,date,text,timestamptz) from public,anon,authenticated;
grant execute on function public.ldi_record_city_coverage(
  text,text,date,date,text,timestamptz) to service_role;

-- Neighborhood scope coverage belongs to the CAFÉ, not the shared place.
-- A successful scope retains its completion timestamp after later failures.
create table public.cafe_neighborhood_source_coverage (
  business_id uuid not null references public.businesses(id) on delete cascade,
  scope text not null check (scope in
    ('campus_and_conventions','workday','arrivals_and_stays','evenings_and_weekends')),
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('found','none_found','partial','failed')),
  retry_eligible boolean not null default true,
  checked_at timestamptz not null,
  last_completed_at timestamptz,
  failure_category text check
    (failure_category is null or length(failure_category) <= 80),
  places_found integer not null default 0 check (places_found >= 0),
  discarded_candidates integer not null default 0 check (discarded_candidates >= 0),
  primary key (business_id,scope)
);
create index cafe_neighborhood_coverage_retry
  on public.cafe_neighborhood_source_coverage
  (business_id,address_hash,retry_eligible,checked_at);
alter table public.cafe_neighborhood_source_coverage enable row level security;
revoke all on public.cafe_neighborhood_source_coverage from public,anon,authenticated;
grant select on public.cafe_neighborhood_source_coverage to authenticated;
grant all on public.cafe_neighborhood_source_coverage to service_role;
create policy cafe_neighborhood_coverage_owner on
  public.cafe_neighborhood_source_coverage
  for select to authenticated using (
    exists(select 1 from public.memberships m
      where m.business_id=cafe_neighborhood_source_coverage.business_id
        and m.user_id=(select auth.uid()) and m.role='owner')
  );
),
  add column end_time text check
    (end_time is null or end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]
-- Explicit unsearched versus attempted state persists across failed cron runs.
alter table public.city_source_coverage
  add column scan_from date,
  add column scan_to date,
  add column window_reason text not null default 'initial',
  add column search_attempted boolean not null default true,
  add column failure_category text;
update public.city_source_coverage
set scan_from = window_from, scan_to = window_to
where scan_from is null or scan_to is null;
alter table public.city_source_coverage
  alter column scan_from set not null,
  alter column scan_to set not null;
alter table public.city_source_coverage
  add constraint ldi_coverage_scan_window check (scan_to >= scan_from),
  add constraint ldi_coverage_window_reason check (window_reason in ('initial','weekly','new_day')),
  add constraint ldi_coverage_failure_length check
    (failure_category is null or length(failure_category) <= 80);
create index city_source_coverage_pending_window
  on public.city_source_coverage(city_key,scan_to,scan_from,status);

-- Neighborhood scope coverage belongs to the CAFÉ, not the shared place.
-- A successful scope retains its completion timestamp after later failures.
create table public.cafe_neighborhood_source_coverage (
  business_id uuid not null references public.businesses(id) on delete cascade,
  scope text not null check (scope in
    ('campus_and_conventions','workday','arrivals_and_stays','evenings_and_weekends')),
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('found','none_found','partial','failed')),
  retry_eligible boolean not null default true,
  checked_at timestamptz not null,
  last_completed_at timestamptz,
  failure_category text check
    (failure_category is null or length(failure_category) <= 80),
  places_found integer not null default 0 check (places_found >= 0),
  discarded_candidates integer not null default 0 check (discarded_candidates >= 0),
  primary key (business_id,scope)
);
create index cafe_neighborhood_coverage_retry
  on public.cafe_neighborhood_source_coverage
  (business_id,address_hash,retry_eligible,checked_at);
alter table public.cafe_neighborhood_source_coverage enable row level security;
revoke all on public.cafe_neighborhood_source_coverage from public,anon,authenticated;
grant select on public.cafe_neighborhood_source_coverage to authenticated;
grant all on public.cafe_neighborhood_source_coverage to service_role;
create policy cafe_neighborhood_coverage_owner on
  public.cafe_neighborhood_source_coverage
  for select to authenticated using (
    exists(select 1 from public.memberships m
      where m.business_id=cafe_neighborhood_source_coverage.business_id
        and m.user_id=(select auth.uid()) and m.role='owner')
  );
),
  add column time_source_url text check
    (time_source_url is null or
      (length(time_source_url) <= 2000 and time_source_url ~ '^https://')),
  add column last_enriched_at timestamptz;

-- A's coverage remains the ONLY public city/source/window status ledger.
-- Explicit unsearched versus attempted state persists across failed cron runs.
alter table public.city_source_coverage
  add column scan_from date,
  add column scan_to date,
  add column window_reason text not null default 'initial',
  add column search_attempted boolean not null default true,
  add column failure_category text;
update public.city_source_coverage
set scan_from = window_from, scan_to = window_to
where scan_from is null or scan_to is null;
alter table public.city_source_coverage
  alter column scan_from set not null,
  alter column scan_to set not null;
alter table public.city_source_coverage
  add constraint ldi_coverage_scan_window check (scan_to >= scan_from),
  add constraint ldi_coverage_window_reason check (window_reason in ('initial','weekly','new_day')),
  add constraint ldi_coverage_failure_length check
    (failure_category is null or length(failure_category) <= 80);
create index city_source_coverage_pending_window
  on public.city_source_coverage(city_key,scan_to,scan_from,status);

-- Neighborhood scope coverage belongs to the CAFÉ, not the shared place.
-- A successful scope retains its completion timestamp after later failures.
create table public.cafe_neighborhood_source_coverage (
  business_id uuid not null references public.businesses(id) on delete cascade,
  scope text not null check (scope in
    ('campus_and_conventions','workday','arrivals_and_stays','evenings_and_weekends')),
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('found','none_found','partial','failed')),
  retry_eligible boolean not null default true,
  checked_at timestamptz not null,
  last_completed_at timestamptz,
  failure_category text check
    (failure_category is null or length(failure_category) <= 80),
  places_found integer not null default 0 check (places_found >= 0),
  discarded_candidates integer not null default 0 check (discarded_candidates >= 0),
  primary key (business_id,scope)
);
create index cafe_neighborhood_coverage_retry
  on public.cafe_neighborhood_source_coverage
  (business_id,address_hash,retry_eligible,checked_at);
alter table public.cafe_neighborhood_source_coverage enable row level security;
revoke all on public.cafe_neighborhood_source_coverage from public,anon,authenticated;
grant select on public.cafe_neighborhood_source_coverage to authenticated;
grant all on public.cafe_neighborhood_source_coverage to service_role;
create policy cafe_neighborhood_coverage_owner on
  public.cafe_neighborhood_source_coverage
  for select to authenticated using (
    exists(select 1 from public.memberships m
      where m.business_id=cafe_neighborhood_source_coverage.business_id
        and m.user_id=(select auth.uid()) and m.role='owner')
  );
