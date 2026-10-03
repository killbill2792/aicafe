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
import { itemSalesDailyByPeriod, itemSalesPeriodTotals, type DatedItemQuantity, type ItemSalesDailyByPeriod, type ItemSalesPeriodTotals, type SalesCoverage } from "@/lib/calc/itemSalesPeriods";

export type MenuControlItem = MenuItemForEdit & {
  pricing: PricingResult | null;
  unitsSold: number | null;
  unitsSoldByPeriod?: ItemSalesPeriodTotals;
  unitsSoldDailyByPeriod?: ItemSalesDailyByPeriod;
  revenueCents: number | null;
  provenance: "MANUAL" | "CSV" | "SQUARE" | "TOAST" | "CLOVER" | "OTHER_POS";
  lastSyncedAt: string | null;
};

/** One canonical read model for both the menu catalog and product detail. */
export async function getMenuControlCenter(): Promise<MenuControlItem[]> {
  const { items } = await getMenuItemsForEdit();
  if (!isSupabaseConfigured() || items.length === 0) return items.map((item) => ({ ...item, pricing: null, unitsSold: null, unitsSoldByPeriod: { today: null, days7: null, days30: null }, unitsSoldDailyByPeriod: { today: null, days7: null, days30: null }, revenueCents: null, provenance: "MANUAL", lastSyncedAt: null }));
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
  const { data: connectionRows, error: coverageError } = await supabase
    .from("pos_connections")
    .select("provider, status, last_synced_at, backfill_completed_at")
    .eq("business_id", businessId)
    .eq("status", "active")
    .eq("provider", "square")
    .not("last_synced_at", "is", null)
    .not("backfill_completed_at", "is", null);
  if (coverageError) { logQueryError("getMenuControlCenter:pos_connections", coverageError); throw new Error(MENU_LOAD_FAILURE_MESSAGE); }
  // A completed Square backfill is the repository's only persisted promise of a continuous
  // sales window (90 days). Rollups and orders intentionally have no row on a closed day, while
  // CSV uploads do not persist the range the owner exported, so neither can prove coverage.
  const coverage = (connectionRows ?? []).reduce<SalesCoverage | null>((best, connection) => {
    const syncedThrough = formatInTimeZone(new Date(connection.last_synced_at), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
    const backfillDay = formatInTimeZone(new Date(connection.backfill_completed_at), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
    const coveredFrom = formatInTimeZone(subDays(new Date(`${backfillDay}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");
    if (!best) return { start: coveredFrom, end: syncedThrough };
    return { start: coveredFrom < best.start ? coveredFrom : best.start, end: syncedThrough > best.end ? syncedThrough : best.end };
  }, null);
  return items.map((item) => {
    const input = inputById.get(item.id);
    return {
      ...item,
      // No separate READY gate here — suggestPrice() itself now returns a PRICE_UNAVAILABLE result
      // (not null) for any item whose recipe isn't ready, so this always agrees with costStatus
      // instead of risking two independent "is this item priced" checks drifting apart.
      pricing: pricingById.get(item.id) ?? null,
      unitsSold: input && input.unitsSoldInWindow > 0 ? input.unitsSoldInWindow : null,
      unitsSoldByPeriod: itemSalesPeriodTotals(datedQuantities, coverage, item.id, today),
      unitsSoldDailyByPeriod: itemSalesDailyByPeriod(datedQuantities, coverage, item.id, today),
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  });
}
