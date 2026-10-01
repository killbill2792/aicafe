-- Owner-facing menu grouping (separate from the internal 8-code analytics `category`), plus
-- café-friendly recipe-entry metadata. Additive only — no existing column is altered or dropped.
-- NOT applied automatically. Review this file and the accompanying preview query before running
-- scripts/db-migrate.mjs, and only against a test/demo tenant.

alter table menu_items
  add column if not exists menu_group text;

alter table recipe_lines
  add column if not exists display_unit text,
  add column if not exists display_quantity numeric(12,4);

-- Per-ingredient operational-unit conversions (e.g. "1 shot of Espresso Beans = 18 g"). Physical
-- unit conversions (ml <-> fl oz) are global constants in lib/calc/recipeUnits.ts and need no row
-- here; shots/pumps are ingredient-specific (a dose varies by ingredient and even by bottle) and
-- must be defined once by the owner before first use, then reused.
create table if not exists ingredient_unit_conversions (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients on delete cascade,
  unit text not null check (unit in ('shot', 'pump')),
  base_units_per_unit numeric(12,6) not null check (base_units_per_unit > 0),
  created_at timestamptz not null default now(),
  unique (ingredient_id, unit)
);

create index if not exists ingredient_unit_conversions_ingredient_idx on ingredient_unit_conversions (ingredient_id);
alter table ingredient_unit_conversions enable row level security;
drop policy if exists "members read" on ingredient_unit_conversions;
drop policy if exists "members write" on ingredient_unit_conversions;
create policy "members read" on ingredient_unit_conversions for select
  using (exists (select 1 from ingredients i where i.id = ingredient_id and is_member(i.business_id)));
create policy "members write" on ingredient_unit_conversions for all
  using (exists (select 1 from ingredients i where i.id = ingredient_id and is_member(i.business_id)))
  with check (exists (select 1 from ingredients i where i.id = ingredient_id and is_member(i.business_id)));

-- Conservative backfill / repair ---------------------------------------------------------------
-- Every row whose category already matches one of the 8 valid analytics codes is left completely
-- untouched by both statements below (neither WHERE clause can match it).

-- Case (a): legacy non-enum lowercase values already coerced in application code
-- (lib/data/getMenuItemsForEdit.ts's `category === "food" ? "FOOD" : category === "drink" ? ...`
-- coercion proves these rows exist). Repair `category` itself to the matching valid code; this is
-- not POS contamination, so menu_group is not touched.
update menu_items set category = 'FOOD' where category = 'food';
update menu_items set category = 'ESPRESSO_DRINK' where category = 'drink';

-- Case (b): any remaining category value that is not one of the 8 valid analytics codes is the
-- lib/actions/catalogMatches.ts contamination path (raw Square/Toast category text written
-- straight into `category`). Preserve that owner-meaningful text by moving it into `menu_group`,
-- and reset `category` to a safe default. Must run after case (a) so 'food'/'drink' (already
-- repaired above) are not swept into this generic branch.
update menu_items
  set menu_group = category,
      category = 'ESPRESSO_DRINK'
  where category is not null
    and category not in (
      'ESPRESSO_DRINK', 'BREWED_COFFEE', 'COLD_BREW', 'TEA',
      'SPECIALTY_DRINK', 'PASTRY', 'FOOD', 'RETAIL'
    );
