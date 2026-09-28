-- Same class of bug as 20260928000014, found by hitting each one in turn while getting the
-- reseed to actually complete against a real database: any foreign key from one business-scoped
-- table to *another* business-scoped table (not directly to `businesses`) has no ON DELETE rule
-- in docs/04-data-model.md, so it defaults to NO ACTION. Deleting a business cascades to both
-- sides of each pair independently and Postgres doesn't guarantee one finishes before the other,
-- so any of these can fail a business-delete (account deletion, or this reseed script) depending
-- on cascade ordering. `order_lines.menu_item_id` was fixed in 20260928000014; these are the rest
-- of the same pattern. `expense_categories` references are deliberately excluded — that table is
-- global reference data, never deleted as part of a business delete.
alter table modifier_recipes drop constraint if exists modifier_recipes_ingredient_id_fkey;
alter table modifier_recipes add constraint modifier_recipes_ingredient_id_fkey foreign key (ingredient_id) references ingredients on delete cascade;

alter table modifier_recipes drop constraint if exists modifier_recipes_replaces_ingredient_id_fkey;
alter table modifier_recipes add constraint modifier_recipes_replaces_ingredient_id_fkey foreign key (replaces_ingredient_id) references ingredients on delete cascade;

alter table orders drop constraint if exists orders_location_id_fkey;
alter table orders add constraint orders_location_id_fkey foreign key (location_id) references locations on delete cascade;

alter table timecards drop constraint if exists timecards_employee_id_fkey;
alter table timecards add constraint timecards_employee_id_fkey foreign key (employee_id) references employees on delete cascade;

alter table expenses drop constraint if exists expenses_recurring_cost_id_fkey;
alter table expenses add constraint expenses_recurring_cost_id_fkey foreign key (recurring_cost_id) references recurring_costs on delete cascade;

alter table expense_lines drop constraint if exists expense_lines_ingredient_id_fkey;
alter table expense_lines add constraint expense_lines_ingredient_id_fkey foreign key (ingredient_id) references ingredients on delete cascade;
