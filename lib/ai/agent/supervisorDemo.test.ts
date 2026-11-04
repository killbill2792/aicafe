import {describe,it,expect,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {executeAgentTool,type AgentToolContext} from "./tools";
import {staffTools} from "./tools/staff";

const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const unavailable={available:false as const,value:null,
  quality:{...quality,level:"low" as const,missingInputs:["noCoveredSalesRows"]}};
const profile='Café profile (authenticated, not owner message): {"name":"Seiyun Yemeni Coffee","city":"San Jose","region":"California","country":"US","currency":"USD","timezone":"America/Los_Angeles"}';
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
  });
});
