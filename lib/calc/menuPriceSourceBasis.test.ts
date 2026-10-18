import { describe, it, expect } from "vitest";
import { menuPriceSourceBasis, type MenuPriceSourceDay } from "./menuPriceSourceBasis";

const day=(n:number):MenuPriceSourceDay=>({
  businessDate:`2026-08-${String(n).padStart(2,"0")}`,
  salesStatus:"actual",netSalesCents:10000,drinksCount:40,
  wagesCents:5000,payrollTaxCents:600,payrollTaxStatus:"estimated",
  cardFeesCents:300,cardFeesStatus:"actual",
});
const basis=(days:MenuPriceSourceDay[],opts:Partial<Parameters<typeof menuPriceSourceBasis>[0]>={})=>
  menuPriceSourceBasis({days,recurring:[],expenses:[],previousMonthExpenseCategories:[],
    totalItemPrepSecondsInWindow:0,asOfBusinessDate:"2026-09-17",...opts});

describe("Menu pricing source basis",()=>{
  it("uses 14 actual historical import days even when none are in the current month",()=>{
    const p=basis(Array.from({length:14},(_,i)=>day(i+1)),{
      recurring:[{categoryCode:"rent",amountCents:150000,frequency:"monthly",estimated:false},
        {categoryCode:"software",amountCents:52000,frequency:"yearly",estimated:true}],
      totalItemPrepSecondsInWindow:84000,
      laborCoveredDates:Array.from({length:14},(_,i)=>day(i+1).businessDate)});
    expect(p).toMatchObject({coveredDays:14,oldestDate:"2026-08-01",latestDate:"2026-08-14",
      monthlyDrinks:1200,monthlyPayrollCents:168000,processingFeeBps:300,
      monthlyPrepSeconds:180000,monthlyRunningCents:154333,runningStatus:"estimated",
      feeStatus:"actual",payrollCoveredDays:14});
  });
  it("uses the canonical recent 28 calendar days when sufficiently covered",()=>{
    const historical=Array.from({length:14},(_,i)=>day(i+1));
    const recent=Array.from({length:14},(_,i)=>({
      ...day(i+1),businessDate:`2026-10-${String(i+1).padStart(2,"0")}`,
      drinksCount:10,cardFeesCents:100,
    }));
    const p=basis([...historical,...recent],{asOfBusinessDate:"2026-10-17"});
    expect(p).toMatchObject({coveredDays:14,oldestDate:"2026-10-01",
      latestDate:"2026-10-14",monthlyDrinks:310,processingFeeBps:100});
  });
  it("withholds payroll when positive paid dates lack independently verified zero-day coverage",()=>{
    const sales=Array.from({length:14},(_,i)=>({
      ...day(i+1),wagesCents:i<10?5000:0,payrollTaxCents:i<10?600:0,
    }));
    const unverified=basis(sales);
    expect(unverified.monthlyPayrollCents).toBeNull();
    expect(unverified.payrollStatus).toBe("missing");
    const verified=basis(sales,{laborCoveredDates:sales.map(d=>d.businessDate)});
    expect(verified.payrollCoveredDays).toBe(14);
    expect(verified.monthlyPayrollCents).toBe(120000);
  });
  it("includes zero and refunded covered sales days in the effective fee ratio",()=>{
    const days=Array.from({length:14},(_,i)=>day(i+1));
    days[12]={...day(13),netSalesCents:0,cardFeesCents:500};
    days[13]={...day(14),netSalesCents:-1000,cardFeesCents:-30};
    const p=basis(days);
    // (12 * 300 + 500 - 30) / (12 * 10000 - 1000) = 342 bps.
    expect(p.processingFeeBps).toBe(342);
    expect(p.feeStatus).toBe("actual");
    const incomplete=basis(days.map((d,i)=>i===12?{
      ...d,cardFeesStatus:"missing" as const}:d));
    expect(incomplete.processingFeeBps).toBeNull();
    expect(incomplete.feeStatus).toBe("missing");
  });
  it("withholds a fee rate when the covered-day aggregate net sales are nonpositive",()=>{
    const days=Array.from({length:14},(_,i)=>({
      ...day(i+1),netSalesCents:-100,cardFeesCents:100,
    }));
    expect(basis(days).processingFeeBps).toBeNull();
  });
  it("retains unrounded aggregate fee sums alongside the displayed bps",()=>{
    const dates=Array.from({length:14},(_,i)=>({
      ...day(i+1),netSalesCents:20000,cardFeesCents:601,
    }));
    const p=basis(dates);
    expect(p.processingFeeBps).toBe(301);
    expect(p.processingFeeNumeratorCents).toBe(8414);
    expect(p.processingFeeDenominatorCents).toBe(280000);
  });
  it("scales covered sales to February, leap February, and 31-day calendar months",()=>{
    const feb28=Array.from({length:14},(_,i)=>({
      ...day(i+1),businessDate:`2027-02-${String(i+1).padStart(2,"0")}`,
    }));
    const feb29=feb28.map(d=>({...d,businessDate:d.businessDate.replace("2027","2028")}));
    const march=feb28.map(d=>({...d,businessDate:d.businessDate.replace("2027-02","2027-03")}));
    expect(basis(feb28,{asOfBusinessDate:"2027-02-20"}).monthlyDrinks).toBe(1120);
    expect(basis(feb29,{asOfBusinessDate:"2028-02-20"}).monthlyDrinks).toBe(1160);
    expect(basis(march,{asOfBusinessDate:"2027-03-20"}).monthlyDrinks).toBe(1240);
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
  it("withholds full cost profit when a prior-month expected category lacks this month's amount",()=>{
    const p=basis([],{
      previousMonthExpenseCategories:["supplies"],
      recurring:[{categoryCode:"rent",amountCents:100000,frequency:"monthly",estimated:false}],
    });
    expect(p).toMatchObject({
      monthlyRunningCents:null,
      runningKnownCents:100000,
      missingRunningCategories:["supplies"],
      runningStatus:"missing",
    });
  });
  it("does not demand a prior-month one-time repair expense as recurring",()=>{
    const p=basis([],{
      previousMonthExpenseCategories:["repairs"],
      recurring:[{categoryCode:"rent",amountCents:100000,frequency:"monthly",estimated:false}],
    });
    expect(p.monthlyRunningCents).toBe(100000);
    expect(p.missingRunningCategories).toEqual([]);
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
  it("counts estimated expense rows and marks combined costs estimated",()=>{
    const p=basis([],{recurring:[
      {categoryCode:"rent",amountCents:120000,frequency:"monthly",estimated:false},
      {categoryCode:"water",amountCents:10000,frequency:"monthly",estimated:false}],
      expenses:[
        {categoryCode:"rent",amountCents:75000,status:"actual"},
        {categoryCode:"rent",amountCents:5000,status:"estimated"},
        {categoryCode:"repairs",amountCents:18000,status:"estimated"}]});
    // Rent expenses (80,000) replace scheduled rent (120,000).
    // Estimated repairs remain included; water still uses its schedule.
    expect(p.monthlyRunningCents).toBe(108000);
    expect(p.runningStatus).toBe("estimated");
  });
  it("does not discard an estimated expense when no recurring cost exists",()=>{
    const p=basis([],{expenses:[
      {categoryCode:"other",amountCents:25000,status:"estimated"}]});
    expect(p.monthlyRunningCents).toBe(25000);
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
    const p=basis([...sales,staffOnly],{
      laborCoveredDates:[...sales,staffOnly].map(d=>d.businessDate),
    });
    expect(p.coveredDays).toBe(14);
    // Seven known $0 labor dates must stay in the calendar-day denominator.
    expect(p.payrollCoveredDays).toBe(15);
    expect(p.monthlyPayrollCents).toBe(89600);
    expect(p.monthlyDrinks).toBe(1200);
    expect(p.payrollLatestDate).toBe("2026-08-15");
  });
  it("does not confuse actual zero employer-tax entries with observed wages",()=>{
    const sales=Array.from({length:14},(_,i)=>({...day(i+1),
      wagesCents:0,payrollTaxCents:0,payrollTaxStatus:"actual" as const}));
    const p=basis(sales);
    expect(p.payrollCoveredDays).toBe(0);
    expect(p.monthlyPayrollCents).toBeNull();
  });
  it("does not project from gapped or incomplete covered labor intervals",()=>{
    const sales=Array.from({length:14},(_,i)=>day(i+1));
    const gapped=basis(sales,{laborCoveredDates:[1,2,3,4,5,8,9,10]
      .map(n=>day(n).businessDate)});
    expect(gapped.monthlyPayrollCents).toBeNull();
    const withMissingRollup=basis(sales.slice(0,13),{
      laborCoveredDates:sales.map(d=>d.businessDate),
    });
    expect(withMissingRollup.monthlyPayrollCents).toBeNull();
  });
  it("does not extrapolate from just one or two staff-only dates",()=>{
    const sales=Array.from({length:14},(_,i)=>({...day(i+1),
      wagesCents:i<2?5000:0,payrollTaxCents:i<2?600:0}));
    const p=basis(sales,{laborCoveredDates:sales.slice(0,2).map(d=>d.businessDate)});
    expect(p.monthlyDrinks).toBe(1200);
    expect(p.payrollCoveredDays).toBe(2);
    expect(p.monthlyPayrollCents).toBeNull();
    expect(p.payrollStatus).toBe("missing");
  });
});
