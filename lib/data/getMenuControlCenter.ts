import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getMenuItemsForEdit, type MenuItemForEdit } from "./getMenuItemsForEdit";
import { getPricingInputs } from "./getPricingInputs";
import { buildPricingViewModel } from "@/lib/viewmodels/pricingViewModel";
import type { PricingResult } from "@/lib/calc";

export type MenuControlItem = MenuItemForEdit & {
  pricing: PricingResult | null;
  unitsSold: number | null;
  revenueCents: number | null;
  provenance: "MANUAL" | "CSV" | "SQUARE" | "TOAST" | "CLOVER" | "OTHER_POS";
  lastSyncedAt: string | null;
};

/** One canonical read model for both the menu catalog and product detail. */
export async function getMenuControlCenter(): Promise<MenuControlItem[]> {
  const { items } = await getMenuItemsForEdit();
  if (!isSupabaseConfigured() || items.length === 0) return items.map((item) => ({ ...item, pricing: null, unitsSold: null, revenueCents: null, provenance: "MANUAL", lastSyncedAt: null }));
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);
  const pricingInputs = await getPricingInputs(supabase, businessId);
  const pricingById = new Map(buildPricingViewModel(pricingInputs).map((row) => [row.itemId, row.result]));
  const inputById = new Map(pricingInputs.items.map((item) => [item.id, item]));
  const itemIds = items.map((item) => item.id);
  const { data: salesRows } = await supabase
    .from("order_lines")
    .select("menu_item_id, net_sales_cents")
    .in("menu_item_id", itemIds)
    .eq("voided", false);
  const revenueById = new Map<string, number>();
  for (const row of salesRows ?? []) {
    if (!row.menu_item_id) continue;
    revenueById.set(row.menu_item_id, (revenueById.get(row.menu_item_id) ?? 0) + row.net_sales_cents);
  }
  return items.map((item) => {
    const input = inputById.get(item.id);
    return {
      ...item,
      // No separate READY gate here — suggestPrice() itself now returns a PRICE_UNAVAILABLE result
      // (not null) for any item whose recipe isn't ready, so this always agrees with costStatus
      // instead of risking two independent "is this item priced" checks drifting apart.
      pricing: pricingById.get(item.id) ?? null,
      unitsSold: input && input.unitsSoldInWindow > 0 ? input.unitsSoldInWindow : null,
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  });
}
