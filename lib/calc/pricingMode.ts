import { MIN_COVERAGE_RATIO, MIN_ORDERS_IN_WINDOW } from "@/lib/pricing/profiles";
import type { PosHistorySignal, PricingMode } from "./types";

export function detectPricingMode(signal: PosHistorySignal): PricingMode {
  const coverage = signal.windowDays > 0 ? signal.daysWithSalesInWindow / signal.windowDays : 0;
  return coverage >= MIN_COVERAGE_RATIO && signal.totalOrdersInWindow >= MIN_ORDERS_IN_WINDOW && signal.monthlyRevenueCents > 0
    ? "BUSINESS_ADJUSTED"
    : "BENCHMARK";
}
