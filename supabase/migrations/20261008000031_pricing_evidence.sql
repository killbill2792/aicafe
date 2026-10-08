-- Evidence for price-change analysis and sourced nearby market comparisons.
-- This does not change pricing math. It preserves what price changed, where that fact came from,
-- and optional verified market observations so owner-facing analysis never guesses.

create unique index if not exists menu_items_business_id_id_idx
  on menu_items (business_id, id);

create table if not exists menu_price_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  menu_item_id uuid not null,
  old_price_cents bigint,
  new_price_cents bigint not null check (new_price_cents > 0),
  source_type text not null check (source_type in ('initial','owner_manual','connected_pos','imported')),
  source_provider text,
  changed_at timestamptz not null default now(),
  foreign key (business_id, menu_item_id)
    references menu_items (business_id, id) on delete cascade
);

create index if not exists menu_price_history_item_changed_idx
  on menu_price_history (business_id, menu_item_id, changed_at desc);

insert into menu_price_history (
  business_id, menu_item_id, old_price_cents, new_price_cents, source_type, source_provider
)
select
  business_id,
  id,
  null,
  price_cents,
  'initial',
  case
    when catalog_source is null then 'Owner'
    else catalog_source
  end
from menu_items
where price_cents is not null
  and price_cents > 0
  and not exists (
    select 1
    from menu_price_history h
    where h.business_id = menu_items.business_id
      and h.menu_item_id = menu_items.id
  );

create table if not exists menu_market_price_observations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  menu_item_id uuid not null,
  competitor_name text not null,
  competitor_address text,
  observed_item_name text not null,
  price_cents bigint not null check (price_cents > 0),
  observed_on date not null,
  distance_meters int check (distance_meters is null or distance_meters >= 0),
  source_url text,
  source_label text not null,
  verified_at timestamptz not null default now(),
  foreign key (business_id, menu_item_id)
    references menu_items (business_id, id) on delete cascade
);

create index if not exists menu_market_price_observations_item_date_idx
  on menu_market_price_observations (business_id, menu_item_id, observed_on desc);

alter table menu_price_history enable row level security;
alter table menu_market_price_observations enable row level security;

create policy "members read price history"
  on menu_price_history for select using (is_member(business_id));
create policy "members write price history"
  on menu_price_history for all using (is_member(business_id)) with check (is_member(business_id));

create policy "members read market prices"
  on menu_market_price_observations for select using (is_member(business_id));
create policy "members write market prices"
  on menu_market_price_observations for all using (is_member(business_id)) with check (is_member(business_id));

grant select, insert, update, delete on menu_price_history, menu_market_price_observations to authenticated;

create or replace function set_menu_item_price_with_history(
  p_business_id uuid,
  p_menu_item_id uuid,
  p_new_price_cents bigint,
  p_source_type text,
  p_source_provider text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old_price_cents bigint;
begin
  if p_new_price_cents is null or p_new_price_cents <= 0 then
    raise exception 'Menu price must be positive';
  end if;
  if p_source_type not in ('owner_manual','connected_pos','imported') then
    raise exception 'Unsupported menu price source';
  end if;

  select price_cents
    into v_old_price_cents
  from menu_items
  where business_id = p_business_id
    and id = p_menu_item_id
  for update;

  if not found then
    return false;
  end if;

  if v_old_price_cents is not distinct from p_new_price_cents then
    return true;
  end if;

  update menu_items
  set price_cents = p_new_price_cents
  where business_id = p_business_id
    and id = p_menu_item_id;

  insert into menu_price_history (
    business_id,
    menu_item_id,
    old_price_cents,
    new_price_cents,
    source_type,
    source_provider
  )
  values (
    p_business_id,
    p_menu_item_id,
    v_old_price_cents,
    p_new_price_cents,
    p_source_type,
    p_source_provider
  );

  return true;
end;
$$;

grant execute on function set_menu_item_price_with_history(uuid, uuid, bigint, text, text) to authenticated;
