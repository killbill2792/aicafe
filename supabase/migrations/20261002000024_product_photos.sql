-- Phase 4B additive migration. Apply before deploying the product-photo UI.
-- One private photo remains anchored to the menu item used when that family first gets a photo.
-- Readers resolve that stored anchor across all current sibling ids; UUID ordering is irrelevant.
alter table menu_items
  add constraint menu_items_business_id_id_key unique (business_id, id);
create table if not exists product_photos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  anchor_menu_item_id uuid not null unique,
  storage_path text not null unique check (storage_path like business_id::text || '/%'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, anchor_menu_item_id)
    references menu_items (business_id, id) on delete cascade
);
create index if not exists product_photos_business_id_idx on product_photos (business_id);
alter table product_photos enable row level security;
create policy "members read" on product_photos for select using (is_member(business_id));
create policy "members write" on product_photos for all using (is_member(business_id)) with check (
  is_member(business_id) and exists (
    select 1 from menu_items mi where mi.id = anchor_menu_item_id and mi.business_id = product_photos.business_id
  )
);
grant select, insert, update, delete on product_photos to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "members read product photos" on storage.objects for select to authenticated
using (bucket_id = 'product-photos' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members upload product photos" on storage.objects for insert to authenticated
with check (bucket_id = 'product-photos' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members update product photos" on storage.objects for update to authenticated
using (bucket_id = 'product-photos' and is_member(((storage.foldername(name))[1])::uuid))
with check (bucket_id = 'product-photos' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members delete product photos" on storage.objects for delete to authenticated
using (bucket_id = 'product-photos' and is_member(((storage.foldername(name))[1])::uuid));

-- Atomic grouped rename. The caller supplies the active business id, but membership and the
-- anchor item's ownership are both checked in the database before any sibling changes.
create or replace function rename_menu_product(target_business_id uuid, target_menu_item_id uuid, new_base_name text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare old_base_name text;
begin
  if not is_member(target_business_id) or length(trim(new_base_name)) = 0 or length(trim(new_base_name)) > 80 then
    return false;
  end if;
  select coalesce(base_name, name) into old_base_name from menu_items
    where id = target_menu_item_id and business_id = target_business_id;
  if old_base_name is null then return false; end if;
  update menu_items
    set base_name = trim(new_base_name),
        name = case when nullif(trim(size_label), '') is null then trim(new_base_name)
                    else trim(new_base_name) || ' ' || trim(size_label) end
    where business_id = target_business_id and coalesce(base_name, name) = old_base_name;
  return found;
end;
$$;
grant execute on function rename_menu_product(uuid, uuid, text) to authenticated;
