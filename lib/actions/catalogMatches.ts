"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { existingMenuGroups, normalizeMenuGroup } from "@/lib/menu/menuGroups";
import { inferMenuItemCategory } from "@/lib/menu/inferCategory";
import { logQueryError } from "@/lib/data/queryError";
import { resolveUnmatchedAlertsIfClear } from "@/lib/data/resolveUnmatchedAlerts.server";
import { readAllPosRows, posIdBatches } from "@/lib/pos/pagedReads";
import { setCanonicalMenuPrice,recordInitialMenuPrice } from "@/lib/menu/priceHistory";

/**
 * A CSV item match must link canonical historical sales as well as the staged source groups.
 * Paginate every matching café order, and update lines in bounded batches. Do not change
 * group pointers until the canonical writes have all succeeded: if any read/write fails,
 * the unresolved match stays actionable and a retry safely repairs previously updated lines.
 * No totals, fees, or quantities are mutated.
 */
async function backfillUploadedSales(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  importedName: string,
  menuItemId: string,
): Promise<boolean> {
  try {
    const orders = await readAllPosRows<{ id: string }>(
      (first, last) => supabase.from("orders").select("id")
        .eq("business_id", businessId).like("pos_order_id", "csv-%")
        .order("id", { ascending: true }).range(first, last),
      "CSV match order IDs",
    );
    for (const ids of posIdBatches(orders.map(order => order.id), 100)) {
      const { error } = await supabase.from("order_lines")
        .update({ menu_item_id: menuItemId })
        .in("order_id", ids).eq("name", importedName).is("menu_item_id", null);
      if (error) throw error;
    }
    const { error } = await supabase.from("csv_sales_import_groups")
      .update({ menu_item_id: menuItemId })
      .eq("business_id", businessId).eq("item_name", importedName).is("menu_item_id", null);
    if (error) throw error;
    return true;
  } catch (error) {
    logQueryError("backfillUploadedSales", { message: error instanceof Error ? error.message : "Unable to backfill CSV sales" });
    return false;
  }
}

/** Keep the historical CSV identity without stealing an existing POS ID.
 * A unique constraint must reject another row's alias rather than silently
 * transferring old sales to the wrong product. */
async function ensureCatalogAlias(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  menuItemId: string,
  provider: string,
  posItemId: string,
): Promise<boolean> {
  const {data:current,error:readError}=await supabase.from("pos_item_aliases")
    .select("menu_item_id").eq("business_id",businessId).eq("provider",provider)
    .eq("pos_item_id",posItemId).maybeSingle();
  if(readError){logQueryError("ensureCatalogAlias:read",readError);return false;}
  if(current)return current.menu_item_id===menuItemId;
  const {error:writeError}=await supabase.from("pos_item_aliases").insert({
    business_id:businessId,menu_item_id:menuItemId,provider,pos_item_id:posItemId,
  });
  if(writeError){logQueryError("ensureCatalogAlias:write",writeError);return false;}
  return true;
}

// The review page shows a localized success or error status after revalidation.
async function finishMatch(result: "matched" | "error"): Promise<never> {
  const locale = await getLocale();
  redirect(`/${locale}/menu/import-review?result=${result}`);
}

