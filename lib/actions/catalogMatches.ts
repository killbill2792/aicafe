"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { existingMenuGroups, normalizeMenuGroup } from "@/lib/menu/menuGroups";
import { inferMenuItemCategory } from "@/lib/menu/inferCategory";
import { logQueryError } from "@/lib/data/queryError";

// Bound directly into a <form action={...}> in import-review/page.tsx, which requires a
// void-returning action — the actual correctness fix (never mark a match confirmed unless the
// underlying menu-item change truly succeeded) lives in the early-returns below, not in a result
// value the form could inspect.
export async function resolveCatalogMatch(matchId: string, choice: "suggested" | "new"): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const businessId = await getActiveBusinessId(user.id);
  const { data: match, error: matchError } = await supabase.from("pos_catalog_matches").select("*").eq("id", matchId).eq("business_id", businessId).single();
  if (matchError) logQueryError("resolveCatalogMatch:match", matchError);
  if (!match) return;

  let applied = false;
  if (choice === "suggested" && match.suggested_menu_item_id) {
    // The POS's own category/group text is owner-meaningful menu organization, not the internal
    // analytics `category` enum — populate it as `menu_group` (normalized, and only when the
    // existing item has none yet, so an owner's own manual choice is never overwritten) instead of
    // ever writing it into `category`, which previously let arbitrary POS text silently corrupt
    // that column.
    const { data: existingItem, error: existingItemError } = await supabase
      .from("menu_items")
      .select("menu_group")
      .eq("id", match.suggested_menu_item_id)
      .eq("business_id", businessId)
      .single();
    if (existingItemError) logQueryError("resolveCatalogMatch:existingItem", existingItemError);
    const menuGroup = !existingItem?.menu_group && match.imported_category
      ? normalizeMenuGroup(match.imported_category, await existingMenuGroups(supabase, businessId))
      : existingItem?.menu_group ?? null;
    const { error: updateError } = await supabase
      .from("menu_items")
      .update({ pos_item_id: match.pos_item_id, price_cents: match.imported_price_cents, menu_group: menuGroup, catalog_source: match.provider, catalog_last_synced_at: new Date().toISOString() })
      .eq("id", match.suggested_menu_item_id)
      .eq("business_id", businessId);
    if (updateError) logQueryError("resolveCatalogMatch:update", updateError);
    applied = !updateError;
  } else {
    const menuGroup = match.imported_category ? normalizeMenuGroup(match.imported_category, await existingMenuGroups(supabase, businessId)) : null;
    const { error: insertError } = await supabase.from("menu_items").insert({
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
    if (insertError) logQueryError("resolveCatalogMatch:insert", insertError);
    applied = !insertError;
  }

  // Never mark a match confirmed unless the menu item it was supposed to update/create actually
  // succeeded — otherwise a transient DB failure would leave the match looking resolved while the
  // owner's catalog silently never got the change.
  if (!applied) return;

  const { error: confirmError } = await supabase.from("pos_catalog_matches").update({ status: "confirmed" }).eq("id", match.id).eq("business_id", businessId);
  if (confirmError) logQueryError("resolveCatalogMatch:confirm", confirmError);

  revalidatePath("/menu"); revalidatePath("/menu/import-review");
}
