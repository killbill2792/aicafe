import {describe,expect,it} from "vitest";
import {laborForPeriod,laborPercentForPeriod,proratedOwnerPayrollExtrasCents} from "./labor";
const dates=[{date:"2026-10-01"},{date:"2026-10-02"}];
const records=[{date:"2026-10-01",wagesCents:10000,staffTaxCents:1200},
  {date:"2026-10-02",wagesCents:null,staffTaxCents:100}];
describe("known and projected labor",()=>{
  it("adds owner extras once and prorates them correctly across a month boundary",()=>{
    expect(proratedOwnerPayrollExtrasCents({monthlyCents:3000,from:"2026-09-30",to:"2026-10-01"})).toBe(197);
    const result=laborForPeriod(dates,records,null,{monthlyCents:3100,from:"2026-10-01",to:"2026-10-02"});
    expect(result.knownLaborCents).toBe(11500);
    expect(result.projectedMonthlyLaborCents).toBe(25500);
    expect(result.notes).toContain("laborOwnerExtras");
  });
  it("returns known cents and coverage when a wage is unknown",()=>{
    const out=laborForPeriod(dates,records);
    expect(out.knownLaborCents).toBe(11300);
    expect(out.coveredDays).toBe(1);
    expect(out.projectedMonthlyLaborCents).toBe(22400);
    expect(out.notes).toContain("laborWageUnknown");
  });
  it("does not present unknown monthly labor as zero",()=>{
    const out=laborForPeriod(dates,[]);
    expect(out.projectedMonthlyLaborCents).toBeNull();
    expect(out.notes).toContain("laborNoCoveredDays");
  });
  it("3 of 20 payroll days produces a partial monthly projection, not null",()=>{
  const days=Array.from({length:20},(_,i)=>({date:"2026-10-"+String(i+1).padStart(2,"0")}));
  const wages=days.slice(0,3).map(d=>({...d,wagesCents:10000,staffTaxCents:1200}));
  const r=laborForPeriod(days,wages);
  expect(r.projectedMonthlyLaborCents).toBe(224000);
  expect(r.coveredDays).toBe(3);
  expect(r.totalDays).toBe(20);
  expect(r.notes).toContain("laborCoveragePartial");
  const known=laborForPeriod(days,[],null,{monthlyCents:31000,from:"2026-10-01",to:"2026-10-31"});
  expect(known.projectedMonthlyLaborCents).toBe(31000);
  expect(known.notes).toContain("laborNoCoveredDays");
 });
 it("lets the owner's monthly payroll win",()=>{
    expect(laborForPeriod(dates,records,28000).projectedMonthlyLaborCents).toBe(28000);
    expect(laborForPeriod(dates,records,28000).basis).toBe("owner_provided");
  });
  it("never divides by zero for missing sales",()=>{
    expect(laborPercentForPeriod(100,0)).toBeNull();
  });
});

describe("laborForPeriod projectedDays",()=>{
  it("spreads the covered-day average over the given days and leaves monthly extras unscaled",()=>{
    const days=Array.from({length:31},(_,i)=>({date:"2026-10-"+String(i+1).padStart(2,"0")}));
    const wages=days.slice(0,10).map(({date})=>({date,wagesCents:9000,staffTaxCents:1000}));
    const extras={monthlyCents:5000,from:"2026-10-01",to:"2026-10-31"};
    expect(laborForPeriod(days,wages,null,extras).projectedMonthlyLaborCents).toBe(315000);
    expect(laborForPeriod(days,wages,null,extras,26).projectedMonthlyLaborCents).toBe(265000);
    expect(()=>laborForPeriod(days,wages,null,null,0)).toThrow(RangeError);
  });
});
