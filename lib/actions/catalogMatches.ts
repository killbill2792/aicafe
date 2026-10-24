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

/** Bind a CSV-only match to an explicit existing menu item without changing its selling price. */
export async function matchUploadedItem(matchId: string, formData: FormData): Promise<void> {
  const menuItemId = formData.get("menuItemId");
  if (typeof menuItemId !== "string" || !/^[0-9a-f-]{36}$/i.test(menuItemId)) return;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const businessId = await getActiveBusinessId(user.id);
  const [{data:match,error:matchError},{data:item,error:itemError}] = await Promise.all([
    supabase.from("pos_catalog_matches").select("id, provider, pos_item_id, imported_name")
      .eq("business_id",businessId).eq("id",matchId).eq("provider","csv").eq("status","needs_review").maybeSingle(),
    supabase.from("menu_items").select("id, pos_item_id").eq("business_id",businessId).eq("id",menuItemId).maybeSingle(),
  ]);
  if (matchError || itemError || !match || !item) return;
  if (item.pos_item_id && item.pos_item_id !== match.pos_item_id) return;
  const { error: updated } = await supabase.from("menu_items").update({
    pos_item_id: match.pos_item_id, catalog_source: "csv", catalog_last_synced_at: new Date().toISOString(),
  }).eq("id",item.id).eq("business_id",businessId);
  if (updated) { logQueryError("matchUploadedItem:update",updated); return; }
  const {error: confirmed} = await supabase.from("pos_catalog_matches").update({status:"confirmed"})
    .eq("id",match.id).eq("business_id",businessId).eq("status","needs_review");
  if (confirmed) { logQueryError("matchUploadedItem:confirm",confirmed); return; }
  // Link already-imported CSV sales to this item. Never change quantity, revenue or fees.
  const {data:groups,error:groupsError} = await supabase.from("csv_sales_import_groups")
    .select("job_id").eq("business_id",businessId).eq("item_name",match.imported_name).is("menu_item_id",null);
  if (!groupsError && groups?.length) {
    const jobIds = [...new Set(groups.map(g=>g.job_id))];
    const {error:groupUpdateError} = await supabase.from("csv_sales_import_groups").update({menu_item_id:item.id})
      .eq("business_id",businessId).eq("item_name",match.imported_name).in("job_id",jobIds).is("menu_item_id",null);
    if (groupUpdateError) logQueryError("matchUploadedItem:groups",groupUpdateError);
    const {data:orders,error:ordersError} = await supabase.from("orders").select("id")
      .eq("business_id",businessId).like("pos_order_id","csv-%");
    if (!ordersError && orders?.length) {
      const {error:lineError} = await supabase.from("order_lines").update({menu_item_id:item.id})
        .in("order_id",orders.map(o=>o.id)).eq("name",match.imported_name).is("menu_item_id",null);
      if (lineError) logQueryError("matchUploadedItem:orderLines",lineError);
    }
  }
  revalidatePath("/menu");
  revalidatePath("/menu/import-review");
}

/** Ignore is deliberately session-only: there is no durable ignored state without a migration. */
export async function addUploadedItemToMenu(matchId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const businessId = await getActiveBusinessId(user.id);
  const {data:match} = await supabase.from("pos_catalog_matches").select("id,provider,status")
    .eq("business_id",businessId).eq("id",matchId).eq("provider","csv").eq("status","needs_review").maybeSingle();
  if (!match) return;
  await resolveCatalogMatch(matchId,"new");
}
