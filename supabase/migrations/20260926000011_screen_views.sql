-- Basic screen-view analytics (docs/07-build-plan.md M8: "basic analytics (screen views only)").
-- Path only, no event payloads — just enough to see which screens owners actually use during the
-- pilot. Logged from ScreenViewLogger via lib/actions/analytics.ts, one row per route change,
-- signed-in users only (anonymous pages like /privacy and /login are not logged).
create table if not exists screen_views (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);

create index if not exists screen_views_business_id_created_at_idx on screen_views (business_id, created_at desc);

alter table screen_views enable row level security;
drop policy if exists "members read" on screen_views;
drop policy if exists "members write" on screen_views;
create policy "members read" on screen_views for select using (is_member(business_id));
create policy "members write" on screen_views for insert with check (is_member(business_id) and user_id = auth.uid());
