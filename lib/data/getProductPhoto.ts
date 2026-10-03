import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { existingProductPhotoAnchor } from "@/lib/menu/productPhotoAnchor";
import type { MenuControlItem } from "./getMenuControlCenter";

export type ProductPhoto = { signedUrl: string; storagePath: string } | null;

/** Loads all catalog photos with one tenant-scoped row query and one Storage signing request.
 * Every member id in a product family points at that family's single photo, so callers never
 * accidentally make the cheapest/displayed size the owner of the image. */
export async function getMenuCatalogPhotos(items: MenuControlItem[]): Promise<Record<string, ProductPhoto>> {
  if (!isSupabaseConfigured() || items.length === 0) return {};
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return {};
  const businessId = await getActiveBusinessId(user.id);
  const itemIds = items.map((item) => item.id);
  const { data: rows } = await supabase
    .from("product_photos")
    .select("anchor_menu_item_id, storage_path")
    .eq("business_id", businessId)
    .in("anchor_menu_item_id", itemIds);
  if (!rows?.length) return {};

  const uniquePaths = [...new Set(rows.map((row) => row.storage_path))];
  const { data: signed } = await supabase.storage.from("product-photos").createSignedUrls(uniquePaths, 3600);
  const urlByPath = new Map((signed ?? []).filter((entry) => entry.signedUrl).map((entry) => [entry.path ?? "", entry.signedUrl]));
  const result: Record<string, ProductPhoto> = {};
  const families = new Map<string, MenuControlItem[]>();
  for (const item of items) {
    families.set(item.baseName, [...(families.get(item.baseName) ?? []), item]);
  }
  for (const members of families.values()) {
    const ids = members.map((member) => member.id);
    const anchor = existingProductPhotoAnchor(ids, rows.map((row) => row.anchor_menu_item_id));
    const row = rows.find((candidate) => candidate.anchor_menu_item_id === anchor);
    const signedUrl = row ? urlByPath.get(row.storage_path) : undefined;
    if (row && signedUrl) for (const member of members) result[member.id] = { signedUrl, storagePath: row.storage_path };
  }
  return result;
}

export async function getProductPhoto(menuItemId: string): Promise<{ photo: ProductPhoto; businessId: string | null }> {
  if (!isSupabaseConfigured()) return { photo: null, businessId: null };
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { photo: null, businessId: null };
  const businessId = await getActiveBusinessId(user.id);
  const { data: item } = await supabase.from("menu_items").select("base_name, name").eq("id", menuItemId).eq("business_id", businessId).single();
  if (!item) return { photo: null, businessId };
  const { data: siblings } = await supabase.from("menu_items").select("id").eq("business_id", businessId).eq("base_name", item.base_name ?? item.name);
  const siblingIds = (siblings ?? []).map((sibling) => sibling.id);
  if (siblingIds.length === 0) return { photo: null, businessId };
  const { data: photos } = await supabase.from("product_photos").select("anchor_menu_item_id, storage_path").eq("business_id", businessId).in("anchor_menu_item_id", siblingIds);
  const anchorId = existingProductPhotoAnchor(siblingIds, (photos ?? []).map((photo) => photo.anchor_menu_item_id));
  if (!anchorId) return { photo: null, businessId };
  const row = photos?.find((photo) => photo.anchor_menu_item_id === anchorId);
  if (!row) return { photo: null, businessId };
  const { data } = await supabase.storage.from("product-photos").createSignedUrl(row.storage_path, 3600);
  return { photo: data?.signedUrl ? { signedUrl: data.signedUrl, storagePath: row.storage_path } : null, businessId };
}
