-- CSV column mapper, saved per business (docs/06-integrations.md "Toast and other POS (v1 = CSV
-- upload)": "Save the mapping per business so later uploads are one tap."). Not in the original
-- docs/04-data-model.md — added for M6's explicit "saved mappings" requirement.
create table if not exists csv_import_mappings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  kind text not null check (kind in ('sales', 'labor')),
  column_mapping jsonb not null, -- {date:"Date", item:"Menu Item", quantity:"Qty", net_sales:"Net Sales", ...}
  source_label text, -- e.g. "Toast product mix export" — shown back to the owner, not parsed
  created_at timestamptz not null default now(),
  unique (business_id, kind)
);

alter table csv_import_mappings enable row level security;
drop policy if exists "members read" on csv_import_mappings;
drop policy if exists "members write" on csv_import_mappings;
create policy "members read" on csv_import_mappings for select using (is_member(business_id));
create policy "members write" on csv_import_mappings for all using (is_member(business_id)) with check (is_member(business_id));
