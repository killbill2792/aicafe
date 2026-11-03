-- LDI A / migration 137. Staging only: owner approval required before production SQL.
-- Shared rows contain sourced PUBLIC facts only. Existing cafe_events, Supervisor
-- proposals, checklist decisions, verification and reports are never rewritten.
create table public.city_events (
  id uuid primary key default gen_random_uuid(),
  city_key text not null check (length(city_key) between 5 and 240),
  identity_key text not null unique check (identity_key ~ '^[0-9a-f]{64}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  kind text not null check (kind in ('holiday','festival','conference','sports','parade','community','other')),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  venue text check (venue is null or length(venue) <= 200),
  venue_address text check (venue_address is null or length(venue_address) <= 500),
  last_checked_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index city_events_window on public.city_events (city_key,start_date,end_date,id);

create table public.city_event_sources (
  city_event_id uuid not null references public.city_events(id) on delete restrict,
  source_url text not null check (length(source_url) between 8 and 2000 and source_url ~ '^https://'),
  observed_name text not null check (length(btrim(observed_name)) between 1 and 200),
  observed_at timestamptz not null,
  primary key (city_event_id,source_url)
);

-- One coverage result per public city/source/window; failed and partial scans
-- do not erase the most recent COMPLETED (found/none_found) result.
create table public.city_source_coverage (
  city_key text not null check (length(city_key) between 5 and 240),
  source_key text not null check (length(source_key) between 1 and 240),
  window_from date not null,
  window_to date not null,
  status text not null check (status in ('found','none_found','partial','failed')),
  last_checked_at timestamptz not null,
  last_completed_at timestamptz,
  primary key (city_key,source_key,window_from,window_to),
  check (window_to >= window_from)
);
create index city_source_coverage_retry on public.city_source_coverage (city_key,status,last_checked_at);

-- Public source-backed places are independent of each cafe's private demand
-- theory. Unsupported entrance/visitor/route claims are not stored as facts.
create table public.city_places (
  id uuid primary key default gen_random_uuid(),
  city_key text not null check (length(city_key) between 5 and 240),
  identity_key text not null unique check (identity_key ~ '^[0-9a-f]{64}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  kind text not null check (kind in ('office','university','convention','medical','transit','hotel','entertainment','other')),
  address text check (address is null or length(address) <= 500),
  source_url text not null check (length(source_url) between 8 and 2000 and source_url ~ '^https://'),
  calendar_url text check (calendar_url is null or (length(calendar_url) <= 2000 and calendar_url ~ '^https://')),
  last_checked_at timestamptz not null
);
create index city_places_city on public.city_places(city_key,id);

-- An association references EXACTLY one legacy cafe_events UUID in the SAME
-- business, so old proposal eventIds, checklist, live samples and reports survive.
create table public.cafe_city_event_links (
  business_id uuid not null,
  cafe_event_id uuid not null,
  city_event_id uuid not null references public.city_events(id) on delete restrict,
  linked_at timestamptz not null default now(),
  primary key (business_id,cafe_event_id),
  unique (business_id,city_event_id),
  foreign key (business_id,cafe_event_id)
    references public.cafe_events(business_id,id) on delete restrict
);
create index cafe_city_event_links_city on public.cafe_city_event_links(city_event_id);

-- Private to each cafe: a sourced place is public, but that place's possible
-- effect on a given business is NOT. Never copy owner facts or POS into city_places.
create table public.cafe_neighborhood_evidence (
  business_id uuid not null references public.businesses(id) on delete cascade,
  place_id uuid not null references public.city_places(id) on delete restrict,
  assessment text not null check (assessment in ('potential','unlikely','unknown')),
  rationale text check (rationale is null or length(rationale) <= 1200),
  checked_at timestamptz not null,
  primary key (business_id,place_id)
);

alter table public.city_events enable row level security;
alter table public.city_event_sources enable row level security;
alter table public.city_source_coverage enable row level security;
alter table public.city_places enable row level security;
alter table public.cafe_city_event_links enable row level security;
alter table public.cafe_neighborhood_evidence enable row level security;
revoke all on public.city_events,public.city_event_sources,public.city_source_coverage,
  public.city_places,public.cafe_city_event_links,public.cafe_neighborhood_evidence
  from public,anon,authenticated;
grant select on public.city_events,public.city_event_sources,public.city_source_coverage,
  public.city_places,public.cafe_city_event_links,public.cafe_neighborhood_evidence to authenticated;
grant all on public.city_events,public.city_event_sources,public.city_source_coverage,
  public.city_places,public.cafe_city_event_links,public.cafe_neighborhood_evidence to service_role;
-- These tables hold public sourced facts, not owner/POS-derived observations.
create policy city_events_owner_catalog on public.city_events for select to authenticated using (true);
create policy city_event_sources_owner_catalog on public.city_event_sources for select to authenticated using (true);
create policy city_coverage_owner_catalog on public.city_source_coverage for select to authenticated using (true);
create policy city_places_owner_catalog on public.city_places for select to authenticated using (true);
create policy cafe_city_links_owner on public.cafe_city_event_links for select to authenticated
 using (exists(select 1 from public.memberships m
   where m.business_id=cafe_city_event_links.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create policy cafe_neighborhood_owner on public.cafe_neighborhood_evidence for select to authenticated
 using (exists(select 1 from public.memberships m
   where m.business_id=cafe_neighborhood_evidence.business_id and m.user_id=(select auth.uid()) and m.role='owner'));

-- One transaction for the public event AND its provenance. Service role only.
-- First canonical identity wins; later independent sources fill missing venue
-- facts without changing historical dates or changing existing event IDs.
create function public.ldi_upsert_city_event(
  p_city_key text, p_identity_key text, p_name text, p_kind text,
  p_start_date date, p_end_date date, p_source_url text,
  p_checked_at timestamptz, p_venue text default null, p_venue_address text default null
) returns uuid language plpgsql security invoker set search_path=public as $$
declare result_id uuid;
begin
  insert into public.city_events(city_key,identity_key,name,kind,start_date,end_date,
    venue,venue_address,last_checked_at)
  values (p_city_key,p_identity_key,p_name,p_kind,p_start_date,p_end_date,
    p_venue,p_venue_address,p_checked_at)
  on conflict (identity_key) do update set
    last_checked_at=greatest(city_events.last_checked_at,excluded.last_checked_at),
    venue=coalesce(city_events.venue,excluded.venue),
    venue_address=coalesce(city_events.venue_address,excluded.venue_address)
  where city_events.city_key=excluded.city_key and city_events.start_date=excluded.start_date
  returning id into result_id;
  if result_id is null then raise exception 'city_event_identity_conflict' using errcode='23514'; end if;
  insert into public.city_event_sources(city_event_id,source_url,observed_name,observed_at)
    values (result_id,p_source_url,p_name,p_checked_at)
    on conflict (city_event_id,source_url) do update set
      observed_at=greatest(city_event_sources.observed_at,excluded.observed_at);
  return result_id;
end $$;
revoke all on function public.ldi_upsert_city_event(text,text,text,text,date,date,text,timestamptz,text,text)
  from public,anon,authenticated;
grant execute on function public.ldi_upsert_city_event(text,text,text,text,date,date,text,timestamptz,text,text)
  to service_role;

-- Never count a retry as complete without found/none_found evidence; replay of
-- the same timestamp/state is a no-op, and stale completions cannot regress.
create function public.ldi_record_city_coverage(
  p_city_key text, p_source_key text, p_from date, p_to date,
  p_status text, p_checked_at timestamptz
) returns void language plpgsql security invoker set search_path=public as $$
begin
  insert into public.city_source_coverage(city_key,source_key,window_from,window_to,
    status,last_checked_at,last_completed_at)
  values (p_city_key,p_source_key,p_from,p_to,p_status,p_checked_at,
    case when p_status in ('found','none_found') then p_checked_at else null end)
  on conflict (city_key,source_key,window_from,window_to) do update set
    status=case when excluded.last_checked_at >= city_source_coverage.last_checked_at
      then excluded.status else city_source_coverage.status end,
    last_checked_at=greatest(city_source_coverage.last_checked_at,excluded.last_checked_at),
    last_completed_at=case
      when excluded.last_completed_at is null then city_source_coverage.last_completed_at
      else greatest(city_source_coverage.last_completed_at,excluded.last_completed_at) end;
end $$;
revoke all on function public.ldi_record_city_coverage(text,text,date,date,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.ldi_record_city_coverage(text,text,date,date,text,timestamptz)
  to service_role;

create function public.ldi_upsert_city_place(
  p_city_key text, p_identity_key text, p_name text, p_kind text,
  p_address text, p_source_url text, p_calendar_url text, p_checked_at timestamptz
) returns uuid language plpgsql security invoker set search_path=public as $$
declare result_id uuid;
begin
  insert into public.city_places(city_key,identity_key,name,kind,address,source_url,
    calendar_url,last_checked_at)
  values (p_city_key,p_identity_key,p_name,p_kind,p_address,p_source_url,
    p_calendar_url,p_checked_at)
  on conflict(identity_key) do update set
    last_checked_at=greatest(city_places.last_checked_at,excluded.last_checked_at),
    address=coalesce(city_places.address,excluded.address),
    calendar_url=coalesce(city_places.calendar_url,excluded.calendar_url)
  where city_places.city_key=excluded.city_key
  returning id into result_id;
  if result_id is null then raise exception 'city_place_identity_conflict' using errcode='23514'; end if;
  return result_id;
end $$;
revoke all on function public.ldi_upsert_city_place(text,text,text,text,text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.ldi_upsert_city_place(text,text,text,text,text,text,text,timestamptz)
  to service_role;

-- Never relink an existing legacy event UUID or silently choose among duplicate
-- legacy rows. Replays return the SAME cafe_event_id, and conflicting mappings fail.
create function public.ldi_link_cafe_event(
  p_business_id uuid, p_cafe_event_id uuid, p_city_event_id uuid
) returns uuid language plpgsql security invoker set search_path=public as $$
declare existing_id uuid;
begin
  insert into public.cafe_city_event_links(business_id,cafe_event_id,city_event_id)
    values(p_business_id,p_cafe_event_id,p_city_event_id)
    on conflict(business_id,cafe_event_id) do nothing;
  select city_event_id into existing_id from public.cafe_city_event_links
    where business_id=p_business_id and cafe_event_id=p_cafe_event_id;
  if existing_id is distinct from p_city_event_id then
    raise exception 'legacy_event_identity_conflict' using errcode='23514';
  end if;
  return p_cafe_event_id;
end $$;
revoke all on function public.ldi_link_cafe_event(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.ldi_link_cafe_event(uuid,uuid,uuid) to service_role;

-- No backfill here: a guessed match could corrupt event-specific old proposals.
-- E will use confirmed identity matches and this guarded, idempotent link API.


-- Public place + cafe-private hypothesis are written in the SAME transaction.
-- The private assessment never enters the shared city place record.
create function public.ldi_upsert_cafe_neighborhood(
  p_business_id uuid, p_city_key text, p_identity_key text,
  p_name text, p_kind text, p_address text, p_source_url text,
  p_calendar_url text, p_checked_at timestamptz,
  p_assessment text, p_rationale text
) returns uuid language plpgsql security invoker set search_path=public as $$
declare result_id uuid;
begin
  result_id:=public.ldi_upsert_city_place(p_city_key,p_identity_key,p_name,
    p_kind,p_address,p_source_url,p_calendar_url,p_checked_at);
  insert into public.cafe_neighborhood_evidence
    (business_id,place_id,assessment,rationale,checked_at)
  values(p_business_id,result_id,p_assessment,p_rationale,p_checked_at)
  on conflict(business_id,place_id) do update set
    assessment=case when excluded.checked_at>=cafe_neighborhood_evidence.checked_at
      then excluded.assessment else cafe_neighborhood_evidence.assessment end,
    rationale=case when excluded.checked_at>=cafe_neighborhood_evidence.checked_at
      then excluded.rationale else cafe_neighborhood_evidence.rationale end,
    checked_at=greatest(cafe_neighborhood_evidence.checked_at,excluded.checked_at);
  return result_id;
end $$;
revoke all on function public.ldi_upsert_cafe_neighborhood(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text)
  from public,anon,authenticated;
grant execute on function public.ldi_upsert_cafe_neighborhood(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text) to service_role;
