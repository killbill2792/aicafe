import { detectPricingMode } from "@/lib/calc/pricingMode";

/**
 * Conservative shortcut for the Home attention projection: if the canonical
 * pricing engine would remain in BENCHMARK mode even with unlimited trusted
 * orders and positive revenue, an order-history read cannot alter any item's
 * pricing result. Other callers still load their full order evidence.
 */
export function ordersMayAffectPricing(daysWithSalesInWindow: number, windowDays: number): boolean {
  return detectPricingMode({
    daysWithSalesInWindow,
    windowDays,
    totalOrdersInWindow: Number.MAX_SAFE_INTEGER,
    itemUnitsSoldInWindow: 0,
    monthlyRevenueCents: 1,
  }) === "BUSINESS_ADJUSTED";
}
