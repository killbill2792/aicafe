-- Client-rollout additions (real pilot café, not just the demo): a free-text label an owner can
-- attach to any expense (mainly used under "Other" so their own naming shows through without
-- breaking the fixed category codes that cost recovery / health checks / rent-share-per-drink all
-- key off of — see PROGRESS.md decisions), and enough on `employees` to support a manual staff
-- roster (name/role/wage entered once) plus manually logging hours, for owners whose register
-- plan doesn't export labor data.

alter table expenses add column if not exists custom_label text;

alter table employees add column if not exists default_hourly_wage_cents bigint;
alter table employees add column if not exists active boolean not null default true;

-- A generic ingredient-cost importer (inventory sites like franchiseinventorymanagement.com have
-- no API — the owner downloads a report nightly and uploads it here, same column-mapper pattern
-- as the existing sales/labor CSV importers) needs its own saved-mapping kind.
alter table csv_import_mappings drop constraint if exists csv_import_mappings_kind_check;
alter table csv_import_mappings add constraint csv_import_mappings_kind_check check (kind in ('sales', 'labor', 'ingredients'));
