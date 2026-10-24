import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE } from "./queryError";

export type CatalogMatchReview = { id: string; provider: string; posItemId: string; importedName: string; importedPriceCents: number | null; suggestedMenuItemId: string | null; suggestedName: string | null; status: string };
export async function getCatalogMatchReview(filter?: { source?: string; uploadId?: string }): Promise<CatalogMatchReview[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);
  let allowedNames: Set<string> | null = null;
  if (filter?.source === "upload") {
    if (!filter.uploadId) return [];
    const { data: upload, error: uploadError } = await supabase.from("uploads")
      .select("kind, summary").eq("id", filter.uploadId).eq("business_id", businessId).maybeSingle();
    if (uploadError) { logQueryError("getCatalogMatchReview:upload", uploadError); throw new Error(MENU_LOAD_FAILURE_MESSAGE); }
    if (!upload || upload.kind !== "sales_csv") return [];
    const summary = upload.summary as { unmatchedItems?: { name: string }[] } | null;
    allowedNames = new Set((summary?.unmatchedItems ?? []).map(row => row.name.toLowerCase()));
  }
  let query = supabase.from("pos_catalog_matches").select("id, provider, pos_item_id, imported_name, imported_price_cents, suggested_menu_item_id, status, menu_items(name)")
    .eq("business_id", businessId).eq("status", "needs_review");
  if (filter?.source === "upload") query = query.eq("provider", "csv");
  const { data, error } = await query.order("created_at");
  if (error) { logQueryError("getCatalogMatchReview", error); throw new Error(MENU_LOAD_FAILURE_MESSAGE); }
  return (data ?? []).filter(row => allowedNames === null || allowedNames.has(row.imported_name.toLowerCase()))
    .map(row => { const joined = row.menu_items as unknown as { name: string } | { name: string }[] | null;
      return { id: row.id, provider: row.provider, posItemId: row.pos_item_id, importedName: row.imported_name, importedPriceCents: row.imported_price_cents, suggestedMenuItemId: row.suggested_menu_item_id, suggestedName: (Array.isArray(joined) ? joined[0] : joined)?.name ?? null, status: row.status };
    });
}
