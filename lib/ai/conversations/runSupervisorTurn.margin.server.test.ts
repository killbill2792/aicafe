/** Compatibility-only regression suite. Default conversational runtime acceptance
 * is in lib/ai/supervisor/investigation/runInvestigation.server.test.ts. */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { runLegacySupervisorTurn as runSupervisorTurn, validateSupervisorFinal } from "./runSupervisorTurn.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { RequestedGoal } from "./requestScope";

const asOf="2026-10-16";
const goal=(period:RequestedGoal["period"]="month_to_date",from:string|null=null,to:string|null=null):RequestedGoal=>({
  domain:"profit_margin",period,from,to,
  comparison_period:null,comparison_from:null,comparison_to:null,
});
const call=(name:string,args:object,id:string)=>({
  type:"function_call",name,arguments:JSON.stringify(args),call_id:id,
});
const output=(items:unknown[])=>new Response(JSON.stringify({
  status:"completed",model:"gpt-6-luna",usage:{input_tokens:70,output_tokens:40},output:items,
}),{status:200});
const message=(payload:object)=>({type:"message",content:[{type:"output_text",text:JSON.stringify(payload)}]});
const done=()=>message({headline:"Here is what I found",summary:"Based on the available café records",
  fact_ids:[],task_ids:[],insight_ids:[],evidence_refs:[]});
const high={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const testBase={text:"What's my profit margin for that August 22 and September 4?",
  locale:"en" as const,asOf,cafeName:"Test Café",timezone:"America/Los_Angeles",
  history:[],readRules:async()=>[],
};
let key:string|undefined;
beforeAll(()=>{key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="mock-key";});
afterAll(()=>{if(key===undefined)delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=key;});
it("explains unsupported prior-month profitability without declaring that uploads are missing",()=>{
  const period={...goal("custom","2026-08-22","2026-08-22")};
  const call={name:"get_financials" as const,call_id:"c1",arguments:{
    metric:"profit_margin",period:"custom",from:"2026-08-22",to:"2026-08-22",
  }};
  const result=validateSupervisorFinal({
    headline:"Here is what I found",summary:"Based on the available café records",
    fact_ids:[],task_ids:[],insight_ids:[],evidence_refs:[],
  },[{status:"unavailable",missingInputs:["periodOutsideLoadedMonth"],
    estimatedInputs:[],coverage:{},data:null,facts:[],tasks:[],insights:[],evidence:[]}],
  ["get_financials"],"en",[period],[call]);
  const words=result.blocks.filter(b=>b.type==="text").map(b=>b.text).join(" ");
  expect(words).toContain("even when sales were uploaded");
  expect(words).toContain("Historical costs and coverage");
  expect(words).not.toContain("Missing or incomplete historical cost source");
});

function transportFactory(){
  const first=output([
    call("declare_request_scope",{goals:[goal()]},"scope"),
    call("get_financials",{metric:"profit_margin",period:"custom",
      from:"2026-08-22",to:"2026-08-22"},"day1"),
    call("get_financials",{metric:"profit_margin",period:"custom",
      from:"2026-09-04",to:"2026-09-04"},"day2"),
  ]);
  const audit=output([message({complete:true,ambiguous:false,
    goals:[goal("custom","2026-08-22","2026-09-04")]})]);
  const last=output([done()]);
  return vi.fn(async(_url:string,init:RequestInit)=>{
    const req=JSON.parse(String(init.body)) as {text?:{format?:{name?:string}}};
    if(req.text?.format?.name==="supervisor_scope_audit")return audit;
    const n=transportFactoryIndex++;
    return n===0?first:last;
  });
}
let transportFactoryIndex=0;

describe("Actual Supervisor entrypoint: operating margin for separate owner-written days",()=>{
  it("calls the authorized canonical financial reader twice, not an arbitrary range or ingredient math",async()=>{
    transportFactoryIndex=0;
    const read=vi.fn(async(period:{from:string;to:string})=>({
      available:true as const,
      value:period.from==="2026-08-22"
        ? {netSalesCents:100000,totalCostsCents:80000,ownerProfitCents:20000,
            operatingMargin:0.2,coveredSalesDays:1,expectedSalesDays:1}
        : {netSalesCents:200000,totalCostsCents:150000,ownerProfitCents:50000,
            operatingMargin:0.25,coveredSalesDays:1,expectedSalesDays:1},
      quality:high,
    }));
    const transport=transportFactory();
    const res=await runSupervisorTurn({...testBase,tools:{
      getProfitability:read,
    } as unknown as BusinessScopedCafeTools},transport);
    expect(read.mock.calls.map(([period])=>period))
      .toEqual([{from:"2026-08-22",to:"2026-08-22"},
        {from:"2026-09-04",to:"2026-09-04"}]);
    expect(res.reply.status).toBe("verified");
    const texts=res.reply.blocks.filter(x=>x.type==="text").map(x=>x.text);
    expect(texts.join(" ")).toContain("2026-08-22");
    expect(texts.join(" ")).toContain("20.0%");
    expect(texts.join(" ")).toContain("2026-09-04");
    expect(texts.join(" ")).toContain("25.0%");
    expect(res.reply.blocks.some(x=>x.type==="metric")).toBe(false);
    expect(res.usage.modelCallCount).toBe(3);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("reports unavailable coverage rather than fabricating a second day's margin",async()=>{
    transportFactoryIndex=0;
    const read=vi.fn(async(period:{from:string;to:string})=>
      period.from==="2026-08-22"
        ? {available:true as const,value:{netSalesCents:100000,totalCostsCents:80000,
            ownerProfitCents:20000,operatingMargin:0.2,coveredSalesDays:1,expectedSalesDays:1},
            quality:high}
        : {available:false as const,value:null,quality:{...high,level:"low" as const,
            missingInputs:["ingredientCosts","laborCoverage"]}});
    const res=await runSupervisorTurn({...testBase,tools:{
      getProfitability:read,
    } as unknown as BusinessScopedCafeTools},transportFactory());
    expect(res.reply.status).toBe("partial");
    const lines=res.reply.blocks.filter(x=>x.type==="text").map(x=>x.text).join(" ");
    expect(lines).toContain("20.0%");
    expect(lines).not.toContain("25.0%");
    expect(lines).toContain("cannot be verified");
    expect(lines).toContain("2026-09-04");
    expect(lines).toContain("ingredient costs");
    expect(lines).toContain("staff labor coverage");
  });
});
