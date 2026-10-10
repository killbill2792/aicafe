import { describe, expect, it } from "vitest";
import type { BusinessSnapshot } from "@/lib/data/types";
import { hasEstimatedTodayCosts } from "./homeSnapshotQuality";

const makeSnapshot = (overrides?: {
  cardFeesStatus?: "actual" | "estimated" | "missing";
  staffTaxStatus?: "actual" | "estimated";
  runningCostEstimate?: boolean;
  runningCostCents?: number;
}): Pick<BusinessSnapshot, "todayDay" | "runningCostLines"> => ({
  todayDay: {
    date: "2026-10-10",
    netSalesCents: 50000,
    ordersCount: 95,
    drinksCount: 80,
    ingredientsCents: 12000,
    wagesCents: 10000,
    staffTaxCents: 1200,
    staffTaxStatus: overrides?.staffTaxStatus ?? "actual",
    cardFeesCents: 1500,
    cardFeesStatus: overrides?.cardFeesStatus ?? "actual",
    voidsCents: 0,
  },
  runningCostLines: [{
    categoryCode: "rent",
    label: "Rent",
    amountCents: overrides?.runningCostCents ?? 100000,
    isEstimate: overrides?.runningCostEstimate ?? false,
    isMissing: false,
  }],
});

describe("compact Home Today snapshot estimate label", () => {
  it("does not imply estimates for actual source values", () => {
    expect(hasEstimatedTodayCosts(makeSnapshot())).toBe(false);
  });

  it("labels positive running-cost estimates", () => {
    expect(hasEstimatedTodayCosts(makeSnapshot({ runningCostEstimate: true }))).toBe(true);
  });

  it("ignores zero-valued running-cost estimates", () => {
    expect(hasEstimatedTodayCosts(makeSnapshot({ runningCostEstimate: true, runningCostCents: 0 }))).toBe(false);
  });

  it("labels estimated daily card processing fees", () => {
    expect(hasEstimatedTodayCosts(makeSnapshot({ cardFeesStatus: "estimated" }))).toBe(true);
  });

  it("labels estimated daily payroll taxes", () => {
    expect(hasEstimatedTodayCosts(makeSnapshot({ staffTaxStatus: "estimated" }))).toBe(true);
  });

  it("does not confuse a missing daily source with an estimated source", () => {
    expect(hasEstimatedTodayCosts(makeSnapshot({ cardFeesStatus: "missing" }))).toBe(false);
  });
});
