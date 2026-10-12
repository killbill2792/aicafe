import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {cafeStateFromSnapshot} from "@/lib/operating/cafeState";
import {createSupervisorToolRegistry} from "./toolRegistry.server";
import {validateSupervisorFinal} from "./runSupervisorTurn.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import type {RequestedGoal} from "./requestScope";
import type {BusinessSnapshot} from "@/lib/data/types";
import type {DataQuality} from "@/lib/calc";

const fixture=getFixtureSnapshot();
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const known=<T>(value:T,quality:DataQuality=q)=>({available:true as const,value,quality});
const unavailable=<T>()=>({available:false as const,value:null as T|null,
  quality:{...q,level:"low" as const,missingInputs:["notVerified"]}});
const run=async(tools:Record<string,unknown>,name:"get_financials"|"get_staff"|"get_menu"|"get_pricing"|"get_sales"|"get_team",
  args:Record<string,unknown>,index=1)=>{
  const f=createSupervisorToolRegistry({tools:tools as unknown as BusinessScopedCafeTools,
    asOf:"2026-09-09",cafeName:"Sample",timezone:"America/Los_Angeles",readRules:async()=>[],locale:"en"});
  return f({name,arguments:args,call_id:"c"+index},index);
};
const dates={period:"month_to_date",from:null,to:null};
const goal=(domain:RequestedGoal["domain"]):RequestedGoal=>({
  domain,period:"month_to_date",from:null,to:null,
  comparison_period:null,comparison_from:null,comparison_to:null,
});
describe("Supervisor canonical domain availability contract matrix",()=>{
 const sales=(metric:"net_sales"|"orders"="net_sales")=>({metric,group_by:"total",
   ...dates,category:"all",product_name:null,sort:"highest",limit:10});
 it("sales positive, verified zero, partial, unavailable",async()=>{
   const days=fixture.monthActualDays;
   for(const [value,quality,expected] of [
     [days.map((d,i)=>({...d,netSalesCents:i===0?2500:0})),q,"verified"],
     [days.map(d=>({...d,netSalesCents:0,ordersCount:0})),q,"verified"],
     [[{...days[0],netSalesCents:1000}],{...q,missingInputs:["salesCoverage:1/9"]},"partial"],
   ] as const){
     const result=await run({getSalesTrend:async()=>known(value as unknown as typeof days,quality as unknown as DataQuality)},
       "get_sales",sales());
     expect(result.status).toBe(expected);
     expect(result.facts[0].value).toBe(value.reduce((n,d)=>n+d.netSalesCents,0));
   }
   const missing=await run({getSalesTrend:async()=>unavailable()},"get_sales",sales());
   expect(missing.status).toBe("unavailable");
   expect(missing.facts).toHaveLength(0);
 });
 it("staff loaded cost full, partial, zero, unavailable",async()=>{
   const rows=fixture.monthActualDays.map(d=>({
     date:d.date,wagesCents:100,staffTaxCents:0,loadedStaffCostCents:100,
   }));
   const labor=()=>({...dates,view:"labor_cost"});
   for(const [dayRows,expected] of [[rows,"verified"],[rows.slice(0,2),"partial"],
     [rows.map(d=>({...d,wagesCents:0,loadedStaffCostCents:0})),"verified"]] as const){
     const result=await run({getLaborMetrics:async()=>known(dayRows)},"get_staff",labor());
     expect(result.status).toBe(expected);
     expect(result.facts).toContainEqual(expect.objectContaining({value:dayRows.reduce((n,d)=>n+d.loadedStaffCostCents,0)}));
   }
   const missing=await run({getLaborMetrics:async()=>unavailable()},"get_staff",labor());
   expect(missing.status).toBe("unavailable");
 });
 it("menu count supports positive and verified zero",async()=>{
   for(const count of [12,0]){
     const catalog=Array.from({length:count},(_,i)=>({
       id:"item"+i,name:"Menu "+i,category:"drink",active:true,priceCents:300,
     }));
     const result=await run({getMenuCatalog:async()=>known(catalog)},"get_menu",
       {view:"active_count",scope:"active",product_name:null,limit:10});
     expect(result.facts).toContainEqual(expect.objectContaining({value:count}));
   }
 });
 it("monthly bills complete, estimated, missing and recorded actual spending zero/missing",async()=>{
   for(const [estimated,status] of [[false,"verified"],[true,"estimated"]] as const){
     const bills=known({totalCents:75000},estimated?{...q,estimatedInputs:["expense:rent"]}:q);
     const result=await run({getMonthlyBills:async()=>bills},"get_financials",
       {...dates,metric:"monthly_bills"});
     expect(result.status).toBe(status);
     expect(result.facts).toContainEqual(expect.objectContaining({value:75000}));
   }
   const missing=await run({getMonthlyBills:async()=>unavailable()},"get_financials",
     {...dates,metric:"monthly_bills"});
   expect(missing.status).toBe("unavailable");
   for(const amount of [5000,0]){
     const r=await run({getRecordedExpenses:async()=>known({totalCents:amount})},
       "get_financials",{...dates,metric:"recorded_spending"});
     expect(r.facts).toContainEqual(expect.objectContaining({value:amount}));
   }
   expect((await run({getRecordedExpenses:async()=>unavailable()},
     "get_financials",{...dates,metric:"recorded_spending"})).status).toBe("unavailable");
 });
 it("break-even ready vs canonical unavailable reasons",async()=>{
   const ready=await run({getBreakEven:async()=>known({drinksNeededPerDay:50,drinksPerHour:5,
     todayDrinks:0,dailyCostsToCoverCents:8000,averageMoneyLeftPerDrinkCents:150})},
     "get_financials",{...dates,metric:"break_even"});
   expect(ready.status).toBe("verified");
   expect(ready.facts).toContainEqual(expect.objectContaining({value:0}));
   for(const reason of ["NOT_ENOUGH_SALES","MISSING_BILLS","MISSING_PRODUCT_COSTS",
     "MISSING_PROCESSING_FEES","VARIABLE_COSTS_TOO_HIGH"]){
     const result=await run({getBreakEven:async()=>({
       ...unavailable(),quality:{...q,level:"low" as const,missingInputs:[reason]},
     })},"get_financials",{...dates,metric:"break_even"});
     expect(result.status).toBe("unavailable");
     expect(result.missingInputs).toContain(reason);
   }
 });
 it("Team needs_owner, needs_response, verified zero and exact same-page task href",async()=>{
   for(const status of ["needs_owner","needs_response"] as const){
     const task={id:"task-123",agentId:"alex",kind:"price_review",status,
       businessId:"trusted-fixture",payload:{itemName:"Latte"},evidence:[],
       confidence:"high",createdAt:"2026-09-09T10:00:00Z"};
     const result=await run({getTeamTasks:async()=>known([task])},"get_team",
       {view:"tasks",status:"needs_you",agent:"all",limit:5});
     expect(result.tasks).toContainEqual(expect.objectContaining({taskId:"task-123",status,
       href:expect.stringContaining("task=task-123")}));
     expect(result.facts).toContainEqual(expect.objectContaining({value:1}));
   }
   const empty=await run({getTeamTasks:async()=>known([])},"get_team",
     {view:"tasks",status:"needs_you",agent:"all",limit:5});
   expect(empty.status).toBe("verified");
   expect(empty.facts).toContainEqual(expect.objectContaining({value:0}));
 });
 it("pricing review-ready, keep, blocked, mixed and zero revisions with blocked",async()=>{
   const item={id:"a",name:"Latte",costStatus:"NO_RECIPE"};
   const rec=(status:string,missing:string[]=[])=>({status,
     recommendedPriceCents:status==="REVIEW_PRICE"?600:null,
     dataQuality:{...q,missingInputs:missing},calculationMode:"BENCHMARK"});
   for(const [products,expectedReview,expectedBlocked] of [
     [[rec("REVIEW_PRICE")],1,0],[[rec("KEEP_CURRENT_PRICE")],0,0],
     [[rec("PRICE_UNAVAILABLE",["ingredientCost"])],0,1],
     [[rec("REVIEW_PRICE"),rec("PRICE_UNAVAILABLE",["ingredientCost"])],1,1],
   ] as const){
     const catalog=products.map((_,i)=>({...item,id:"p"+i,name:"Menu "+i}));
     const recommendations=Object.fromEntries(products.map((p,i)=>["p"+i,p]));
     const result=await run({getCafeSummary:async()=>({
       products:known(catalog),pricingRecommendations:known(recommendations),
     })},"get_pricing",{product_name:null,limit:10});
     expect(result.facts).toContainEqual(expect.objectContaining({id:"t1:pricingCount",value:expectedReview}));
     expect(result.data).toMatchObject({blocked:expectedBlocked});
     if(expectedBlocked)expect(result.status).toBe("partial");
   }
 });
});
describe("Exact four-part question delivers known cost, staff, menu and pricing without losing a clause",()=>{
 it("correctly labels partial cost and preserves all four evidence-based goals",async()=>{
   const products=Array.from({length:12},(_,i)=>({
     ...fixture.menuItems[0],id:"menu-"+i,name:"Product "+i,
     active:true,costStatus:"NO_RECIPE" as const,quantitySoldLast28Days:2,
   }));
   const snapshot:BusinessSnapshot={...fixture,menuItems:products,
     allCostProducts:products,
     // Twelve actual participating products IN the requested MTD period.
     // Rolling 28-day menu quantities are never used as coverage evidence.
     periodItemSales:{period:{from:"2026-09-01",to:"2026-09-09"},covered:true,
       soldItems:products.map(p=>({id:p.id,units:2}))},
   };
   const state=cafeStateFromSnapshot(snapshot,undefined,[]);
   const staffRows=fixture.monthActualDays.map((d,i)=>({
     date:d.date,wagesCents:i===0?400224:0,staffTaxCents:0,
     loadedStaffCostCents:i===0?400224:0,
   }));
   const tools={
     getBusinessCostSummary:async()=>state.businessCosts,
     getProfitability:async()=>state.profitability,
     getLaborMetrics:async()=>known(staffRows),
     getMenuCatalog:async()=>known(products.map(p=>({
       id:p.id,name:p.name,category:p.category,priceCents:p.priceCents,active:true,
     }))),
     getCafeSummary:async()=>state,
   } as unknown as BusinessScopedCafeTools;
   const registry=createSupervisorToolRegistry({tools,asOf:"2026-09-09",cafeName:"Fixture",
     timezone:"America/Los_Angeles",readRules:async()=>[],locale:"en"});
   const calls=[
     {name:"get_financials" as const,arguments:{metric:"total_business_costs",...dates},call_id:"cost"},
     {name:"get_staff" as const,arguments:{view:"labor_cost",...dates},call_id:"staff"},
     {name:"get_menu" as const,arguments:{view:"active_count",scope:"active",product_name:null,limit:10},call_id:"menu"},
     {name:"get_pricing" as const,arguments:{product_name:null,limit:10},call_id:"pricing"},
   ];
   const results=await Promise.all(calls.map((c,i)=>registry(c,i+1)));
   expect(results.map(r=>r.status)).toEqual(["partial","verified","verified","partial"]);
   const reply=validateSupervisorFinal({headline:"Here is the recorded picture",
     summary:"Based on the available café records",
     fact_ids:[],task_ids:[],insight_ids:[],evidence_refs:[]},results,
     calls.map(c=>c.name),"en",(["total_business_costs","staff_cost","menu_count","pricing_review"] as const).map(goal),
     calls);
   const facts=reply.blocks.filter(b=>b.type==="metric"||b.type==="count");
   expect(facts).toEqual(expect.arrayContaining([
     expect.objectContaining({type:"metric",label:"Known business costs — month to date",
       valueCents:state.businessCosts.knownTotalCents}),
     expect.objectContaining({type:"metric",label:"Staff cost — month to date",valueCents:400224}),
     expect.objectContaining({type:"count",label:"Products on your menu",value:12}),
     expect.objectContaining({type:"count",label:"Verified price changes",value:0}),
   ]));
   const text=reply.blocks.filter(b=>b.type==="text").map(b=>b.text).join(" ");
   expect(text).toContain("Product/ingredient costs are incomplete for 12 products.");
   expect(text).toContain("12 / 12 still need complete cost/pricing data");
   expect(text).not.toContain("Total business costs: Unable to verify");
   expect(reply.status).toBe("partial");
   expect(state.profitability.available).toBe(false);
 });
});
