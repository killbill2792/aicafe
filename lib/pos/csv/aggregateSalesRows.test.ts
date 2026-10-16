import { describe, expect, it } from "vitest";
import { aggregateSalesRows } from "./aggregateSalesRows";
import type { NormalizedSalesRow } from "./parseSalesCsv";

const ITEMS = ["Latte", "Drip Coffee", "Cappuccino", "Mocha", "Americano", "Cold Brew", "Espresso", "Chai Latte", "Croissant", "Muffin", "Bagel", "Tea", "Hot Chocolate"];

/** A per-selection export (one row per individual sale, Toast's `ItemSelectionDetails` shape) —
 * not Toast's pre-aggregated product-mix shape. Reproduces the real incident: 14 business dates,
 * repeated same-day selections of the same item, 2,555+ source rows. */
function buildSelectionLevelFixture(): NormalizedSalesRow[] {
  const rows: NormalizedSalesRow[] = [];
  for (let day = 0; day < 14; day++) {
    const date = `2026-08-${String(22 + day).padStart(2, "0")}`;
    for (let selection = 0; selection < 183; selection++) {
      const item = ITEMS[(day * 183 + selection) % ITEMS.length];
      rows.push({ date, item, quantity: 1, netSalesCents: 450 + ((selection * 7) % 300), category: "Drinks", processingFeeCents: 0, processingFeeStatus: "missing" });
    }
  }
  return rows;
}

describe("aggregateSalesRows", () => {
  it("reconciles a 14-day, 2,500+ row selection-level export to exact quantity and cents totals", () => {
    const rows = buildSelectionLevelFixture();
    expect(rows.length).toBeGreaterThanOrEqual(2555);

    const aggregated = aggregateSalesRows(rows);

    const expectedDates = new Set(rows.map((r) => r.date));
    const aggregatedDates = new Set(aggregated.map((a) => a.date));
    expect(aggregatedDates).toEqual(expectedDates);
    expect(aggregatedDates.size).toBe(14);

    // Collapses to far fewer groups than source rows — aggregation actually happened, not a 1:1 passthrough.
    expect(aggregated.length).toBeLessThan(rows.length / 10);

    const totalQuantityIn = rows.reduce((s, r) => s + r.quantity, 0);
    const totalQuantityOut = aggregated.reduce((s, a) => s + a.quantity, 0);
    expect(totalQuantityOut).toBe(totalQuantityIn);

    const totalCentsIn = rows.reduce((s, r) => s + r.netSalesCents, 0);
    const totalCentsOut = aggregated.reduce((s, a) => s + a.netSalesCents, 0);
    expect(totalCentsOut).toBe(totalCentsIn);

    const totalSourceRowCount = aggregated.reduce((s, a) => s + a.sourceRowCount, 0);
    expect(totalSourceRowCount).toBe(rows.length);
  });

  it("sums repeated same-day selections of the same item instead of the last one winning", () => {
    const rows: NormalizedSalesRow[] = [
      { date: "2026-08-22", item: "Latte", quantity: 1, netSalesCents: 500, category: null, processingFeeCents: 0, processingFeeStatus: "missing" },
      { date: "2026-08-22", item: "Latte", quantity: 1, netSalesCents: 525, category: null, processingFeeCents: 0, processingFeeStatus: "missing" },
      { date: "2026-08-22", item: "Latte", quantity: 2, netSalesCents: 1000, category: null, processingFeeCents: 0, processingFeeStatus: "missing" },
    ];
    expect(aggregateSalesRows(rows)).toEqual([
      { date: "2026-08-22", item: "Latte", category: null, quantity: 4, netSalesCents: 2025, processingFeeCents: 0, processingFeeStatus: "missing", sourceRowCount: 3 },
    ]);
  });

  it("leaves a pre-aggregated product-mix file (already one row per item per day) unchanged in value", () => {
    const rows: NormalizedSalesRow[] = [
      { date: "2026-08-22", item: "Latte", quantity: 42, netSalesCents: 22_050, category: "Espresso", processingFeeCents: 0, processingFeeStatus: "missing" },
      { date: "2026-08-22", item: "Drip Coffee", quantity: 30, netSalesCents: 9_750, category: "Coffee", processingFeeCents: 0, processingFeeStatus: "missing" },
    ];
    expect(aggregateSalesRows(rows)).toEqual([
      { date: "2026-08-22", item: "Drip Coffee", category: "Coffee", quantity: 30, netSalesCents: 9_750, processingFeeCents: 0, processingFeeStatus: "missing", sourceRowCount: 1 },
      { date: "2026-08-22", item: "Latte", category: "Espresso", quantity: 42, netSalesCents: 22_050, processingFeeCents: 0, processingFeeStatus: "missing", sourceRowCount: 1 },
    ]);
  });

  it("never merges the same item name across different categories", () => {
    const rows: NormalizedSalesRow[] = [
      { date: "2026-08-22", item: "Chai", quantity: 1, netSalesCents: 400, category: "Hot Drinks", processingFeeCents: 0, processingFeeStatus: "missing" },
      { date: "2026-08-22", item: "Chai", quantity: 1, netSalesCents: 450, category: "Iced Drinks", processingFeeCents: 0, processingFeeStatus: "missing" },
    ];
    expect(aggregateSalesRows(rows)).toHaveLength(2);
  });

  it("only sums a fee as actual when every contributing row reported an actual fee", () => {
    const rows: NormalizedSalesRow[] = [
      { date: "2026-08-22", item: "Latte", quantity: 1, netSalesCents: 500, category: null, processingFeeCents: 15, processingFeeStatus: "actual" },
      { date: "2026-08-22", item: "Latte", quantity: 1, netSalesCents: 500, category: null, processingFeeCents: 0, processingFeeStatus: "missing" },
    ];
    const [group] = aggregateSalesRows(rows);
    expect(group.processingFeeStatus).toBe("missing");
    expect(group.processingFeeCents).toBe(0);
  });
});
