import {describe,expect,it} from "vitest";
import {laborForPeriod,laborPercentForPeriod} from "./labor";
const dates=[{date:"2026-10-01"},{date:"2026-10-02"}];
const records=[{date:"2026-10-01",wagesCents:10000,staffTaxCents:1200},
  {date:"2026-10-02",wagesCents:null,staffTaxCents:100}];
describe("known and projected labor",()=>{
  it("returns known cents and coverage when a wage is unknown",()=>{
    const out=laborForPeriod(dates,records);
    expect(out.knownLaborCents).toBe(11300);
    expect(out.coveredDays).toBe(1);
    expect(out.projectedMonthlyLaborCents).toBe(22400);
    expect(out.notes).toContain("laborWageUnknown");
  });
  it("lets the owner's monthly payroll win",()=>{
    expect(laborForPeriod(dates,records,28000).projectedMonthlyLaborCents).toBe(28000);
    expect(laborForPeriod(dates,records,28000).basis).toBe("owner_provided");
  });
  it("never divides by zero for missing sales",()=>{
    expect(laborPercentForPeriod(100,0)).toBeNull();
  });
});
