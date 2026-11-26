import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {cafeStateFromSnapshot} from "@/lib/operating/cafeState";
import {buildProfitAndCostsViewModel,buildCostRecoveryViewModel} from "@/lib/viewmodels/moneyViewModel";
import {buildBreakEvenViewModel,breakEvenSnapshotInputs} from "@/lib/viewmodels/breakEvenViewModel";
import {breakEvenFor} from "./breakEven";
import {cardFeesForDays} from "./fees";
import {laborForPeriod} from "./labor";
import {profitForPeriod} from "./profit";
import type {BusinessSnapshot} from "@/lib/data/types";
import {summarizeResolvedSoldProductCosts,type DailyFacts} from "@/lib/calc";
import {shiftCafeDate} from "./clock";

const date=(i:number)=>shiftCafeDate("2026-09-01",i);
function demo(caseName:"complete"|"today_missing"|"fees_missing"|"wage_missing"|"bill_missing"|"actual_toast_fees"){
  const day=(i:number):DailyFacts=>({
    date:date(i),netSalesCents:240_000,ingredientsCents:65_000,
    cardFeesCents:caseName==="fees_missing"?0:caseName==="actual_toast_fees"?3_641:7_000,
    cardFeesStatus:caseName==="fees_missing"?"missing":"actual",
    wagesCents:caseName==="wage_missing"&&i===0?null:69_600,
    staffTaxCents:8_352,ordersCount:240,drinksCount:480,voidsCents:0,
    laborWageStatus:caseName==="wage_missing"&&i===0?"missing":"actual",
    staffTaxStatus:"actual",salesDataStatus:"actual",
  });
  const current=Array.from({length:caseName==="today_missing"?28:29},(_,i)=>day(i));
  const fixture=getFixtureSnapshot();
  const snapshot:BusinessSnapshot & {ownerFeePlans?:{percentageBps:number}[]}={
    ...fixture,ownerFeePlans:caseName==="actual_toast_fees"?[{percentageBps:400}]:[],
    todayDateStr:date(28),monthKey:"2026-09",daysInMonth:30,
    monthActualDays:current,monthRecordedDays:current,last28Days:current,
    last7Days:current.slice(-7),todayDay:caseName==="today_missing"?
      {...day(28),netSalesCents:0,salesDataStatus:"missing"}:current[current.length-1],
    todayHasData:caseName!=="today_missing",
    previousMonthDays:[],
    runningCostLines:fixture.runningCostLines.map(l=>caseName==="bill_missing"&&l.categoryCode==="rent"?
      {...l,amountCents:0,isMissing:true,isExpected:true}:l),
  };
  return snapshot;
}

