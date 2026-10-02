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

export type MenuControlItem = MenuItemForEdit & {
  pricing: PricingResult | null;
  unitsSold: number | null;
  unitsSoldToday: number;
  unitsSoldLast7Days: number;
  unitsSoldLast30Days: number;
  revenueCents: number | null;
  provenance: "MANUAL" | "CSV" | "SQUARE" | "TOAST" | "CLOVER" | "OTHER_POS";
  lastSyncedAt: string | null;
};

/** One canonical read model for both the menu catalog and product detail. */
export async function getMenuControlCenter(): Promise<MenuControlItem[]> {
  const { items } = await getMenuItemsForEdit();
  if (!isSupabaseConfigured() || items.length === 0) return items.map((item) => ({ ...item, pricing: null, unitsSold: null, unitsSoldToday: 0, unitsSoldLast7Days: 0, unitsSoldLast30Days: 0, revenueCents: null, provenance: "MANUAL", lastSyncedAt: null }));
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);
  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const pricingInputs = await getPricingInputs(supabase, businessId);
  const pricingById = new Map(buildPricingViewModel(pricingInputs).map((row) => [row.itemId, row.result]));
  const inputById = new Map(pricingInputs.items.map((item) => [item.id, item]));
  const itemIds = items.map((item) => item.id);
  const { data: salesRows, error: salesError } = await supabase
    .from("order_lines")
    .select("menu_item_id, quantity, net_sales_cents, orders!inner(business_date)")
    .in("menu_item_id", itemIds)
    .eq("voided", false);
  if (salesError) {
    logQueryError("getMenuControlCenter:order_lines", salesError);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const revenueById = new Map<string, number>();
  const unitsByPeriod = new Map<string, { today: number; last7: number; last30: number }>();
  const today = new Date();
  const timezone = business?.timezone ?? "America/Los_Angeles";
  const todayKey = formatInTimeZone(today, timezone, "yyyy-MM-dd");
  const cutoff7 = formatInTimeZone(new Date(today.getTime() - 6 * 86_400_000), timezone, "yyyy-MM-dd");
  const cutoff30 = formatInTimeZone(new Date(today.getTime() - 29 * 86_400_000), timezone, "yyyy-MM-dd");
  for (const row of salesRows ?? []) {
    if (!row.menu_item_id) continue;
    revenueById.set(row.menu_item_id, (revenueById.get(row.menu_item_id) ?? 0) + row.net_sales_cents);
    const joined = row.orders as unknown as { business_date: string } | { business_date: string }[];
    const businessDate = (Array.isArray(joined) ? joined[0] : joined)?.business_date;
    const current = unitsByPeriod.get(row.menu_item_id) ?? { today: 0, last7: 0, last30: 0 };
    const quantity = Number(row.quantity);
    if (businessDate === todayKey) current.today += quantity;
    if (businessDate >= cutoff7 && businessDate <= todayKey) current.last7 += quantity;
    if (businessDate >= cutoff30 && businessDate <= todayKey) current.last30 += quantity;
    unitsByPeriod.set(row.menu_item_id, current);
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
      unitsSoldToday: unitsByPeriod.get(item.id)?.today ?? 0,
      unitsSoldLast7Days: unitsByPeriod.get(item.id)?.last7 ?? 0,
      unitsSoldLast30Days: unitsByPeriod.get(item.id)?.last30 ?? 0,
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  });
}
