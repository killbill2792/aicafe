import { describe, expect, it } from "vitest";
import { buildProfitAndCostsViewModel } from "./moneyViewModel";
import { businessCostSummaryFromSnapshot } from "@/lib/operating/businessCosts";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import {totalCostsCentsForPeriod, type DailyFacts} from "@/lib/calc";
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
    todayDay: monthActualDays[0],
    todayHasData: true,
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

describe("Money Week spanning previous month remains supported Oct 1–6",()=>{
  // Existing Money Week uses last7Days plus previous/current-month day rates.
  // A cost-coverage gate must never hide that otherwise legitimate subtotal.
  for(let octoberDay=1;octoberDay<=6;octoberDay++){
    const date="2026-10-"+String(octoberDay).padStart(2,"0");
    it("Oct "+octoberDay+": seven-day subtotal, rent proration and strict profit gate",()=>{
      const original=buildOctoberFirstSnapshot();
      const start=addDaysLocal(date,-6);
      const last7=Array.from({length:7},(_,i)=>day(addDaysLocal(start,i)));
      const current=Array.from({length:octoberDay},(_,i)=>day(
        "2026-10-"+String(i+1).padStart(2,"0")));
      const item=getFixtureSnapshot().menuItems[0];
      const base:BusinessSnapshot={...original,todayDateStr:date,
        monthActualDays:current,monthRecordedDays:current,
        last7Days:last7,todayDay:current[current.length-1],todayHasData:true,
        previousMonthRecordedDays:original.previousMonthDays,
        menuItems:[item],allCostProducts:[item],
        periodItemSales:{period:{from:start,to:date},covered:true,
          soldItems:[{id:item.id,units:7}]},
      };
      const partial=buildProfitAndCostsViewModel(base,"week");
      expect(partial.businessCosts.completeness).toBe("partial");
      expect(partial.businessCosts.missingInputs).toContain("historicalIngredientCostCoverage");
      expect(partial.businessCosts.missingInputs).not.toContain("periodOutsideLoadedMonth");
      expect(partial.businessCosts.missingInputs).toContain("priorMonthRunningCostCoverage");
      const previousDays=7-octoberDay;
      const expectedRunning=Math.round(310000*(previousDays/30+octoberDay/31));

      const expectedTotal=Math.round(totalCostsCentsForPeriod(last7,expectedRunning));
      expect(partial.businessCosts.components.runningCostsCents).toBe(expectedRunning);
      expect(partial.businessCosts.knownTotalCents).toBe(expectedTotal);
      expect(partial.totalCostsCents).toBe(expectedTotal);
      expect(partial.runningCostLines[0].amountCents).toBe(expectedRunning);
      expect(partial.salesCents).toBe(7*100000);
      expect(partial.ownerProfitDisplay.kind).toBe("unavailable");
      expect(partial.comparisonState.kind).toBe("available");
      expect(partial.changes.map(x=>x.key)).toContain("sales");
      expect(partial.changes.map(x=>x.key)).not.toContain("ownerProfit");
      expect(partial.changes.map(x=>x.key)).not.toContain("ingredients");
      const reconciled:BusinessSnapshot={...base,periodItemSales:{
        ...base.periodItemSales!,historicalIngredientCostProof:{
          source:"historical_recomputation",
          days:last7.map(d=>({date:d.date,ingredientsCents:d.ingredientsCents})),
        },
      }};
      const completed=buildProfitAndCostsViewModel(reconciled,"week");
      // Even after historically reconciled ingredients, prior-month running
      // costs use the original Money fallback (this month's nominal bills),
      // which supports a useful subtotal but not fully confirmed owner profit.
      expect(completed.businessCosts.coverage.historicalIngredientCostsProven).toBe(true);
      expect(completed.businessCosts.completeness).toBe("partial");
      expect(completed.businessCosts.missingInputs).toEqual(["priorMonthRunningCostCoverage"]);
      expect(completed.totalCostsCents).toBe(expectedTotal);
      expect(completed.ownerProfitDisplay.kind).toBe("unavailable");
      expect(completed.changes.map(x=>x.key)).not.toContain("ownerProfit");
    });
  }
});