describe("metricsParity — one observed café through screen and structured chat read",()=>{
  for(const scenario of ["complete","today_missing","fees_missing","wage_missing","bill_missing","actual_toast_fees"] as const){
    it(scenario+" matches cents for fees, labor, break-even, drinks/day, and partial profit",()=>{
      const snapshot=demo(scenario);
      const screen=buildProfitAndCostsViewModel(snapshot,"month");
      const chat=cafeStateFromSnapshot(snapshot,{from:"2026-09-01",to:snapshot.todayDateStr});
      const recovery=buildCostRecoveryViewModel(snapshot);
      const plan=buildBreakEvenViewModel(snapshot);
      const fee=cardFeesForDays(snapshot.monthActualDays,
        scenario==="actual_toast_fees"?{percentageBps:400}:null);
      const dates=Array.from({length:29},(_,i)=>({date:date(i)}));
      const labor=laborForPeriod(dates,snapshot.monthRecordedDays??[]);
      const billCents=screen.runningCostLines.reduce((total,line)=>total+line.amountCents,0);
      const p=profitForPeriod(snapshot.monthActualDays,{amountCents:billCents,
        missing:snapshot.runningCostLines.filter(l=>l.isMissing&&l.isExpected).map(l=>l.categoryCode)},
        {amountCents:fee.amountCents,missing:scenario==="fees_missing"?["feesMissing"]:[]},
        {amountCents:labor.knownLaborCents,missing:labor.coveredDays<29?["laborMissing"]:[]},
        {amountCents:snapshot.monthActualDays.reduce((v,d)=>v+d.ingredientsCents,0)});
      expect(screen.cardFeesCents).toBe(fee.amountCents);
      expect(screen.wagesCents!+screen.staffTaxCents!).toBe(labor.knownLaborCents);
      expect(chat.profitability.available).toBe(true);
      if(!chat.profitability.available)throw Error("Expected covered historical sales");
      expect(chat.profitability.value.ownerProfitCents).toBe(screen.ownerProfitCents);
      expect(chat.profitability.value.totalCostsCents).toBe(screen.totalCostsCents);
      expect(p.profitCents).toBe(screen.ownerProfitCents);
      const productCostEvidence=summarizeResolvedSoldProductCosts(snapshot.breakEvenProductCosts??snapshot.menuItems);
      const core=breakEvenFor({days:snapshot.last28Days,asOfDate:snapshot.todayDateStr,
        daysInMonth:plan.openDaysPerMonth,monthlyBillsCents:recovery.monthlyBillsCents,
        monthlyStaffCents:recovery.monthlyStaffCents,
        observedIngredientCents:productCostEvidence.totalCostCents});
      expect(recovery.breakEven).toEqual(plan.breakEven);
      expect(recovery.breakEven.kind).toBe(core.calculation.kind);
      if(recovery.breakEven.kind==="ready"&&core.calculation.kind==="ready"){
        expect(recovery.breakEven.breakEvenSalesCents).toBe(core.calculation.breakEvenSalesCents);
      }
      expect(plan.drinksNeededPerDay).toBe(core.drinksPerDay??0);
      if(scenario==="today_missing")expect(screen.coverage.actualDays).toBe(28);
      if(scenario==="fees_missing")expect(fee.basis).toBe("default_estimate");
      if(scenario==="actual_toast_fees"){
        expect(fee.basis).toBe("actual");
        expect(fee.amountCents).toBe(snapshot.monthActualDays.length*3641);
      }
      if(scenario==="wage_missing")expect(screen.financialNotes).toContain("profitLaborMissing");
      if(scenario==="bill_missing")expect(screen.financialNotes).toContain("profitBillsMissing");
    });
  }
});

describe("canonical core and screen parity for sparse payroll",()=>{
 it("does not present missing wages as zero",()=>{
   const base=demo("complete");
   const raw=base.monthActualDays.map((day,i)=>i>=3?{...day,wagesCents:null,laborWageStatus:"missing" as const}:day);
   const snapshot:BusinessSnapshot={...base,monthActualDays:raw,monthRecordedDays:raw,
     last28Days:raw,breakEvenDays:raw.filter(day=>day.date<base.todayDateStr)};
   const recovery=buildCostRecoveryViewModel(snapshot),plan=buildBreakEvenViewModel(snapshot);
   expect(recovery.monthlyStaffCents).not.toBeNull();
   expect(plan.noteKeys).toContain("laborCoveragePartial");
   expect(recovery.breakEven).toEqual(plan.breakEven);
 });
});

