import { describe, expect, it } from "vitest";
import { itemSalesPeriodTotals } from "./itemSalesPeriods";

const dates = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 8, 3 + index)).toISOString().slice(0, 10));

describe("itemSalesPeriodTotals", () => {
  it("reports a known zero only with coverage", () => {
    expect(itemSalesPeriodTotals([], dates, "americano", "2026-10-02")).toEqual({ today: 0, days7: 0, days30: 0 });
  });
  it("reports unavailable periods instead of fabricated zeroes", () => {
    expect(itemSalesPeriodTotals([], [], "americano", "2026-10-02")).toEqual({ today: null, days7: null, days30: null });
  });
  it("totals real quantities independently for Today, 7 days, and 30 days", () => {
    const rows = [
      { menuItemId: "americano", businessDate: "2026-10-02", quantity: 2 },
      { menuItemId: "americano", businessDate: "2026-09-30", quantity: 3 },
      { menuItemId: "americano", businessDate: "2026-09-10", quantity: 4 },
    ];
    expect(itemSalesPeriodTotals(rows, dates, "americano", "2026-10-02")).toEqual({ today: 2, days7: 5, days30: 9 });
  });
});
