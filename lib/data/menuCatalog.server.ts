import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPosRows } from "@/lib/pos/pagedReads";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE } from "./queryError";

/** The one café-scoped menu item and selling-price read for the Menu screen and Supervisor.
 * Include open-price and archived rows here; consumers decide how to display them.
 * Pagination prevents the provider's default row cap from hiding menu items.
 */
export type MenuCatalogRow = {
  id: string;
  name: string;
  base_name: string | null;
  size_label: string | null;
  price_cents: number | null;
  prep_seconds: number;
  category: string;
  menu_group: string | null;
  is_active: boolean;
  pos_item_id: string | null;
  catalog_source: string | null;
  catalog_last_synced_at: string | null;
  description: string | null;
  pos_visibility: string | null;
  pos_pricing_strategy: string | null;
};

export async function readMenuCatalogRows(
  client: SupabaseClient,
  businessId: string,
): Promise<MenuCatalogRow[]> {
  if (!businessId) throw new Error("Café access scope mismatch");
  try {
    return await readAllPosRows<MenuCatalogRow>(
      (first, last) => client.from("menu_items")
        .select("id, name, base_name, size_label, price_cents, prep_seconds, category, menu_group, is_active, pos_item_id, catalog_source, catalog_last_synced_at, description, pos_visibility, pos_pricing_strategy")
        .eq("business_id", businessId)
        .order("name").order("id")
        .range(first, last),
      "café menu items",
    );
  } catch {
    // Report only an error category, never row data or DB payloads.
    logQueryError("readMenuCatalogRows:menu_items", { message: "read_failed" });
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
}
