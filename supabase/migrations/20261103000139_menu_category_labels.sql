-- Which of a café's own menu categories are drinks.
--
-- Each café names its Toast categories itself ("Specialty", "Traditional",
-- "FALL DRINKS", "Food" …) and Toast has no drink flag. The AI labels each new
-- category once from its name and a few of its item names
-- (lib/menu/drinkLabels.server.ts); the morning brief uses the label to pick
-- yesterday's top drink. One row per café and category. An owner correction
-- (source 'owner') is never overwritten by the AI.

create table if not exists public.menu_category_labels(
 business_id uuid not null references public.businesses(id) on delete cascade,
 category text not null check (length(category) between 1 and 200),
 is_drink boolean not null,
 source text not null check (source in ('ai','owner')),
 labeled_at timestamptz not null default now(),
 primary key (business_id,category)
);
alter table public.menu_category_labels enable row level security;
revoke all on public.menu_category_labels from public,anon,authenticated;
drop policy if exists "owner read" on public.menu_category_labels;
create policy "owner read" on public.menu_category_labels for select
 to authenticated using(public.scheduling_is_owner(business_id));
grant select on public.menu_category_labels to authenticated;
grant select,insert,update,delete on public.menu_category_labels to service_role;
