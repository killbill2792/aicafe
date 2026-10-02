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

export type MenuControlItem = MenuItemForEdit & {
  pricing: PricingResult | null;
  unitsSold: number | null;
  unitsSoldByPeriod?: { today: number; days7: number; days30: number };
  revenueCents: number | null;
  provenance: "MANUAL" | "CSV" | "SQUARE" | "TOAST" | "CLOVER" | "OTHER_POS";
  lastSyncedAt: string | null;
};

/** One canonical read model for both the menu catalog and product detail. */
export async function getMenuControlCenter(): Promise<MenuControlItem[]> {
  const { items } = await getMenuItemsForEdit();
  if (!isSupabaseConfigured() || items.length === 0) return items.map((item) => ({ ...item, pricing: null, unitsSold: null, unitsSoldByPeriod: { today: 0, days7: 0, days30: 0 }, revenueCents: null, provenance: "MANUAL", lastSyncedAt: null }));
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
  const start7 = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 6), "UTC", "yyyy-MM-dd");
  const { data: salesRows, error: salesError } = await supabase
    .from("order_lines")
    .select("menu_item_id, net_sales_cents, quantity, orders!inner(business_date, business_id)")
    .in("menu_item_id", itemIds)
    .eq("orders.business_id", businessId)
    .eq("voided", false);
  if (salesError) {
    logQueryError("getMenuControlCenter:order_lines", salesError);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const revenueById = new Map<string, number>();
  const periodById = new Map<string, { today: number; days7: number; days30: number }>();
  for (const row of salesRows ?? []) {
    if (!row.menu_item_id) continue;
    revenueById.set(row.menu_item_id, (revenueById.get(row.menu_item_id) ?? 0) + row.net_sales_cents);
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    if (!order) continue;
    const quantity = Number(row.quantity);
    const periods = periodById.get(row.menu_item_id) ?? { today: 0, days7: 0, days30: 0 };
    if (order.business_date >= start30 && order.business_date <= today) periods.days30 += quantity;
    if (order.business_date >= start7 && order.business_date <= today) periods.days7 += quantity;
    if (order.business_date === today) periods.today += quantity;
    periodById.set(row.menu_item_id, periods);
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
      unitsSoldByPeriod: periodById.get(item.id) ?? { today: 0, days7: 0, days30: 0 },
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  });
}
