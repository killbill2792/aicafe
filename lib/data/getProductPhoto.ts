import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { existingProductPhotoAnchor } from "@/lib/menu/productPhotoAnchor";

export type ProductPhoto = { signedUrl: string; storagePath: string } | null;

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
