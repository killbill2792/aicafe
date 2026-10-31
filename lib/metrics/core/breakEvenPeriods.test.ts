import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {breakEvenSnapshotInputs} from "@/lib/viewmodels/breakEvenViewModel";
import {buildBreakEvenViewModel} from "@/lib/viewmodels/breakEvenViewModel";
import {buildCostRecoveryViewModel} from "@/lib/viewmodels/moneyViewModel";
import {moneyTools} from "@/lib/ai/agent/tools/money";
import type {AgentToolContext} from "@/lib/ai/agent/tools/index";
import type {BusinessSnapshot} from "@/lib/data/types";
import type {DailyFacts} from "@/lib/calc";
import {shiftCafeDate} from "./clock";

function fixture() {
  const base=getFixtureSnapshot();
  const start="2026-10-01";
  const days:DailyFacts[]=Array.from({length:29},(_,i)=>({
    date:shiftCafeDate(start,i),netSalesCents:100_000,
    ingredientsCents:0,drinksCount:100,ordersCount:60,voidsCents:0,
    cardFeesCents:3_200,cardFeesStatus:"actual",
    wagesCents:15_000,staffTaxCents:1_800,
    laborWageStatus:"actual",staffTaxStatus:"estimated",
    salesDataStatus:"actual",
  }));
  const snapshot:BusinessSnapshot={...base,
    business:{...base.business,openHours:null,
      targetIngredientCostRate:.20,targetIngredientCostRateStatus:"owner",
      payrollTaxRateStatus:"confirmed"},
    todayDateStr:"2026-10-30",monthKey:"2026-10",daysInMonth:31,
    monthRecordedDays:days,monthActualDays:days,
    last28Days:days.slice(1),breakEvenDays:days.slice(1),
    breakEvenProductCosts:[],
    todayDay:{...days[28],date:"2026-10-30",netSalesCents:0,
      wagesCents:null,staffTaxCents:null,staffTaxStatus:"estimated",
      laborWageStatus:"missing",salesDataStatus:"missing"},
    todayHasData:false,
  };
  return snapshot;
}

function context(snapshot:BusinessSnapshot):AgentToolContext {
  return {
    asOf:snapshot.todayDateStr,timezone:snapshot.business.timezone,locale:"en",
    currency:snapshot.business.currency??null,
    tools:{} as AgentToolContext["tools"],
    readEconomics:async()=>({
      canonicalSnapshot:snapshot,
      canonicalBreakEven:breakEvenSnapshotInputs(snapshot),
      economics:{openDaysBasis:"opening_hours"} as never,
      items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:.20,
    }),
  };
}

