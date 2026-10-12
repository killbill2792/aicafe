import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createSupervisorToolRegistry,type SupervisorToolCall} from "./toolRegistry.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const known=<T>(value:T)=>({available:true as const,value,quality:q});
const unavailable={available:false as const,value:null,quality:{...q,level:"low" as const,missingInputs:["historicalCostUnavailable"]}};
const tools={
 getCurrentStaff:vi.fn(async()=>known({count:2,asOf:"2026-10-10T12:00:00Z",
   people:[{name:"Sam",role:"barista",sourceType:"owner_schedule",sourceProvider:null,
     start:"2026-10-10T08:00:00Z",breakStatus:"ok",isSchedulePrediction:true}]})),
 getRecurringSchedule:vi.fn(async()=>known({source:"owner_recurring_schedule",
   from:"2026-10-12",to:"2026-10-18",shifts:[{displayName:"Sam",dayOfWeek:1,startTime:"09:00",
     endTime:"17:00",effectiveFrom:"2026-10-01",effectiveTo:null}]})),
 getBreakEven:vi.fn(async()=>known({drinksNeededPerDay:80,drinksPerHour:7,todayDrinks:22,
   dailyCostsToCoverCents:13000,averageMoneyLeftPerDrinkCents:165,progressPercent:27})),
 getSalesTrend:vi.fn(async(period:{from:string;to:string})=>
   known([{date:period.from,netSalesCents:period.from==="2026-10-10"?30000:40000,ordersCount:30}])),
 getProfitability:vi.fn(async()=>unavailable),
 getLaborMetrics:vi.fn(async()=>unavailable),
} as unknown as BusinessScopedCafeTools;
const registry=createSupervisorToolRegistry({tools,asOf:"2026-10-10",cafeName:"Sample",
  timezone:"America/Los_Angeles",readRules:async()=>[]});
const execute=(name:SupervisorToolCall["name"],args:Record<string,unknown>,index=1)=>registry({
  name,arguments:args,call_id:"c"+index},index);
