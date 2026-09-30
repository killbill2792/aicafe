-- Adds a "size" concept to menu items (e.g. Latte 12 oz / 16 oz / 18 oz) without changing how
-- anything else in the app identifies a menu item. `name` stays the single canonical string every
-- other query/screen already reads (Home/Money/Menu tables, per-drink cost rows, any future
-- POS/CSV name-matching) — `base_name`/`size_label` are additive metadata used only by the
-- "manage menu" editor to group related sizes together and to prefill the add-another-size form.
alter table menu_items add column if not exists base_name text;
alter table menu_items add column if not exists size_label text;

-- Existing items keep displaying exactly as they do today (a "group of one", no size).
update menu_items set base_name = name where base_name is null;

alter table menu_items alter column base_name set not null;
