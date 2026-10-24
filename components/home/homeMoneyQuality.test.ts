import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";
import { homeMoneyQuality } from "./homeMoneyQuality";

describe("Home key-number trust", () => {
  it("withholds a seemingly complete profit if product and cost evidence is still missing", () => {
    const snapshot = getFixtureSnapshot();
    const home = buildHomeViewModel(snapshot, "today");
    const money = buildProfitAndCostsViewModel(snapshot, "today");
    // Having a sales rollup does not prove ingredient provenance, processing fees,
    // wages, or recurring-cost coverage. The old Home missed this distinction.
    expect(home.ownerProfitDisplay.kind).toBe("complete");
    expect(money.businessCosts.completeness).not.toBe("complete");
    const quality = homeMoneyQuality(home, money);
    expect(quality.canShowProfit).toBe(false);
    expect(quality.profitChangePct).toBeNull();
  });

  it("does not label an unknown cost subtotal as confirmed", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.todayHasData = false;
    snapshot.last7Days = [];
    snapshot.monthActualDays = [];
    snapshot.monthRecordedDays = [];
    snapshot.runningCostLines = [];
    const home = buildHomeViewModel(snapshot, "today");
    const money = buildProfitAndCostsViewModel(snapshot, "today");
    const quality = homeMoneyQuality(home, money);
    expect(quality.costCompleteness).toBe("unavailable");
    expect(quality.canShowProfit).toBe(false);
    expect(quality.hasPartial).toBe(true);
  });

  it("does not confirm a profit when legacy missing-bill evidence is incomplete", () => {
    const snapshot = getFixtureSnapshot();
    const home = buildHomeViewModel(snapshot,"today");
    const money = buildProfitAndCostsViewModel(snapshot,"today");
    const reported = { ...home, missingCategories: [
      {categoryCode:"rent" as const,label:"Rent",amountCents:0,isMissing:true,isEstimate:false}
    ]};
    const quality = homeMoneyQuality(reported,{
      ...money, businessCosts:{...money.businessCosts,completeness:"complete" as const},
      ownerProfitDisplay:home.ownerProfitDisplay,
      changes:[{ key:"ownerProfit",label:"Owner profit",deltaCents:100 }],
    });
    expect(quality.canShowProfit).toBe(false);
    expect(quality.hasPartial).toBe(true);
    expect(quality.profitChangePct).toBeNull();
  });

  it("shows an estimate marker when canonical costs use estimated input", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.runningCostLines = snapshot.runningCostLines.map(line =>
      line.categoryCode === "rent" ? {...line,isEstimate:true} : line);
    const home = buildHomeViewModel(snapshot, "today");
    const money = buildProfitAndCostsViewModel(snapshot, "today");
    expect(homeMoneyQuality(home, money).hasEstimatedCosts).toBe(true);
  });
});