const dates=(period:string)=>({period,from:null,to:null});
describe("Read-only domain registry computes grounded facts and trusted insights",()=>{
 it("uses current Staff projection and excludes salary/wage fields",async()=>{
   const result=await execute("get_staff",{view:"current_staffing",...dates("today")});
   expect(result.facts).toContainEqual(expect.objectContaining({label:"People shown on shift by Staff",value:2}));
   expect(result.data).toMatchObject({people:[{name:"Sam",isSchedulePrediction:true}]});
   expect(JSON.stringify(result)).not.toContain("hourlyWage");
 });
 it("returns owner-entered schedule separately from attendance",async()=>{
   const schedule=await execute("get_staff",{view:"schedule",period:"custom",from:"2026-10-12",to:"2026-10-18"});
   expect(schedule.data).toMatchObject({source:"owner_recurring_schedule"});
   expect(schedule.insights.some(x=>x.text.includes("not confirmed attendance"))).toBe(true);
   expect(tools.getRecurringSchedule).toHaveBeenCalled();
 });
 it("projects canonical Break-even without recomputing any ratios in the model",async()=>{
   const r=await execute("get_financials",{metric:"break_even",...dates("today")});
   expect(r.facts).toEqual(expect.arrayContaining([
     expect.objectContaining({label:"Drinks needed per day",value:80}),
     expect.objectContaining({label:"Daily costs to cover",value:13000}),
   ]));
 });
 it("returns unavailable when Break-even view model has missing costs",async()=>{
   vi.mocked(tools.getBreakEven).mockResolvedValueOnce(unavailable as never);
   const r=await execute("get_financials",{metric:"break_even",...dates("today")});
   expect(r.status).toBe("unavailable");
   expect(r.facts).toEqual([]);
 });
 it("computes comparison direction and delta on server with complete sales",async()=>{
   const r=await execute("compare_periods",{metric:"net_sales",
      current_period:"today",current_from:null,current_to:null,
      comparison_period:"yesterday",comparison_from:null,comparison_to:null});
   expect(r.facts).toEqual(expect.arrayContaining([
     expect.objectContaining({id:"t1:difference",value:-10000}),
   ]));
   expect(r.insights[0].text).toContain("decreased");
   expect(r.data).toMatchObject({direction:"down",difference:-10000});
 });
 it("does not invent historical owner profit comparisons",async()=>{
   const r=await execute("compare_periods",{metric:"owner_profit",
     current_period:"today",current_from:null,current_to:null,
     comparison_period:"yesterday",comparison_from:null,comparison_to:null});
   expect(r.facts).toEqual([]);
   expect(r.insights[0].text).toContain("not supported");
 });
 it("control returns a strict non-data intent, not generic advice",async()=>{
   const r=await execute("conversation_control",{intent:"unsupported"});
   expect(r.control).toBe("unsupported");
   expect(r.facts).toHaveLength(0);
 });
 it("counts active menu offerings without item-level sales coverage",async()=>{
   const catalog=[{id:"a",name:"Latte",active:true,category:"drink",priceCents:550},
     {id:"b",name:"Mocha",active:false,category:"drink",priceCents:600}];
   const local=createSupervisorToolRegistry({tools:{...tools,getMenuCatalog:async()=>known(catalog)} as unknown as BusinessScopedCafeTools,
     asOf:"2026-10-10",cafeName:"Sample",timezone:"America/Los_Angeles",readRules:async()=>[]});
   const r=await local({name:"get_menu",arguments:{view:"active_count",scope:"active",product_name:null,limit:10},call_id:"menu"},1);
   expect(r.facts).toEqual(expect.arrayContaining([expect.objectContaining({label:"Active menu products",value:1})]));
 });
 it("distinguishes verified-zero reviews from missing-input blocked products",async()=>{
   const product={id:"a",name:"Latte"};
   const pricing=(status:string,missingInputs:string[]=[]):Record<string,unknown>=>({
     status,recommendedPriceCents:status==="REVIEW_PRICE"?650:null,
     calculationMode:"BENCHMARK",dataQuality:{...q,missingInputs}
   });
   const evaluate=async(rec:Record<string,unknown>)=>{
     const local=createSupervisorToolRegistry({tools:{...tools,getCafeSummary:async()=>({
       products:known([product]),pricingRecommendations:known({a:rec})
     })} as unknown as BusinessScopedCafeTools,
       asOf:"2026-10-10",cafeName:"Sample",timezone:"America/Los_Angeles",readRules:async()=>[]});
     return local({name:"get_pricing",arguments:{product_name:null,limit:10},call_id:"pricing"},1);
   };
   const zero=await evaluate(pricing("KEEP_PRICE"));
   expect(zero.facts).toEqual(expect.arrayContaining([expect.objectContaining({label:"Verified review-ready price changes",value:0})]));
   expect(zero.insights.some(i=>i.text.includes("No verified review-ready"))).toBe(true);
   const blocked=await evaluate(pricing("PRICE_UNAVAILABLE",["ingredientCost"]));
   expect(blocked.status).toBe("partial");
   expect(blocked.facts).toEqual(expect.arrayContaining([expect.objectContaining({label:"Products blocked by missing pricing inputs",value:1})]));
   expect(blocked.insights.some(i=>i.text.includes("No verified review-ready"))).toBe(false);
   const review=await evaluate(pricing("REVIEW_PRICE"));
   expect(review.facts).toEqual(expect.arrayContaining([expect.objectContaining({label:"Latte recommended price (review only)",value:650})]));
 });

});

describe("Explicit item-sales coverage and natural staffing notice",()=>{
  it("fails closed even if rows exist but independent canonical item coverage is unproven",async()=>{
    const local=createSupervisorToolRegistry({
      tools:{...tools,
        getProductSales:async()=>known([{name:"Latte",category:"drink",units:5}]),
        getItemSalesCoverage:async()=>unavailable,
      } as unknown as BusinessScopedCafeTools,
      asOf:"2026-10-10",cafeName:"Sample",timezone:"America/Los_Angeles",readRules:async()=>[],
    });
    const result=await local({name:"get_sales",arguments:{
      metric:"distinct_products",group_by:"total",period:"today",from:null,to:null,
      category:"all",product_name:null,sort:"highest",limit:10,
    },call_id:"coverage"},1);
    expect(result.status).toBe("unavailable");
    expect(result.facts).toEqual([]);
    expect(result.missingInputs).toContain("itemSalesCoverageNotProven");
  });
  it("qualifies staffing only when a person is a schedule prediction",async()=>{
    const projected=await execute("get_staff",{view:"current_staffing",...dates("today")});
    expect(projected.insights.some(x=>x.text.includes("based on the schedule rather than a recorded clock-in"))).toBe(true);
    const local=createSupervisorToolRegistry({tools:{...tools,
      getCurrentStaff:async()=>known({count:1,people:[{
        name:"Sam",role:"barista",breakStatus:"ok",isSchedulePrediction:false,
      }]}),
    } as unknown as BusinessScopedCafeTools,
      asOf:"2026-10-10",cafeName:"Sample",timezone:"America/Los_Angeles",readRules:async()=>[],
    });
    const recorded=await local({name:"get_staff",
      arguments:{view:"current_staffing",...dates("today")},call_id:"present"},1);
    expect(recorded.insights.some(x=>x.text.includes("schedule rather than"))).toBe(false);
  });
});
