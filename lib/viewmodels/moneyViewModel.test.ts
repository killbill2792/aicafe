import { describe, expect, it } from "vitest";
import { buildProfitAndCostsViewModel } from "./moneyViewModel";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import type { DailyFacts } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";

function addDaysLocal(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function day(date: string, overrides: Partial<DailyFacts> = {}): DailyFacts {
  return {
    date,
    netSalesCents: 100_000,
    ordersCount: 50,
    drinksCount: 100,
    ingredientsCents: 20_000,
    wagesCents: 15_000,
    staffTaxCents: 1_500,
    cardFeesCents: 2_500,
    voidsCents: 0,
    ...overrides,
  };
}

/** October 1 — the first day of the month, so "Today" and "Month to date" cover the exact same
 * single calendar day and must legitimately produce identical numbers (see the request's own
 * note: don't "fix" that by inventing a difference). Rent is $3,100/mo so October's per-day share
 * is a clean $100.00 (3,100 ÷ 31) and September's is $103.33 (3,100 ÷ 30, the existing
 * same-amount-last-month fallback period.ts already documents) — chosen so "Week" (which dips
 * six days into September) has an easy-to-hand-verify expected total. */
function buildOctoberFirstSnapshot(): BusinessSnapshot {
  const todayDateStr = "2026-10-01";
  const last7Days = Array.from({ length: 7 }, (_, i) => day(addDaysLocal(todayDateStr, i - 6)));
  const last28Days = Array.from({ length: 28 }, (_, i) => day(addDaysLocal(todayDateStr, i - 27)));
  const monthActualDays = [day(todayDateStr)];
  const previousMonthDays = Array.from({ length: 30 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`));

  return {
    business: { id: "test", name: "Test Café", timezone: "America/Los_Angeles", payrollTaxRate: 0.0765 },
    todayDateStr,
    monthKey: "2026-10",
    daysInMonth: 31,
    monthActualDays,
    last28Days,
    last7Days,
    latestDay: monthActualDays[0],
    previousMonthDays,
    runningCostLines: [{ categoryCode: "rent", label: "Rent", amountCents: 310_000, isEstimate: false, isMissing: false }],
    recoveryOrder: ["rent"],
    menuItems: [],
    alerts: { count: 0, leakingCents: 0 },
    staffShiftsToday: [],
    staffNowIso: `${todayDateStr}T09:00:00-07:00`,
  };
}

describe("buildProfitAndCostsViewModel — running cost rows match the selected period", () => {
  const snapshot = buildOctoberFirstSnapshot();

  it("Today (Oct 1) shows October's own per-day rent share, not the full month", () => {
    const vm = buildProfitAndCostsViewModel(snapshot, "today");
    expect(vm.runningCostLines).toHaveLength(1);
    expect(vm.runningCostLines[0].amountCents).toBeCloseTo(10_000, 0); // 310,000 / 31 = $100.00
  });

  it("Month to date on Oct 1 is identical to Today — same single calendar day, not a bug", () => {
    const today = buildProfitAndCostsViewModel(snapshot, "today");
    const month = buildProfitAndCostsViewModel(snapshot, "month");
    expect(month.runningCostLines[0].amountCents).toBeCloseTo(today.runningCostLines[0].amountCents, 6);
    expect(month.totalCostsCents).toBeCloseTo(today.totalCostsCents, 6);
    expect(month.salesCents).toBe(today.salesCents);
  });

  it("Week actually spans 7 real days (6 of September + Oct 1), not a repeat of Today", () => {
    const vm = buildProfitAndCostsViewModel(snapshot, "week");
    // 6 days of Sep at 310,000/30 = 62,000, plus 1 day of Oct at 310,000/31 = 10,000.
    expect(vm.runningCostLines[0].amountCents).toBeCloseTo(72_000, 0);
    // Sales must be 7× a single day's sales, not 1× — proves Week pulls all 7 days, not just today.
    expect(vm.salesCents).toBe(7 * 100_000);
  });

  it("the displayed rent row reconciles with the total/owner-profit calculation for every period", () => {
    for (const period of ["today", "week", "month"] as const) {
      const vm = buildProfitAndCostsViewModel(snapshot, period);
      const rowsTotal = vm.runningCostLines.reduce((sum, line) => sum + line.amountCents, 0);
      const expectedNonOperatingCosts = vm.totalCostsCents - vm.ingredientsCents - vm.wagesCents - vm.staffTaxCents - vm.cardFeesCents;
      expect(rowsTotal).toBeCloseTo(expectedNonOperatingCosts, 6);
    }
  });

  it("owner profit is sales minus every cost, consistent with the displayed rows, for each period", () => {
    for (const period of ["today", "week", "month"] as const) {
      const vm = buildProfitAndCostsViewModel(snapshot, period);
      const rowsTotal = vm.runningCostLines.reduce((sum, line) => sum + line.amountCents, 0);
      const recomputedTotalCosts = vm.ingredientsCents + vm.wagesCents + vm.staffTaxCents + vm.cardFeesCents + rowsTotal;
      expect(recomputedTotalCosts).toBeCloseTo(vm.totalCostsCents, 6);
      expect(vm.salesCents - recomputedTotalCosts).toBeCloseTo(vm.ownerProfitCents, 6);
    }
  });
});

describe("buildProfitAndCostsViewModel — against the richer Fixture A snapshot (today is Sep 9, 9 days into the month)", () => {
  const snapshot = getFixtureSnapshot();
  // Fixture A's rent is $6,000/mo (see lib/calc/__fixtures__/fixtureA.ts), September has 30 days.
  const rentLine = (period: "today" | "week" | "month") => buildProfitAndCostsViewModel(snapshot, period).runningCostLines.find((l) => l.categoryCode === "rent")!;

  it("Today shows one day's worth of rent ($200), not the full $6,000", () => {
    expect(rentLine("today").amountCents).toBeCloseTo(20_000, 0);
  });

  it("Week shows 7 days' worth of rent ($1,400)", () => {
    expect(rentLine("week").amountCents).toBeCloseTo(140_000, 0);
  });

  it("Month to date (9 actual days elapsed) shows 9 days' worth, not the full month", () => {
    expect(rentLine("month").amountCents).toBeCloseTo(180_000, 0);
  });

  it("Today < Week < Month to date for a month more than a week old — each period strictly larger", () => {
    expect(rentLine("today").amountCents).toBeLessThan(rentLine("week").amountCents);
    expect(rentLine("week").amountCents).toBeLessThan(rentLine("month").amountCents);
  });

  it("every running-cost row is a whole number of cents, even when the monthly amount doesn't divide evenly by days-in-month", () => {
    // Insurance is $500.00/mo over a 30-day September — 50,000 / 30 = 1,666.6666... repeating, a
    // case that would surface any fractional-cents regression immediately.
    for (const period of ["today", "week", "month"] as const) {
      const vm = buildProfitAndCostsViewModel(snapshot, period);
      for (const line of vm.runningCostLines) {
        expect(Number.isInteger(line.amountCents)).toBe(true);
      }
    }
  });
});