// Bound directly into a <form action={...}> in import-review/page.tsx, which requires a
// void-returning action — the actual correctness fix (never mark a match confirmed unless the
// underlying menu-item change truly succeeded) lives in the early-returns below, not in a result
// value the form could inspect.
export async function resolveCatalogMatch(matchId: string, choice: "suggested" | "new"): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return finishMatch("error");
  const businessId = await getActiveBusinessId(user.id);
  const { data: match, error: matchError } = await supabase.from("pos_catalog_matches").select("*").eq("id", matchId).eq("business_id", businessId).eq("status","needs_review").single();
  if (matchError) logQueryError("resolveCatalogMatch:match", matchError);
  if (!match) return finishMatch("error");

  let applied = false;
  let csvItemId: string | null = null;
  if (choice === "suggested" && match.suggested_menu_item_id) {
    // The POS's own category/group text is owner-meaningful menu organization, not the internal
    // analytics `category` enum — populate it as `menu_group` (normalized, and only when the
    // existing item has none yet, so an owner's own manual choice is never overwritten) instead of
    // ever writing it into `category`, which previously let arbitrary POS text silently corrupt
    // that column.
    const { data: existingItem, error: existingItemError } = await supabase
      .from("menu_items")
      .select("menu_group,pos_item_id,catalog_source,price_cents")
      .eq("id", match.suggested_menu_item_id)
      .eq("business_id", businessId)
      .single();
    if (existingItemError || !existingItem) {
      if(existingItemError)logQueryError("resolveCatalogMatch:existingItem",existingItemError);
      return finishMatch("error");
    }
    const oldPos=existingItem.pos_item_id as string|null;
    const changingIdentity=oldPos!==null&&oldPos!==match.pos_item_id;
    const csvToPos=changingIdentity&&oldPos!.startsWith("csv-item-")&&match.provider!=="csv";
    const csvToExistingPos=changingIdentity&&match.provider==="csv";
    if(changingIdentity&&!csvToPos&&!csvToExistingPos)
      return finishMatch("error"); // another live POS identity must never be stolen
    if(csvToPos&&!await ensureCatalogAlias(supabase,businessId,match.suggested_menu_item_id,
      "csv",oldPos!))return finishMatch("error");
    if(csvToExistingPos&&!await ensureCatalogAlias(supabase,businessId,match.suggested_menu_item_id,
      "csv",match.pos_item_id))return finishMatch("error");
    const menuGroup = !existingItem.menu_group && match.imported_category
      ? normalizeMenuGroup(match.imported_category, await existingMenuGroups(supabase, businessId))
      : existingItem?.menu_group ?? null;
    const { error: updateError } = await supabase
      .from("menu_items")
      .update({
        ...(csvToExistingPos?{}:{
          pos_item_id:match.pos_item_id,catalog_source:match.provider,
          // Preserve the owner's original display name after approval.
          ...(match.provider!=="csv"?{pos_name:match.imported_name}:{}),
        }),
        ...(match.provider==="csv"&&!csvToExistingPos||match.imported_price_cents===null?
          {price_cents:csvToExistingPos?existingItem.price_cents:match.imported_price_cents}:{}),
        menu_group:menuGroup,catalog_last_synced_at:new Date().toISOString(),
      })
      .eq("id", match.suggested_menu_item_id)
      .eq("business_id", businessId);
    if (updateError) logQueryError("resolveCatalogMatch:update", updateError);
    applied = !updateError;
    if(applied && match.provider!=="csv" && match.imported_price_cents!==null &&
      match.imported_price_cents>0 && existingItem.price_cents!==match.imported_price_cents){
      try{
        applied=await setCanonicalMenuPrice(supabase,{
          businessId,menuItemId:match.suggested_menu_item_id,
          priceCents:match.imported_price_cents,sourceType:"connected_pos",
          sourceProvider:match.provider,
        });
      }catch(error){
        logQueryError("resolveCatalogMatch:priceHistory",error);applied=false;
      }
    }
    if (applied && match.provider === "csv") csvItemId = match.suggested_menu_item_id;
  } else {
    // Both CSV and POS reviews may retry after a partial write. The provider
    // identity is unique per café, so reuse the same row rather than inserting.
    const {data:previous,error:previousError}=await supabase.from("menu_items")
      .select("id").eq("business_id",businessId).eq("pos_item_id",match.pos_item_id).maybeSingle();
    if(previousError){logQueryError("resolveCatalogMatch:prior",previousError);return finishMatch("error");}
    const priorId=previous?.id as string|undefined;
    if(match.provider==="csv")csvItemId=priorId??null;
    if (!priorId) {
      const menuGroup = match.imported_category ? normalizeMenuGroup(match.imported_category, await existingMenuGroups(supabase, businessId)) : null;
      const insertion = supabase.from("menu_items").insert({
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
      if (match.provider === "csv") {
        const { data: created, error: insertError } = await insertion.select("id").single();
        if (insertError) logQueryError("resolveCatalogMatch:insert", insertError);
        csvItemId = created?.id ?? null;
        applied = !!csvItemId && !insertError;
      } else {
        const {data:created,error:insertError}=await insertion.select("id").single();
        if(insertError)logQueryError("resolveCatalogMatch:insert",insertError);
        applied=!!created?.id&&!insertError;
        if(applied&&match.imported_price_cents!==null&&match.imported_price_cents>0){
          try{
            await recordInitialMenuPrice(supabase,{
              businessId,menuItemId:created!.id,priceCents:match.imported_price_cents,
              sourceProvider:match.provider,
            });
          }catch(error){
            logQueryError("resolveCatalogMatch:initialHistory",error);applied=false;
          }
        }
      }
    } else {
      applied = true;
      if(match.provider!=="csv"&&match.imported_price_cents!==null&&match.imported_price_cents>0){
        const {data:history,error:historyError}=await supabase.from("menu_price_history")
          .select("id").eq("business_id",businessId).eq("menu_item_id",priorId)
          .limit(1);
        if(historyError){logQueryError("resolveCatalogMatch:historyRead",historyError);applied=false;}
        else if(!history?.length){
          try{
            await recordInitialMenuPrice(supabase,{
              businessId,menuItemId:priorId,priceCents:match.imported_price_cents,
              sourceProvider:match.provider,
            });
          }catch(error){
            logQueryError("resolveCatalogMatch:historyRetry",error);applied=false;
          }
        }
      }
    }
  }

  // Never mark a match confirmed unless the menu item it was supposed to update/create actually
  // succeeded — otherwise a transient DB failure would leave the match looking resolved while the
  // owner's catalog silently never got the change.
  if (!applied) return finishMatch("error");
  if (match.provider === "csv" && csvItemId) {
    if (!await backfillUploadedSales(supabase, businessId, match.imported_name, csvItemId)) return finishMatch("error");
  }

  const { error: confirmError } = await supabase.from("pos_catalog_matches").update({ status: "confirmed" }).eq("id", match.id).eq("business_id", businessId).eq("status", "needs_review");
  if (confirmError) { logQueryError("resolveCatalogMatch:confirm", confirmError); return finishMatch("error"); }
  await resolveUnmatchedAlertsIfClear(supabase, businessId, { nonBlocking: true });

  revalidatePath("/"); revalidatePath("/more/alerts");
  revalidatePath("/menu"); revalidatePath("/menu/import-review");
  return finishMatch("matched");
}

/** Bind a CSV-only match to an explicit existing menu item without changing its selling price. */
export async function matchUploadedItem(matchId: string, formData: FormData): Promise<void> {
  const menuItemId = formData.get("menuItemId");
  if (typeof menuItemId !== "string" || !/^[0-9a-f-]{36}$/i.test(menuItemId)) return finishMatch("error");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return finishMatch("error");
  const businessId = await getActiveBusinessId(user.id);
  const [{data:match,error:matchError},{data:item,error:itemError}] = await Promise.all([
    supabase.from("pos_catalog_matches").select("id, provider, pos_item_id, imported_name")
      .eq("business_id",businessId).eq("id",matchId).eq("provider","csv").eq("status","needs_review").maybeSingle(),
    supabase.from("menu_items").select("id, pos_item_id").eq("business_id",businessId).eq("id",menuItemId).maybeSingle(),
  ]);
  if (matchError || itemError || !match || !item) return finishMatch("error");
  if(item.pos_item_id && item.pos_item_id !== match.pos_item_id){
    if(!await ensureCatalogAlias(supabase,businessId,item.id,"csv",match.pos_item_id))
      return finishMatch("error");
  }else{
    const { error: updated } = await supabase.from("menu_items").update({
      pos_item_id: match.pos_item_id,catalog_source:"csv",
      catalog_last_synced_at:new Date().toISOString(),
    }).eq("id",item.id).eq("business_id",businessId);
    if(updated){logQueryError("matchUploadedItem:update",updated);return finishMatch("error");}
  }
  if (!await backfillUploadedSales(supabase, businessId, match.imported_name, item.id)) return finishMatch("error");
  const {error: confirmed} = await supabase.from("pos_catalog_matches").update({status:"confirmed"})
    .eq("id",match.id).eq("business_id",businessId).eq("status","needs_review");
  if (confirmed) { logQueryError("matchUploadedItem:confirm",confirmed); return finishMatch("error"); }
  await resolveUnmatchedAlertsIfClear(supabase, businessId, { nonBlocking: true });
  revalidatePath("/");
  revalidatePath("/more/alerts");
  revalidatePath("/menu");
  revalidatePath("/menu/import-review");
  revalidatePath("/more/uploads");
  return finishMatch("matched");
}

/** Ignore is deliberately session-only: there is no durable ignored state without a migration. */
export async function addUploadedItemToMenu(matchId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return finishMatch("error");
  const businessId = await getActiveBusinessId(user.id);
  const {data:match} = await supabase.from("pos_catalog_matches").select("id,provider,status")
    .eq("business_id",businessId).eq("id",matchId).eq("provider","csv").eq("status","needs_review").maybeSingle();
  if (!match) return finishMatch("error");
  await resolveCatalogMatch(matchId,"new");
}
