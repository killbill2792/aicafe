import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {cafeStateFromSnapshot} from "@/lib/operating/cafeState";
import {buildProfitAndCostsViewModel,buildCostRecoveryViewModel} from "@/lib/viewmodels/moneyViewModel";
import {buildBreakEvenViewModel} from "@/lib/viewmodels/breakEvenViewModel";
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
  const snapshot:BusinessSnapshot={...fixture,todayDateStr:date(28),monthKey:"2026-09",daysInMonth:30,
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
        daysInMonth:30,monthlyBillsCents:recovery.monthlyBillsCents,
        monthlyStaffCents:recovery.monthlyStaffCents,
        observedIngredientCents:productCostEvidence.totalCostCents});
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
