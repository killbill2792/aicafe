-- P1 pantry: optional starter identity and purchase-pack information.
-- Additive only. Existing owner ingredients, prices, conversions and recipe lines remain untouched.
-- Existing ingredient/price row-level security policies continue to apply.
alter table public.ingredients
  add column if not exists starter_key text,
  add column if not exists category text;

alter table public.ingredients
  add constraint ingredients_pantry_category_check
  check (category is null or category in (
    'coffee','milk','syrup','sauce','powder','tea','packaging','bakery','food','other'
  ));

create unique index if not exists ingredients_business_starter_key_unique
  on public.ingredients (business_id, starter_key)
  where starter_key is not null;

alter table public.ingredient_prices
  add column if not exists pack_quantity numeric,
  add column if not exists pack_unit text,
  add column if not exists pack_cost_cents bigint,
  add column if not exists recorded_at timestamptz not null default now();

alter table public.ingredient_prices
  add constraint ingredient_prices_pack_quantity_positive
  check (pack_quantity is null or pack_quantity > 0),
  add constraint ingredient_prices_pack_cost_positive
  check (pack_cost_cents is null or pack_cost_cents > 0),
  add constraint ingredient_prices_pack_unit_check
  check (pack_unit is null or pack_unit in (
    'gal','qt','l','ml','fl_oz','lb','kg','oz_wt','g','each','dozen','oz'
  ) or pack_unit ~ '^case[(][1-9][0-9]*[)]$');

-- Stable latest-effective pricing when the owner changes a pack twice on the same day.
create index if not exists ingredient_prices_effective_recorded_idx
  on public.ingredient_prices (ingredient_id, effective_from desc, recorded_at desc, id desc);

