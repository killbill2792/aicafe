import { describe, expect, it } from "vitest";
import { resolveSalesDataStatus } from "./salesCoverage";

describe("sales coverage", () => {
  it("keeps a zero-sales staff-only day missing without provider coverage", () => {
    expect(resolveSalesDataStatus({ ordersCount: 0, netSalesCents: 0, drinksCount: 0 })).toBe("missing");
  });

  it("accepts an explicitly covered zero-sales day from an import or connector", () => {
    expect(resolveSalesDataStatus({ explicitStatus: "actual", ordersCount: 0, netSalesCents: 0, drinksCount: 0 })).toBe("actual");
  });

  it("treats observable sales facts as actual and preserves prior actual coverage", () => {
    expect(resolveSalesDataStatus({ ordersCount: 1, netSalesCents: 0, drinksCount: 0 })).toBe("actual");
    expect(resolveSalesDataStatus({ previousStatus: "actual", ordersCount: 0, netSalesCents: 0, drinksCount: 0 })).toBe("actual");
  });
});