describe("canonical period break-even and Toast provenance",()=>{
  it("uses exactly the same monthly cents for Money, Plan and Supervisor",async()=>{
    const snapshot=fixture();
    const basis=breakEvenSnapshotInputs(snapshot);
    const money=buildCostRecoveryViewModel(snapshot);
    const plan=buildBreakEvenViewModel(snapshot);
    const chat=await moneyTools.get_break_even.execute({},context(snapshot));
    expect(basis.shared.calculation).toEqual(money.breakEven);
    expect(plan.breakEven).toEqual(money.breakEven);
    expect(chat.monthlyBreakEvenCents).toBe(
      money.breakEven.kind==="ready"?money.breakEven.breakEvenSalesCents:null);
    expect(chat.periodBreakEvenCents).toBe(chat.monthlyBreakEvenCents);
    expect(chat.historicalFeeCoverage).toMatchObject({
      actualDays:28,estimatedDays:0,source:"toast_actual"});
    expect(chat.feeStatus).toBe("actual");
    expect(chat.costProvenance).toMatchObject({
      employerPayrollTax:"saved_rate_estimate",
      historicalProcessingFees:"toast_actual",
      futureProcessingFeeRate:"projected_from_actual",
      ingredients:"saved_rate",
    });
    expect(chat.reasonKey).not.toBe("profitFeesEstimated");
    expect(chat.estimated).toContain("savedIngredientRate");
    expect(chat.missing).not.toContain("processingFeeDaysIncomplete");
    expect((chat.explain as unknown[]).length).toBe(1);
  });

  it("month-to-date does not project the two missing future October labor days",async()=>{
    const snapshot=fixture();
    const forecast=breakEvenSnapshotInputs(snapshot);
    const mtd=breakEvenSnapshotInputs(snapshot,{period:"month_to_date"});
    const actualLabor=29*(15_000+1_800);
    expect(mtd.monthlyStaffCents).toBe(actualLabor);
    expect(forecast.monthlyStaffCents).toBe(Math.round(actualLabor*31/29));
    expect(mtd.monthlyBillsCents).toBe(
      Math.round(forecast.monthlyBillsCents*29/31));
    expect(mtd.shared.calculation.kind).toBe("ready");
    const chat=await moneyTools.get_break_even.execute({period:"month_to_date"},context(snapshot));
    expect(chat.periodKind).toBe("month_to_date");
    expect(chat.monthlyBreakEvenCents).toBeNull();
    expect(chat.periodBreakEvenCents).toBe(mtd.shared.salesPerMonthCents);
    expect(chat.costProvenance).toMatchObject({futureLabor:"not_projected"});
    expect(chat.period).toMatchObject({from:"2026-10-01",to:"2026-10-29"});
  });

  it("today does not present the monthly average as today's verified staffing cost",async()=>{
    const snapshot=fixture();
    const today=breakEvenSnapshotInputs(snapshot,{period:"today"});
    expect(today.monthlyStaffCents).toBeNull();
    expect(today.monthlyBillsCents).toBe(
      Math.round(breakEvenSnapshotInputs(snapshot).monthlyBillsCents/31));
    const chat=await moneyTools.get_break_even.execute({period:"today"},context(snapshot));
    expect(chat.periodKind).toBe("today");
    expect(chat.period).toMatchObject({from:"2026-10-30",to:"2026-10-30"});
    expect(chat.monthlyBreakEvenCents).toBeNull();
    expect(chat.periodBreakEvenCents).toBe(today.shared.salesPerMonthCents);
    expect(chat.missing).toContain("todayLaborUnavailable");
    expect(chat.costProvenance).toMatchObject({wages:"missing"});
    expect(chat.knownCostBreakEvenFloorCents).toBe(chat.periodBreakEvenCents);
  });

  it("explicit owner rate overrides use the same core formula, not a second adapter",async()=>{
    const snapshot=fixture();
    const unchanged=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:20},context(snapshot));
    const original=await moneyTools.get_break_even.execute({},context(snapshot));
    expect(unchanged.monthlyBreakEvenCents).toBe(original.monthlyBreakEvenCents);
    const changed=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:25,ownerProcessingFeePercent:4},context(snapshot));
    const basis=breakEvenSnapshotInputs(snapshot,{
      ingredientRateOverride:.25,feeRateOverride:.04});
    expect(changed.monthlyBreakEvenCents).toBe(basis.shared.salesPerMonthCents);
    expect(changed.feeStatus).toBe("actual"); // Historical Toast fees remain actual.
    expect(changed.costProvenance).toMatchObject({
      historicalProcessingFees:"toast_actual",ingredients:"owner_override"});
  });

  it("asks for truly absent ingredient assumptions instead of making up a zero rate",async()=>{
    const snapshot=fixture();
    const missing:BusinessSnapshot={...snapshot,
      business:{...snapshot.business,targetIngredientCostRate:null},
      breakEvenProductCosts:[],menuItems:[]};
    const chat=await moneyTools.get_break_even.execute({},context(missing));
    expect(chat.missing).toContain("ingredientRateMissing:ask_owner");
    expect(chat.ingredientStatus).toBe("missing");
    expect(chat.status).toBe("estimate");
  });

  it("does not certify placeholder zeros as Toast labor but retains a genuine $0 shift",async()=>{
    const snapshot=fixture();
    const placeholder:BusinessSnapshot={...snapshot,
      todayDay:{...snapshot.todayDay,wagesCents:0,staffTaxCents:0,
        laborWageStatus:undefined,salesDataStatus:"missing"}};
    const unknown=breakEvenSnapshotInputs(placeholder,{period:"today"});
    expect(unknown.todayLaborReady).toBe(false);
    expect(unknown.monthlyStaffCents).toBeNull();
    const reply=await moneyTools.get_break_even.execute({period:"today"},context(placeholder));
    expect(reply.missing).toContain("todayLaborUnavailable");
    expect(reply.costProvenance).toMatchObject({wages:"missing"});
    const genuine={...placeholder.todayDay,laborWageStatus:"actual" as const,
      wagesCents:0,staffTaxCents:0};
    const withShift:BusinessSnapshot={...placeholder,todayDay:genuine,
      monthRecordedDays:[...(placeholder.monthRecordedDays??[]),genuine]};
    const actual=breakEvenSnapshotInputs(withShift,{period:"today"});
    expect(actual.todayLaborReady).toBe(true);
    expect(actual.monthlyStaffCents).toBe(0);
  });

  it("preserves owner labor stated for exactly today or month-to-date",async()=>{
    const snapshot=fixture();
    const ownerInputs=(laborCents:number,laborPeriod:{from:string;to:string})=>({
      netSalesCents:null,salesPeriod:null,laborCents,laborPeriod,
      rentCents:null,otherOverheadCents:null,overheadPeriod:null,
      unitCostCents:null,itemsSoldPerDay:null,
    });
    const today=await moneyTools.get_break_even.execute({period:"today",
      ownerOpenDaysPerMonth:27,
      ownerInputs:ownerInputs(10_000,{from:"2026-10-30",to:"2026-10-30"})},
      context(snapshot));
    expect((today.monthlyLabor as {valueCents:number|null}).valueCents).toBe(10_000);
    const mtd=await moneyTools.get_break_even.execute({period:"month_to_date",
      ownerOpenDaysPerMonth:27,
      ownerInputs:ownerInputs(487_200,{from:"2026-10-01",to:"2026-10-29"})},
      context(snapshot));
    expect((mtd.monthlyLabor as {valueCents:number|null}).valueCents).toBe(487_200);
  });

  it("includes actual expenses already incurred MTD, prorating recurring bills only",()=>{
    const snapshot=fixture();
    const lines=snapshot.runningCostLines.filter(line=>line.categoryCode!=="repairs")
      .map(line=>({...line,amountSource:"recurring" as const}));
    const repaired:BusinessSnapshot={...snapshot,runningCostLines:[
      ...lines,{categoryCode:"repairs",label:"Repairs",amountCents:31_000,
        amountSource:"recorded_expense",isEstimate:false,isMissing:false,isExpected:true},
    ]};
    const forecast=breakEvenSnapshotInputs(repaired,{period:"month_forecast"});
    const mtd=breakEvenSnapshotInputs(repaired,{period:"month_to_date"});
    const recurringCents=lines.filter(line=>!line.isMissing)
      .reduce((sum,line)=>sum+line.amountCents,0);
    expect(forecast.monthlyBillsCents).toBe(recurringCents+31_000);
    expect(mtd.monthlyBillsCents).toBe(31_000+Math.round(recurringCents*29/31));
    expect(mtd.monthlyBillsCents).toBeGreaterThan(
      Math.round(forecast.monthlyBillsCents*29/31));
  });

});
