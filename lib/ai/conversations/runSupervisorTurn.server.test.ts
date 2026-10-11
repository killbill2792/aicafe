import {beforeAll,afterAll,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {runSupervisorTurn,validateSupervisorFinal} from "./runSupervisorTurn.server";
import {parseSupervisorCalls} from "./toolRegistry.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
let originalKey:string|undefined;
beforeAll(()=>{originalKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="mock-key";});
afterAll(()=>{if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;});
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const call=(name:string,args:object,id:string)=>({type:"function_call",name,arguments:JSON.stringify(args),call_id:id});
const finish=(ids:string[],insightIds:string[]=[])=>({type:"message",content:[{
  type:"output_text",text:JSON.stringify({headline:"Here is the recorded picture",
    summary:"Based on the available café records",fact_ids:ids,task_ids:[],
    insight_ids:insightIds,evidence_refs:[]}),
}]});
const response=(output:unknown[])=>new Response(JSON.stringify({status:"completed",model:"gpt-6-luna",
  usage:{input_tokens:100,output_tokens:40},output}),{status:200});
const bills=call("get_financials",{metric:"monthly_bills",period:"month_to_date",from:null,to:null},"c1");
const team=call("get_team",{status:"handled",agent:"all",view:"tasks",limit:3},"c2");
const sales=call("get_sales",{metric:"net_sales",group_by:"total",period:"previous_week",from:null,to:null,
  category:"all",product_name:null,sort:"highest",limit:3},"c1");
const control=call("conversation_control",{intent:"greeting"},"c1");
const tools={
  getMonthlyBills:vi.fn(async()=>({available:true,value:{totalCents:730000},quality})),
  getTeamTasks:vi.fn(async()=>({available:true,value:[],quality})),
  getSalesTrend:vi.fn(async()=>({available:true,value:[{date:"2026-09-28",netSalesCents:542000,ordersCount:70}],
    quality:{...quality,missingInputs:["salesCoverage:1/7"]}})),
} as unknown as BusinessScopedCafeTools;
const base={text:"How are we doing?",locale:"en" as const,asOf:"2026-10-10",cafeName:"Sample",
  timezone:"America/Los_Angeles",tools,history:[],readRules:async()=>[]};
describe("Mocked Responses loop MECHANICS, not evidence of live GPT semantic understanding",()=>{
  it("executes chosen allow-listed call regardless of question wording (routing semantics not under test)",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([bills])).mockResolvedValueOnce(response([finish(["t1:bills"])]));
    const answer=await runSupervisorTurn({...base,text:"Mock transport chooses bills"},transport);
    expect(answer.reply.blocks).toContainEqual(expect.objectContaining({type:"metric",valueCents:730000}));
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("keeps multiple functions, call_ids, both history roles, and aggregates all model usage",async()=>{
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));bodies.push(body);
      return bodies.length===1?response([bills,team]):response([finish(["t1:bills","t2:handled"])]);
    });
    const r=await runSupervisorTurn({...base,history:[{role:"owner",text:"What needs me?"},
      {role:"supervisor",text:"AI Team handled a supply check."}]},transport);
    expect(r.usage).toMatchObject({modelCallCount:2,toolCallCount:2,inputTokens:200,outputTokens:80});
    expect(bodies[0].tool_choice).toBe("required");
    expect(bodies[1].tool_choice).toBe("auto");
    expect(bodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"function_call_output",call_id:"c1"}),
      expect.objectContaining({type:"function_call_output",call_id:"c2"}),
      expect.objectContaining({role:"assistant",content:"AI Team handled a supply check."}),
    ]));
    expect(JSON.stringify(bodies)).not.toContain("business_id");
  });
  it("keeps partial observed sales card and missing-coverage warning",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([sales])).mockResolvedValueOnce(response([finish(["t1:total"])]));
    const r=await runSupervisorTurn({...base,text:"What about last week?"},transport);
    expect(r.reply.status).toBe("partial");
    expect(r.reply.blocks).toContainEqual(expect.objectContaining({type:"metric",valueCents:542000}));
    expect(r.reply.blocks.some(x=>x.type==="warning")).toBe(true);
  });
  it("rejects unknown tools, business selectors and invented monetary or insight IDs",()=>{
    expect(()=>parseSupervisorCalls([call("raw_sql",{sql:"select"},"c1")])).toThrow();
    expect(()=>parseSupervisorCalls([call("get_cafe_overview",{focus:"today",business_id:"other"},"c1")])).toThrow();
    const response={headline:"Here is what I found",summary:"",fact_ids:["fake"],
      task_ids:[],insight_ids:[],evidence_refs:[]};
    expect(()=>validateSupervisorFinal(response,[],[])).toThrow("fact reference");
    expect(()=>validateSupervisorFinal({...response,fact_ids:[],insight_ids:["fake"]},[],[])).toThrow("insight reference");
    expect(()=>validateSupervisorFinal({...response,fact_ids:[],headline:"Labor is the main reason profitability declined"},[],[])).toThrow();
  });
  it("rejects unsupported qualitative business conclusions even without numeric claims",()=>{
    expect(()=>validateSupervisorFinal({headline:"Sales fell because employees were late",
      summary:"",fact_ids:[],task_ids:[],insight_ids:[],evidence_refs:[]},[],[])).toThrow();
  });
  it("requires first-round function call; a raw chat answer cannot escape grounding",async()=>{
    const transport=vi.fn().mockResolvedValue(response([finish([])]));
    await expect(runSupervisorTurn({...base,text:"How can I improve my café?"},transport))
      .rejects.toThrow("first round");
  });
  it("greeting/clarification work through conversation_control without touching business readers",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([control])).mockResolvedValueOnce(response([finish([])]));
    const r=await runSupervisorTurn({...base,text:"Hi"},transport);
    expect(r.reply.blocks).toEqual([{type:"text",text:"Hello. What would you like to know about your café?"}]);
    expect(r.usage.toolCallCount).toBe(1);
    const clarify=vi.fn().mockResolvedValueOnce(response([call("conversation_control",{intent:"clarification"},"c1")]))
      .mockResolvedValueOnce(response([finish([])]));
    const second=await runSupervisorTurn({...base,text:"Which month?"},clarify);
    expect(second.reply.blocks[0]).toMatchObject({type:"text",text:expect.stringContaining("check")});
  });
  it("rejects control combined with business tools and over-budget calls",async()=>{
    const mixed=vi.fn().mockResolvedValue(response([control,team]));
    await expect(runSupervisorTurn(base,mixed)).rejects.toThrow("control cannot accompany");
    const over=vi.fn().mockResolvedValue(response(Array.from({length:6},(_,i)=>
      call("get_cafe_overview",{focus:"today"},"call"+i))));
    await expect(runSupervisorTurn(base,over)).rejects.toThrow("budget");
  });
  it("maintains max three rounds; third round cannot request another tool",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([bills]))
      .mockResolvedValueOnce(response([team]))
      .mockResolvedValueOnce(response([bills]));
    await expect(runSupervisorTurn(base,transport)).rejects.toThrow("budget");
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
