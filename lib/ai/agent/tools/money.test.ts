import { describe,expect,it } from "vitest";
import { moneyTools } from "./money";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {businessCostSummaryFromSnapshot} from "@/lib/operating/businessCosts";
import {newResolveState} from "../resolve";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import type { AgentToolContext } from "./index";
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const unavailable={available:false as const,value:null,quality:{...q,missingInputs:["missingSource"]}};
function ctx(extra:Partial<AgentToolContext["tools"]>):AgentToolContext{
  return {asOf:"2026-10-22",timezone:"America/Los_Angeles",locale:"en",tools:{
    getProfitability:async()=>unavailable,getSalesTrend:async()=>unavailable,
    getMenuCatalog:async()=>unavailable,...extra}};
}
describe("Leo scoped money reads",()=>{
  it("fails closed instead of using old Supervisor economics without canonical snapshot",async()=>{
    const economics:Economics={
      monthlyBills:figure(30000,"actual","rent"),monthlyStaff:figure(30000,"actual","payroll"),
      monthlyRevenue:figure(100000,"actual","recorded"),ingredientRate:.1,feeRate:.02,
      ingredientStatus:"actual",feeStatus:"actual",averagePriceCents:500,monthlyUnits:200,
      daysInMonth:31,targetMargin:.15,missingDays:[],
    };
    const context:AgentToolContext={...ctx({}),readEconomics:async()=>({
      economics,items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,
      ownerIngredientRate:null,
    })};
    for(const raw of [
      {},
      {ownerIngredientPackagingPercent:20,ownerProcessingFeePercent:3},
      {ownerNetSalesCents:200000,ownerSalesDays:2},
      {period:"today"},
      {period:"month_to_date"},
    ]){
      const result=await moneyTools.get_break_even.execute(raw,context);
      expect(result.missing).toContain("canonicalBreakEvenUnavailable");
      expect(result.monthlyBreakEvenCents).toBeNull();
      expect(result.periodBreakEvenCents).toBeNull();
      expect(result.dailyBreakEvenCents).toBeNull();
      expect(result.explain).toEqual([]);
    }
  });
  it("get_cost_summary renders the ledger label in EN ES and AR",async()=>{
    const snapshot=getFixtureSnapshot();
    const observed=businessCostSummaryFromSnapshot(snapshot,{from:snapshot.monthKey+"-01",to:snapshot.todayDateStr});
    const sum=Object.values(observed.components).reduce((total,n)=>total+n,0);
    const source={...observed,completeness:"complete" as const,knownTotalCents:sum,
      observed:{ingredients:true,loadedStaff:true,cardFees:true,runningCosts:true},
      estimatedInputs:[]};
    for(const [locale,label] of [["en","Recorded business costs"],["es","Costes del negocio registrados"],["ar","تكاليف العمل المسجلة"]] as const){
      const c={...ctx({getBusinessCostSummary:async()=>source}),locale,currency:"EUR"};
      const answer=await moneyTools.get_cost_summary.execute({period:"month"},c);
      const lines=answer.explain as Array<{label:string;inputs:Array<{name:string}>}>;
      expect(lines[0].label).toBe(label);
      if(locale!=="en")expect(lines[0].inputs.map(x=>x.name)).not.toContain("ingredients");
    }
  });
  it("does not quietly use UTC when café timezone is unavailable",async()=>{
    const missingZone={...ctx({}),timezone:undefined} as unknown as AgentToolContext;
    const expense=await moneyTools.get_expenses.execute(
      {period:"month",category:null},missingZone);
    const costs=await moneyTools.get_cost_summary.execute(
      {period:"month"},missingZone);
    expect(expense.missing).toContain("cafeTimezoneMissing");
    expect(costs.missing).toContain("cafeTimezoneMissing");
    expect(expense.period).toBeNull();
    expect(costs.period).toBeNull();
  });
  it("allows only the category selected in the previous trusted clarification",async()=>{
    const state=newResolveState("Supplies — supplies",[
      {role:"assistant",content:"Asked: Which category? Options: Supplies — supplies (supplies); Supplies — other (other)"}]);
    const c=ctx({
      getRecordedExpenses:async()=>({available:true,value:{totalCents:120000},quality:q}),
      getExpenseSummary:async()=>({available:true,value:[
        {label:"Supplies",categoryCode:"supplies",amountCents:20000,isEstimate:false,isMissing:false},
        {label:"Supplies",categoryCode:"other",amountCents:15000,isEstimate:false,isMissing:false}],quality:q}),
    });
    c.resolveState=state;
    const response=await moneyTools.get_expenses.execute({period:"month",category:"supplies"},c);
    expect(response.needsOwnerChoice).toBeUndefined();
    expect(response.categories).toEqual([expect.objectContaining({categoryCode:"supplies"})]);
    expect(response.recordedActualTotalCents).toBeNull();
  });
  it("does not replace a named category with all-business expenses if categories are unavailable",async()=>{
    const r=await moneyTools.get_expenses.execute({period:"month",category:"Rent"},ctx({
      getRecordedExpenses:async()=>({available:true,value:{totalCents:150000},quality:q}),
      getExpenseSummary:async()=>unavailable,
    }));
    expect(r.recordedActualTotalCents).toBeNull();
    expect(r.categories).toBeNull();
    expect(r.missing).toContain("missingSource");
  });
  it("never presents the all-category actual total as a selected category's spending",async()=>{
    const r=await moneyTools.get_expenses.execute({period:"month",category:"Rent"},ctx({
      getRecordedExpenses:async()=>({available:true,value:{totalCents:150000},quality:q}),
      getExpenseSummary:async()=>({available:true,value:[
        {label:"Rent",categoryCode:"rent",amountCents:50000,isEstimate:true,isMissing:false},
        {label:"Utilities",categoryCode:"utilities_power",amountCents:10000,isEstimate:false,isMissing:false}],quality:q}),
    }));
    expect(r.recordedActualTotalCents).toBeNull();
    expect(r.missing).toContain("categoryRecordedActualTotalUnavailable");
    expect(r.categories).toEqual([expect.objectContaining({categoryCode:"rent",amountCents:50000})]);
  });
  it("asks when multiple categories have an identical owner-facing name",async()=>{
    const r=await moneyTools.get_expenses.execute({period:"month",category:"Supplies"},ctx({
      getRecordedExpenses:async()=>({available:true,value:{totalCents:120000},quality:q}),
      getExpenseSummary:async()=>({available:true,value:[
        {label:"Supplies",categoryCode:"supplies",amountCents:20000,isEstimate:false,isMissing:false},
        {label:"Supplies",categoryCode:"other",amountCents:15000,isEstimate:false,isMissing:false}],quality:q}),
    }));
    expect(r.needsOwnerChoice).toBe(true);
    expect((r.candidates as Array<{id:string}>).map(c=>c.id)).toEqual(["supplies","other"]);
  });

  it("does not call recurring bills recorded expenses",async()=>{
    const r=await moneyTools.get_expenses.execute({period:"month",category:null},ctx({
      getRecordedExpenses:async()=>({available:true,value:{totalCents:2500},quality:q}),
      getExpenseSummary:async()=>({available:true,value:[
        {label:"Rent",categoryCode:"rent",amountCents:45000,isEstimate:true,isMissing:false}],quality:q}),
    }));
    expect(r.recordedActualTotalCents).toBe(2500);
    expect(r.categories).toHaveLength(1);
    expect(r.agentId).toBe("leo");
  });
  it("represents unknown bills as null",async()=>{
    const r=await moneyTools.get_bills.execute({},ctx({getMonthlyBills:async()=>unavailable}));
    expect(r.monthlyEquivalentCents).toBeNull();
  });
  it("never calls legacy fixed-cost, payroll or break-even readers without the canonical snapshot",async()=>{
    let called=0;
    const r=await moneyTools.get_break_even.execute({
      ownerNetSalesCents:1100000,ownerSalesDays:22,
      ownerIngredientPackagingPercent:20,ownerProcessingFeePercent:3,
    },ctx({
      getBreakEven:async()=>{called++;return {available:true,
        value:{dailyCostsToCoverCents:70724},quality:q};},
      getBusinessCostSummary:async()=>{called++;throw Error("Legacy fallback must not run");},
      getOwnerMonthlyPayrollExtras:async()=>{called++;throw Error("Legacy fallback must not run");},
    }));
    expect(called).toBe(0);
    expect(r.status).toBe("missing");
    expect(r.missing).toContain("canonicalBreakEvenUnavailable");
    expect(r.numberEstimates).toBeUndefined();
    expect(r.dailyBreakEvenCents).toBeNull();
  });
  it("returns a missing rather than invented break-even for each requested period",async()=>{
    const absent=ctx({});
    for(const [name,to] of [["month","2026-10-31"],["month_to_date","2026-10-22"],
      ["today","2026-10-22"]] as const){
      const r=await moneyTools.get_break_even.execute({period:name},absent);
      expect(r.period).toEqual({from:name==="today"?"2026-10-22":"2026-10-01",to});
      expect(r.periodBreakEvenCents).toBeNull();
      expect(r.missing).toContain("canonicalBreakEvenUnavailable");
    }
  });
  it("reports unobserved cost components as null instead of confirmed zero",async()=>{
    const result=await moneyTools.get_cost_summary.execute({period:"month"},ctx({
      getBusinessCostSummary:async p=>({
        period:p,knownTotalCents:10000,completeness:"partial",
        components:{ingredientsCents:10000,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
        observed:{ingredients:true,loadedStaff:false,cardFees:false,runningCosts:false},
        missingInputs:["staffCostsUnobserved"],estimatedInputs:[],
        coverage:{salesDays:2,laborDays:0,expectedDays:22,missingProductCostCount:0,
          itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
          historicalIngredientCostsProven:false,soldProductIds:[],
          missingProductCostIds:[],estimatedProductCostIds:[],missingFeeDays:2,
          missingOperatingCategories:[]},
      }),
    }));
    expect(result.components).toEqual({
      ingredientsCents:10000,loadedStaffCents:null,cardFeesCents:null,runningCostsCents:null,
    });
    expect(result.missing).toContain("staffCostsUnobserved");
  });
  it("rejects input containing a business id",async()=>{
    await expect(moneyTools.get_bills.execute({businessId:"other"},ctx({}))).rejects.toThrow();
  });
});


describe("AI known-only wages are not verified zero labor",()=>{
  it("exposes known subtotal as partial, but hides the incomplete labor component",async()=>{
    const fixture=getFixtureSnapshot();
    const day=fixture.monthActualDays[0];
    const days=fixture.monthActualDays.map(d=>d.date===day.date?{
      ...d,wagesCents:0,staffTaxCents:0,laborWageStatus:"missing" as const}:d);
    const snapshot={...fixture,monthRecordedDays:days,monthActualDays:days};
    const summary=businessCostSummaryFromSnapshot(snapshot,{
      from:fixture.monthKey+"-01",to:fixture.todayDateStr});
    expect(summary.completeness).toBe("partial");
    expect(summary.observed.loadedStaff).toBe(false);
    const response=await moneyTools.get_cost_summary.execute({period:"month"},
      ctx({getBusinessCostSummary:async()=>summary}));
    expect(response.completeness).toBe("partial");
    expect((response.components as {loadedStaffCents:number|null}).loadedStaffCents).toBeNull();
    expect(response.missing).toContain("laborWageUnknown:"+day.date);
  });
});
