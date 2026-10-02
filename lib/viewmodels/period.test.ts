import { describe, expect, it } from "vitest";
import { roundHalfUpToCent } from "@/lib/calc";
import { runningCostLinesForPeriod, runningCostsForPeriod } from "./period";
import type { BusinessSnapshot } from "@/lib/data/types";

/** A minimal, otherwise-empty snapshot — these functions only read `runningCostLines`, `monthKey`,
 * and `todayDateStr`, so everything else just needs to be structurally valid. October has 31 days,
 * chosen so $100/mo lines prorate to a non-whole-cent daily share (100 ÷ 31 = 3.2258...). */
function buildSnapshot(runningCostLines: BusinessSnapshot["runningCostLines"]): BusinessSnapshot {
  const todayDateStr = "2026-10-01";
  return {
    business: { id: "test", name: "Test Café", timezone: "America/Los_Angeles", payrollTaxRate: 0.0765 },
    todayDateStr,
    monthKey: "2026-10",
    daysInMonth: 31,
    monthActualDays: [],
    last28Days: [],
    last7Days: [],
    todayDay: { date: todayDateStr, netSalesCents: 0, ordersCount: 0, drinksCount: 0, ingredientsCents: 0, wagesCents: 0, staffTaxCents: 0, cardFeesCents: 0, voidsCents: 0 },
    todayHasData: true,
    previousMonthDays: [],
    runningCostLines,
    recoveryOrder: runningCostLines.map((l) => l.categoryCode),
    menuItems: [],
    alerts: { count: 0, leakingCents: 0 },
    staffShiftsToday: [],
    staffNowIso: `${todayDateStr}T09:00:00-07:00`,
  };
}

describe("runningCostLinesForPeriod — reconciles exactly with the aggregate total", () => {
  it("three $100/mo lines in a 31-day month: rows sum to the rounded aggregate, not independent rounding (PR #6 review example)", () => {
    // Each line prorated for "today" (1 of 31 days) = 10,000 / 31 = 322.5806...¢. Rounding each
    // independently gives 323×3 = 969¢; the true aggregate 967.7419...¢ rounds to 968¢.
    const snapshot = buildSnapshot([
      { categoryCode: "rent", label: "Rent", amountCents: 10_000, isEstimate: false, isMissing: false },
      { categoryCode: "water", label: "Water", amountCents: 10_000, isEstimate: false, isMissing: false },
      { categoryCode: "software", label: "Software", amountCents: 10_000, isEstimate: false, isMissing: false },
    ]);

    const aggregateTarget = roundHalfUpToCent(runningCostsForPeriod(snapshot, "today"));
    expect(aggregateTarget).toBe(968); // not 969 — confirms the worked example's premise

    const lines = runningCostLinesForPeriod(snapshot, "today");
    const rowsSum = lines.reduce((sum, line) => sum + line.amountCents, 0);

    expect(rowsSum).toBe(aggregateTarget);
    for (const line of lines) expect(Number.isInteger(line.amountCents)).toBe(true);
  });

  it("reconciles for Week and Month to date too, with a richer, unevenly-divisible set of lines", () => {
    const snapshot = buildSnapshot([
      { categoryCode: "rent", label: "Rent", amountCents: 617_000, isEstimate: false, isMissing: false }, // doesn't divide evenly by 31 or 30
      { categoryCode: "utilities_power", label: "Electricity & gas", amountCents: 133_000, isEstimate: true, isMissing: false },
      { categoryCode: "water", label: "Water", amountCents: 2_500, isEstimate: false, isMissing: false },
      { categoryCode: "insurance", label: "Insurance", amountCents: 50_000, isEstimate: false, isMissing: false },
      { categoryCode: "loan", label: "Loan payment", amountCents: 0, isEstimate: false, isMissing: true }, // never allocated, always 0
    ]);

    for (const period of ["today", "week", "month"] as const) {
      const aggregateTarget = roundHalfUpToCent(runningCostsForPeriod(snapshot, period));
      const lines = runningCostLinesForPeriod(snapshot, period);
      const rowsSum = lines.reduce((sum, line) => sum + line.amountCents, 0);

      expect(rowsSum).toBe(aggregateTarget);
      for (const line of lines) expect(Number.isInteger(line.amountCents)).toBe(true);
      expect(lines.find((l) => l.categoryCode === "loan")?.amountCents).toBe(0);
    }
  });
});
