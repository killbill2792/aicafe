import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getMenuItemsForEdit, type MenuItemForEdit } from "./getMenuItemsForEdit";
import { getPricingInputs } from "./getPricingInputs";
import { buildPricingViewModel } from "@/lib/viewmodels/pricingViewModel";
import {
  analyzePriceChangeSalesResponse,
  compareCostBasedPrice,
  compareNearbyMarketPrice,
  type CostBenchmarkComparison,
  type ItemSalesEvidenceDay,
  type MarketPriceObservation,
  type NearbyMarketComparison,
  type PriceChangeSalesResponse,
  type PricingResult,
} from "@/lib/calc";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE } from "./queryError";
import { formatInTimeZone } from "date-fns-tz";
import { subDays } from "date-fns";
import {
  itemSalesDailyByPeriod,
  itemSalesPeriodTotals,
  type DatedItemQuantity,
  type ItemSalesDailyByPeriod,
  type ItemSalesPeriodTotals,
  type SalesCoverage,
} from "@/lib/calc/itemSalesPeriods";

export type MenuPricingEvidence = {
  costBenchmark: CostBenchmarkComparison;
  salesResponse: PriceChangeSalesResponse;
  nearbyMarket: NearbyMarketComparison;
};

export type MenuControlItem = MenuItemForEdit & {
  pricing: PricingResult | null;
  pricingEvidence?: MenuPricingEvidence;
  unitsSold: number | null;
  unitsSoldByPeriod?: ItemSalesPeriodTotals;
  unitsSoldDailyByPeriod?: ItemSalesDailyByPeriod;
  revenueCents: number | null;
  provenance: "MANUAL" | "CSV" | "SQUARE" | "TOAST" | "CLOVER" | "OTHER_POS";
  lastSyncedAt: string | null;
};

const EMPTY_EVIDENCE: MenuPricingEvidence = {
  costBenchmark: { status: "unavailable" },
  salesResponse: { status: "no_change_history" },
  nearbyMarket: { status: "unavailable", verifiedNearbyCount: 0, minimumCompetitors: 3 },
};