-- Atomic, scoped bulk recipe replacement. Never delete one size until every requested
-- size/ingredient has been validated. RLS remains enabled, and SECURITY INVOKER is deliberate.
create or replace function public.pantry_replace_recipes(
  p_business_id uuid, p_product_item_id uuid, p_changes jsonb
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare
  parent_base text;
  c jsonb;
  ln jsonb;
  item uuid;
  ingredient uuid;
  actual jsonb;
  source_expected jsonb;
  sibling_ids jsonb;
  seen_items uuid[] := '{}';
  seen_ingredients uuid[];
  updated_ids uuid[] := '{}';
begin
  if auth.uid() is null or not public.is_member(p_business_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  -- Resolve product identity without a row lock, then acquire the shared product
  -- advisory lock BEFORE locking any sibling row, avoiding cross-size deadlocks.
  select base_name into parent_base from public.menu_items
    where id=p_product_item_id and business_id=p_business_id;
  if not found then raise exception 'product not found'; end if;
  perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || parent_base));
  perform 1 from public.menu_items where id=p_product_item_id
    and business_id=p_business_id and base_name=parent_base for update;
  if not found then raise exception 'product changed'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array'
     or jsonb_array_length(p_changes) not between 1 and 64
    then raise exception 'invalid recipe changes'; end if;
  if p_changes->0 ? 'expectedSiblingIds' then
    select coalesce(jsonb_agg(id::text order by id), '[]'::jsonb) into sibling_ids
      from public.menu_items
      where business_id=p_business_id and base_name=parent_base;
    if sibling_ids is distinct from p_changes->0->'expectedSiblingIds' then
      raise exception 'recipe_family_changed' using errcode='40001'; end if;
  end if;
  -- If the source recipe was read before this transaction, detect any intervening
  -- edits, including legacy single-line writes, before applying derived changes.
  source_expected := p_changes->0->'expectedSourceLines';
  if source_expected is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'ingredientId',ingredient_id::text,'quantity',quantity,
      'displayUnit',display_unit,'displayQuantity',display_quantity
    ) order by ingredient_id),'[]'::jsonb) into actual
      from public.recipe_lines where menu_item_id=p_product_item_id;
    if actual is distinct from source_expected then
      raise exception 'recipe_changed' using errcode='40001'; end if;
  end if;
  for c in select value from jsonb_array_elements(p_changes) loop
    item := (c->>'menuItemId')::uuid;
    if item=any(seen_items) then raise exception 'duplicate menu item'; end if;
    seen_items := array_append(seen_items,item);
    perform 1 from public.menu_items
      where id=item and business_id=p_business_id and base_name=parent_base for update;
    if not found then raise exception 'item not in product'; end if;
    if jsonb_typeof(c->'lines') is distinct from 'array'
      or jsonb_array_length(c->'lines') > 80 then raise exception 'invalid recipe lines'; end if;
    if c ? 'expectedLines' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'ingredientId',ingredient_id::text,'quantity',quantity,
        'displayUnit',display_unit,'displayQuantity',display_quantity
      ) order by ingredient_id),'[]'::jsonb) into actual
        from public.recipe_lines where menu_item_id=item;
      if actual is distinct from c->'expectedLines' then
        raise exception 'recipe_changed' using errcode='40001'; end if;
    end if;
    seen_ingredients := '{}';
    for ln in select value from jsonb_array_elements(c->'lines') loop
      ingredient := (ln->>'ingredientId')::uuid;
      if ingredient=any(seen_ingredients) then raise exception 'duplicate ingredient'; end if;
      seen_ingredients := array_append(seen_ingredients,ingredient);
      perform 1 from public.ingredients
        where id=ingredient and business_id=p_business_id;
      if not found then raise exception 'ingredient not in business'; end if;
      if (ln->>'quantity')::numeric <= 0
        or (ln->>'quantity')::numeric > 999999
        or (ln->>'displayQuantity')::numeric <= 0
        or (ln->>'displayQuantity')::numeric > 999999
        or (ln->>'displayUnit') not in ('g','ml','fl_oz','each','shot','pump')
        then raise exception 'invalid recipe quantity or unit'; end if;
    end loop;
  end loop;
  for c in select value from jsonb_array_elements(p_changes) loop
    if c->>'checkOnly' = 'true' then continue; end if;
    item := (c->>'menuItemId')::uuid;
    delete from public.recipe_lines where menu_item_id=item;
    insert into public.recipe_lines
      (menu_item_id, ingredient_id, quantity, display_unit, display_quantity)
    select item, (r.value->>'ingredientId')::uuid, (r.value->>'quantity')::numeric,
      r.value->>'displayUnit', (r.value->>'displayQuantity')::numeric
    from jsonb_array_elements(c->'lines') as r(value);
    updated_ids := array_append(updated_ids,item);
  end loop;
  return jsonb_build_object('itemIds',to_jsonb(updated_ids));
end;
$$;