describe("October closed-day parity, verified Toast zero fees and visible working",()=>{
 it("Money and Plan use identical cents and elapsed coverage",()=>{
   const base=demo("complete");
   const dateRow=(date:string,fees:number,status:"actual"|"estimated"):DailyFacts=>({
     ...base.monthActualDays[0],date,netSalesCents:1_000_000,
     drinksCount:200,ordersCount:90,wagesCents:0,staffTaxCents:0,
     laborWageStatus:"actual",staffTaxStatus:"actual",
     cardFeesCents:fees,cardFeesStatus:status,salesDataStatus:"actual",
   });
   const history=[dateRow("2026-10-12",5_357,"actual"),
     dateRow("2026-10-14",5_464,"actual")];
   const snapshot:BusinessSnapshot={...base,todayDateStr:"2026-10-15",
     monthKey:"2026-10",daysInMonth:31,monthActualDays:history,
     monthRecordedDays:history,last28Days:history,breakEvenDays:history,
     };
   const inputs=breakEvenSnapshotInputs(snapshot);
   const money=buildCostRecoveryViewModel(snapshot);
   const plan=buildBreakEvenViewModel(snapshot);
   expect(inputs.monthLabor.projectedMonthlyLaborCents).toBe(0);
   expect(inputs.feeResult.basis).toBe("actual");
   expect(inputs.feeResult.amountCents).toBe(10_821);
   expect(money.observedProcessingFeesCents).toBe(10_821);
   expect(plan.breakEven).toEqual(money.breakEven);
   expect(inputs.missingLaborDates.every(date=>date.startsWith("2026-10-")&&
     date<"2026-10-15")).toBe(true);
   const missingFee:BusinessSnapshot={...snapshot,
     monthActualDays:[history[0],dateRow("2026-10-14",0,"estimated")],
     monthRecordedDays:[history[0],dateRow("2026-10-14",0,"estimated")],
     last28Days:[history[0],dateRow("2026-10-14",0,"estimated")],
     breakEvenDays:[history[0],dateRow("2026-10-14",0,"estimated")]};
   const missing=breakEvenSnapshotInputs(missingFee);
   expect(missing.feeResult.amountCents).not.toBe(10_821);
   expect(missing.feeResult.basis).not.toBe("actual");
   expect(missing.estimatesUsed).toBe(true);
   const zeroActual:BusinessSnapshot={...snapshot,
     last28Days:[history[0],dateRow("2026-10-14",0,"actual")],
     breakEvenDays:[history[0],dateRow("2026-10-14",0,"actual")]};
   const verifiedZero=breakEvenSnapshotInputs(zeroActual);
   expect(verifiedZero.feeResult.basis).toBe("actual");
   expect(verifiedZero.feeResult.amountCents).toBe(5_357); // actual $0 wins fallback

 });
});

describe("Codex P1 financial input regressions",()=>{
 it("excludes unclosed today's wages from the disclosed elapsed labor calibration",()=>{
   const original=demo("complete");
   const days=(original.monthRecordedDays??original.monthActualDays).map(day=>
     day.date===original.todayDateStr?{
       ...day,salesDataStatus:"missing" as const,wagesCents:2_000,staffTaxCents:240,
     }:day);
   const snapshot:BusinessSnapshot={...original,monthRecordedDays:days,
     monthActualDays:days.filter(day=>day.salesDataStatus!=="missing")};
   const inputs=breakEvenSnapshotInputs(snapshot);
   const completed=days.filter(day=>day.date<snapshot.todayDateStr);
   const expected=laborForPeriod(inputs.openDates.map(date=>({date})),completed);
   expect(inputs.monthLabor.projectedMonthlyLaborCents).toBe(expected.projectedMonthlyLaborCents);
   expect(inputs.elapsedOpenDates).not.toContain(snapshot.todayDateStr);
   expect(inputs.missingLaborDates).not.toContain(snapshot.todayDateStr);
   expect(inputs.monthLabor.coveredDays).toBe(expected.coveredDays);
   expect(buildCostRecoveryViewModel(snapshot).monthlyStaffCents).toBe(expected.projectedMonthlyLaborCents);
 });
 it("uses a saved ingredient rate if recipes are unavailable, and labels genuine unknowns",()=>{
   const original=demo("complete");
   const snapshot:BusinessSnapshot={...original,menuItems:[],breakEvenProductCosts:[],
     business:{...original.business,targetIngredientCostRate:.24,targetIngredientCostRateStatus:"confirmed"}};
   const owner=breakEvenSnapshotInputs(snapshot);
   expect(owner.ingredientSource).toBe("saved_rate");
   expect(owner.ingredientStatus).toBe("owner");
   expect(owner.observedIngredientCents).toBe(Math.round(owner.observedSalesCents*.24));
   expect(owner.ingredientMissing).toBe(false);
   expect(owner.estimatesUsed).toBe(true);
   expect(buildBreakEvenViewModel(snapshot).breakEven).toEqual(
     buildCostRecoveryViewModel(snapshot).breakEven);
   const unknown=breakEvenSnapshotInputs({...snapshot,business:{
     ...snapshot.business,targetIngredientCostRate:null}});
   expect(unknown.ingredientMissing).toBe(true);
   expect(unknown.ingredientStatus).toBe("missing");
   expect(unknown.estimatesUsed).toBe(true);
   expect(buildBreakEvenViewModel({...snapshot,business:{
     ...snapshot.business,targetIngredientCostRate:null}}).noteKeys).toContain("profitProductCostsMissing");
 });
});
