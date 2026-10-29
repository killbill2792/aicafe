-- Toast "today so far", read every 15 minutes and saved here so the Home key
-- numbers and the chat show the same live reading. One row per café: the
-- latest reading. Provisional; the closeout import replaces it with the final day.
create table if not exists public.toast_today_live(
 business_id uuid primary key references public.businesses(id) on delete cascade,
 business_date date not null,
 read_at timestamptz not null,
 net_sales_cents bigint not null,
 orders integer not null,
 reading jsonb not null,
 updated_at timestamptz not null default now()
);
alter table public.toast_today_live enable row level security;
revoke all on public.toast_today_live from public,anon,authenticated;
create policy "owner read" on public.toast_today_live for select
 to authenticated using(public.scheduling_is_owner(business_id));
grant select on public.toast_today_live to authenticated;
grant select,insert,update,delete on public.toast_today_live to service_role;
