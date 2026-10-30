-- Facts about nearby events and holidays. Plans and reports belong exclusively to
-- supervisor_proposals and supervisor_reports, not these supporting tables.
create table public.cafe_events (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 name text not null check (length(btrim(name)) between 1 and 200),
 kind text not null check (kind in ('holiday','festival','conference','sports','parade','community','other')),
 start_date date not null,
 end_date date not null,
 start_time time,
 end_time time,
 venue text check (venue is null or length(venue)<=200),
 venue_address text check (venue_address is null or length(venue_address)<=500),
 area_label text check (area_label is null or length(area_label)<=160),
 source_url text check (source_url is null or length(source_url)<=2000),
 status text not null default 'found' check (status in ('found','cancelled','moved')),
 found_at timestamptz not null default now(),
 last_checked_at timestamptz not null default now(),
 constraint cafe_events_dates check (end_date>=start_date),
 constraint cafe_events_source check (kind='holiday' or source_url is not null),
 unique (business_id,id)
);
create index cafe_events_by_date on public.cafe_events
 (business_id,start_date,end_date);
create unique index cafe_events_source_dedupe on public.cafe_events
 (business_id,kind,name,start_date,coalesce(source_url,''));

-- Rows are optional until the owner taps an action in PR 5. Absence means
-- pending, not done. Only an approved/committed plan can receive a tick.
create table public.cafe_event_checklist (
 business_id uuid not null,
 proposal_id uuid not null,
 action_index integer not null check (action_index between 0 and 2),
 state text not null check (state in ('done','dismissed')),
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(),
 primary key (business_id,proposal_id,action_index),
 foreign key (business_id,proposal_id)
   references public.supervisor_proposals(business_id,id) on delete cascade
);
create index cafe_event_checklist_proposal on public.cafe_event_checklist
 (business_id,proposal_id);

alter table public.cafe_events enable row level security;
alter table public.cafe_event_checklist enable row level security;
revoke all on public.cafe_events,public.cafe_event_checklist from public,anon,authenticated;
grant select on public.cafe_events,public.cafe_event_checklist to authenticated;
grant insert,update on public.cafe_event_checklist to authenticated;
grant all on public.cafe_events,public.cafe_event_checklist to service_role;

create policy "owner reads cafe events" on public.cafe_events for select to authenticated
 using (exists(select 1 from public.memberships m
   where m.business_id=cafe_events.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner reads event checklist" on public.cafe_event_checklist for select to authenticated
 using (exists(select 1 from public.supervisor_proposals p join public.memberships m
   on m.business_id=p.business_id and m.user_id=p.owner_user_id and m.role='owner'
   where p.business_id=cafe_event_checklist.business_id
     and p.id=cafe_event_checklist.proposal_id
     and p.owner_user_id=(select auth.uid()) and p.capability_id='alex.event_readiness.v1'));
create policy "owner ticks committed event plan" on public.cafe_event_checklist for insert to authenticated
 with check (updated_by=(select auth.uid()) and exists(select 1 from public.supervisor_proposals p
   join public.memberships m on m.business_id=p.business_id
     and m.user_id=p.owner_user_id and m.role='owner'
   where p.business_id=cafe_event_checklist.business_id
     and p.id=cafe_event_checklist.proposal_id and p.owner_user_id=(select auth.uid())
     and p.capability_id='alex.event_readiness.v1' and p.status in ('committed','monitored')
     and action_index<jsonb_array_length(p.canonical_effect_payload->'actions')));
create policy "owner updates committed event checklist" on public.cafe_event_checklist for update to authenticated
 using (updated_by=(select auth.uid()) and exists(select 1 from public.supervisor_proposals p
   where p.business_id=cafe_event_checklist.business_id
     and p.id=cafe_event_checklist.proposal_id and p.owner_user_id=(select auth.uid())
     and p.capability_id='alex.event_readiness.v1' and p.status in ('committed','monitored')))
 with check (updated_by=(select auth.uid()) and exists(select 1 from public.supervisor_proposals p
   where p.business_id=cafe_event_checklist.business_id
     and p.id=cafe_event_checklist.proposal_id and p.owner_user_id=(select auth.uid())
     and p.capability_id='alex.event_readiness.v1' and p.status in ('committed','monitored')
     and action_index<jsonb_array_length(p.canonical_effect_payload->'actions')));
