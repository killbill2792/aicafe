import {beforeAll,afterAll,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {runSupervisorTurn,validateSupervisorFinal} from "./runSupervisorTurn.server";
import {parseSupervisorCalls} from "./toolRegistry.server";
import {SupervisorStageError,createSupervisorDiagnosticLogger} from "./diagnostics.server";
import {buildSupervisorInstructions,buildSupervisorRequest} from "./supervisorRequest.mjs";
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
  it("production request exposes the exact ten shared tool schemas, including compare and control",async()=>{
    const shared = (await import("./supervisorFunctions.mjs")).SUPERVISOR_FUNCTIONS;
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body)) as Record<string,unknown>;
      bodies.push(body);
      return bodies.length===1?response([control]):response([finish([])]);
    });
    await runSupervisorTurn({...base,text:"Hi"},transport);
    const offered=bodies[0].tools as Array<{name:string}>;
    expect(offered).toHaveLength(10);
    expect(offered.map(x=>x.name)).toEqual(shared.map(x=>x.name));
    expect(new Set(offered.map(x=>x.name)).size).toBe(10);
    expect(offered).toEqual(expect.arrayContaining([
      expect.objectContaining({name:"compare_periods"}),
      expect.objectContaining({name:"conversation_control"}),
    ]));
  });
  it("reports tokens for an incomplete provider response before retrying it",async()=>{
    const reports:Array<{inputTokens:number;outputTokens:number;modelCallCount:number}>=[];
    const incomplete=new Response(JSON.stringify({status:"incomplete",model:"gpt-6-luna",
      usage:{input_tokens:90,output_tokens:25},output:[]}),{status:200});
    const transport=vi.fn().mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(response([control]))
      .mockResolvedValueOnce(response([finish([])]));
    const result=await runSupervisorTurn({...base,text:"Hi",onUsage:u=>reports.push({...u})},transport);
    expect(result.usage).toMatchObject({inputTokens:290,outputTokens:105,
      modelCallCount:3,toolCallCount:1});
    expect(reports[0]).toMatchObject({inputTokens:90,outputTokens:25,modelCallCount:1});
    expect(reports.at(-1)).toMatchObject({inputTokens:290,outputTokens:105,modelCallCount:3});
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("preserves incomplete-response usage when both provider attempts fail",async()=>{
    const reports:Array<{inputTokens:number;outputTokens:number;modelCallCount:number}>=[];
    const incomplete=(inTokens:number,outTokens:number)=>new Response(JSON.stringify({
      status:"incomplete",model:"gpt-6-luna",usage:{input_tokens:inTokens,output_tokens:outTokens},output:[],
    }),{status:200});
    const transport=vi.fn().mockResolvedValueOnce(incomplete(110,30))
      .mockResolvedValueOnce(incomplete(140,35));
    await expect(runSupervisorTurn({...base,onUsage:u=>reports.push({...u})},transport))
      .rejects.toMatchObject({category:"provider_incomplete",stage:"provider_response"});
    expect(reports.at(-1)).toMatchObject({inputTokens:250,outputTokens:65,modelCallCount:2});
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("uses the exact shared production request builder including strict schema and tools",async()=>{
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length===1?response([control]):response([finish([])]);
    });
    await runSupervisorTurn({...base,text:"Hi"},transport);
    const instructions=buildSupervisorInstructions({locale:base.locale,asOf:base.asOf,timezone:base.timezone});
    const expected=buildSupervisorRequest({model:"gpt-6-luna",instructions,
      input:[{role:"user",content:"Hi"}],round:0});
    expect(bodies[0]).toEqual(expected);
    expect((bodies[0].tools as unknown[]).length).toBe(10);
  });
  it("reports provider non-2xx without swallowing its safe HTTP status",async()=>{
    const stages:string[]=[];
    const transport=vi.fn().mockResolvedValue(new Response("do-not-log-raw-provider-body",{status:401}));
    const error=await runSupervisorTurn({...base,onDiagnostic:d=>stages.push(d.stage)},transport)
      .then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({category:"provider_http",stage:"provider_response",httpStatus:401});
    expect(stages).toContain("provider_request");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("reports only sanitized 403 provider error type, code and optional request ID",async()=>{
    const logLines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>logLines.push(line));
    const sensitive="SECRET owner prompt, financial data and provider error.message";
    const body={
      error:{type:"permission_error",code:"organization_blocked",message:sensitive,
        secret:"not-allow-listed"},
      prompt:sensitive,cafeData:{cost:999},randomField:"arbitrary private field",
    };
    const headers={"content-type":"application/json","x-request-id":"req_test-403.ABC"};
    const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:403,headers}));
    const error=await runSupervisorTurn({...base,onDiagnostic:d=>logger.emit(d)},transport)
      .then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({stage:"provider_response",category:"provider_http",httpStatus:403,
      providerErrorType:"permission_error",providerErrorCode:"organization_blocked",
      providerRequestId:"req_test-403.ABC"});
    expect(transport).toHaveBeenCalledTimes(1);
    const events=logLines.map(line=>JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      stage:"provider_response",category:"provider_http",httpStatus:403,
      providerErrorType:"permission_error",providerErrorCode:"organization_blocked",
      providerRequestId:"req_test-403.ABC",round:1,attempt:1}));
    const serialized=logLines.join("\n");
    for(const forbidden of [sensitive,"not-allow-listed","arbitrary private field","cost","999","message","cafeData","prompt"])
      expect(serialized).not.toContain(forbidden);
  });
  it("handles malformed provider 403 error JSON without exposing its text",async()=>{
    const messages:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>messages.push(line));
    const transport=vi.fn().mockResolvedValue(new Response("PRIVATE invalid response body",{
      status:403,headers:{"content-type":"text/plain","x-request-id":"invalid id with spaces"},
    }));
    const error=await runSupervisorTurn({...base,onDiagnostic:d=>logger.emit(d)},transport)
      .then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({stage:"provider_response",category:"provider_http",httpStatus:403});
    expect(error?.providerErrorCode).toBeUndefined();
    expect(error?.providerErrorType).toBeUndefined();
    expect(error?.providerRequestId).toBeUndefined();
    expect(messages.join("\n")).not.toContain("PRIVATE invalid response body");
    expect(messages.join("\n")).not.toContain("invalid id with spaces");
  });
  it("classifies provider timeout distinctly from provider HTTP failures",async()=>{
    const transport=vi.fn().mockRejectedValue(Object.assign(new Error("private network error"),{name:"AbortError"}));
    const error=await runSupervisorTurn(base,transport).then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({category:"provider_timeout",stage:"provider_request",timeout:true});
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed function arguments as invalid_tool_call",async()=>{
    const invalid={type:"function_call",name:"get_financials",arguments:"{broken-json",call_id:"c1"};
    const error=await runSupervisorTurn(base,vi.fn().mockResolvedValue(response([invalid])))
      .then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({category:"invalid_tool_call",stage:"tool_call_parse"});
  });
  it("classifies thrown business reader errors without surfacing financial or employee information",async()=>{
    const redacted="private salary or café data must never appear";
    const brokenTools={...tools,getMonthlyBills:vi.fn(async()=>{throw Error(redacted);})};
    const transport=vi.fn().mockResolvedValueOnce(response([bills]));
    const events:unknown[]=[];
    const error=await runSupervisorTurn({...base,tools:brokenTools as unknown as BusinessScopedCafeTools,
      onDiagnostic:d=>events.push(d)},transport).then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({category:"tool_execution",stage:"tool_execution"});
    expect(JSON.stringify(events)).not.toContain(redacted);
  });
  it("classifies final structured validation errors separately",async()=>{
    const bad={type:"message",content:[{type:"output_text",
      text:JSON.stringify({headline:"invented business profit decreased",summary:"",
        fact_ids:[],task_ids:[],insight_ids:[],evidence_refs:[]})}]};
    const transport=vi.fn().mockResolvedValueOnce(response([control]))
      .mockResolvedValueOnce(response([bad]));
    const error=await runSupervisorTurn(base,transport).then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({category:"final_output_validation",stage:"final_response_validation"});
  });
  it("classifies invalid final JSON as final_output_malformed",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([control]))
      .mockResolvedValueOnce(response([{type:"message",content:[{type:"output_text",text:"{bad"}]}]));
    const error=await runSupervisorTurn(base,transport).then(()=>null,e=>e as SupervisorStageError);
    expect(error).toMatchObject({category:"final_output_malformed",stage:"final_response_parse"});
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
      .rejects.toMatchObject({category:"invalid_tool_call",stage:"tool_call_parse"});
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
    await expect(runSupervisorTurn(base,mixed)).rejects.toMatchObject({category:"invalid_tool_call",stage:"tool_call_parse"});
    const over=vi.fn().mockResolvedValue(response(Array.from({length:6},(_,i)=>
      call("get_cafe_overview",{focus:"today"},"call"+i))));
    await expect(runSupervisorTurn(base,over)).rejects.toMatchObject({category:"invalid_tool_call",stage:"tool_call_parse"});
  });
  it("maintains max three rounds; third round cannot request another tool",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(response([bills]))
      .mockResolvedValueOnce(response([team]))
      .mockResolvedValueOnce(response([bills]));
    await expect(runSupervisorTurn(base,transport)).rejects.toMatchObject({category:"invalid_tool_call",stage:"tool_call_parse"});
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
