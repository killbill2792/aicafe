"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { existingMenuGroups, normalizeMenuGroup } from "@/lib/menu/menuGroups";
import { inferMenuItemCategory } from "@/lib/menu/inferCategory";

export async function resolveCatalogMatch(matchId: string, choice: "suggested" | "new") {
  const supabase = await createServerSupabaseClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return;
  const businessId = await getActiveBusinessId(user.id);
  const { data: match } = await supabase.from("pos_catalog_matches").select("*").eq("id", matchId).eq("business_id", businessId).single(); if (!match) return;
  if (choice === "suggested" && match.suggested_menu_item_id) {
    await supabase.from("menu_items").update({ pos_item_id: match.pos_item_id, price_cents: match.imported_price_cents, catalog_source: match.provider, catalog_last_synced_at: new Date().toISOString() }).eq("id", match.suggested_menu_item_id).eq("business_id", businessId);
  } else {
    // The POS's own category/group text is owner-meaningful menu organization, not the internal
    // analytics `category` enum — preserve it as `menu_group` (normalized against whatever this
    // business already uses) instead of writing it straight into `category`, which previously let
    // arbitrary POS text silently corrupt that column (see docs/08 Menu UX refactor plan).
    const menuGroup = match.imported_category ? normalizeMenuGroup(match.imported_category, await existingMenuGroups(supabase, businessId)) : null;
    await supabase.from("menu_items").insert({
      business_id: businessId,
      pos_item_id: match.pos_item_id,
      name: match.imported_name,
      base_name: match.imported_name,
      price_cents: match.imported_price_cents,
      category: inferMenuItemCategory(match.imported_name, menuGroup),
      menu_group: menuGroup,
      catalog_source: match.provider,
      catalog_last_synced_at: new Date().toISOString(),
    });
  }
  await supabase.from("pos_catalog_matches").update({ status: "confirmed" }).eq("id", match.id).eq("business_id", businessId);
  revalidatePath("/menu"); revalidatePath("/menu/import-review");
}
