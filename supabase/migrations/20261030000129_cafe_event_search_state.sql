-- Durable discovery cursor: an empty successful search is still complete.
-- Supporting research metadata only; event facts remain in cafe_events and
-- owner proposals/reports remain in their existing Supervisor loop tables.
-- Apply only after explicit owner approval, after migration 127.
create table public.cafe_event_search_state (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 location_hash text not null check (location_hash ~ '^[0-9a-f]{64}$'),
 scanned_through_date date not null,
 weekly_researched_on date,
 updated_at timestamptz not null default now()
);
alter table public.cafe_event_search_state enable row level security;
revoke all on public.cafe_event_search_state from public,anon,authenticated;
grant all on public.cafe_event_search_state to service_role;
-- No authenticated policy: the state is service-role-only cron metadata.