describe("Money comparison evidence gates: sales is not verified profit",()=>{
  const item = getFixtureSnapshot().menuItems[0];
  const fixture = getFixtureSnapshot();
  const current = fixture.monthActualDays[8];
  const previous = fixture.monthActualDays[7];
  const provenItemPeriod = (day:DailyFacts)=>({
    period:{from:day.date,to:day.date},covered:true,
    soldItems:[{id:item.id,units:1}],
    historicalIngredientCostProof:{source:"historical_recomputation" as const,
      days:[{date:day.date,ingredientsCents:day.ingredientsCents}]},
  });
  it("current period partial: no owner-profit or ingredient delta, but sales still compares",()=>{
    const vm=buildProfitAndCostsViewModel({
      ...fixture,
      // A MTD proof is NOT proof of this one-day Today range.
      comparisonPeriodItemSales:provenItemPeriod(previous),
    },"today");
    expect(vm.comparisonState.kind).toBe("available");
    expect(vm.businessCosts.completeness).toBe("partial");
    expect(vm.ownerProfitDisplay.kind).toBe("unavailable");
    expect(vm.changes.map(x=>x.key)).toContain("sales");
    expect(vm.changes.map(x=>x.key)).not.toContain("ownerProfit");
    expect(vm.changes.map(x=>x.key)).not.toContain("ingredients");
  });
  it("current fully proven, previous only sales-covered: profit and ingredient deltas stay hidden",()=>{
    const vm=buildProfitAndCostsViewModel({...fixture,
      periodItemSales:provenItemPeriod(current),
      // No independent previous-period historical cost proof is loaded.
      comparisonPeriodItemSales:undefined,
    },"today");
    expect(vm.businessCosts.completeness).toBe("complete");
    expect(vm.ownerProfitDisplay.kind).toBe("complete");
    expect(vm.comparisonState.kind).toBe("available");
    expect(vm.changes.map(x=>x.key)).toContain("sales");
    expect(vm.changes.map(x=>x.key)).not.toContain("ownerProfit");
    expect(vm.changes.map(x=>x.key)).not.toContain("ingredients");
  });
  it("both dates have independent historical item-cost proof: owner-profit delta remains",()=>{
    const snapshot:BusinessSnapshot={...fixture,
      periodItemSales:provenItemPeriod(current),
      comparisonPeriodItemSales:provenItemPeriod(previous),
    };
    const vm=buildProfitAndCostsViewModel(snapshot,"today");
    expect(vm.ownerProfitDisplay.kind).toBe("complete");
    expect(vm.businessCosts.completeness).toBe("complete");
    expect(vm.comparisonState.kind).toBe("available");
    expect(vm.changes.map(x=>x.key)).toEqual(["sales","ingredients","staff","ownerProfit"]);
    const delta=vm.changes.find(x=>x.key==="ownerProfit")!;
    const previousCosts=businessCostSummaryFromSnapshot(
      {...snapshot,periodItemSales:snapshot.comparisonPeriodItemSales},
      {from:previous.date,to:previous.date},
    );
    expect(previousCosts.completeness).toBe("complete");
    expect(delta.deltaCents).toBe(
      vm.ownerProfitCents-(previous.netSalesCents-previousCosts.knownTotalCents),
    );
  });
  it("previous period complete item proof but missing a staff record: no staff or profit delta",()=>{
    const snapshot:BusinessSnapshot={...fixture,
      periodItemSales:provenItemPeriod(current),
      comparisonPeriodItemSales:provenItemPeriod(previous),
      monthRecordedDays:fixture.monthActualDays.filter(d=>d.date!==previous.date),
    };
    const vm=buildProfitAndCostsViewModel(snapshot,"today");
    expect(vm.ownerProfitDisplay.kind).toBe("complete");
    expect(vm.changes.map(x=>x.key)).toContain("sales");
    expect(vm.changes.map(x=>x.key)).toContain("ingredients");
    expect(vm.changes.map(x=>x.key)).not.toContain("staff");
    expect(vm.changes.map(x=>x.key)).not.toContain("ownerProfit");
  });
  it("estimated payroll tax is not presented as a verified staff delta",()=>{
    const snapshot:BusinessSnapshot={...fixture,
      periodItemSales:provenItemPeriod(current),
      comparisonPeriodItemSales:provenItemPeriod(previous),
      monthRecordedDays:fixture.monthActualDays.map(d=>d.date===previous.date
        ? {...d,staffTaxStatus:"estimated" as const}:d),
    };
    const vm=buildProfitAndCostsViewModel(snapshot,"today");
    expect(vm.changes.map(x=>x.key)).toContain("sales");
    expect(vm.changes.map(x=>x.key)).not.toContain("staff");
  });
  it("current and comparison both verified-zero sales can still compare real profit",()=>{
    const zero=(d:DailyFacts):DailyFacts=>({...d,netSalesCents:0,
      ordersCount:0,ingredientsCents:0,cardFeesCents:0,
      salesDataStatus:"actual",cardFeesStatus:"actual"});
    const days=fixture.monthActualDays.map(d=>
      d.date===current.date||d.date===previous.date?zero(d):d);
    const snapshot:BusinessSnapshot={...fixture,
      monthActualDays:days,monthRecordedDays:days,
      todayDay:days[days.length-1],
      periodItemSales:undefined,comparisonPeriodItemSales:undefined,
    };
    const vm=buildProfitAndCostsViewModel(snapshot,"today");
    expect(vm.businessCosts.completeness).toBe("complete");
    expect(vm.ownerProfitDisplay.kind).toBe("complete");
    expect(vm.changes.map(x=>x.key)).toContain("ownerProfit");
    expect(vm.changes.find(x=>x.key==="sales")?.deltaCents).toBe(0);
  });
});
