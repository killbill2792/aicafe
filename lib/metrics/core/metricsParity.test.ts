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
import {moneyTools} from "@/lib/ai/agent/tools/money";
import {newItemPriceTools} from "@/lib/ai/agent/tools/newItemPrice";
import {staffTools} from "@/lib/ai/agent/tools/staff";
import type {AgentToolContext} from "@/lib/ai/agent/tools/index";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import {businessCostSummaryFromSnapshot} from "@/lib/operating/businessCosts";

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

describe("parity across real chat tool handlers and screens (a)-(g)",()=>{
 const cases=["complete","today_missing","fees_missing","wage_missing","bill_missing","actual_toast_fees","sparse_payroll"] as const;
 for(const kind of cases){
  it(kind+": get_break_even and get_labor and new-item pricing match screen cents",async()=>{
   const base=demo(kind==="sparse_payroll"?"complete":kind);
   const raw=base.monthActualDays.map((day,i)=>kind==="sparse_payroll"&&i>=3?
     {...day,wagesCents:null,laborWageStatus:"missing" as const}:day);
   const snapshot:BusinessSnapshot={...base,monthActualDays:raw,monthRecordedDays:raw,
     last28Days:raw,breakEvenDays:raw.filter(day=>day.date<base.todayDateStr)};
   const screen=buildProfitAndCostsViewModel(snapshot,"month");
   const recovery=buildCostRecoveryViewModel(snapshot);
   const plan=buildBreakEvenViewModel(snapshot);
   const days=snapshot.breakEvenDays??[];
   const fees=cardFeesForDays(days,(snapshot as BusinessSnapshot&{ownerFeePlans?:{percentageBps:number}[]}).ownerFeePlans??null);
   const sold=summarizeResolvedSoldProductCosts(snapshot.breakEvenProductCosts??snapshot.menuItems);
   const sales=days.reduce((sum,d)=>sum+d.netSalesCents,0);
   const monthlyUnits=days.reduce((sum,d)=>sum+d.drinksCount,0);
   const economics:Economics={
    monthlyBills:figure(recovery.monthlyBillsCents,"actual","billsRecorded"),
    monthlyStaff:figure(recovery.monthlyStaffCents,"estimate","laborPartialCoverage"),
    monthlyRevenue:figure(sales,"estimate","monthlyRevenueCovered"),
    ingredientRate:sales? sold.totalCostCents/sales:null,
    feeRate:sales?fees.amountCents/sales:null,
    ingredientStatus:"actual",feeStatus:fees.basis==="actual"?"actual":"estimate",
    averagePriceCents:monthlyUnits?Math.round(sales/monthlyUnits):null,
    monthlyUnits,daysInMonth:snapshot.daysInMonth,targetMargin:.15,missingDays:[],
    asOfDate:snapshot.todayDateStr,observedDays:days,
    observedIngredientCentsOverride:sold.totalCostCents,
    missingIngredientCosts:sold.missingProductCosts,
    ownerFeePlans:(snapshot as BusinessSnapshot&{ownerFeePlans?:{percentageBps:number}[]}).ownerFeePlans??[],
    laborCoveredDays:raw.filter(d=>d.wagesCents!==null).length,laborWindowDays:raw.length,
   };
   const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
   const period={from:snapshot.monthKey+"-01",to:snapshot.todayDateStr};
   const ctx:AgentToolContext={asOf:snapshot.todayDateStr,timezone:snapshot.business.timezone,locale:"en",
    tools:{
     getLaborMetrics:async()=>({available:true as const,value:raw.map(d=>({
       date:d.date,wagesCents:d.wagesCents,staffTaxCents:d.staffTaxCents,
       wageStatus:d.laborWageStatus??"actual",
       loadedStaffCostCents:d.wagesCents===null||d.staffTaxCents===null?
        null:d.wagesCents+d.staffTaxCents,
     })),quality}),
     getBusinessCostSummary:async()=>businessCostSummaryFromSnapshot(snapshot,period),
    } as AgentToolContext["tools"],
    readEconomics:async()=>({economics,items:[],staff:[],
     ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null}),
   };
   const chat=await moneyTools.get_break_even.execute({},ctx);
   const expectedBreakEven=recovery.breakEven.kind==="ready"?
     recovery.breakEven.breakEvenSalesCents:null;
   expect(chat.monthlyBreakEvenCents).toBe(expectedBreakEven);
   expect(chat.drinksPerDay).toBe(plan.drinksNeededPerDay);
   expect(chat.observedProcessingFeesCents).toBe(recovery.observedProcessingFeesCents);
   expect((chat.monthlyLabor as {valueCents:number|null}).valueCents).toBe(recovery.monthlyStaffCents);
   expect((chat.monthlyBills as {valueCents:number|null}).valueCents).toBe(recovery.monthlyBillsCents);
   const laborChat=await staffTools.get_labor.execute({period:"month"},ctx);
   const knownLabor=(laborChat.laborDays as Array<{wagesCents:number|null;staffTaxCents:number|null}>)
     .reduce((sum,day)=>sum+(day.wagesCents??0)+(day.staffTaxCents??0),0);
   expect(knownLabor).toBe(screen.wagesCents!+screen.staffTaxCents!);
   const costChat=await moneyTools.get_cost_summary.execute({period:"month"},ctx);
   expect(costChat.knownTotalCents).toBeGreaterThanOrEqual(0);
   const price=await newItemPriceTools.suggest_new_item_price.execute({
    ingredient_cost_cents:145,category:"drink",packaging_cents:0,item_name:null,ownerInputs:null,
   },ctx);
   expect((price.monthlyLabor as {valueCents:number|null}).valueCents).toBe(recovery.monthlyStaffCents);
   const profit=cafeStateFromSnapshot(snapshot,period);
   expect(profit.profitability.available).toBe(true);
   if(profit.profitability.available)
     expect(profit.profitability.value.ownerProfitCents).toBe(screen.ownerProfitCents);
   if(kind==="sparse_payroll"){
     expect(recovery.monthlyStaffCents).not.toBeNull();
     expect(chat.monthlyLabor.valueCents).not.toBeNull();
     expect(plan.noteKeys).toContain("laborCoveragePartial");
   }
  });
 }
});
