-- P1 menu UI extension: persisted add-on selections and combo membership only.
-- PR 150's pantry/recipe tables and migrations remain authoritative.
create unique index if not exists menu_items_id_business_unique on public.menu_items(id,business_id);
create unique index if not exists ingredients_id_business_unique on public.ingredients(id,business_id);

create table if not exists public.menu_product_addons (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 menu_item_id uuid not null,
 ingredient_id uuid not null,
 kind text not null check (kind in ('milk','extra')),
 enabled boolean not null default false,
 is_default boolean not null default false,
 upcharge_cents bigint not null default 0 check (upcharge_cents >= 0),
 display_unit text not null check (display_unit in ('g','ml','fl_oz','each','shot','pump')),
 display_quantity numeric(12,4) not null check (display_quantity > 0),
 foreign key (menu_item_id,business_id) references public.menu_items(id,business_id) on delete cascade,
 foreign key (ingredient_id,business_id) references public.ingredients(id,business_id) on delete cascade,
 unique (menu_item_id,kind,ingredient_id),
 check (kind = 'milk' or not is_default)
);
create unique index if not exists menu_product_addons_one_default
 on public.menu_product_addons(menu_item_id) where kind = 'milk' and is_default;
create index if not exists menu_product_addons_business_item_idx on public.menu_product_addons(business_id,menu_item_id);
alter table public.menu_product_addons enable row level security;
create policy "members read" on public.menu_product_addons for select using (public.is_member(business_id));
create policy "members write" on public.menu_product_addons for all using (public.is_member(business_id)) with check (public.is_member(business_id));

create table if not exists public.menu_combo_components (
 business_id uuid not null references public.businesses(id) on delete cascade,
 combo_item_id uuid not null,
 component_item_id uuid not null,
 quantity integer not null default 1 check (quantity > 0 and quantity <= 100),
 buy_in_cost_cents bigint check (buy_in_cost_cents is null or buy_in_cost_cents > 0),
 primary key(combo_item_id,component_item_id),
 foreign key(combo_item_id,business_id) references public.menu_items(id,business_id) on delete cascade,
 foreign key(component_item_id,business_id) references public.menu_items(id,business_id) on delete restrict,
 check (combo_item_id <> component_item_id)
);
create index if not exists menu_combo_components_business_idx on public.menu_combo_components(business_id);
alter table public.menu_combo_components enable row level security;
create policy "members read" on public.menu_combo_components for select using (public.is_member(business_id));
create policy "members write" on public.menu_combo_components for all using (public.is_member(business_id)) with check (public.is_member(business_id));

-- Atomic option replacement. A single RPC locks the product's size family,
-- validates each option and its owner-scoped ingredient, and commits all or none.
create or replace function public.save_menu_product_addons(
 p_business_id uuid,p_item_id uuid,p_options jsonb
) returns void language plpgsql security invoker set search_path=public as $$
declare
 family_name text;
 option_row jsonb;
 normalized_kind text;
 option_ingredient uuid;
 option_unit text;
 option_quantity numeric;
 option_cost bigint;
 options_array jsonb;
 recipe_changes jsonb;
begin
 if auth.uid() is null or not public.is_member(p_business_id) then
  raise exception 'not authorized' using errcode='42501';
 end if;
 -- Match P1 recipe RPC lock ordering: identity read, family advisory lock,
 -- optional verified recipe replacement, then sorted sibling row locks.
 -- Locking the clicked size first can deadlock another editor using a sibling.
 select base_name into family_name from public.menu_items where id=p_item_id and business_id=p_business_id;
 if not found then raise exception 'product not found'; end if;
 perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || family_name));
 options_array := case when jsonb_typeof(p_options)='object' then p_options->'options' else p_options end;
 recipe_changes := case when jsonb_typeof(p_options)='object' then p_options->'recipeChanges' else null end;
 if jsonb_typeof(options_array) is distinct from 'array' or jsonb_array_length(options_array)>60
   then raise exception 'invalid options'; end if;
 if recipe_changes is not null then
   if jsonb_typeof(recipe_changes) is distinct from 'array' or jsonb_array_length(recipe_changes)<1
     then raise exception 'invalid recipe changes'; end if;
   -- P1 CAS and its cross-size atomic replacement execute IN THIS transaction.
   -- A failing price/unit/snapshot validation rolls back options and recipe together.
   perform public.pantry_replace_recipes(p_business_id,p_item_id,recipe_changes);
 end if;
 perform 1 from public.menu_items where business_id=p_business_id and base_name=family_name order by id for update;
 delete from public.menu_product_addons a using public.menu_items m
  where a.menu_item_id=m.id and a.business_id=p_business_id and m.business_id=p_business_id and m.base_name=family_name;
 for option_row in select value from jsonb_array_elements(options_array) loop
  normalized_kind := option_row->>'kind';
  option_ingredient := (option_row->>'ingredientId')::uuid;
  option_unit := option_row->>'displayUnit';
  option_quantity := (option_row->>'displayQuantity')::numeric;
  option_cost := (option_row->>'upchargeCents')::bigint;
  if normalized_kind not in ('milk','extra')
    or option_unit not in ('g','ml','fl_oz','each','shot','pump')
    or option_quantity is null or option_quantity <= 0 or option_quantity > 100000
    or option_cost is null or option_cost < 0 then raise exception 'invalid option'; end if;
  if not exists (select 1 from public.ingredients where id=option_ingredient and business_id=p_business_id) then
   raise exception 'ingredient not found'; end if;
  insert into public.menu_product_addons(business_id,menu_item_id,ingredient_id,kind,enabled,is_default,upcharge_cents,display_unit,display_quantity)
   values(p_business_id,p_item_id,option_ingredient,normalized_kind,
    coalesce((option_row->>'enabled')::boolean,false),
    coalesce((option_row->>'isDefault')::boolean,false),
    option_cost,option_unit,option_quantity);
 end loop;
end;$$;