/** One canonical read model for both the menu catalog and product detail. */
export async function getMenuControlCenter(): Promise<MenuControlItem[]> {
  const { items } = await getMenuItemsForEdit();
  if (!isSupabaseConfigured() || items.length === 0) {
    return items.map((item) => ({
      ...item,
      pricing: null,
      pricingEvidence: EMPTY_EVIDENCE,
      unitsSold: null,
      unitsSoldByPeriod: { today: null, days7: null, days30: null },
      unitsSoldDailyByPeriod: { today: null, days7: null, days30: null },
      revenueCents: null,
      provenance: "MANUAL",
      lastSyncedAt: null,
    }));
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const businessId = await getActiveBusinessId(user.id);
  const pricingInputs = await getPricingInputs(supabase, businessId);
  const pricingById = new Map(buildPricingViewModel(pricingInputs).map((row) => [row.itemId, row.result]));
  const inputById = new Map(pricingInputs.items.map((item) => [item.id, item]));
  const itemIds = items.map((item) => item.id);

  const { data: business } = await supabase
    .from("businesses")
    .select("timezone")
    .eq("id", businessId)
    .single();
  const timezone = business?.timezone ?? "America/Los_Angeles";
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const start30 = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 29), "UTC", "yyyy-MM-dd");
  const start90 = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");

  const [salesResult, rollupsResult, historyResult, marketResult, connectionsResult] = await Promise.all([
    supabase
      .from("order_lines")
      .select("menu_item_id, net_sales_cents, quantity, orders!inner(business_date, business_id)")
      .in("menu_item_id", itemIds)
      .eq("orders.business_id", businessId)
      .gte("orders.business_date", start90)
      .lte("orders.business_date", today)
      .eq("voided", false),
    supabase
      .from("daily_rollups")
      .select("business_date, sales_data_status")
      .eq("business_id", businessId)
      .gte("business_date", start90)
      .lte("business_date", today),
    supabase
      .from("menu_price_history")
      .select("menu_item_id, old_price_cents, new_price_cents, source_type, source_provider, changed_at")
      .eq("business_id", businessId)
      .in("menu_item_id", itemIds)
      .order("changed_at", { ascending: false }),
    supabase
      .from("menu_market_price_observations")
      .select("menu_item_id, competitor_name, price_cents, observed_on, distance_meters, source_label, source_url")
      .eq("business_id", businessId)
      .in("menu_item_id", itemIds)
      .gte("observed_on", start90)
      .lte("observed_on", today),
    supabase
      .from("pos_connections")
      .select("provider, status, last_synced_at, backfill_completed_at")
      .eq("business_id", businessId)
      .eq("status", "active")
      .eq("provider", "square")
      .not("last_synced_at", "is", null)
      .not("backfill_completed_at", "is", null),
  ]);

  if (salesResult.error) {
    logQueryError("getMenuControlCenter:order_lines", salesResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  if (rollupsResult.error) {
    logQueryError("getMenuControlCenter:daily_rollups", rollupsResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  if (historyResult.error) {
    logQueryError("getMenuControlCenter:menu_price_history", historyResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  if (marketResult.error) {
    logQueryError("getMenuControlCenter:market_prices", marketResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  if (connectionsResult.error) {
    logQueryError("getMenuControlCenter:pos_connections", connectionsResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }

  const revenueById = new Map<string, number>();
  const datedQuantities: DatedItemQuantity[] = [];
  const itemDaily = new Map<string, Map<string, { units: number; revenueCents: number }>>();

  for (const row of salesResult.data ?? []) {
    if (!row.menu_item_id) continue;
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    if (!order) continue;
    const quantity = Number(row.quantity);
    const revenueCents = Number(row.net_sales_cents);
    datedQuantities.push({ menuItemId: row.menu_item_id, businessDate: order.business_date, quantity });

    if (order.business_date >= start30) {
      revenueById.set(row.menu_item_id, (revenueById.get(row.menu_item_id) ?? 0) + revenueCents);
    }

    const byDate = itemDaily.get(row.menu_item_id) ?? new Map<string, { units: number; revenueCents: number }>();
    const prior = byDate.get(order.business_date) ?? { units: 0, revenueCents: 0 };
    byDate.set(order.business_date, {
      units: prior.units + quantity,
      revenueCents: prior.revenueCents + revenueCents,
    });
    itemDaily.set(row.menu_item_id, byDate);
  }

  const coveredSalesDates = (rollupsResult.data ?? [])
    .filter((row) => row.sales_data_status === "actual")
    .map((row) => row.business_date)
    .sort();

  const latestChangeByItem = new Map<string, {
    changedOn: string;
    oldPriceCents: number;
    newPriceCents: number;
    sourceType: "owner_manual" | "connected_pos" | "imported";
    sourceProvider: string | null;
  }>();
  for (const row of historyResult.data ?? []) {
    if (
      latestChangeByItem.has(row.menu_item_id) ||
      row.old_price_cents === null ||
      Number(row.old_price_cents) <= 0 ||
      Number(row.new_price_cents) <= 0 ||
      Number(row.old_price_cents) === Number(row.new_price_cents) ||
      row.source_type === "initial"
    ) {
      continue;
    }
    latestChangeByItem.set(row.menu_item_id, {
      changedOn: formatInTimeZone(new Date(row.changed_at), timezone, "yyyy-MM-dd"),
      oldPriceCents: Number(row.old_price_cents),
      newPriceCents: Number(row.new_price_cents),
      sourceType: row.source_type as "owner_manual" | "connected_pos" | "imported",
      sourceProvider: row.source_provider,
    });
  }

  const marketByItem = new Map<string, MarketPriceObservation[]>();
  for (const row of marketResult.data ?? []) {
    const rows = marketByItem.get(row.menu_item_id) ?? [];
    rows.push({
      competitorName: row.competitor_name,
      priceCents: Number(row.price_cents),
      observedOn: row.observed_on,
      distanceMeters: row.distance_meters === null ? null : Number(row.distance_meters),
      sourceLabel: row.source_label,
      sourceUrl: row.source_url,
    });
    marketByItem.set(row.menu_item_id, rows);
  }

  // A completed Square backfill is the repository's persisted promise of a continuous sales
  // window for the Menu's Today/7/30-day display. Price-response analysis is stricter: it only
  // uses dates explicitly marked sales_data_status=actual, so it never invents zero-sales days.
  const coverage = (connectionsResult.data ?? []).reduce<SalesCoverage | null>((best, connection) => {
    const syncedThrough = formatInTimeZone(new Date(connection.last_synced_at), timezone, "yyyy-MM-dd");
    const backfillDay = formatInTimeZone(new Date(connection.backfill_completed_at), timezone, "yyyy-MM-dd");
    const coveredFrom = formatInTimeZone(subDays(new Date(`${backfillDay}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");
    if (!best) return { start: coveredFrom, end: syncedThrough };
    return {
      start: coveredFrom < best.start ? coveredFrom : best.start,
      end: syncedThrough > best.end ? syncedThrough : best.end,
    };
  }, null);

  return items.map((item) => {
    const input = inputById.get(item.id);
    const pricing = pricingById.get(item.id) ?? null;
    const daily = itemDaily.get(item.id) ?? new Map<string, { units: number; revenueCents: number }>();
    const salesEvidence: ItemSalesEvidenceDay[] = coveredSalesDates.map((date) => {
      const itemDay = daily.get(date);
      return {
        date,
        covered: true,
        units: itemDay?.units ?? 0,
        revenueCents: itemDay?.revenueCents ?? 0,
      };
    });
    const latestChange = latestChangeByItem.get(item.id) ?? null;

    return {
      ...item,
      pricing,
      pricingEvidence: {
        costBenchmark: compareCostBasedPrice(item.priceCents, pricing?.baselinePriceCents ?? null),
        salesResponse: analyzePriceChangeSalesResponse(latestChange, salesEvidence),
        nearbyMarket: compareNearbyMarketPrice(item.priceCents, marketByItem.get(item.id) ?? [], today),
      },
      unitsSold: input && input.unitsSoldInWindow > 0 ? input.unitsSoldInWindow : null,
      unitsSoldByPeriod: itemSalesPeriodTotals(datedQuantities, coverage, item.id, today),
      unitsSoldDailyByPeriod: itemSalesDailyByPeriod(datedQuantities, coverage, item.id, today),
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  });
}
