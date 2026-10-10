-- Owner-provided aggregate product cost fallback.
-- Kept separate from recipe_lines so a total cost is never fabricated as an ingredient.

create table if not exists menu_item_cost_fallbacks (
  business_id uuid not null references businesses on delete cascade,
  menu_item_id uuid not null,
  cost_cents bigint not null check (cost_cents > 0),
  source_type text not null default 'owner_manual'
    check (source_type in ('owner_manual','imported')),
  status text not null default 'confirmed'
    check (status in ('confirmed','estimated')),
  source_label text,
  updated_at timestamptz not null default now(),
  primary key (business_id, menu_item_id),
  foreign key (business_id, menu_item_id)
    references menu_items (business_id, id) on delete cascade
);

alter table menu_item_cost_fallbacks enable row level security;

create policy "members read menu item cost fallbacks"
  on menu_item_cost_fallbacks for select
  using (is_member(business_id));

create policy "members write menu item cost fallbacks"
  on menu_item_cost_fallbacks for all
  using (is_member(business_id))
  with check (is_member(business_id));

grant select, insert, update, delete on menu_item_cost_fallbacks to authenticated;
