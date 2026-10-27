import {describe,it,expect} from "vitest";
import {figure,unifiedBreakEven,recommendFullCostPrice,simulateEconomics,addOwnerPayrollExtras,type Economics} from "./supervisorEconomics";
const base:Economics={
 monthlyBills:figure(746700,"actual","Recurring bills"),monthlyStaff:figure(1300000,"owner","You told me",["2026-10-24","2026-10-25","2026-10-26"]),
 monthlyRevenue:figure(3_000_000,"actual","Recorded sales"),
 ingredientRate:.3,feeRate:.029,ingredientStatus:"estimate",feeStatus:"estimate",
 averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,targetMargin:.15,
 missingDays:["2026-10-24","2026-10-25","2026-10-26"],
};
describe("single deterministic supervisor economics model",()=>{
 it("adds extras exactly once without substituting for unknown clocked labor",()=>{
  expect(addOwnerPayrollExtras(500000,25000)).toBe(525000);
  expect(addOwnerPayrollExtras(500000,null)).toBe(500000);
  expect(addOwnerPayrollExtras(0,25000)).toBe(25000);
  expect(addOwnerPayrollExtras(null,25000)).toBeNull();
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
  expect(actual.monthlyBreakEven.valueCents).toBeNull();
 });
 it("shows a known-cost floor without claiming a complete break-even when a bill category is missing",()=>{
  const partial={...base,missingBillCategories:["utilities_power"]};
  const answer=unifiedBreakEven(partial);
  expect(answer.monthlyBreakEven.valueCents).toBeNull();
  expect(answer.knownCostBreakEvenFloorCents).toBeGreaterThan(0);
  expect(answer.missing).toContain("monthlyBill:utilities_power");
 });
 it("prices full loaded cost with fee and saved margin, and shows exactly one break-even floor",()=>{
  const result=recommendFullCostPrice({ingredientCents:145,packagingCents:0,laborCents:600000,
   overheadCents:746700,units:6000,feeRate:.029,targetMargin:.15});
  expect(result.fullCostCents).toBe(145+100+124);
  expect(result.breakEvenCents).toBe(Math.ceil(369/(1-.029)));
  // Ingredient-cost target ~30% in the café profile: $1.45 / .30
  // rounds to $4.75, above its approximately $4.50 full-cost target.
  expect(result.recommendedPriceCents).toBe(475);
  expect(result.recommendedPriceCents!%25).toBe(0);
  expect(result.recommendedPriceCents!).toBeGreaterThanOrEqual(result.breakEvenCents!);
  expect(result.recommendedPriceCents).not.toBe(450);
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
 it("calculates a ten-cent latte what-if from current weekly units and no card",()=>{
  const result=simulateEconomics(base,{kind:"price",itemId:"latte",oldPriceCents:2000,
   newPriceCents:2010,weeklyUnits:100,unitCostCents:600});
  expect(result.weeklyChangeCents).toBe(971);
  expect(result.after.itemMarginCents).toBeGreaterThan(result.before.itemMarginCents!);
  expect(result.provenance).toBe("estimate");
 });
});
