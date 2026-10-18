import { describe, it, expect } from "vitest";
import { menuPriceSourceBasis, type MenuPriceSourceDay } from "./menuPriceSourceBasis";

const day=(n:number):MenuPriceSourceDay=>({
  businessDate:`2026-08-${String(n).padStart(2,"0")}`,
  salesStatus:"actual",netSalesCents:10000,drinksCount:40,
  wagesCents:5000,payrollTaxCents:600,payrollTaxStatus:"estimated",
  cardFeesCents:300,cardFeesStatus:"actual",
});
describe("Menu pricing source basis",()=>{
  it("uses 14 actual historical import days even when none are in the current month",()=>{
    const p=menuPriceSourceBasis({days:Array.from({length:14},(_,i)=>day(i+1)),
      recurring:[{amountCents:150000,frequency:"monthly",estimated:false},
        {amountCents:52000,frequency:"yearly",estimated:true}],
      totalItemPrepSecondsInWindow:84000});
    expect(p).toMatchObject({coveredDays:14,oldestDate:"2026-08-01",latestDate:"2026-08-14",
      monthlyDrinks:1200,monthlyPayrollCents:168000,processingFeeBps:300,
      monthlyPrepSeconds:180000,monthlyRunningCents:154333,runningStatus:"estimated",
      feeStatus:"actual"});
  });
  it("never treats the other 76 unimported days of a 90-day window as zero",()=>{
    const p=menuPriceSourceBasis({days:[day(1),day(2)],recurring:[],totalItemPrepSecondsInWindow:0});
    expect(p).toMatchObject({coveredDays:2,monthlyDrinks:null,monthlyPayrollCents:null,
      monthlyRunningCents:null,processingFeeBps:null});
  });
  it("requires fee and payroll evidence instead of inventing reliable zeros",()=>{
    const days=Array.from({length:14},(_,i)=>({...day(i+1),wagesCents:0,
      payrollTaxCents:0,payrollTaxStatus:"estimated" as const,cardFeesStatus:"missing" as const}));
    const p=menuPriceSourceBasis({days,recurring:[],totalItemPrepSecondsInWindow:0});
    expect(p.payrollStatus).toBe("missing");
    expect(p.feeStatus).toBe("missing");
    expect(p.monthlyDrinks).toBe(1200);
  });
  it("keeps explicit zero monthly recurring bill separate from no bill",()=>{
    const p=menuPriceSourceBasis({days:[],recurring:[{amountCents:0,frequency:"monthly",estimated:false}],
      totalItemPrepSecondsInWindow:0});
    expect(p.monthlyRunningCents).toBe(0);
    expect(p.runningStatus).toBe("recorded");
  });
});
