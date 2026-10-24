import { describe, expect, it } from "vitest";
import { profitGoalBlockers } from "./profitGoalBlockers";
import type { ProfitGoalSimulatorData } from "@/lib/data/getProfitGoalSimulatorData";

const fixture = {
  business: { daysWithSalesInWindow: 3, processingFeesStatus: "missing", operatingCostsStatus: "missing" },
  items: [{ unitsSoldInWindow: 12, productCostStatus: "NO_RECIPE" }],
} as ProfitGoalSimulatorData;

describe("profit goal repair actions", () => {
  it("lists every blocker with an actionable deep link", () => {
    expect(profitGoalBlockers(fixture)).toEqual([
      { kind: "sales", href: "/more/uploads/sales" },
      { kind: "fees", href: "/more/processing-fees" },
      { kind: "costs", href: "/menu" },
      { kind: "operating", href: "/more/bills" },
    ]);
  });
  it("does not treat unsold menu items as a blocker", () => {
    expect(profitGoalBlockers({ ...fixture, business: {
      ...fixture.business, daysWithSalesInWindow: 9, processingFeesStatus: "actual", operatingCostsStatus: "actual",
    }, items: [{ unitsSoldInWindow: 0, productCostStatus: "NO_RECIPE" }] } as ProfitGoalSimulatorData)).toEqual([]);
  });
});
