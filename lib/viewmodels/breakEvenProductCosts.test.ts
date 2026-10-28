import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { buildCostRecoveryViewModel } from "./moneyViewModel";
import { buildBreakEvenViewModel } from "./breakEvenViewModel";

describe("break-even resolved product costs", () => {
  it("uses the exact 28 completed days when live snapshot provides them",()=>{
    const snapshot=getFixtureSnapshot();
    const first=snapshot.last28Days[0];
    // Ordinary rolling UI data includes today; sold-item evidence does not.
    snapshot.breakEvenDays=[{...first,date:"2026-08-12"},
      ...snapshot.last28Days.filter(d=>d.date<snapshot.todayDateStr)];
    expect(snapshot.breakEvenDays).toHaveLength(28);
    const screen=buildCostRecoveryViewModel(snapshot);
    const plan=buildBreakEvenViewModel(snapshot);
    expect(screen.breakEven.kind).toBe("ready");
    if(screen.breakEven.kind==="ready"){
      const expectedSales=snapshot.breakEvenDays.reduce((sum,d)=>sum+d.netSalesCents,0);
      const expectedCost=(snapshot.breakEvenProductCosts??snapshot.menuItems)
        .reduce((sum,item)=>sum+item.quantitySoldLast28Days*item.ingredientsCentsToday,0);
      expect(screen.breakEven.ingredientRate).toBeCloseTo(expectedCost/expectedSales,8);
    }
    expect(plan.noteKeys).not.toContain("breakEvenCoveragePartial");
  });
  it("monthly owner payroll extras use actual month days, not a 28-day denominator",()=>{
    const snapshot=getFixtureSnapshot();
    snapshot.ownerMonthlyPayrollExtrasCents=300000;
    const value=buildBreakEvenViewModel(snapshot);
    const baseline=buildBreakEvenViewModel({...snapshot,ownerMonthlyPayrollExtrasCents:0});
    expect(value.avgDailyStaffCostCents!-baseline.avgDailyStaffCostCents!).toBeCloseTo(10000,5);
    expect(value.noteKeys).toContain("laborOwnerExtras");
  });
  it("uses owner-total resolved costs instead of recipe-only rollup ingredients", () => {
    const snapshot = getFixtureSnapshot();
    const sold = 100;
    const costPerItem = 150;
    snapshot.menuItems = [{
      id: "fallback-item",
      name: "Latte",
      priceCents: 600,
      prepSeconds: 60,
      category: "drink",
      ingredientsCentsToday: costPerItem,
      hasRecipe: false,
      costStatus: "READY",
      costSource: "owner_total",
      recipeCostCents: null,
      recipeCostStatus: "NO_RECIPE",
      ownerTotalCostCents: costPerItem,
      costDifferenceCents: null,
      quantitySoldLast28Days: sold,
    }];

    const observedSales=snapshot.last28Days.filter(day=>day.date<snapshot.todayDateStr)
      .reduce((sum,day)=>sum+day.netSalesCents,0);
    const expectedRate = (sold * costPerItem) / observedSales;
    const vm = buildCostRecoveryViewModel(snapshot);
    expect(vm.breakEven.kind).toBe("ready");
    if (vm.breakEven.kind === "ready") expect(vm.breakEven.ingredientRate).toBeCloseTo(expectedRate, 8);
  });

  it("refuses break-even when a sold item still has no resolved product cost", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.menuItems = [{
      id: "missing-item",
      name: "Mystery drink",
      priceCents: 600,
      prepSeconds: 60,
      category: "drink",
      ingredientsCentsToday: 0,
      hasRecipe: false,
      costStatus: "NO_RECIPE",
      costSource: null,
      recipeCostCents: null,
      recipeCostStatus: "NO_RECIPE",
      ownerTotalCostCents: null,
      costDifferenceCents: null,
      quantitySoldLast28Days: 20,
    }];
    const partial=buildCostRecoveryViewModel(snapshot);
    expect(partial.breakEven.kind).toBe("ready");
    expect(partial.breakEvenNotes).toContain("profitProductCostsMissing");
    expect(buildBreakEvenViewModel(snapshot).noteKeys).toContain("profitProductCostsMissing");
  });
});


describe("break-even archived sold items", () => {
  it("includes a sold archived item's resolved cost without adding it back to the active menu list", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.menuItems = [];
    snapshot.breakEvenProductCosts = [{
      id: "archived-latte",
      name: "Archived latte",
      priceCents: 600,
      prepSeconds: 60,
      category: "drink",
      active: false,
      ingredientsCentsToday: 200,
      hasRecipe: false,
      costStatus: "READY",
      costSource: "owner_total",
      ownerTotalCostCents: 200,
      costQuality: "actual",
      quantitySoldLast28Days: 10,
    }];
    const observedSales=snapshot.last28Days.filter(day=>day.date<snapshot.todayDateStr)
      .reduce((sum,day)=>sum+day.netSalesCents,0);
    const vm = buildCostRecoveryViewModel(snapshot);
    expect(vm.breakEven.kind).toBe("ready");
    if (vm.breakEven.kind === "ready") {
      expect(vm.breakEven.ingredientRate).toBeCloseTo(2_000 / observedSales, 8);
    }
  });
});
