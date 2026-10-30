import { describe, expect, it } from "vitest";
import { detectPricingMode } from "@/lib/calc/pricingMode";
import { buildPricingViewModel } from "@/lib/viewmodels/pricingViewModel";
import { pricingTask } from "@/lib/operating/tasks";
import type { PricingBusinessInput, PricingItemInput } from "./getPricingInputs";
import { ordersMayAffectPricing } from "./pricingOrderGate";

const item: PricingItemInput = {
  id: "latte", name: "Latte", category: "ESPRESSO_DRINK", currentPriceCents: 350,
  productCostCents: 180, productCostStatus: "READY", productCostQuality: "actual",
  unitsSoldInWindow: 50,
};
const business: PricingBusinessInput = {
  windowDays: 90, daysWithSalesInWindow: 44, totalOrdersInWindow: 800,
  monthlyRevenueCents: 500000, monthlyWagesCents: 90000, monthlyStaffCostCents: 100000,
  monthlyOperatingCostCents: 75000, monthlyVariableProductCostCents: 60000,
  monthlyProcessingFeesCents: 12000, processingFeesStatus: "actual",
  productCostsStatus: "actual", payrollCostsStatus: "actual", operatingCostsStatus: "actual",
};
function priced(totalOrdersInWindow: number) {
  return buildPricingViewModel({ items: [item], business: { ...business, totalOrdersInWindow } });
}

describe("Home pricing order evidence gate", () => {
  it("cannot omit trusted orders at or above the engine's coverage boundary", () => {
    expect(ordersMayAffectPricing(44, 90)).toBe(false);
    expect(ordersMayAffectPricing(45, 90)).toBe(true);
    expect(ordersMayAffectPricing(90, 90)).toBe(true);
    expect(ordersMayAffectPricing(0, 90)).toBe(false);
  });

  it("preserves the full Menu/chat price result and Home attention task with insufficient coverage", () => {
    const full = priced(800);
    const home = priced(0);
    expect(home).toEqual(full);
    const now = new Date("2026-10-30T12:00:00Z");
    const task = (result: ReturnType<typeof priced>) => pricingTask({
      businessId: "cafe-a", itemId: item.id, itemName: item.name,
      result: result[0].result, now,
    });
    expect(task(home)).toEqual(task(full));
    expect(home[0].result.calculationMode).toBe("BENCHMARK");
  });

  it("retains the order read where trusted orders can change the exact recommendation", () => {
    const covered = { ...business, daysWithSalesInWindow: 45 };
    const result = (count: number) => buildPricingViewModel({
      items: [item], business: { ...covered, totalOrdersInWindow: count },
    })[0].result;
    expect(detectPricingMode({
      windowDays: 90, daysWithSalesInWindow: 45, totalOrdersInWindow: 800,
      monthlyRevenueCents: covered.monthlyRevenueCents, itemUnitsSoldInWindow: item.unitsSoldInWindow,
    })).toBe("BUSINESS_ADJUSTED");
    expect(result(800).calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result(0).calculationMode).toBe("BENCHMARK");
    expect(ordersMayAffectPricing(45, 90)).toBe(true);
  });

  it("conservatively reads orders for eligible coverage even when revenue is actually missing", () => {
    expect(ordersMayAffectPricing(60, 90)).toBe(true);
    expect(detectPricingMode({
      windowDays: 90, daysWithSalesInWindow: 60, totalOrdersInWindow: 500,
      monthlyRevenueCents: 0, itemUnitsSoldInWindow: 50,
    })).toBe("BENCHMARK");
  });
});
