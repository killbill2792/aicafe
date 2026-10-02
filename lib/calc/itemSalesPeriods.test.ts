import { describe, expect, it } from "vitest";
import { itemSalesPeriodTotals } from "./itemSalesPeriods";

const coverage = { start: "2026-09-03", end: "2026-10-02" };

describe("itemSalesPeriodTotals", () => {
  it("reports known zero units for an item during trustworthy coverage", () => {
    expect(itemSalesPeriodTotals([], coverage, "americano", "2026-10-02")).toEqual({ today: 0, days7: 0, days30: 0 });
  });
  it("reports null when trustworthy coverage is genuinely unavailable", () => {
    expect(itemSalesPeriodTotals([], null, "americano", "2026-10-02")).toEqual({ today: null, days7: null, days30: null });
  });
  it("computes a valid 7-day total when the cafe was closed for a day", () => {
    const rows = [
      { menuItemId: "americano", businessDate: "2026-10-02", quantity: 2 },
      { menuItemId: "americano", businessDate: "2026-09-30", quantity: 3 },
    ];
    expect(itemSalesPeriodTotals(rows, { start: "2026-09-26", end: "2026-10-02" }, "americano", "2026-10-02")).toEqual({ today: 2, days7: 5, days30: null });
  });
  it("totals real quantities independently for Today, 7 days, and 30 days", () => {
    const rows = [
      { menuItemId: "americano", businessDate: "2026-10-02", quantity: 2 },
      { menuItemId: "americano", businessDate: "2026-09-30", quantity: 3 },
      { menuItemId: "americano", businessDate: "2026-09-10", quantity: 4 },
    ];
    expect(itemSalesPeriodTotals(rows, coverage, "americano", "2026-10-02")).toEqual({ today: 2, days7: 5, days30: 9 });
  });
});

