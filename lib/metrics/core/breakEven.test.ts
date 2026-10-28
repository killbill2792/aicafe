import {describe,expect,it} from "vitest";
import {breakEvenFor} from "./breakEven";
const d=Array.from({length:28},(_,i)=>({
 date:new Date(Date.UTC(2026,8,1+i,12)).toISOString().slice(0,10),
 netSalesCents:240000,ingredientsCents:65000,cardFeesCents:7000,drinksCount:480,
}));
describe("28 complete-day break-even",()=>{
  it("matches the source-of-truth 315 drinks/day for demo inputs",()=>{
    const out=breakEvenFor({days:d,asOfDate:"2026-09-29",daysInMonth:30,
      monthlyBillsCents:960000,monthlyStaffCents:77952*30});
    expect(out.drinksPerDay).toBe(315);
    expect(out.coveredDays).toBe(28);
    expect(out.notes).not.toContain("breakEvenCoveragePartial");
  });
  it("keeps a labeled known-cost floor on incomplete bill data",()=>{
    const out=breakEvenFor({days:d.slice(1),asOfDate:"2026-09-29",daysInMonth:30,
      monthlyBillsCents:null,monthlyStaffCents:77952*30});
    expect(out.salesPerMonthCents).toBeGreaterThan(0);
    expect(out.knownCostFloorCents).toBe(out.salesPerMonthCents);
    expect(out.notes).toContain("breakEvenBillsMissing");
  });
});
