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
  add column if not exists pack_cost_cents bigint;

alter table public.ingredient_prices
  add constraint ingredient_prices_pack_quantity_positive
  check (pack_quantity is null or pack_quantity > 0),
  add constraint ingredient_prices_pack_cost_positive
  check (pack_cost_cents is null or pack_cost_cents > 0),
  add constraint ingredient_prices_pack_unit_check
  check (pack_unit is null or pack_unit in (
    'gal','qt','l','ml','fl_oz','lb','kg','oz_wt','g','each','dozen','case'
  ));
