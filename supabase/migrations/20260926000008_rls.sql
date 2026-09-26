-- ===== Row level security ===== (docs/04-data-model.md "RLS pattern", applied to every table)
-- is_member(): true if the current auth user belongs to the business. security definer so it
-- can read `memberships` even though `memberships` itself is RLS-protected.
create or replace function is_member(target_business_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from memberships m
    where m.business_id = target_business_id and m.user_id = auth.uid()
  );
$$;

-- Direct business_id column tables: same select/write predicate.
do $$
declare
  t text;
  direct_tables text[] := array[
    'businesses', 'locations', 'pos_connections', 'menu_items', 'ingredients',
    'modifier_recipes', 'orders', 'employees', 'timecards', 'recurring_costs',
    'expenses', 'vendor_rules', 'uploads', 'recovery_order', 'daily_rollups', 'alerts'
  ];
begin
  foreach t in array direct_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "members read" on %I', t);
    execute format('drop policy if exists "members write" on %I', t);
    execute format(
      'create policy "members read" on %I for select using (is_member(business_id))', t
    );
    execute format(
      'create policy "members write" on %I for all using (is_member(business_id)) with check (is_member(business_id))', t
    );
  end loop;
end $$;

-- businesses.id *is* the business id (not a business_id column) — override with the right predicate.
drop policy if exists "members read" on businesses;
drop policy if exists "members write" on businesses;
create policy "members read" on businesses for select using (is_member(id));
create policy "members write" on businesses for all using (is_member(id)) with check (is_member(id));

-- memberships: a user sees only their own rows (business_id can't be read via is_member() here,
-- since that would let anyone see who else is on a business they belong to — fine to relax later
-- if a "Team access" admin view needs it, but v1 only needs a user to know their own membership).
alter table memberships enable row level security;
drop policy if exists "own membership" on memberships;
create policy "own membership" on memberships for select using (user_id = auth.uid());

-- Child tables without their own business_id: join to the owning row.
alter table ingredient_prices enable row level security;
drop policy if exists "members read" on ingredient_prices;
drop policy if exists "members write" on ingredient_prices;
create policy "members read" on ingredient_prices for select using (
  exists (select 1 from ingredients i where i.id = ingredient_prices.ingredient_id and is_member(i.business_id))
);
create policy "members write" on ingredient_prices for all using (
  exists (select 1 from ingredients i where i.id = ingredient_prices.ingredient_id and is_member(i.business_id))
) with check (
  exists (select 1 from ingredients i where i.id = ingredient_prices.ingredient_id and is_member(i.business_id))
);

alter table recipe_lines enable row level security;
drop policy if exists "members read" on recipe_lines;
drop policy if exists "members write" on recipe_lines;
create policy "members read" on recipe_lines for select using (
  exists (select 1 from menu_items mi where mi.id = recipe_lines.menu_item_id and is_member(mi.business_id))
);
create policy "members write" on recipe_lines for all using (
  exists (select 1 from menu_items mi where mi.id = recipe_lines.menu_item_id and is_member(mi.business_id))
) with check (
  exists (select 1 from menu_items mi where mi.id = recipe_lines.menu_item_id and is_member(mi.business_id))
);

alter table order_lines enable row level security;
drop policy if exists "members read" on order_lines;
drop policy if exists "members write" on order_lines;
create policy "members read" on order_lines for select using (
  exists (select 1 from orders o where o.id = order_lines.order_id and is_member(o.business_id))
);
create policy "members write" on order_lines for all using (
  exists (select 1 from orders o where o.id = order_lines.order_id and is_member(o.business_id))
) with check (
  exists (select 1 from orders o where o.id = order_lines.order_id and is_member(o.business_id))
);

alter table expense_lines enable row level security;
drop policy if exists "members read" on expense_lines;
drop policy if exists "members write" on expense_lines;
create policy "members read" on expense_lines for select using (
  exists (select 1 from expenses e where e.id = expense_lines.expense_id and is_member(e.business_id))
);
create policy "members write" on expense_lines for all using (
  exists (select 1 from expenses e where e.id = expense_lines.expense_id and is_member(e.business_id))
) with check (
  exists (select 1 from expenses e where e.id = expense_lines.expense_id and is_member(e.business_id))
);

-- expense_categories: global reference data, readable by any signed-in user, writable only by
-- the service role (migrations), never by app users.
alter table expense_categories enable row level security;
drop policy if exists "anyone signed in can read" on expense_categories;
create policy "anyone signed in can read" on expense_categories for select using (auth.role() = 'authenticated');
