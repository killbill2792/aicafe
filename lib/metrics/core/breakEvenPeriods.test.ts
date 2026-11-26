import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {breakEvenSnapshotInputs} from "@/lib/viewmodels/breakEvenViewModel";
import {buildBreakEvenViewModel} from "@/lib/viewmodels/breakEvenViewModel";
import {buildCostRecoveryViewModel} from "@/lib/viewmodels/moneyViewModel";
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

describe("canonical period break-even and Toast provenance",()=>{
  it("uses exactly the same monthly cents for Money and Plan",()=>{
    const snapshot=fixture();
    const basis=breakEvenSnapshotInputs(snapshot);
    const money=buildCostRecoveryViewModel(snapshot);
    const plan=buildBreakEvenViewModel(snapshot);
    expect(basis.shared.calculation).toEqual(money.breakEven);
    expect(plan.breakEven).toEqual(money.breakEven);
    expect(basis.feeResult.basis).toBe("actual");
    expect(basis.feeResult.amountCents).toBe(28*3200);
    expect(basis.ingredientSource).toBe("saved_rate");
  });
    expect(chat.reasonKey).not.toBe("profitFeesEstimated");
    expect(chat.estimated).toContain("savedIngredientRate");
    expect(chat.missing).not.toContain("processingFeeDaysIncomplete");
    expect((chat.explain as unknown[]).length).toBe(1);
  });

  it("month-to-date does not project the two missing future October labor days",()=>{
    const snapshot=fixture();
    const forecast=breakEvenSnapshotInputs(snapshot);
    const mtd=breakEvenSnapshotInputs(snapshot,{period:"month_to_date"});
    const actualLabor=29*(15_000+1_800);
    expect(mtd.monthlyStaffCents).toBe(actualLabor);
    expect(forecast.monthlyStaffCents).toBe(Math.round(actualLabor*31/29));
    expect(mtd.monthlyBillsCents).toBe(
      Math.round(forecast.monthlyBillsCents*29/31));
    expect(mtd.shared.calculation.kind).toBe("ready");
  });

  it("today does not present the monthly average as today's verified staffing cost",()=>{
    const snapshot=fixture();
    const today=breakEvenSnapshotInputs(snapshot,{period:"today"});
    expect(today.monthlyStaffCents).toBeNull();
    expect(today.monthlyBillsCents).toBe(
      Math.round(breakEvenSnapshotInputs(snapshot).monthlyBillsCents/31));
  });

  it("explicit owner rate overrides use the same core formula, not a second adapter",()=>{
    const snapshot=fixture();
    const unchanged=breakEvenSnapshotInputs(snapshot,{ingredientRateOverride:.20});
    const original=breakEvenSnapshotInputs(snapshot);
    expect(unchanged.shared.salesPerMonthCents).toBe(original.shared.salesPerMonthCents);
    const changed=breakEvenSnapshotInputs(snapshot,{ingredientRateOverride:.25,feeRateOverride:.04});
    expect(changed.feeResult.basis).toBe("actual");
    expect(changed.ingredientSource).toBe("owner_override");
    expect(changed.shared.salesPerMonthCents).not.toBe(original.shared.salesPerMonthCents);
  });

  it("asks for truly absent ingredient assumptions instead of making up a zero rate",()=>{
    const snapshot=fixture();
    const missing:BusinessSnapshot={...snapshot,
      business:{...snapshot.business,targetIngredientCostRate:null},
      breakEvenProductCosts:[],menuItems:[]};
    const basis=breakEvenSnapshotInputs(missing);
    expect(basis.ingredientMissing).toBe(true);
    expect(basis.ingredientStatus).toBe("missing");
    expect(basis.estimatesUsed).toBe(true);
  });

  it("does not certify placeholder zeros as Toast labor but retains a genuine $0 shift",()=>{
    const snapshot=fixture();
    const placeholder:BusinessSnapshot={...snapshot,
      todayDay:{...snapshot.todayDay,wagesCents:0,staffTaxCents:0,
        laborWageStatus:undefined,salesDataStatus:"missing"}};
    const unknown=breakEvenSnapshotInputs(placeholder,{period:"today"});
    expect(unknown.todayLaborReady).toBe(false);
    expect(unknown.monthlyStaffCents).toBeNull();
    const genuine={...placeholder.todayDay,laborWageStatus:"actual" as const,
      wagesCents:0,staffTaxCents:0};
    const withShift:BusinessSnapshot={...placeholder,todayDay:genuine,
      monthRecordedDays:[...(placeholder.monthRecordedDays??[]),genuine]};
    const actual=breakEvenSnapshotInputs(withShift,{period:"today"});
    expect(actual.todayLaborReady).toBe(true);
    expect(actual.monthlyStaffCents).toBe(0);
  });

  it("preserves owner labor stated for exactly today or month-to-date",()=>{
    const snapshot=fixture();
    const today=breakEvenSnapshotInputs(snapshot,{period:"today",periodLaborCentsOverride:10_000});
    expect(today.monthlyStaffCents).toBe(10_000);
    const mtd=breakEvenSnapshotInputs(snapshot,{period:"month_to_date",periodLaborCentsOverride:487_200});
    expect(mtd.monthlyStaffCents).toBe(487_200);
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
