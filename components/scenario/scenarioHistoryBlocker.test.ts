import { describe, expect, it } from "vitest";
import { scenarioHistoryBlocker } from "./scenarioHistoryBlocker";

describe("What-if history blockers", () => {
  it.each(["price", "ingredient"] as const)("blocks %s when open-day item sales are missing", (kind) => {
    expect(scenarioHistoryBlocker(kind, { closedDaySales: false, salesCoverageGaps: true })).toBe("salesCoverageGaps");
  });
  it.each(["price", "ingredient"] as const)("blocks %s when sales contradict closed weekdays", (kind) => {
    expect(scenarioHistoryBlocker(kind, { closedDaySales: true, salesCoverageGaps: false })).toBe("closedDaySales");
  });
  it("prefers the café-hours repair when both item-sales problems exist", () => {
    expect(scenarioHistoryBlocker("price", { closedDaySales: true, salesCoverageGaps: true })).toBe("closedDaySales");
  });
  it.each([
    { closedDaySales: false, salesCoverageGaps: false },
    { closedDaySales: true, salesCoverageGaps: false },
    { closedDaySales: false, salesCoverageGaps: true },
    { closedDaySales: true, salesCoverageGaps: true },
  ])("never blocks a staff-hour scenario because of item history: %o", flags => {
    expect(scenarioHistoryBlocker("staff", flags)).toBeNull();
  });
  it("keeps staffing usable with fewer than seven open sales dates", () => {
    expect(scenarioHistoryBlocker("staff", { salesDaysCovered: 5, closedDaySales: false, salesCoverageGaps: false })).toBeNull();
    expect(scenarioHistoryBlocker("price", { salesDaysCovered: 5, closedDaySales: false, salesCoverageGaps: false })).toBe("insufficientSalesDays");
    expect(scenarioHistoryBlocker("ingredient", { salesDaysCovered: 6, closedDaySales: false, salesCoverageGaps: false })).toBe("insufficientSalesDays");
    expect(scenarioHistoryBlocker("price", { salesDaysCovered: 7, closedDaySales: false, salesCoverageGaps: false })).toBeNull();
  });
  it("does not block a priced-item forecast with complete historical coverage", () => {
    expect(scenarioHistoryBlocker("ingredient", { closedDaySales: false, salesCoverageGaps: false })).toBeNull();
  });
});
