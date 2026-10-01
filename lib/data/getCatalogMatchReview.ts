import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { getActiveBusinessId } from "./getActiveBusinessId";

export type CatalogMatchReview = { id: string; provider: string; posItemId: string; importedName: string; importedPriceCents: number | null; suggestedMenuItemId: string | null; suggestedName: string | null; status: string };
export async function getCatalogMatchReview(): Promise<CatalogMatchReview[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);
  const { data } = await supabase.from("pos_catalog_matches").select("id, provider, pos_item_id, imported_name, imported_price_cents, suggested_menu_item_id, status, menu_items(name)").eq("business_id", businessId).eq("status", "needs_review").order("created_at");
  return (data ?? []).map((row) => { const joined = row.menu_items as unknown as { name: string } | { name: string }[] | null; return { id: row.id, provider: row.provider, posItemId: row.pos_item_id, importedName: row.imported_name, importedPriceCents: row.imported_price_cents, suggestedMenuItemId: row.suggested_menu_item_id, suggestedName: (Array.isArray(joined) ? joined[0] : joined)?.name ?? null, status: row.status }; });
}
