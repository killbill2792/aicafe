import { beforeAll,afterAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { runSupervisorTurn, validateSupervisorFinal } from "./runSupervisorTurn.server";
import { parseSupervisorCalls } from "./toolRegistry.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";

let originalKey: string | undefined;
beforeAll(()=>{ originalKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="test-only"; });
afterAll(()=>{ if(originalKey===undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=originalKey; });
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const call=(name:string,args:object,id:string)=>({type:"function_call",name,arguments:JSON.stringify(args),call_id:id});
const complete=(ids:string[],refs:string[]=[])=>({type:"message",content:[{
  type:"output_text",text:JSON.stringify({headline:"Here is the recorded picture",summary:"Based on the available café records",
    fact_ids:ids,task_ids:[],evidence_refs:refs}),
}]});
const response=(output:unknown[],input_tokens=100)=>new Response(JSON.stringify({status:"completed",model:"gpt-6-luna",
  usage:{input_tokens,output_tokens:40},output}),{status:200});
const calls={
  bills:call("get_financials",{metric:"monthly_bills",period:"month_to_date",from:null,to:null},"c1"),
  team:call("get_team",{status:"handled",agent:"all",view:"tasks",limit:3},"c2"),
  sales:call("get_sales",{metric:"net_sales",group_by:"total",period:"previous_week",
    from:null,to:null,category:"all",product_name:null,sort:"highest",limit:3},"c1"),
};
const tools={
  getMonthlyBills:vi.fn(async()=>({available:true,value:{totalCents:730000},quality})),
  getTeamTasks:vi.fn(async()=>({available:true,value:[],quality})),
  getSalesTrend:vi.fn(async()=>({available:true,value:[{
    date:"2026-09-28",netSalesCents:542000,ordersCount:70,
  }],quality:{...quality,missingInputs:["salesCoverage:1/7"]}})),
} as unknown as BusinessScopedCafeTools;
const base={text:"How are we doing?",locale:"en" as const,asOf:"2026-10-10",
  cafeName:"Sample",timezone:"America/Los_Angeles",tools,history:[],readRules:async()=>[]};

describe("Bounded semantic café tool orchestration",()=>{
  it.each([
    "what did we make today","sales so far?","how much business have we done",
    "are we okay today?","anything weird happening?",
    "what's making less money?","should I be worried?",
    "do I need to worry about coverage?","is anyone causing me problems today?",
    "qué necesita mi atención","ما الذي يحتاج انتباهي",
  ])("accepts varied business language without production phrase routing: %s",async text=>{
    const transport=vi.fn().mockResolvedValueOnce(response([calls.bills]))
      .mockResolvedValueOnce(response([complete(["t1:bills"])]));
    const answer=await runSupervisorTurn({...base,text},transport);
    expect(answer.reply.blocks.some(x=>x.type==="metric"&&x.valueCents===730000)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("handles multiple tools in one response, returns every call_id, and aggregates usage",async()=>{
    const bodies:Array<Record<string,unknown>>=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));bodies.push(body);
      return bodies.length===1?response([calls.bills,calls.team]):response([complete(["t1:bills","t2:handled"])]);
    });
    const answer=await runSupervisorTurn({...base,history:[{role:"owner",text:"What needs attention?"},
      {role:"supervisor",text:"No recorded active needs-you tasks"}]},transport);
    expect(answer.usage).toMatchObject({modelCallCount:2,toolCallCount:2,inputTokens:200,outputTokens:80});
    expect(answer.reply.blocks.some(x=>x.type==="metric"&&x.valueCents===730000)).toBe(true);
    expect(bodies[0].tool_choice).toBe("auto");
    expect(bodies[0].parallel_tool_calls).toBe(true);
    expect(bodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"function_call_output",call_id:"c1"}),
      expect.objectContaining({type:"function_call_output",call_id:"c2"}),
    ]));
    expect(JSON.stringify(bodies)).not.toContain("business_id");
  });
  it("shows partial recorded historical sales instead of refusing verified observed days",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([calls.sales]))
      .mockResolvedValueOnce(response([complete(["t1:total"])]));
    const answer=await runSupervisorTurn({...base,text:"What about last week?"},transport);
    expect(answer.reply.status).toBe("partial");
    expect(answer.reply.blocks).toContainEqual(expect.objectContaining({type:"metric",valueCents:542000}));
    expect(answer.reply.blocks.some(x=>x.type==="warning")).toBe(true);
  });
  it("rejects forged tool names, arbitrary scopes and nonexistent monetary fact IDs",async()=>{
    expect(()=>parseSupervisorCalls([call("raw_sql",{sql:"select *"},"c1")])).toThrow();
    expect(()=>parseSupervisorCalls([call("get_cafe_overview",{focus:"today",business_id:"other"},"c1")])).toThrow();
    expect(()=>validateSupervisorFinal({headline:"Profit",summary:"Verified",
      fact_ids:["made-up"],task_ids:[],evidence_refs:[]},[] ,[])).toThrow();
    expect(()=>validateSupervisorFinal({headline:"Profit is $900",summary:"",
      fact_ids:[],task_ids:[],evidence_refs:[]},[],[])).toThrow();
  });
  it("permits zero read tools for a greeting but never invents a numeric card",async()=>{
    const transport=vi.fn().mockResolvedValue(response([{type:"message",content:[{type:"output_text",
      text:JSON.stringify({headline:"Hello",summary:"How can I help with your café?",
        fact_ids:[],task_ids:[],evidence_refs:[]})}]}]));
    const result=await runSupervisorTurn({...base,text:"Hi"},transport);
    expect(result.reply.blocks).toEqual([{type:"text",text:"Hello. How can I help with your café?"}]);
    expect(result.usage.toolCallCount).toBe(0);
  });
  it("stops when the read budget is exceeded",async()=>{
    const transport=vi.fn().mockResolvedValue(response(Array.from({length:6},(_,i)=>call("get_cafe_overview",{focus:"today"},"c"+i))));
    await expect(runSupervisorTurn(base,transport)).rejects.toThrow("budget");
  });
});
