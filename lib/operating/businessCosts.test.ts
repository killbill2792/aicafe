import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import type {BusinessSnapshot} from "@/lib/data/types";
import {cafeStateFromSnapshot} from "./cafeState";
import {businessCostSummaryFromSnapshot} from "./businessCosts";
import {businessCostLimitations} from "./businessCostMessages";
import {
  ingredientsCentsForPeriod,staffCostCentsForPeriod,cardFeesCentsForPeriod,
  totalCostsCentsForPeriod,runningCostsForPeriodCents,roundHalfUpToCent,
} from "@/lib/calc";
import {buildProfitAndCostsViewModel} from "@/lib/viewmodels/moneyViewModel";

const fixture=getFixtureSnapshot();
const period={from:"2026-09-01",to:"2026-09-09"};
const sum=(snapshot:BusinessSnapshot=fixture)=>businessCostSummaryFromSnapshot(snapshot,period);
describe("One canonical BusinessCostSummary for Money and Supervisor",()=>{
 it("fully covered costs reconcile exactly to existing Money total and canonical calc",()=>{
   const x=sum(),state=cafeStateFromSnapshot(fixture);
   const money=buildProfitAndCostsViewModel(fixture,"month");
   expect(x.completeness).toBe("complete");
   expect(x.knownTotalCents).toBe(1_637_568);
   expect(x.knownTotalCents).toBe(money.totalCostsCents);
   expect(money.businessCosts).toEqual(x);
   expect(state.businessCosts).toEqual(x);
   expect(x.knownTotalCents).toBe(Object.values(x.components).reduce((a,b)=>a+b,0));
   const days=fixture.monthActualDays;
   const running=runningCostsForPeriodCents(fixture.runningCostLines.map(l=>({
     ...l,monthKey:fixture.monthKey
   })),period.from,period.to);
   expect(roundHalfUpToCent(totalCostsCentsForPeriod(days,running))).toBe(x.knownTotalCents);
   expect(x.components).toEqual({
     ingredientsCents:ingredientsCentsForPeriod(days),
     loadedStaffCents:staffCostCentsForPeriod(days),
     cardFeesCents:cardFeesCentsForPeriod(days),
     runningCostsCents:roundHalfUpToCent(running),
   });
 });
 it("product cost incomplete -> known subtotal while owner profit stays unavailable",()=>{
   const item=fixture.menuItems[0];
   const snapshot:BusinessSnapshot={...fixture,
     menuItems:[{...item,costStatus:"NO_RECIPE",quantitySoldLast28Days:2},...fixture.menuItems.slice(1)]};
   const state=cafeStateFromSnapshot(snapshot);
   expect(state.businessCosts).toMatchObject({completeness:"partial",knownTotalCents:1_637_568});
   expect(state.businessCosts.coverage.missingProductCostCount).toBe(1);
   expect(state.profitability.available).toBe(false);
   const message=businessCostLimitations(state.businessCosts,"en");
   expect(message).toContain("1 products");
   expect(message).not.toContain(item.id);
 });
 it("missing expected running bill is partial, not erased, without adding recurring costs twice",()=>{
   const snapshot:BusinessSnapshot={...fixture,runningCostLines:[...fixture.runningCostLines,{
     categoryCode:"internet",label:"Internet",amountCents:0,isMissing:true,isExpected:true,isEstimate:false,
   }]};
   const x=sum(snapshot);
   expect(x.completeness).toBe("partial");
   expect(x.coverage.missingOperatingCategories).toContainEqual(
     {code:"internet",label:"Internet"});
   expect(x.knownTotalCents).toBe(sum().knownTotalCents);
   expect(x.knownTotalCents).toBe(Object.values(x.components).reduce((a,b)=>a+b,0));
   expect(businessCostLimitations(x,"en")).toContain("Internet has not been entered.");
 });
 it("missing processing fees never invents a fee and does not erase other known costs",()=>{
   const snapshot:BusinessSnapshot={...fixture,monthActualDays:fixture.monthActualDays.map((d,i)=>
     i===0?{...d,cardFeesCents:0,cardFeesStatus:"missing"}:d)};
   const x=sum(snapshot);
   expect(x.completeness).toBe("partial");
   expect(x.coverage.missingFeeDays).toBe(1);
   expect(businessCostLimitations(x,"en")).toContain("1 recorded sales days.");
   expect(x.knownTotalCents).toBe(Object.values(x.components).reduce((a,b)=>a+b,0));
 });
 it("partial missing sales/labor data never means a complete total",()=>{
   const snapshot:BusinessSnapshot={...fixture,monthActualDays:fixture.monthActualDays.slice(0,3),
     monthRecordedDays:fixture.monthActualDays.slice(0,4)};
   const x=sum(snapshot);
   expect(x.completeness).toBe("partial");
   expect(x.coverage).toMatchObject({salesDays:3,laborDays:4,expectedDays:9});
   expect(x.components.loadedStaffCents).toBe(
     staffCostCentsForPeriod(snapshot.monthRecordedDays!));
   const money=buildProfitAndCostsViewModel(snapshot,"month");
   expect(money.wagesCents+money.staffTaxCents).toBe(x.components.loadedStaffCents);
   expect(money.totalCostsCents).toBe(x.knownTotalCents);
   expect(x.knownTotalCents).toBe(Object.values(x.components).reduce((a,b)=>a+b,0));
 });
 it("verified zero is not missing, including fees on an actual zero-sales day",()=>{
   const zero=fixture.monthActualDays[0];
   const snapshot:BusinessSnapshot={...fixture,
     monthActualDays:[{...zero,date:period.from,netSalesCents:0,ordersCount:0,
       ingredientsCents:0,wagesCents:0,staffTaxCents:0,cardFeesCents:0,
       salesDataStatus:"actual",cardFeesStatus:"missing"}],
     monthRecordedDays:[{...zero,date:period.from,wagesCents:0,staffTaxCents:0}],
     runningCostLines:fixture.runningCostLines.map(l=>({...l,isMissing:true,amountCents:0,isExpected:false})),
   };
   const x=businessCostSummaryFromSnapshot(snapshot,{from:period.from,to:period.from});
   expect(x.knownTotalCents).toBe(0);
   expect(x.completeness).toBe("complete"); // all required components for this one date are proven
   expect(x.coverage.missingFeeDays).toBe(0);
 });
 it("no observed days or operating-cost record => unavailable, never zero-as-fact",()=>{
   const snapshot:BusinessSnapshot={...fixture,monthActualDays:[],monthRecordedDays:[],
     runningCostLines:fixture.runningCostLines.map(l=>({...l,isMissing:true,amountCents:0}))};
   const x=sum(snapshot);
   expect(x.completeness).toBe("unavailable");
   expect(x.knownTotalCents).toBe(0);
 });
 it("strict unsupported period remains unavailable",()=>{
   expect(businessCostSummaryFromSnapshot(fixture,{from:"2026-08-01",to:"2026-08-31"}).completeness)
     .toBe("unavailable");
 });
 it("does not leak IDs in localized owner explanations",()=>{
   const x=sum({...fixture,menuItems:fixture.menuItems.map(p=>({
     ...p,costStatus:"NO_RECIPE",quantitySoldLast28Days:5,
   }))});
   for(const locale of ["en","es","ar"] as const){
     const message=businessCostLimitations(x,locale);
     expect(message).not.toContain("productCost:");
     expect(message).not.toContain("expense:");
     expect(message.length).toBeLessThan(450);
   }
 });
});

