import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getMenuItemsForEdit, type MenuItemForEdit } from "./getMenuItemsForEdit";
import { getPricingInputs } from "./getPricingInputs";
import { buildPricingViewModel } from "@/lib/viewmodels/pricingViewModel";
import type { PricingResult } from "@/lib/calc";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE } from "./queryError";
import { formatInTimeZone } from "date-fns-tz";
import { subDays } from "date-fns";
import { itemSalesPeriodTotals, type DatedItemQuantity, type ItemSalesPeriodTotals } from "@/lib/menu/itemSalesPeriods";

export type MenuControlItem = MenuItemForEdit & {
  pricing: PricingResult | null;
  unitsSold: number | null;
  unitsSoldByPeriod?: ItemSalesPeriodTotals;
  revenueCents: number | null;
  provenance: "MANUAL" | "CSV" | "SQUARE" | "TOAST" | "CLOVER" | "OTHER_POS";
  lastSyncedAt: string | null;
};

/** One canonical read model for both the menu catalog and product detail. */
export async function getMenuControlCenter(): Promise<MenuControlItem[]> {
  const { items } = await getMenuItemsForEdit();
  if (!isSupabaseConfigured() || items.length === 0) return items.map((item) => ({ ...item, pricing: null, unitsSold: null, unitsSoldByPeriod: { today: null, days7: null, days30: null }, revenueCents: null, provenance: "MANUAL", lastSyncedAt: null }));
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);
  const pricingInputs = await getPricingInputs(supabase, businessId);
  const pricingById = new Map(buildPricingViewModel(pricingInputs).map((row) => [row.itemId, row.result]));
  const inputById = new Map(pricingInputs.items.map((item) => [item.id, item]));
  const itemIds = items.map((item) => item.id);
  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const today = formatInTimeZone(new Date(), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
  const start30 = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 29), "UTC", "yyyy-MM-dd");
  const { data: salesRows, error: salesError } = await supabase
    .from("order_lines")
    .select("menu_item_id, net_sales_cents, quantity, orders!inner(business_date, business_id)")
    .in("menu_item_id", itemIds)
    .eq("orders.business_id", businessId)
    .gte("orders.business_date", start30)
    .lte("orders.business_date", today)
    .eq("voided", false);
  if (salesError) {
    logQueryError("getMenuControlCenter:order_lines", salesError);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const revenueById = new Map<string, number>();
  const datedQuantities: DatedItemQuantity[] = [];
  for (const row of salesRows ?? []) {
    if (!row.menu_item_id) continue;
    revenueById.set(row.menu_item_id, (revenueById.get(row.menu_item_id) ?? 0) + row.net_sales_cents);
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    if (!order) continue;
    const quantity = Number(row.quantity);
    datedQuantities.push({ menuItemId: row.menu_item_id, businessDate: order.business_date, quantity });
  }
  const { data: coverageRows, error: coverageError } = await supabase.from("daily_rollups").select("business_date").eq("business_id", businessId).gte("business_date", start30).lte("business_date", today);
  if (coverageError) { logQueryError("getMenuControlCenter:daily_rollups", coverageError); throw new Error(MENU_LOAD_FAILURE_MESSAGE); }
  const coverageDates = (coverageRows ?? []).map((row) => row.business_date);
  return items.map((item) => {
    const input = inputById.get(item.id);
    return {
      ...item,
      // No separate READY gate here — suggestPrice() itself now returns a PRICE_UNAVAILABLE result
      // (not null) for any item whose recipe isn't ready, so this always agrees with costStatus
      // instead of risking two independent "is this item priced" checks drifting apart.
      pricing: pricingById.get(item.id) ?? null,
      unitsSold: input && input.unitsSoldInWindow > 0 ? input.unitsSoldInWindow : null,
      unitsSoldByPeriod: itemSalesPeriodTotals(datedQuantities, coverageDates, item.id, today),
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  });
}
