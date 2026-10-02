import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

export type ProductPhoto = { signedUrl: string; storagePath: string } | null;

export async function getProductPhoto(menuItemId: string): Promise<{ photo: ProductPhoto; businessId: string | null }> {
  if (!isSupabaseConfigured()) return { photo: null, businessId: null };
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { photo: null, businessId: null };
  const businessId = await getActiveBusinessId(user.id);
  const { data: item } = await supabase.from("menu_items").select("base_name, name").eq("id", menuItemId).eq("business_id", businessId).single();
  if (!item) return { photo: null, businessId };
  const { data: siblings } = await supabase.from("menu_items").select("id").eq("business_id", businessId).eq("base_name", item.base_name ?? item.name).order("id").limit(1);
  const anchorId = siblings?.[0]?.id;
  if (!anchorId) return { photo: null, businessId };
  const { data: row } = await supabase.from("product_photos").select("storage_path").eq("anchor_menu_item_id", anchorId).maybeSingle();
  if (!row) return { photo: null, businessId };
  const { data } = await supabase.storage.from("product-photos").createSignedUrl(row.storage_path, 3600);
  return { photo: data?.signedUrl ? { signedUrl: data.signedUrl, storagePath: row.storage_path } : null, businessId };
}
