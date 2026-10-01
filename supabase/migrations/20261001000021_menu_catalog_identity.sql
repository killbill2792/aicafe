-- Canonical menu provenance plus a temporary review queue for safely attaching a POS catalog
-- to owner-created menu items. Recipes and all platform intelligence remain on menu_items.id.
alter table menu_items
  add column if not exists catalog_source text not null default 'manual'
    check (catalog_source in ('manual','csv','square','toast','clover','other_pos')),
  add column if not exists catalog_last_synced_at timestamptz;

create table if not exists pos_catalog_matches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  provider text not null check (provider in ('square','toast','clover','csv','other_pos')),
  pos_item_id text not null,
  imported_name text not null,
  imported_size_label text,
  imported_price_cents bigint,
  imported_category text,
  suggested_menu_item_id uuid references menu_items on delete cascade,
  match_score numeric(4,3),
  status text not null check (status in ('matched','needs_review','new','confirmed','ignored')),
  created_at timestamptz not null default now(),
  unique (business_id, provider, pos_item_id)
);

create index if not exists pos_catalog_matches_business_idx on pos_catalog_matches (business_id, status);
alter table pos_catalog_matches enable row level security;
drop policy if exists "members read" on pos_catalog_matches;
drop policy if exists "members write" on pos_catalog_matches;
create policy "members read" on pos_catalog_matches for select using (is_member(business_id));
create policy "members write" on pos_catalog_matches for all using (is_member(business_id)) with check (is_member(business_id));
