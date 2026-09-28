-- Another real bug found running the first live reseed: docs/04-data-model.md's
-- `order_lines.menu_item_id references menu_items` has no ON DELETE rule (defaults to NO ACTION).
-- Deleting a business cascades to both `menu_items` (business_id → businesses on delete cascade)
-- and, independently, to `order_lines` via `orders` (order_id → orders on delete cascade) —
-- Postgres doesn't guarantee the `orders` cascade fully clears an item's order_lines before the
-- `menu_items` cascade tries to remove that item, so `npm run db:reset`'s reseed step failed with
-- a foreign key violation the first time it ever ran against a real database. In normal operation
-- menu_items are never hard-deleted (deactivated via is_active instead), so cascading here only
-- ever fires as part of deleting the whole business (account deletion, or this reseed) — safe.
alter table order_lines drop constraint if exists order_lines_menu_item_id_fkey;
alter table order_lines add constraint order_lines_menu_item_id_fkey foreign key (menu_item_id) references menu_items on delete cascade;