// Period-exact canonical item participation regressions. The request-specific
// evidence is distinct from the rolling 28-day menu quantity by construction.
describe("Requested-period sold item cost coverage (including archived products)",()=>{
  const month={from:"2026-09-01",to:"2026-09-09"};
  const today={from:"2026-09-09",to:"2026-09-09"};
  const latte=fixture.menuItems[0];
  const bad={...latte,costStatus:"NO_RECIPE" as const,quantitySoldLast28Days:42};
  const good=fixture.menuItems[1];
  const withSales=(range:{from:string;to:string},soldItems:Array<{id:string;units:number}>,covered=true)=>{
    const snapshot:BusinessSnapshot={...fixture,
      menuItems:[bad,good,...fixture.menuItems.slice(2)],
      allCostProducts:[bad,good,...fixture.menuItems.slice(2)],
      periodItemSales:{period:range,covered,soldItems,
        historicalIngredientCostProof:{source:"historical_recomputation" as const,
          days:fixture.monthActualDays.filter(d=>d.date>=range.from&&d.date<=range.to)
            .map(d=>({date:d.date,ingredientsCents:d.ingredientsCents}))}},
    };
    return snapshot;
  };
  it("A: old missing-cost Latte sold seven days ago does NOT contaminate verified today",()=>{
    const snapshot=withSales(today,[{id:good.id,units:3}]);
    const result=businessCostSummaryFromSnapshot(snapshot,today);
    expect(result.completeness).toBe("complete");
    expect(result.coverage).toMatchObject({itemSalesCovered:true,soldProductCount:1,missingProductCostCount:0});
    expect(result.missingInputs).not.toEqual(expect.arrayContaining([expect.stringMatching(/productCost/)]));
  });
  it("B: late-September sale does NOT contaminate October month-to-date",()=>{
    const oct={from:"2026-10-01",to:"2026-10-12"};
    const octoberDays=Array.from({length:12},(_,i)=>({
      ...fixture.monthActualDays[0],date:"2026-10-"+String(i+1).padStart(2,"0"),
    }));
    const snapshot:BusinessSnapshot={...withSales(oct,[{id:good.id,units:4}]),
      monthKey:"2026-10",todayDateStr:"2026-10-12",daysInMonth:31,
      monthActualDays:octoberDays,monthRecordedDays:octoberDays,
      periodItemSales:{period:oct,covered:true,
        soldItems:[{id:good.id,units:4}],
        historicalIngredientCostProof:{source:"historical_recomputation",
          days:octoberDays.map(d=>({date:d.date,ingredientsCents:d.ingredientsCents}))}},
    };
    const result=businessCostSummaryFromSnapshot(snapshot,oct);
    expect(result.completeness).toBe("complete");
    expect(result.coverage).toMatchObject({missingProductCostCount:0,soldProductCount:1,
      soldProductIds:[good.id],missingProductCostIds:[]});
    // The archived/older sold item still has 28-day sales metadata, which is irrelevant.
    expect(snapshot.menuItems[0].quantitySoldLast28Days).toBe(42);
  });
  it("C: active missing-cost product sold IN the requested period is partial",()=>{
    const result=businessCostSummaryFromSnapshot(withSales(month,[{id:bad.id,units:2}]),month);
    expect(result).toMatchObject({completeness:"partial",coverage:{
      itemSalesCovered:true,missingProductCostCount:1,soldProductCount:1}});
    expect(result.missingInputs).toContain("productCost:"+bad.id);
  });
  it("D: archived missing-cost product sold IN period is included even though absent from active menu",()=>{
    const archived={...bad,active:false};
    const snapshot:BusinessSnapshot={...withSales(month,[{id:bad.id,units:2}]),
      menuItems:[good],
      allCostProducts:[good,archived],
    };
    const result=businessCostSummaryFromSnapshot(snapshot,month);
    expect(result).toMatchObject({completeness:"partial",coverage:{
      itemSalesCovered:true,soldProductCount:1,missingProductCostCount:1,
      soldProductIds:[bad.id],missingProductCostIds:[bad.id]}});
    expect(result.missingInputs).toContain("productCost:"+bad.id);
    expect(snapshot.menuItems.find(item=>item.id===bad.id)).toBeUndefined();
  });
  it("E: archived missing-cost product NOT sold does not affect completeness",()=>{
    const snapshot:BusinessSnapshot={...withSales(month,[{id:good.id,units:3}]),
      menuItems:[good],allCostProducts:[good,{...bad,active:false}],
    };
    expect(businessCostSummaryFromSnapshot(snapshot,month)).toMatchObject({
      completeness:"complete",coverage:{missingProductCostCount:0,soldProductCount:1}});
  });
  it("F: aggregate-only positive sales with ingredient cents zero is partial, never proof",()=>{
    const snapshot:BusinessSnapshot={...withSales(month,[],false),
      monthActualDays:fixture.monthActualDays.map(day=>({...day,ingredientsCents:0})),
    };
    const result=businessCostSummaryFromSnapshot(snapshot,month);
    expect(result).toMatchObject({completeness:"partial",coverage:{itemSalesCovered:false}});
    expect(result.missingInputs).toContain("itemSalesCoverage");
    expect(result.components.ingredientsCents).toBe(0);
    expect(result.knownTotalCents).toBeGreaterThan(0);
    expect(businessCostLimitations(result,"en")).toContain("Product-level sales");
    for(const locale of ["es","ar"] as const)
      expect(businessCostLimitations(result,locale).length).toBeGreaterThan(20);
  });
  it("positive aggregate with covered-but-empty item rows also stays partial",()=>{
    const result=businessCostSummaryFromSnapshot(withSales(month,[],true),month);
    expect(result.completeness).toBe("partial");
    expect(result.coverage.itemSalesCovered).toBe(false);
  });
  it("G: explicitly verified zero sales/zero orders allows ingredient zero without missing data",()=>{
    const d={...fixture.monthActualDays[0],date:today.from,
      salesDataStatus:"actual" as const,netSalesCents:0,ordersCount:0,
      ingredientsCents:0,cardFeesCents:0,cardFeesStatus:"missing" as const};
    const snapshot:BusinessSnapshot={...withSales(today,[],false),
      monthActualDays:[d],monthRecordedDays:[d],
    };
    const result=businessCostSummaryFromSnapshot(snapshot,today);
    expect(result.completeness).toBe("complete");
    expect(result.components.ingredientsCents).toBe(0);
    expect(result.coverage).toMatchObject({itemSalesCovered:true,missingProductCostCount:0});
    expect(result.missingInputs).not.toContain("itemSalesCoverage");
  });
  it("unknown product catalog ID is a missing-cost product, not a free product",()=>{
    const result=businessCostSummaryFromSnapshot(withSales(month,[{id:"missing-catalog-item",units:2}]),month);
    expect(result.completeness).toBe("partial");
    expect(result.coverage.missingProductCostCount).toBe(1);
    expect(result.missingInputs).toContain("productCost:missing-catalog-item");
  });
  it("only products sold IN the period appear among estimated item-cost IDs",()=>{
    const estimated={...good,costQuality:"estimated" as const};
    const snapshot:BusinessSnapshot={...withSales(month,[{id:good.id,units:2}]),
      menuItems:[bad,estimated],allCostProducts:[bad,estimated],
    };
    const result=businessCostSummaryFromSnapshot(snapshot,month);
    expect(result.coverage).toMatchObject({
      itemSalesCovered:true,soldProductCount:1,estimatedProductCostCount:1,
      soldProductIds:[good.id],missingProductCostIds:[],estimatedProductCostIds:[good.id],
    });
    expect(result.estimatedInputs).toContain("productCost:"+good.id);
    expect(result.completeness).toBe("complete");
  });
  it("a known zero-cost component is not confused with unavailable aggregate sales",()=>{
    const base=withSales(today,[{id:good.id,units:1}]);
    const snapshot:BusinessSnapshot={...base,
      monthActualDays:fixture.monthActualDays.filter(day=>day.date===today.from).map(day=>({...day,ingredientsCents:0})),
      monthRecordedDays:fixture.monthActualDays.filter(day=>day.date===today.from),
      periodItemSales:{...base.periodItemSales!,
        historicalIngredientCostProof:{source:"historical_recomputation",
          days:[{date:today.from,ingredientsCents:0}]}},
    };
    const result=businessCostSummaryFromSnapshot(snapshot,today);
    expect(result.completeness).toBe("complete");
    expect(result.components.ingredientsCents).toBe(0);
  });
});