-- Add missing sizes as INACTIVE drafts with no invented selling price; existing POS
-- items retain their identities, prices, and active state. Roll back everything on error.
create or replace function public.pantry_apply_sized_recipes(
  p_business_id uuid, p_product_item_id uuid, p_sizes jsonb
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare
  parent_row public.menu_items%rowtype;
  size_row jsonb;
  label text;
  chosen uuid;
  matches uuid[];
  changes jsonb := '[]'::jsonb;
  seen_labels text[] := '{}';
  default_size text;
  original_base text;
begin
  if auth.uid() is null or not public.is_member(p_business_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select * into parent_row from public.menu_items
    where id=p_product_item_id and business_id=p_business_id;
  if not found then raise exception 'product not found'; end if;
  original_base := parent_row.base_name;
  perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || original_base));
  select * into parent_row from public.menu_items
    where id=p_product_item_id and business_id=p_business_id for update;
  if not found or parent_row.base_name is distinct from original_base
    then raise exception 'product changed'; end if;
  if jsonb_typeof(p_sizes) is distinct from 'array'
    or jsonb_array_length(p_sizes) not between 3 and 4
    then raise exception 'invalid size set'; end if;
  default_size := case when jsonb_array_length(p_sizes)=3 then '16 oz' else '12 oz' end;
  for size_row in select value from jsonb_array_elements(p_sizes) loop
    label := size_row->>'sizeLabel';
    if label !~ '^(8|12|16|20|24) oz$' or label=any(seen_labels)
      then raise exception 'invalid or repeated size'; end if;
    seen_labels := array_append(seen_labels,label);
    if jsonb_typeof(size_row->'lines') <> 'array' then raise exception 'invalid recipe'; end if;
    select array_agg(id order by id) into matches from public.menu_items
      where business_id=p_business_id and base_name=parent_row.base_name and size_label=label;
    if coalesce(array_length(matches,1),0)>1 then raise exception 'duplicate size in menu'; end if;
    chosen := matches[1];
    if chosen is null and parent_row.size_label is null and label=default_size then
      -- Keep the POS-linked parent ID/name/price intact; only persist size metadata.
      update public.menu_items set size_label=label
        where id=parent_row.id and business_id=p_business_id
        returning id into chosen;
    end if;
    if chosen is null then
      insert into public.menu_items (
        business_id, name, base_name, size_label, price_cents, prep_seconds,
        category, menu_group, is_active, catalog_source
      ) values (
        p_business_id, parent_row.base_name || ' ' || label, parent_row.base_name,
        label, null, parent_row.prep_seconds, parent_row.category, parent_row.menu_group,
        false, 'manual'
      ) returning id into chosen;
    end if;
    changes := changes || jsonb_build_array(
      jsonb_build_object('menuItemId',chosen,'lines',size_row->'lines'));
  end loop;
  return public.pantry_replace_recipes(p_business_id,p_product_item_id,changes);
end;
$$;

revoke all on function public.pantry_replace_recipes(uuid,uuid,jsonb) from public;
revoke all on function public.pantry_apply_sized_recipes(uuid,uuid,jsonb) from public;
grant execute on function public.pantry_replace_recipes(uuid,uuid,jsonb) to authenticated;
grant execute on function public.pantry_apply_sized_recipes(uuid,uuid,jsonb) to authenticated;

-- One transactional, idempotent install of starter rows AND ingredient-specific conversions.
-- The partial unique starter index is used directly by the ON CONFLICT predicate.
create or replace function public.pantry_add_starters(
  p_business_id uuid, p_items jsonb
) returns jsonb
language plpgsql security invoker set search_path=public
as $$
declare
  item jsonb;
  found_id uuid;
  added text[] := '{}';
  key text;
  operational text;
begin
  if auth.uid() is null or not public.is_member(p_business_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) not between 1 and 80
    then raise exception 'invalid starters'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    key := item->>'starterKey';
    operational := item->>'operationalUnit';
    if key is null or length(key)>100
      or (item->>'baseUnit') not in ('g','ml','each')
      or (item->>'category') not in ('coffee','milk','syrup','sauce','powder','tea','packaging','bakery','food','other')
      or nullif(btrim(item->>'name'),'') is null
      or (operational is not null and operational not in ('shot','pump'))
      then raise exception 'invalid starter'; end if;
    found_id := null;
    insert into public.ingredients(business_id,starter_key,name,base_unit,category)
      values(p_business_id,key,item->>'name',item->>'baseUnit',item->>'category')
      on conflict (business_id,starter_key) where starter_key is not null do nothing
      returning id into found_id;
    if found_id is not null then added := array_append(added,key); end if;
    select id into found_id from public.ingredients
      where business_id=p_business_id and starter_key=key;
    if found_id is null then raise exception 'could not find starter'; end if;
    if operational is not null then
      if coalesce((item->>'baseUnitsPerOperationalUnit')::numeric,0) <= 0
        then raise exception 'invalid conversion'; end if;
      insert into public.ingredient_unit_conversions(ingredient_id,unit,base_units_per_unit)
      values(found_id,operational,(item->>'baseUnitsPerOperationalUnit')::numeric)
      on conflict (ingredient_id,unit) do nothing;
    end if;
  end loop;
  return jsonb_build_object('addedKeys',to_jsonb(added));
end;
$$;
revoke all on function public.pantry_add_starters(uuid,jsonb) from public;
grant execute on function public.pantry_add_starters(uuid,jsonb) to authenticated;
