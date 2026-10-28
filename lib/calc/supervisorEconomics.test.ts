import {describe,it,expect} from "vitest";
import {figure,unifiedBreakEven,recommendFullCostPrice,simulateEconomics,addOwnerPayrollExtras,fixedCardFeeForCoveredSales,type Economics} from "./supervisorEconomics";
const base:Economics={
 monthlyBills:figure(746700,"actual","Recurring bills"),monthlyStaff:figure(1300000,"owner","You told me",["2026-10-24","2026-10-25","2026-10-26"]),
 monthlyRevenue:figure(3_000_000,"actual","Recorded sales"),
 ingredientRate:.3,feeRate:.029,ingredientStatus:"estimate",feeStatus:"estimate",
 averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,targetMargin:.15,
 missingDays:["2026-10-24","2026-10-25","2026-10-26"],
};
describe("single deterministic supervisor economics model",()=>{
 it("uses actual observed ingredient/processor cents even without configured rates",()=>{
  const input:Economics={...base,asOfDate:"2026-10-29",ingredientRate:null,feeRate:null,
   ingredientStatus:"missing",feeStatus:"missing",
   observedDays:[{date:"2026-10-28",netSalesCents:100000,
     ingredientsCents:20000,cardFeesCents:3000,cardFeesStatus:"actual",drinksCount:200}]};
  const result=unifiedBreakEven(input);
  expect(result.monthlyBreakEven.valueCents).toBe(Math.round(2046700/.77));
  expect(result.monthlyBreakEven.status).toBe("estimate");
  expect(result.missing).toContain("ingredientRate");
 });
 it("applies dated owner fee plans after actual fees, rather than defaulting to 2.9%",()=>{
  const input:Economics={...base,asOfDate:"2026-10-29",feeRate:null,
   ownerFeePlans:[{effectiveFrom:"2026-10-01",percentageBps:400}],
   observedDays:[{date:"2026-10-28",netSalesCents:100000,ingredientsCents:20000,
     cardFeesCents:0,cardFeesStatus:"missing",drinksCount:200}]};
  expect(unifiedBreakEven(input).monthlyBreakEven.valueCents).toBe(Math.round(2046700/.76));
 });
 it("honors explicitly supplied owner sales and variable rates over prior recorded costs",()=>{
  const input:Economics={...base,asOfDate:"2026-10-29",ownerNetSalesCents:200000,
   ingredientRate:.25,ingredientStatus:"owner",feeRate:.05,feeStatus:"owner",
   observedDays:[{date:"2026-10-28",netSalesCents:100000,
     ingredientsCents:10000,cardFeesCents:2000,cardFeesStatus:"actual",drinksCount:200}]};
  expect(unifiedBreakEven(input).monthlyBreakEven.valueCents).toBe(Math.round(2046700/.70));
  expect(unifiedBreakEven({...input,ownerNetSalesCents:0}).monthlyBreakEven.valueCents).toBeNull();
 });
 it("adds extras exactly once without substituting for unknown clocked labor",()=>{
  expect(addOwnerPayrollExtras(500000,25000)).toBe(525000);
  expect(addOwnerPayrollExtras(500000,null)).toBe(500000);
  expect(addOwnerPayrollExtras(0,25000)).toBe(25000);
  expect(addOwnerPayrollExtras(null,25000)).toBeNull();
 });
 it("keeps known owner extras in the break-even floor when clocked payroll is missing",()=>{
  const unknown={...base,monthlyStaff:figure(null,"missing","No recorded wages"),
   knownMonthlyLaborExtrasCents:25000};
  const answer=unifiedBreakEven(unknown);
  expect(answer.monthlyFixedKnownCents).toBe(746700+25000);
  expect(answer.knownCostBreakEvenFloorCents).toBeGreaterThan(0);
  expect(answer.monthlyBreakEven.valueCents).toBeGreaterThan(0);
   expect(answer.monthlyBreakEven.status).toBe("estimate");
  expect(answer.missing).toContain("monthlyLabor");
 });
 it("does not count owner extras twice when clocked payroll is known",()=>{
  const known={...base,monthlyStaff:figure(525000,"estimate","Wages and saved extras"),
   knownMonthlyLaborExtrasCents:25000};
  expect(unifiedBreakEven(known).monthlyFixedKnownCents).toBe(746700+525000);
 });
 it("item-cost scenario updates observed break-even, not just profit",()=>{
  const observed:Economics={...base,asOfDate:"2026-10-29",
   observedDays:[{date:"2026-10-28",netSalesCents:100000,ingredientsCents:25000,
    cardFeesCents:3000,cardFeesStatus:"actual",drinksCount:250}],
   ingredientRate:.25,ingredientStatus:"actual",feeRate:.03,feeStatus:"actual"};
  const result=simulateEconomics(observed,{kind:"item_cost",itemId:"test-item",
   oldCostCents:150,newCostCents:100,weeklyUnits:500,currentPriceCents:500});
  expect(result.difference.monthlyBreakEvenCents).toBeLessThan(0);
  expect(result.difference.drinksPerDay).toBeLessThan(0);
 });
 it("includes owner extras on top of clocked wages only once",()=>{
  const extras=25000,clocked=500000;
  const model={...base,monthlyStaff:figure(addOwnerPayrollExtras(clocked,extras),"estimate","Clocked payroll plus owner extras")};
  const result=unifiedBreakEven(model);
  expect(result.monthlyFixedKnownCents).toBe(746700+500000+25000);
  expect(result.monthlyBreakEven.status).toBe("estimate");
 });
 it("includes bills with owner payroll and names incomplete labor evidence",()=>{
  const answer=unifiedBreakEven(base);
  expect(answer.monthlyFixedKnownCents).toBe(2_046_700);
  expect(answer.monthlyBreakEven.valueCents).toBe(Math.round(2_046_700/(1-.3-.029)));
  expect(answer.monthlyBreakEven.status).toBe("estimate");
  expect(answer.drinksPerDay).toBe(Math.ceil(answer.monthlyBreakEven.valueCents!/500/31));
  expect(answer.monthlyBreakEven.missingDays).toHaveLength(3);
 });
 it("keeps recorded bills when labor is partial or missing",()=>{
  const partial={...base,monthlyStaff:figure(null,"missing","Clock data incomplete")};
  const actual=unifiedBreakEven(partial);
  expect(actual.monthlyFixedKnownCents).toBe(746700);
  expect(actual.monthlyBills.valueCents).toBe(746700);
  expect(actual.missing).toContain("monthlyLabor");
  expect(actual.monthlyBreakEven.valueCents).toBeGreaterThan(0);
   expect(actual.monthlyBreakEven.status).toBe("estimate");
 });
 it("shows a known-cost floor without claiming a complete break-even when a bill category is missing",()=>{
  const partial={...base,missingBillCategories:["utilities_power"]};
  const answer=unifiedBreakEven(partial);
  expect(answer.monthlyBreakEven.valueCents).toBeGreaterThan(0);
   expect(answer.monthlyBreakEven.status).toBe("estimate");
  expect(answer.knownCostBreakEvenFloorCents).toBeGreaterThan(0);
  expect(answer.missing).toContain("monthlyBill:utilities_power");
 });
 it("prices full loaded cost with fee and saved margin, and shows exactly one break-even floor",()=>{
  const result=recommendFullCostPrice({ingredientCents:145,packagingCents:0,laborCents:600000,
   overheadCents:746700,units:6000,feeRate:.029,targetMargin:.15});
  expect(result.fullCostCents).toBe(145+100+124);
  expect(result.breakEvenCents).toBe(Math.ceil(369/(1-.029)));
  // Ingredient-cost target ~30%: $1.45 / .30 rounds UP to $5.00.
  expect(result.recommendedPriceCents).toBe(500);
  expect(result.recommendedPriceCents!%25).toBe(0);
  expect(result.recommendedPriceCents!).toBeGreaterThanOrEqual(result.breakEvenCents!);
  expect(result.recommendedPriceCents).not.toBe(450);
 });
 it("allocates an owner-confirmed 2.49% plus 15 cents/order over covered drink and order counts",()=>{
  const plan={processorLabel:"Card rate",processedSalesShareBps:10000,
   processedTransactionShareBps:10000,rules:[{percentageBps:249,fixedFeeCents:15,
    salesMixBps:10000,transactionMixBps:10000}]};
  const fee=fixedCardFeeForCoveredSales(plan,6000,3000);
  expect(fee).toMatchObject({percentRate:.0249,fixedFeeCents:15,drinksPerOrder:2});
  const result=recommendFullCostPrice({ingredientCents:145,packagingCents:0,
   laborCents:1300000,overheadCents:836000,units:6000,feeRate:fee!.percentRate,
   fixedFeePerDrinkCents:fee!.fixedFeeCents/fee!.drinksPerOrder,targetMargin:.15});
  expect(result.breakEvenCents).toBe(Math.ceil((501+7.5)/(1-.0249)));
  expect(result.recommendedPriceCents).toBe(525);
  expect(fixedCardFeeForCoveredSales(plan,6000,0)).toBeUndefined();
 });
 it("withholds a full-cost price for unknown labor, overhead, fee, packaging, or units",()=>{
  const known={ingredientCents:145,packagingCents:40,laborCents:600000,
    overheadCents:746700,units:6000,feeRate:.029,targetMargin:.15};
  for(const [change,key] of [
   [{laborCents:null},"laborPerUnit"],
   [{overheadCents:null},"overheadPerUnit"],
   [{feeRate:null},"processingFeeRate"],
   [{packagingCents:null},"packagingCents"],
   [{units:null},"laborPerUnit"],
  ] as const){
   const result=recommendFullCostPrice({...known,...change});
   expect(result.recommendedPriceCents).toBe(change.packagingCents===null?null:625);
   expect(result.breakEvenCents).toBeNull();
   // A missing fee does not erase the known loaded unit cost; only the fee-adjusted break-even is incomplete.
   if(change.feeRate===null)expect(result.fullCostCents).toBeGreaterThan(0);
   else expect(result.fullCostCents).toBeNull();
   expect(result.missing).toContain(key);
   expect(result.knownCostFloorLabel).toBe("floor, not a recommendation");
   expect(result.knownCostFloorCents).toBeGreaterThan(0);
  }
  const allMissing=recommendFullCostPrice({...known,packagingCents:null,
   laborCents:null,overheadCents:null,feeRate:null});
  expect(allMissing.knownCostFloorCents).toBe(145);
  expect(allMissing.missing).toEqual([
   "packagingCents","laborPerUnit","overheadPerUnit","processingFeeRate"]);
  expect(recommendFullCostPrice(known).knownCostFloorCents).toBeNull();
 });
 it("refuses false zero wage/rate and preserves only known bill totals",()=>{
  const unknown={...base,monthlyStaff:figure(null,"missing","not observed"),feeRate:null};
  const change=simulateEconomics(unknown,{kind:"bill",monthlyChangeCents:50000});
  expect(change.before.monthlyProfitCents).toBeNull();
  expect(change.after.monthlyProfitCents).toBeNull();
  expect(change.before.monthlyBreakEvenCents).toBeNull();
  expect(change.after.monthlyBreakEvenCents).toBeNull();
 });
 it("recomputes monthly target sales when the target margin changes",()=>{
  const changed=simulateEconomics(base,{kind:"margin",targetMargin:.20});
  expect(changed.after.monthlyTargetSalesCents).toBeGreaterThan(changed.before.monthlyTargetSalesCents!);
  expect(changed.after.monthlyBreakEvenCents).toBe(changed.before.monthlyBreakEvenCents);
 });
 it("calculates a rent increase and six-hour lost shift without model arithmetic",()=>{
  const increased=simulateEconomics(base,{kind:"bill",monthlyChangeCents:50000});
  expect(increased.difference.monthlyProfitCents).toBe(-50000);
  const shift=simulateEconomics(base,{kind:"shift",hoursChange:-6,wageCents:2000,
   payrollTaxRate:.12,shiftsPerWeek:1});
  expect(shift.weeklyChangeCents).toBe(13440);
  expect(shift.after.monthlyProfitCents).toBeGreaterThan(shift.before.monthlyProfitCents!);
 });
 it("never calls an unsupported sales-volume scenario a zero dollar effect",()=>{
  const unavailable=simulateEconomics({...base,monthlyRevenue:figure(null,"missing","no actual sales")},
    {kind:"drinks",changePercent:10});
  expect(unavailable.weeklyChangeCents).toBeNull();
  expect(unavailable.difference.monthlyProfitCents).toBeNull();
  expect(unavailable.after.monthlyProfitCents).toBeNull();
 });
 it("does not invent zero processing fees in a price what-if",()=>{
  const result=simulateEconomics({...base,feeRate:null,feeStatus:"missing"},
   {kind:"price",itemId:"latte",oldPriceCents:2000,newPriceCents:2010,
    weeklyUnits:100,unitCostCents:600});
  expect(result.weeklyChangeCents).toBeNull();
  expect(result.difference.monthlyProfitCents).toBeNull();
  expect(result.before.itemMarginCents).toBeNull();
  expect(result.after.itemMarginCents).toBeNull();
  expect(result.missing).toContain("processingFeeRate");
 });
 it("calculates a ten-cent latte what-if from current weekly units and no card",()=>{
  const result=simulateEconomics(base,{kind:"price",itemId:"latte",oldPriceCents:2000,
   newPriceCents:2010,weeklyUnits:100,unitCostCents:600});
  expect(result.weeklyChangeCents).toBe(971);
  expect(result.after.itemMarginCents).toBeGreaterThan(result.before.itemMarginCents!);
  expect(result.provenance).toBe("estimate");
 });
});