describe("Historical rollup proof cannot be manufactured by today's newly added recipe",()=>{
  it("late recipe READY does NOT retroactively certify older zero-cost sales",()=>{
    const oldDay={...fixture.monthActualDays[0],ingredientsCents:0,
      netSalesCents:10000,ordersCount:1,salesDataStatus:"actual" as const};
    const dayPeriod={from:oldDay.date,to:oldDay.date};
    const product={...fixture.menuItems[0],costStatus:"READY" as const,
      hasRecipe:true,ingredientsCentsToday:125,quantitySoldLast28Days:1};
    const snapshot:BusinessSnapshot={...fixture,monthActualDays:[oldDay],
      monthRecordedDays:[oldDay],menuItems:[product],allCostProducts:[product],
      periodItemSales:{period:dayPeriod,covered:true,
        soldItems:[{id:product.id,units:1}]},
    };
    const observed=businessCostSummaryFromSnapshot(snapshot,dayPeriod);
    expect(observed.completeness).toBe("partial");
    expect(observed.coverage.itemSalesCovered).toBe(true);
    expect(observed.coverage.historicalIngredientCostsProven).toBe(false);
    expect(observed.missingInputs).toContain("historicalIngredientCostCoverage");
    expect(observed.components.ingredientsCents).toBe(0);
    expect(observed.knownTotalCents).toBeGreaterThan(0);
    expect(cafeStateFromSnapshot(snapshot,dayPeriod).profitability.available).toBe(false);
    // Only explicitly attested, date-exact, stored-rollup reconciliation
    // (not the current recipe READY state) can clear this missing category.
    const proven:BusinessSnapshot={...snapshot,periodItemSales:{
      ...snapshot.periodItemSales!,historicalIngredientCostProof:{
        source:"historical_recomputation",days:[{date:oldDay.date,ingredientsCents:0}],
      },
    }};
    expect(businessCostSummaryFromSnapshot(proven,dayPeriod).completeness).toBe("complete");
  });
  it("historical proof must match every sold day and stored daily rollup exactly",()=>{
    const days=fixture.monthActualDays.slice(0,2);
    const requested={from:days[0].date,to:days[1].date};
    const product=fixture.menuItems[0];
    const baseline:BusinessSnapshot={...fixture,monthActualDays:days,monthRecordedDays:days,
      periodItemSales:{period:requested,covered:true,soldItems:[{id:product.id,units:2}],
        historicalIngredientCostProof:{source:"historical_recomputation",
          days:[{date:days[0].date,ingredientsCents:days[0].ingredientsCents+1},
            {date:days[1].date,ingredientsCents:days[1].ingredientsCents}]},
      }};
    expect(businessCostSummaryFromSnapshot(baseline,requested).completeness).toBe("partial");
    expect(businessCostSummaryFromSnapshot({...baseline,periodItemSales:{
      ...baseline.periodItemSales!,historicalIngredientCostProof:{
        source:"historical_recomputation",
        days:[{date:days[0].date,ingredientsCents:days[0].ingredientsCents}],
      }}},requested).completeness).toBe("partial");
    expect(businessCostSummaryFromSnapshot({...baseline,periodItemSales:{
      ...baseline.periodItemSales!,historicalIngredientCostProof:{
        source:"historical_recomputation",
        days:days.map(d=>({date:d.date,ingredientsCents:d.ingredientsCents})),
      }}},requested).completeness).toBe("complete");
  });
});
