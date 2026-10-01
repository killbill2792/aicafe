import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PosAdapter } from "./types";
import { catalogSourceFor, matchCatalogItem, type CanonicalMenuCandidate } from "./catalogMatching";

/** Enrich the canonical catalog without touching recipes, costs, or decision history. */
export async function syncCanonicalCatalog(supabase: SupabaseClient, businessId: string, adapter: PosAdapter) {
  const imported = await adapter.fetchCatalogItems();
  const { data } = await supabase.from("menu_items").select("id, name, size_label, price_cents, category, pos_item_id").eq("business_id", businessId);
  const candidates: CanonicalMenuCandidate[] = (data ?? []).map((item) => ({ id: item.id, name: item.name, sizeLabel: item.size_label, priceCents: item.price_cents, category: item.category, posItemId: item.pos_item_id }));
  let matched = 0;
  let needsReview = 0;
  let created = 0;
  for (const item of imported) {
    const result = matchCatalogItem(item, candidates);
    if (result.status === "needs_review") {
      needsReview += 1;
      await supabase.from("pos_catalog_matches").upsert({ business_id: businessId, provider: adapter.provider, pos_item_id: item.posItemId, imported_name: item.name, imported_price_cents: item.priceCents, imported_category: item.category, suggested_menu_item_id: result.candidateId, match_score: result.score, status: "needs_review" }, { onConflict: "business_id,provider,pos_item_id" });
      continue;
    }
    if (result.candidateId) {
      matched += 1;
      await supabase.from("menu_items").update({ pos_item_id: item.posItemId, name: item.name, price_cents: item.priceCents, category: item.category, is_active: true, catalog_source: catalogSourceFor(adapter.provider), catalog_last_synced_at: new Date().toISOString() }).eq("id", result.candidateId).eq("business_id", businessId);
      continue;
    }
    created += 1;
    await supabase.from("menu_items").insert({ business_id: businessId, pos_item_id: item.posItemId, name: item.name, base_name: item.name, price_cents: item.priceCents, category: item.category, is_active: true, catalog_source: catalogSourceFor(adapter.provider), catalog_last_synced_at: new Date().toISOString() });
  }
  return { imported: imported.length, matched, needsReview, created };
}
