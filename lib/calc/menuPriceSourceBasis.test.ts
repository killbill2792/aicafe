import { describe, it, expect } from "vitest";
import { menuPriceSourceBasis, type MenuPriceSourceDay } from "./menuPriceSourceBasis";

const day=(n:number):MenuPriceSourceDay=>({
  businessDate:`2026-08-${String(n).padStart(2,"0")}`,
  salesStatus:"actual",netSalesCents:10000,drinksCount:40,
  wagesCents:5000,payrollTaxCents:600,payrollTaxStatus:"estimated",
  cardFeesCents:300,cardFeesStatus:"actual",
});
const basis=(days:MenuPriceSourceDay[],opts:Partial<Parameters<typeof menuPriceSourceBasis>[0]>={})=>
  menuPriceSourceBasis({days,recurring:[],expenses:[],totalItemPrepSecondsInWindow:0,...opts});

describe("Menu pricing source basis",()=>{
  it("uses 14 actual historical import days even when none are in the current month",()=>{
    const p=basis(Array.from({length:14},(_,i)=>day(i+1)),{
      recurring:[{categoryCode:"rent",amountCents:150000,frequency:"monthly",estimated:false},
        {categoryCode:"software",amountCents:52000,frequency:"yearly",estimated:true}],
      totalItemPrepSecondsInWindow:84000});
    expect(p).toMatchObject({coveredDays:14,oldestDate:"2026-08-01",latestDate:"2026-08-14",
      monthlyDrinks:1200,monthlyPayrollCents:168000,processingFeeBps:300,
      monthlyPrepSeconds:180000,monthlyRunningCents:154333,runningStatus:"estimated",
      feeStatus:"actual",payrollCoveredDays:14});
  });
  it("never treats the other 76 unimported days of a 90-day window as zero",()=>{
    const p=basis([day(1),day(2)]);
    expect(p).toMatchObject({coveredDays:2,monthlyDrinks:null,monthlyPayrollCents:null,
      monthlyRunningCents:null,processingFeeBps:null});
  });
  it("requires fee and payroll evidence instead of inventing reliable zeros",()=>{
    const days=Array.from({length:14},(_,i)=>({...day(i+1),wagesCents:0,
      payrollTaxCents:0,payrollTaxStatus:"estimated" as const,cardFeesStatus:"missing" as const}));
    const p=basis(days);
    expect(p.payrollStatus).toBe("missing");
    expect(p.feeStatus).toBe("missing");
    expect(p.monthlyDrinks).toBe(1200);
  });
  it("keeps explicit zero recurring bill separate from missing",()=>{
    const p=basis([],{recurring:[
      {categoryCode:"rent",amountCents:0,frequency:"monthly",estimated:false}]});
    expect(p.monthlyRunningCents).toBe(0);
    expect(p.runningStatus).toBe("estimated");
  });
  it("uses current-month actuals instead of double counting scheduled bills",()=>{
    const p=basis([],{recurring:[
      {categoryCode:"rent",amountCents:120000,frequency:"monthly",estimated:false},
      {categoryCode:"utilities_power",amountCents:12000,frequency:"monthly",estimated:false}],
      expenses:[
        {categoryCode:"rent",amountCents:70000,status:"actual"},
        {categoryCode:"rent",amountCents:30000,status:"actual"},
        {categoryCode:"ingredients",amountCents:90000,status:"actual"}]});
    expect(p.monthlyRunningCents).toBe(112000);
    expect(p.runningStatus).toBe("estimated");
  });
  it("uses actual expenses alone when no recurring bill exists",()=>{
    const p=basis([],{expenses:[
      {categoryCode:"repairs",amountCents:8000,status:"actual"}]});
    expect(p.monthlyRunningCents).toBe(8000);
    expect(p.runningStatus).toBe("recorded");
  });
  it("keeps payroll coverage independent of sales coverage and includes staff-only days",()=>{
    const sales=Array.from({length:14},(_,i)=>({...day(i+1),
      wagesCents:i<7?5000:0,payrollTaxCents:i<7?600:0}));
    const staffOnly={...day(15),salesStatus:"missing" as const,netSalesCents:0,drinksCount:0};
    const p=basis([...sales,staffOnly]);
    expect(p.coveredDays).toBe(14);
    expect(p.payrollCoveredDays).toBe(8);
    expect(p.monthlyPayrollCents).toBe(168000);
    expect(p.monthlyDrinks).toBe(1200);
    expect(p.payrollLatestDate).toBe("2026-08-15");
  });
  it("does not extrapolate from just one or two staff-only dates",()=>{
    const sales=Array.from({length:14},(_,i)=>({...day(i+1),
      wagesCents:i<2?5000:0,payrollTaxCents:i<2?600:0}));
    const p=basis(sales);
    expect(p.monthlyDrinks).toBe(1200);
    expect(p.payrollCoveredDays).toBe(2);
    expect(p.monthlyPayrollCents).toBeNull();
    expect(p.payrollStatus).toBe("missing");
  });
});
