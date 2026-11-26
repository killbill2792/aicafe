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
      (first, last) => client.from("cv_menu")
        .select("id:data->id,name:data->name,base_name:data->base_name,size_label:data->size_label,price_cents:data->price_cents,prep_seconds:data->prep_seconds,category:data->category,menu_group:data->menu_group,is_active:data->is_active,pos_item_id:data->pos_item_id,catalog_source:data->catalog_source,catalog_last_synced_at:data->catalog_last_synced_at,description:data->description,pos_visibility:data->pos_visibility,pos_pricing_strategy:data->pos_pricing_strategy")
        .eq("business_id", businessId).like("source_ref","item:%")
        .order("data->>name").order("source_ref")
        .range(first, last),
      "café menu items",
    );
  } catch {
    // Report only an error category, never row data or DB payloads.
    logQueryError("readMenuCatalogRows:cv_menu", { message: "read_failed" });
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
}
