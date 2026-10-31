-- PR #319: additive Pantry persistence only. Owner must approve production application.
-- Existing recipe amounts, financial numbers, purchase history and ingredient identities
-- are never rewritten. Preexisting recipe rows keep NULL positions (UUID fallback).
alter table public.recipe_lines add column if not exists sort_order integer;
alter table public.ingredients add column if not exists archived_at timestamptz;
alter table public.ingredient_prices add column if not exists original_pack jsonb;

-- NULL denotes legacy rows. New writes use a distinct 1-based position per size.
alter table public.recipe_lines add constraint recipe_lines_sort_order_bounds
  check (sort_order is null or sort_order between 1 and 80);
create unique index if not exists recipe_lines_order_unique
  on public.recipe_lines(menu_item_id, sort_order) where sort_order is not null;
create index if not exists ingredients_archive_by_business
  on public.ingredients(business_id, archived_at);

-- A stored breakdown is an exact explanation of the canonical pack_quantity/unit,
-- never an alternative cost source. A legacy NULL means we don't know the factors.
alter table public.ingredient_prices add constraint ingredient_prices_original_pack_valid check (
  original_pack is null or (
    jsonb_typeof(original_pack) = 'object'
    and jsonb_typeof(original_pack->'count') = 'number'
    and jsonb_typeof(original_pack->'unitQuantity') = 'number'
    and jsonb_typeof(original_pack->'unit') = 'string'
    and (original_pack->>'count')::numeric > 0
    and (original_pack->>'unitQuantity')::numeric > 0
    and original_pack->>'unit' = pack_unit
    and abs(((original_pack->>'count')::numeric * (original_pack->>'unitQuantity')::numeric) - pack_quantity) < 0.000001
  )
);

-- Never allow a signed-in member's DELETE on ingredients to cascade into recipes,
-- prices, purchases or stock history. Existing SELECT/INSERT/UPDATE remain member-RLS.
drop policy if exists "members write" on public.ingredients;
create policy "members insert" on public.ingredients for insert
  with check (public.is_member(business_id));
create policy "members update" on public.ingredients for update
  using (public.is_member(business_id)) with check (public.is_member(business_id));

-- Archive/restore is authorized for the owner of the explicit café, with INVOKER
-- RLS in addition. A retry is idempotent; no linked row is ever deleted.
create or replace function public.pantry_set_archived(
  p_business_id uuid, p_ingredient_id uuid, p_archived boolean
) returns boolean language plpgsql security invoker set search_path=public as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.memberships where business_id=p_business_id
      and user_id=auth.uid() and role='owner'
  ) then raise exception 'not authorized' using errcode='42501'; end if;
  update public.ingredients
    set archived_at = case when p_archived then coalesce(archived_at,now()) else null end
    where id=p_ingredient_id and business_id=p_business_id;
  return found;
end;
$$;
revoke all on function public.pantry_set_archived(uuid,uuid,boolean) from public;
grant execute on function public.pantry_set_archived(uuid,uuid,boolean) to authenticated;

-- Reuse the existing single atomic, RLS-scoped, optimistic-concurrency recipe
-- writer; its insertion order is the only authoritative saved display order.
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
  ingredient_archive timestamptz;
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
  -- Legacy single-line recipe writes do not participate in the product advisory
  -- lock. Take a short relation-level write conflict lock before validating any
  -- read snapshot, so their INSERT/UPDATE/DELETE cannot commit between CAS
  -- verification and replacing rows. This deliberately trades rare bulk-edit
  -- throughput for prevention of silent cross-writer data loss.
  LOCK TABLE public.recipe_lines IN SHARE ROW EXCLUSIVE MODE;
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
    -- Older recipes have NULL sort_order and fall back to ingredient UUID.
    -- Compare the owner's ordered snapshot before modifying any recipe row.
    if c ? 'expectedOrder' then
      select coalesce(jsonb_agg(ingredient_id::text order by sort_order nulls last, ingredient_id), '[]'::jsonb)
        into actual from public.recipe_lines where menu_item_id=item;
      if actual is distinct from c->'expectedOrder' then
        raise exception 'recipe_order_changed' using errcode='40001'; end if;
    end if;
    seen_ingredients := '{}';
    for ln in select value from jsonb_array_elements(c->'lines') loop
      ingredient := (ln->>'ingredientId')::uuid;
      if ingredient=any(seen_ingredients) then raise exception 'duplicate ingredient'; end if;
      seen_ingredients := array_append(seen_ingredients,ingredient);
      select archived_at into ingredient_archive from public.ingredients
        where id=ingredient and business_id=p_business_id;
      if not found then raise exception 'ingredient not in business'; end if;
      -- A previously used ingredient may remain in its historical recipe, but
      -- archiving prevents NEW inclusion in a different product or size.
      if ingredient_archive is not null and not exists (
        select 1 from public.recipe_lines
          where menu_item_id=item and ingredient_id=ingredient
      ) then raise exception 'ingredient archived'; end if;
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
      (menu_item_id, ingredient_id, quantity, display_unit, display_quantity, sort_order)
    select item, (r.value->>'ingredientId')::uuid, (r.value->>'quantity')::numeric,
      r.value->>'displayUnit', (r.value->>'displayQuantity')::numeric, r.ordinality::integer
    from jsonb_array_elements(c->'lines') with ordinality as r(value, ordinality);
    updated_ids := array_append(updated_ids,item);
  end loop;
  return jsonb_build_object('itemIds',to_jsonb(updated_ids));
end;
$$;


