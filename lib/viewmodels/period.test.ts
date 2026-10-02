import { describe, expect, it } from "vitest";
import { roundHalfUpToCent, zeroDailyFacts } from "@/lib/calc";
import { previousPeriodDays, runningCostLinesForPeriod, runningCostsForPeriod } from "./period";
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

function day(date: string, netSalesCents: number) {
  return { ...zeroDailyFacts(date), netSalesCents };
}

/** A snapshot with real gaps in its rollup history — only `todayDateStr`, `monthKey`,
 * `monthActualDays`, and `previousMonthDays` vary per test; everything else is structurally valid
 * but unused by `previousPeriodDays`. */
function buildSparseSnapshot(opts: {
  todayDateStr: string;
  monthKey: string;
  monthActualDays: BusinessSnapshot["monthActualDays"];
  previousMonthDays: BusinessSnapshot["previousMonthDays"];
}): BusinessSnapshot {
  return {
    business: { id: "test", name: "Test Café", timezone: "America/Los_Angeles", payrollTaxRate: 0.0765 },
    todayDateStr: opts.todayDateStr,
    monthKey: opts.monthKey,
    daysInMonth: 31,
    monthActualDays: opts.monthActualDays,
    last28Days: [],
    last7Days: [],
    todayDay: zeroDailyFacts(opts.todayDateStr),
    todayHasData: opts.monthActualDays.some((d) => d.date === opts.todayDateStr),
    previousMonthDays: opts.previousMonthDays,
    runningCostLines: [],
    recoveryOrder: [],
    menuItems: [],
    alerts: { count: 0, leakingCents: 0 },
    staffShiftsToday: [],
    staffNowIso: `${opts.todayDateStr}T09:00:00-07:00`,
  };
}

describe("previousPeriodDays — date-filtered, never a row-position slice", () => {
  // The exact sparse scenario from the review: rows exist for Sep 28, Sep 29, and Oct 1; today is
  // Oct 2 (no row yet). A row-position slice (e.g. `last28Days.slice(-2, -1)`, "second to last row")
  // would resolve "yesterday" to Sep 29 — this must resolve to Oct 1, the date that's actually
  // yesterday, since it exists.
  function sparseSnapshot() {
    return buildSparseSnapshot({
      todayDateStr: "2026-10-02",
      monthKey: "2026-10",
      monthActualDays: [day("2026-10-01", 300)],
      previousMonthDays: [day("2026-09-28", 100), day("2026-09-29", 200)],
    });
  }

  it("today: previous period resolves to Oct 1 (real yesterday), never Sep 29", () => {
    const result = previousPeriodDays(sparseSnapshot(), "today");
    expect(result).toEqual([day("2026-10-01", 300)]);
  });

  it("week: previous-week window (Sep 19–25) contains none of the sparse rows — stays empty, not fabricated from whatever rows exist", () => {
    const result = previousPeriodDays(sparseSnapshot(), "week");
    expect(result).toEqual([]);
  });

  it("week: selects only the rows whose dates actually fall in the previous-week window, ignoring rows just outside it", () => {
    // today = Oct 15 -> previous week window = Oct 2..Oct 8. A row on Oct 3 is inside; a row on
    // Sep 30 (just before the window) and Oct 10 (inside the *current* week) must be excluded.
    const snapshot = buildSparseSnapshot({
      todayDateStr: "2026-10-15",
      monthKey: "2026-10",
      monthActualDays: [day("2026-10-03", 500), day("2026-10-10", 999)],
      previousMonthDays: [day("2026-09-30", 400)],
    });
    const result = previousPeriodDays(snapshot, "week");
    expect(result).toEqual([day("2026-10-03", 500)]);
  });

  it("month: previous month's day 1 through the equivalent day-of-month, filtered by date — not the first N rows of previousMonthDays", () => {
    // today is Oct 5 (day-of-month 5) -> previous-month window is Sep 1..Sep 5. previousMonthDays
    // has a gap (no Sep 2 row) and an out-of-window row (Sep 20) that a positional
    // `slice(0, monthActualDays.length)` could wrongly include depending on array order.
    const snapshot = buildSparseSnapshot({
      todayDateStr: "2026-10-05",
      monthKey: "2026-10",
      monthActualDays: [day("2026-10-01", 10), day("2026-10-02", 20)], // length 2 — a slice(0,2) trap
      previousMonthDays: [day("2026-09-01", 100), day("2026-09-03", 300), day("2026-09-20", 999)],
    });
    const result = previousPeriodDays(snapshot, "month");
    expect(result).toEqual([day("2026-09-01", 100), day("2026-09-03", 300)]);
  });
});
