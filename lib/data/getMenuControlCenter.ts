import "server-only";
import { readDailyFactRows } from "./dailyFacts.server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getMenuItemsForEdit, type MenuItemForEdit } from "./getMenuItemsForEdit";
import { getPricingInputs } from "./getPricingInputs";
import { timeReader } from "@/lib/perf/timeReader.server";
import type { MenuPriceSourceBasis } from "@/lib/calc/menuPriceSourceBasis";
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
import {resolveSalesCoverage} from "@/lib/calc/salesCoverage";
import {
  itemSalesDailyByPeriod,
  itemSalesPeriodTotals,
  type DatedItemQuantity,
  type ItemSalesDailyByPeriod,
  type ItemSalesPeriodTotals,

} from "@/lib/calc/itemSalesPeriods";

export type MenuPricingEvidence = {
  costBenchmark: CostBenchmarkComparison;
  salesResponse: PriceChangeSalesResponse;
  nearbyMarket: NearbyMarketComparison;
};

export type MenuPricingBasis = MenuPriceSourceBasis & {
  targetOperatingMarginBps: number;
  targetMarginStatus: "default" | "confirmed";
};
export type MenuControlItem = MenuItemForEdit & {
  pricingBasis?: MenuPricingBasis;
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
export async function getMenuControlCenter(options: { includeSalesEvidence?: boolean } = {}): Promise<MenuControlItem[]> {
  const attentionOnly = options.includeSalesEvidence === false;
  const measure = <T>(stage: string, read: () => Promise<T>): Promise<T> =>
    attentionOnly ? timeReader("Home", "menu." + stage, read) : read();
  const { items } = await measure("catalog", getMenuItemsForEdit);
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
  const pricingInputs = await measure("pricingInputs", () =>
    getPricingInputs(supabase, businessId, { attentionOnly }));
  const pricingById = new Map(buildPricingViewModel(pricingInputs).map((row) => [row.itemId, row.result]));
  const pricingBasis: MenuPricingBasis = {
    ...pricingInputs.menuPriceBasis,
    targetOperatingMarginBps: Math.round(
      (pricingInputs.business.targetOperatingMargin ?? 0.15) * 10000),
    targetMarginStatus: pricingInputs.business.targetOperatingMarginStatus ?? "default",
  };
  const inputById = new Map(pricingInputs.items.map((item) => [item.id, item]));
  // Both full Menu and Home attention use exactly the same pricing calculation.
  const baseItem = (item: MenuItemForEdit) => {
    const input = inputById.get(item.id);
    return {
      ...item,
      pricing: pricingById.get(item.id) ?? null,
      pricingBasis,
      unitsSold: input && input.unitsSoldInWindow > 0 ? input.unitsSoldInWindow : null,
      provenance: ((item.catalogSource ?? (item.posItemId ? "OTHER_POS" : "MANUAL")).toUpperCase()) as MenuControlItem["provenance"],
      lastSyncedAt: item.catalogLastSyncedAt,
    };
  };
  // Home only projects pricing into attention tasks. It doesn't display item
  // sales response, market comparisons, daily units or revenue. Avoid that
  // separate 90-day order-line scan and its optional evidence queries.
  if (options.includeSalesEvidence === false) {
    return items.map((item) => ({
      ...baseItem(item),
      pricingEvidence: EMPTY_EVIDENCE,
      unitsSoldByPeriod: { today: null, days7: null, days30: null },
      unitsSoldDailyByPeriod: { today: null, days7: null, days30: null },
      revenueCents: null,
    }));
  }
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
      .eq("orders.toast_excluded", false).is("orders.superseded_by", null)
      .gte("orders.business_date", start90)
      .lte("orders.business_date", today)
      .eq("voided", false),
    readDailyFactRows(supabase, businessId, start90, today)
      .then((data) => ({ data, error: null }), (error: { message: string }) => ({ data: null, error })),
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
      .eq("status", "active"),
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

  type RecordedPriceChange = {
    changedOn: string;
    oldPriceCents: number;
    newPriceCents: number;
    sourceType: "owner_manual" | "connected_pos" | "imported";
    sourceProvider: string | null;
  };
  const changesByItem = new Map<string, RecordedPriceChange[]>();
  for (const row of historyResult.data ?? []) {
    if (
      row.old_price_cents === null ||
      Number(row.old_price_cents) <= 0 ||
      Number(row.new_price_cents) <= 0 ||
      Number(row.old_price_cents) === Number(row.new_price_cents) ||
      row.source_type === "initial"
    ) {
      continue;
    }
    const rows = changesByItem.get(row.menu_item_id) ?? [];
    rows.push({
      changedOn: formatInTimeZone(new Date(row.changed_at), timezone, "yyyy-MM-dd"),
      oldPriceCents: Number(row.old_price_cents),
      newPriceCents: Number(row.new_price_cents),
      sourceType: row.source_type as "owner_manual" | "connected_pos" | "imported",
      sourceProvider: row.source_provider,
    });
    changesByItem.set(row.menu_item_id, rows);
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

  // The same provider-neutral actual-day proof powers Menu and chat. Partial
  // periods stay unknown rather than turning missing days into zero sales.
  const coverage=resolveSalesCoverage({from:start90,to:today},coveredSalesDates,
    connectionsResult.data??[]).coveredDates;

  const hasLiveSquareCatalog = (connectionsResult.data ?? []).some(row=>row.provider==="square");

  return items.map((item) => {
    const base = baseItem(item);
    const pricing = base.pricing;
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
    const latestChange =
      (changesByItem.get(item.id) ?? []).find(
        (change) => !hasLiveSquareCatalog || change.sourceType !== "owner_manual",
      ) ?? null;

    return {
      ...base,
      pricingEvidence: {
        costBenchmark: compareCostBasedPrice(item.priceCents, pricing?.baselinePriceCents ?? null),
        salesResponse: analyzePriceChangeSalesResponse(latestChange, salesEvidence),
        nearbyMarket: compareNearbyMarketPrice(item.priceCents, marketByItem.get(item.id) ?? [], today),
      },
      unitsSoldByPeriod: itemSalesPeriodTotals(datedQuantities, coverage, item.id, today),
      unitsSoldDailyByPeriod: itemSalesDailyByPeriod(datedQuantities, coverage, item.id, today),
      revenueCents: revenueById.has(item.id) ? revenueById.get(item.id)! : null,
    };
  });
}
