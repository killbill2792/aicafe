import {describe,it,expect,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {executeAgentTool,type AgentToolContext} from "./tools";
import {staffTools} from "./tools/staff";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {buildProfitAndCostsViewModel} from "@/lib/viewmodels/moneyViewModel";
import {todayReadingFreshness} from "./tools/today";

const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const unavailable={available:false as const,value:null,
  quality:{...quality,level:"low" as const,missingInputs:["noCoveredSalesRows"]}};
const profile='Café profile (authenticated, not owner message): {"name":"Seiyun Yemeni Coffee","city":"San Jose","region":"California","country":"US","currency":"USD","timezone":"America/Los_Angeles"}' + ". For events, use saved get_events/get_nearby_events for this city; never ask the owner for a city already in the profile.";
const context=():AgentToolContext=>({
  asOf:"2026-11-03",timezone:"America/Los_Angeles",locale:"en",currency:"USD",
  tools:{getSalesTrend:vi.fn(async()=>unavailable)} as unknown as AgentToolContext["tools"],
});
const completion={type:"response.completed",response:{usage:{
  input_tokens:20,output_tokens:4,input_tokens_details:{cached_tokens:0}}}};

describe("Supervisor owner demo: shared model and core metric paths",()=>{
  it.each(["web","WhatsApp"])("%s sees the authenticated café profile before the owner question",async channel=>{
    const seen:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function* (params){
      seen.push(params);
      yield {type:"response.output_text.delta",delta:"Nearby saved events are available."};
      yield completion;
    };
    const answer=await runAgentTurn({ownerText:"What events are near my café?",
      context:context(),cafeProfile:profile,provider});
    const input=seen[0].input as Array<{role:string;content:string}>;
    expect(channel).toMatch(/web|WhatsApp/);
    expect(input.some(i=>i.role==="developer"&&i.content===profile)).toBe(true);
    expect(input.at(-1)).toEqual({role:"user",content:"What events are near my café?"});
    expect(answer.text).toContain("Nearby saved events");
  });

  it("labels stale Today data with a local last-updated time",()=>{
    const now=new Date("2026-11-03T22:20:00Z");
    const old=todayReadingFreshness("2026-11-03T21:40:00Z","America/Los_Angeles","en",now);
    const fresh=todayReadingFreshness("2026-11-03T22:16:00Z","America/Los_Angeles","en",now);
    expect(old).toMatchObject({stale:true,lastUpdated:"13:40",freshnessLabel:"last updated 13:40"});
    expect(fresh).toMatchObject({stale:false,freshnessLabel:null});
  });
  it("matches Money's staff ratio with the same calendar days and saved payroll extras",async()=>{
    const base=getFixtureSnapshot();
    const rows=[
      {...base.monthActualDays[0],date:"2026-11-02",netSalesCents:430000,
        wagesCents:110000,staffTaxCents:7300,laborWageStatus:"actual" as const},
      {...base.monthActualDays[0],date:"2026-11-03",netSalesCents:435325,
        wagesCents:120000,staffTaxCents:7995,laborWageStatus:"actual" as const},
    ];
    const snapshot={...base,todayDateStr:"2026-11-03",monthKey:"2026-11",daysInMonth:30,
      monthActualDays:rows,monthRecordedDays:rows,last7Days:rows,last28Days:rows,
      todayDay:rows[1],todayHasData:true,previousMonthDays:[],
      ownerMonthlyPayrollExtrasCents:30000};
    const money=buildProfitAndCostsViewModel(snapshot,"month");
    const ctx=context();
    ctx.tools.getSalesTrend=vi.fn(async()=>({available:true,quality,
      value:rows.map(d=>({date:d.date,netSalesCents:d.netSalesCents}))} as never));
    ctx.tools.getLaborMetrics=vi.fn(async()=>({available:true,quality,
      value:rows.map(d=>({date:d.date,wagesCents:d.wagesCents,
        staffTaxCents:d.staffTaxCents,loadedStaffCostCents:d.wagesCents!+d.staffTaxCents!,
        wageStatus:"actual" as const}))} as never));
    ctx.tools.getOwnerMonthlyPayrollExtras=vi.fn(async()=>({available:true,quality,
      value:{monthlyCents:30000}} as never));
    const chat=await staffTools.get_labor.execute({period:"month"},ctx);
    expect(money.ownerPayrollExtrasCents).toBe(3000);
    expect(chat.laborCostPercentKnownLaborCents).toBe(
      rows.reduce((sum,d)=>sum+d.wagesCents!+d.staffTaxCents!,0)+money.ownerPayrollExtrasCents);
    expect(chat.laborCostPercentSalesCents).toBe(money.salesCents);
    expect(chat.laborCostPercent).toBe(money.staffRatio);
    expect(chat.laborCostPercentPartial).toBe(true);
  });

  it("uses saved city events to answer without asking for location or searching the web",async()=>{
    const webSearch=vi.fn();
    const savedEvents=vi.fn(async()=>({
      events:[{id:"event-1",name:"Downtown Market",startDate:"2026-11-08",endDate:"2026-11-08"}],
      plans:[],cityCatalog:{available:false,items:[],total:0,page:0,pageSize:25,
        hasMore:false,missing:"unresearched"},
    }));
    const ctx=context();
    ctx.savedEvents=savedEvents as AgentToolContext["savedEvents"];
    ctx.webSearch=webSearch;
    const seen:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function* (params){
      seen.push(params as Record<string,unknown>);
      if(seen.length===1)yield {type:"response.output_item.done",item:{
        type:"function_call",name:"get_events",arguments:JSON.stringify({
          from:"2026-11-03",to:"2026-11-16",cityEventId:null}),call_id:"city-1"}};
      else yield {type:"response.output_text.delta",
        delta:"Near your café in San Jose: Downtown Market on November 8."};
      yield completion;
    };
    const answer=await runAgentTurn({ownerText:"Events near my café?",context:ctx,cafeProfile:profile,provider});
    expect(savedEvents).toHaveBeenCalledWith("2026-11-03","2026-11-16");
    expect(webSearch).not.toHaveBeenCalled();
    expect(answer.text).toContain("San Jose: Downtown Market");
    expect(answer.text).not.toMatch(/what city|which neighborhood/i);
    expect(JSON.stringify(seen[0].input)).toContain("never ask the owner for a city");
  });
  it("get_sales and its day list use the same provisional saved Today reading",async()=>{
    const ctx=context();
    ctx.readTodaySoFar=vi.fn(async()=>({available:true,value:{
      provisional:true,businessDate:"2026-11-03",readAt:"2026-11-03T19:00:00Z",
      netSalesCents:125396,grossSalesCents:125396,discountsCents:0,
      refundsCents:0,tipCents:0,orders:92,openChecks:7,
      unparsedOrders:0,topItems:[],locationsRead:1,locationsFailed:0,truncated:false,
    }} as never));
    const result=await executeAgentTool("get_sales",{period:"today"},ctx);
    expect(result.netSalesCents).toBe(125396);
    expect(result.provisional).toBe(true);
    expect(result.days).toEqual([{date:"2026-11-03",netSalesCents:125396,provisional:true}]);
    expect(result.readAt).toBe("2026-11-03T19:00:00Z");
  });
  it("get_labor returns a percentage calculated by the existing core, with covered days",async()=>{
    const ctx=context();
    ctx.tools.getSalesTrend=vi.fn(async()=>({available:true,quality,value:[
      {date:"2026-11-02",netSalesCents:865325},
    ]} as never));
    ctx.tools.getLaborMetrics=vi.fn(async()=>({available:true,quality,value:[
      {date:"2026-11-02",wagesCents:230000,staffTaxCents:15295,
        loadedStaffCostCents:245295,wageStatus:"actual"},
    ]} as never));
    const result=await staffTools.get_labor.execute({period:{from:"2026-11-02",to:"2026-11-03"}},ctx);
    expect(result.laborCostPercent).toBeCloseTo(245295/865325,8);
    expect(result.laborCostPercentKnownLaborCents).toBe(245295);
    expect(result.laborCostPercentSalesCents).toBe(865325);
    expect(result.laborCostPercentCoveredDays).toBe(1);
    expect(result.laborCostPercentSalesDays).toBe(1);
    expect(result.laborCostPercentPartial).toBe(true);
    expect(result.laborCostPercentDisplay).toBe("28.3%");
  });
});
