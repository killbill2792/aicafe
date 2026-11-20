import { describe, expect, it, vi } from "vitest";
import { agentInstructions, agentPromptCacheKey, runAgentTurn, task14bInlineContinuation, type AgentProvider, type OwnerFollowUp } from "./loop.server";
import { STYLE_RULES } from "./style";
import { withWorkerBudget,withDurableProviderTurn } from "@/lib/ai/supervisor/runs/usage.server";
import { meteredInvestigationProvider } from "@/lib/ai/supervisor/routines/investigationUsage.server";
import { memoryToolDefinition } from "./tools/memory";
import { routineToolDefinition } from "./tools/routines";
import type { AgentToolContext } from "./tools";

const context: AgentToolContext = {
  locale: "en", asOf: "2026-10-21", timezone: "America/Los_Angeles",
  tools: {
    getMenuCatalog: async () => ({ available: true,
      quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] },
      value: [{ id: "item-1", name: "Latte", category: "drink", active: true, priceCents: 450 }] }),
    getProfitability: async () => ({ available: false, value: null,
      quality: { level: "low", missingInputs: ["profitNotAvailable"], estimatedInputs: [], staleInputs: [] } }),
    getSalesTrend: async () => ({ available: false, value: null,
      quality: { level: "low", missingInputs: ["salesNotAvailable"], estimatedInputs: [], staleInputs: [] } }),
  },
};
const completed = { type: "response.completed", response: { usage: {
  input_tokens: 40, output_tokens: 8, input_tokens_details: { cached_tokens: 10 } } } };
const text = (value: string) => ({ type: "response.output_text.delta", delta: value });
const call = (name: string, args: string, id: string) => ({ type: "response.output_item.done",
  item: { type: "function_call", name, arguments: args, call_id: id } });
function recording(rounds: Array<Array<Record<string, unknown>>>) {
  const requests: Record<string, unknown>[] = [];
  const provider: AgentProvider = async function* (params) {
    requests.push(params as Record<string, unknown>);
    for (const event of rounds[requests.length - 1] ?? []) yield { ...event, type: String(event.type) };
  };
  return { requests, provider };
}
function inbox(batches: OwnerFollowUp[][]) {
  const asked: number[] = [];
  return { asked, take: async (max: number) => { asked.push(max); return (batches.shift() ?? []).slice(0, max); } };
}

describe("Task14B trusted broker request-shape preflight (zero provider cost)",()=>{
  it("replays original-order encrypted reasoning with function call and tool result, without narrowing tools",async()=>{
    const {requests,provider}=recording([
      [{type:"response.output_item.done",item:{type:"reasoning",
        id:"rs_local_issued",status:"completed",summary:[],encrypted_content:"U".repeat(512)}},
       call("get_supplier_purchase_orders","{}","call_purchase_1"),completed],
      [text("The saved purchasing history is empty."),completed]
    ]);
    const ctx={...context,purchasing:{
      list:async()=>({orders:[],truncated:false,drafts:[],draftsTruncated:false,
        unresolvedApprovals:[],unresolvedApprovalsTruncated:false}),
      inspect:vi.fn(),propose:vi.fn(),
    }} as AgentToolContext;
    vi.stubEnv("AI_CAFE_LIVE_ACCEPTANCE","OWNER_APPROVED_LOCAL_ONLY");
    vi.stubEnv("APP_URL","http://127.0.0.1:3000");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","http://127.0.0.1:54321");
    // Exact Docker environment: candidate gets a proxy token but NEVER host ledger.
    vi.stubEnv("AICAFE_TASK14B_BUDGET_LEDGER","");
    vi.stubEnv("AICAFE_14B_BROKER_TOKEN","z".repeat(64));
    try{
      const result=await runAgentTurn({ownerText:"Read my saved supplier purchase orders.",
        context:ctx,provider});
      expect(result.endReason).toBe("complete");
      expect(result.tools).toContain("get_supplier_purchase_orders");
    }finally{vi.unstubAllEnvs();}
    expect(requests).toHaveLength(2);
    const next=requests[1].input as Array<Record<string,unknown>>;
    expect(requests[0].store).toBe(false);
    expect(requests[1].store).toBe(false);
    const history=next.filter(x=>["reasoning","function_call","function_call_output"].includes(String(x.type)));
    expect(history.map(x=>x.type)).toEqual(["reasoning","function_call","function_call_output"]);
    expect(history[0]).toEqual({type:"reasoning",id:"rs_local_issued",
      status:"completed",summary:[],encrypted_content:"U".repeat(512)});
    expect(next).toContainEqual({type:"function_call",name:"get_supplier_purchase_orders",
      arguments:"{}",call_id:"call_purchase_1"});
    expect(next.some(x=>x.type==="function_call_output"&&x.call_id==="call_purchase_1")).toBe(true);
    expect(JSON.stringify(requests[1])).toContain("rs_local_issued");
    expect(JSON.stringify(requests[1])).not.toContain("fc_opaque_remote");
    expect(Buffer.byteLength(JSON.stringify(requests[1]),"utf8")).toBeLessThanOrEqual(120_000);
    const names=(requests[1].tools as Array<{name:string}>).map(x=>x.name);
    expect(names).toContain("get_supplier_purchase_orders");
    expect(names).toContain("inspect_supplier_purchase");
    expect(names).toContain("propose_supplier_purchase_order");
  });
  it("does not enable stateless pilot mode without the isolated host broker token",async()=>{
    const {requests,provider}=recording([[text("No supplier change."),completed]]);
    vi.stubEnv("AI_CAFE_LIVE_ACCEPTANCE","OWNER_APPROVED_LOCAL_ONLY");
    vi.stubEnv("APP_URL","http://127.0.0.1:3000");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","http://127.0.0.1:54321");
    vi.stubEnv("AICAFE_TASK14B_BUDGET_LEDGER","/tmp/misleading-host-only-ledger");
    vi.stubEnv("AICAFE_14B_BROKER_TOKEN","");
    try{
      const result=await runAgentTurn({ownerText:"Tell me about ordering milk.",
        context,provider});
      expect(result.endReason).toBe("complete");
    }finally{vi.unstubAllEnvs();}
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("store");
  });
  it("keeps self-contained encrypted reasoning, call IDs and strips other opaque IDs",()=>{
    expect(task14bInlineContinuation([
      {type:"reasoning",id:"rs_local_issued",status:"completed",summary:[],encrypted_content:"U".repeat(512)},
      {type:"function_call",id:"fc_opaque",status:"completed",
        name:"inspect_supplier_purchase",call_id:"call_2",arguments:'{"items":[]}'},
      {type:"message",id:"msg_opaque",role:"assistant",content:[
        {type:"output_text",text:"A source-backed result.",annotations:[{url:"https://secret.test"}]}
      ]}
    ])).toEqual([
      {type:"reasoning",id:"rs_local_issued",status:"completed",
        summary:[],encrypted_content:"U".repeat(512)},
      {type:"function_call",name:"inspect_supplier_purchase",call_id:"call_2",arguments:'{"items":[]}'},
      {type:"message",role:"assistant",content:[
        {type:"output_text",text:"A source-backed result.",annotations:[]}
      ]}
    ]);
    expect(()=>task14bInlineContinuation([{type:"function_call",name:"inspect_supplier_purchase",
      call_id:"bad call id",arguments:"{}"}])).toThrow("task14b_invalid_inline_function_call");
    expect(()=>task14bInlineContinuation([{type:"reasoning",id:"rs_untrusted",
      summary:[]}])).toThrow("task14b_invalid_inline_reasoning");
    expect(()=>task14bInlineContinuation([{type:"reasoning",id:"rs_untrusted",
      summary:[],encrypted_content:"x".repeat(48_001)}])).toThrow("task14b_invalid_inline_reasoning");
  });

  it("the complete unfiltered café Supervisor tool contract fits the tested 120KB bound",async()=>{
    const {requests,provider}=recording([[text("Investigating."),completed]]);
    await runAgentTurn({ownerText:"Investigate real supplier quotes for milk and prepare an owner-approval draft.",
      context,provider});
    expect(requests).toHaveLength(1);
    expect((requests[0].tools as Array<{name:string}>).map(t=>t.name))
      .toContain("inspect_supplier_purchase");
    expect((requests[0].tools as Array<{name:string}>).map(t=>t.name))
      .toContain("propose_supplier_purchase_order");
    // The trusted host broker blocks oversized requests BEFORE any paid call.
    // This is the full production tool list, not a narrowed test-only shortcut.
    const byteCount=Buffer.byteLength(JSON.stringify(requests[0]),"utf8");
    expect(byteCount).toBeLessThanOrEqual(120_000);
  });
  it("validates every function schema in the REAL authenticated request including memory/routine",async()=>{
    const {requests,provider}=recording([[text("Investigating."),completed]]);
    await runAgentTurn({ownerText:"Investigate current supplier quotes for milk and save an inert owner order draft.",
      context,provider,extraTools:[routineToolDefinition,memoryToolDefinition]});
    expect(requests).toHaveLength(1);
    const tools=requests[0].tools as Array<{type:string;name:string;strict:boolean;
      parameters:Record<string,unknown>}>;
    expect(tools.map(t=>t.name)).toContain("present_response");
    expect(tools.map(t=>t.name)).toContain("manage_routine");
    expect(tools.map(t=>t.name)).toContain("remember_cafe_fact");
    expect(tools.length).toBeLessThanOrEqual(128);
    expect(new Set(tools.map(t=>t.name)).size).toBe(tools.length);
    const schemaObject=(value:unknown):value is Record<string,unknown> =>
      value!==null&&typeof value==="object"&&!Array.isArray(value);
    const assertStrict=(schema:unknown,path:string):void=>{
      if(Array.isArray(schema)){schema.forEach((v,i)=>assertStrict(v,path+"["+i+"]"));return;}
      if(!schemaObject(schema))return;
      // A single unsupported "uri" format caused the REAL v3 paid Supervisor
      // turn to fail (provider HTTP400, tools[56] inspect_public_page).
      // Check the complete emitted function registry, including extra tools.
      if(Object.hasOwn(schema,"format")){
        const allowed=new Set(["date-time","time","date","duration",
          "email","hostname","ipv4","ipv6","uuid"]);
        expect(allowed.has(String(schema.format)),path+": unsupported JSON format "+String(schema.format)).toBe(true);
      }
      const props=schemaObject(schema.properties)?schema.properties:{};
      if(schema.type==="object"||Object.hasOwn(schema,"properties")){
        expect(schema.additionalProperties,path+": additionalProperties must be false").toBe(false);
        const required=schema.required;
        expect(Array.isArray(required),path+": required list missing").toBe(true);
        expect([...(required as string[])].sort(),path+": required must match every property")
          .toEqual(Object.keys(props).sort());
      }
      for(const [key,entry] of Object.entries(schema))
        if(key!=="description"&&key!=="examples")assertStrict(entry,path+"."+key);
    };
    for(const tool of tools){
      expect(tool.type,tool.name).toBe("function");
      expect(tool.strict,tool.name).toBe(true);
      expect(tool.name.length,tool.name).toBeLessThanOrEqual(64);
      // OpenAI's strict function contract requires an object at the root;
      // valid nested anyOf alternatives must each meet the same object rules.
      expect(tool.parameters.type,tool.name+": root parameter schema").toBe("object");
      expect(Object.hasOwn(tool.parameters,"anyOf"),tool.name+": root anyOf is forbidden").toBe(false);
      let propertyCount=0, maxObjectDepth=0;
      const inspect=(node:unknown,depth:number):void=>{
        if(Array.isArray(node)){node.forEach(entry=>inspect(entry,depth));return;}
        if(!schemaObject(node))return;
        for(const forbidden of ["allOf","not","dependentRequired","dependentSchemas","if","then","else"])
          expect(Object.hasOwn(node,forbidden),tool.name+": unsupported "+forbidden).toBe(false);
        const properties=schemaObject(node.properties)?node.properties:{};
        if(node.type==="object"){
          maxObjectDepth=Math.max(maxObjectDepth,depth);
          propertyCount+=Object.keys(properties).length;
        }
        for(const [key,value] of Object.entries(node))
          if(key==="properties"){
            for(const entry of Object.values(properties))inspect(entry,depth+1);
          }else if(key!=="description"&&key!=="examples")inspect(value,depth);
      };
      inspect(tool.parameters,1);
      expect(propertyCount,tool.name+": max schema properties").toBeLessThanOrEqual(5000);
      expect(maxObjectDepth,tool.name+": max object nesting").toBeLessThanOrEqual(10);
      assertStrict(tool.parameters,tool.name+".parameters");
    }
    expect(Buffer.byteLength(JSON.stringify(requests[0]),"utf8")).toBeLessThanOrEqual(120_000);
  });
});

describe("answer style ()", () => {
  it("adds the style rules with a new cache key when on", async () => {
    const { requests, provider } = recording([[text("Hi."), completed]]);
    await runAgentTurn({ ownerText: "Hi", context, provider });
    expect(requests[0].prompt_cache_key).toBe("cafe-agent-v15-universal-execution");
    expect(String(requests[0].instructions)).toContain(STYLE_RULES);
    expect(String(requests[0].instructions)).toContain("replaceProposalId=null");
    expect(String(requests[0].instructions)).toContain("NEVER infer replacement authority");
    expect(String(requests[0].instructions)).toContain("call get_supervisor_permissions");
    expect(String(requests[0].instructions)).toContain("A genuinely uncertain result requires receipt-only reconciliation");
    expect(agentPromptCacheKey()).toBe("cafe-agent-v15-universal-execution");
  });
});

describe("café memory in context ()", () => {
  it("sends approved facts as the first input item and appends the memory tool", async () => {
    const { requests, provider } = recording([[text("Noted."), completed]]);
    await runAgentTurn({ ownerText: "Hi", context, provider, memoryFacts: "Café facts…\n- [all] We close at 3pm on Sundays",
      extraTools: [memoryToolDefinition] });
    const input = requests[0].input as Array<{ role?: string; content?: unknown }>;
    expect(input[0]).toEqual({ role: "developer", content: "Café facts…\n- [all] We close at 3pm on Sundays" });
    const names = (requests[0].tools as Array<{ name: string }>).map(t => t.name);
    expect(names.at(-1)).toBe("remember_cafe_fact");
    expect(names.filter(n => n === "remember_cafe_fact")).toHaveLength(1);
  });
  it("sends no memory item and no extra tool by default", async () => {
    const { requests, provider } = recording([[text("Hi."), completed]]);
    await runAgentTurn({ ownerText: "Hi", context, provider });
    expect(JSON.stringify(requests[0].input)).toContain("Café local date:");
    expect((requests[0].tools as Array<{ name: string }>).some(t => t.name === "remember_cafe_fact")).toBe(false);
  });
});

describe("mid-run follow-ups ()", () => {
  it("reads a follow-up before the next model call and reports it as answered", async () => {
    const { requests, provider } = recording([
      [call("get_menu_items", '{"query":null,"limit":null}', "c1"), completed],
      [text("Latte is $4.50 and yes, oat milk is available."), completed],
    ]);
    const box = inbox([[{ id: "11111111-1111-4111-8111-111111111111", text: "and do we have oat milk?" }]]);
    const seen: number[] = [];
    const result = await runAgentTurn({ ownerText: "Latte price?", context, provider,
      takeFollowUps: box.take, onFollowUp: n => seen.push(n) });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].input)).toContain("and do we have oat milk?");
    expect(result.absorbedOwnerMessageIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(seen).toEqual([1]);
    expect(box.asked.every(max => max >= 1 && max <= 5)).toBe(true);
  });
  it("answers a follow-up that arrived while a tools-free answer streamed, in the same reply", async () => {
    const { requests, provider } = recording([
      [text("Hello!"), completed],
      [text("Sunday hours are 8 to 3."), completed],
    ]);
    const box = inbox([[{ id: "22222222-2222-4222-8222-222222222222", text: "what are sunday hours?" }]]);
    const deltas: string[] = [];
    const result = await runAgentTurn({ ownerText: "Hi", context, provider, takeFollowUps: box.take, onDelta: d => deltas.push(d) });
    expect(requests).toHaveLength(2);
    expect(result.text).toBe("Hello!\n\nSunday hours are 8 to 3.");
    expect(deltas.join("")).toBe(result.text);
    expect(result.absorbedOwnerMessageIds).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });
  it("stays within the model-call budget and never fails the turn when the inbox errors", async () => {
    const { requests, provider } = recording([[text("Hi."), completed]]);
    const result = await runAgentTurn({ ownerText: "Hi", context, provider,
      takeFollowUps: async () => { throw new Error("db down"); } });
    expect(result.text).toBe("Hi.");
    expect(requests).toHaveLength(1);
    expect(result.absorbedOwnerMessageIds).toBeUndefined();
  });
  it("times out a stalled inbox at the work deadline and keeps the final-answer window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { requests, provider } = recording([
        [call("get_menu_items", '{"query":null,"limit":null}', "c1"), completed],
        [text("Final answer."), completed],
      ]);
      let enteredInbox = false;
      let releaseInbox: (messages: OwnerFollowUp[]) => void = () => undefined;
      const stalled = new Promise<OwnerFollowUp[]>(resolve => { releaseInbox = resolve; });
      const turn = runAgentTurn({ ownerText: "Latte?", context, provider,
        takeFollowUps: () => { enteredInbox = true; return stalled; } });
      for (let i = 0; i < 30 && !enteredInbox; i++) await Promise.resolve();
      expect(enteredInbox).toBe(true);

      await vi.advanceTimersByTimeAsync(48_000);
      const result = await turn;
      expect(requests).toHaveLength(2);
      expect(requests[1].tool_choice).toBe("none");
      expect(result.text).toBe("Final answer.");
      expect(result.endReason).toBe("timeout");
      expect(result.absorbedOwnerMessageIds).toBeUndefined();
      expect(result.usage.latencyMs).toBeLessThanOrEqual(60_000);
      releaseInbox([{ id: "99999999-9999-4999-8999-999999999999", text: "too late" }]);
      await Promise.resolve();
      expect(result.absorbedOwnerMessageIds).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
  it("does not acknowledge inbox messages if every model response after reading them fails", async () => {
    const failed = { type: "response.failed" };
    const { provider, requests } = recording([
      [call("get_menu_items", '{"query":null,"limit":null}', "c1"), completed],
      [failed],
      [failed],
    ]);
    const box = inbox([[{ id: "88888888-8888-4888-8888-888888888888", text: "and oat milk?" }]]);
    const result = await runAgentTurn({ ownerText: "Latte price?", context, provider,
      takeFollowUps: box.take });
    expect(requests).toHaveLength(3);
    expect(result.absorbedOwnerMessageIds).toBeUndefined();
    expect(result.endReason).toBe("provider_error");
  });

  it("does not claim follow-ups from a tool-only model response when no final answer completes", async () => {
    const failed = { type: "response.failed" };
    const { provider, requests } = recording([
      [call("get_menu_items", '{"query":null,"limit":null}', "c1"), completed],
      [call("get_menu_items", '{"query":null,"limit":null}', "c2"), completed],
      [failed],
      [failed],
    ]);
    const box = inbox([[{ id: "99999999-9999-4999-8999-999999999999", text: "any oat milk?" }]]);
    const result = await runAgentTurn({ ownerText: "Latte?", context, provider, takeFollowUps: box.take });
    expect(requests).toHaveLength(4);
    expect(result.absorbedOwnerMessageIds).toBeUndefined();
  });

  it("caps absorbed follow-ups at five per turn", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `3333333${i}-3333-4333-8333-333333333333`, text: "more " + i }));
    const { requests, provider } = recording([[text("A."), completed], [text("B."), completed]]);
    const box = inbox([many, [{ id: "44444444-4444-4444-8444-444444444444", text: "too late" }]]);
    const result = await runAgentTurn({ ownerText: "Hi", context, provider, takeFollowUps: box.take });
    expect(result.absorbedOwnerMessageIds).toHaveLength(5);
    expect(box.asked).toEqual([5]);
    expect(requests.length).toBeLessThanOrEqual(6);
  });
});

describe("incomplete provider response diagnostics and fail-closed tool recovery",()=>{
  function isolated(){
    vi.stubEnv("AI_CAFE_LIVE_ACCEPTANCE","OWNER_APPROVED_LOCAL_ONLY");
    vi.stubEnv("APP_URL","http://127.0.0.1:3000");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","http://127.0.0.1:54321");
    vi.stubEnv("AICAFE_14B_BROKER_TOKEN","z".repeat(64));
    vi.stubEnv("AICAFE_TASK14B_BUDGET_LEDGER","");
  }
  it("charges explicit incomplete usage, discards all partial output and never executes its tools",async()=>{
    isolated();
    try{
      const {requests,provider}=recording([
        [text("Unverified partial text"),call("get_menu_items",'{"query":null,"limit":null}',"partial_call"),
          {type:"response.incomplete",response:{incomplete_details:{reason:"max_output_tokens"},
            model:"unverified_model",usage:{input_tokens:100,output_tokens:1200,input_tokens_details:{cached_tokens:20}}}}],
        [text("I could not verify the requested information."),completed]
      ]);
      const tools=vi.fn(),reset=vi.fn();
      const result=await runAgentTurn({ownerText:"What milk products do I have?",context:{...context},
        provider,onTool:tools,onReset:reset});
      expect(result.endReason).toBe("provider_error");
      expect(result.providerFailureCodes).toEqual(["max_output_tokens"]);
      expect(result.text).toBe("I could not verify the requested information.");
      expect(reset).toHaveBeenCalledWith("Unverified partial text".length);
      expect(tools).not.toHaveBeenCalled();
      expect(result.results).toEqual([]);
      expect(result.usage).toMatchObject({modelCalls:2,toolCalls:0,inputTokens:140,outputTokens:1208,cachedTokens:30});
      expect(result.usage.model).not.toBe("unverified_model");
      expect(requests).toHaveLength(2);
      expect(requests[1].tool_choice).toBe("none");
      expect(JSON.stringify(requests[1].input)).not.toContain("partial_call");
    }finally{vi.unstubAllEnvs()}
  });
  it.each([
    ["content_filter","content_filter"],
    ["untrusted private upstream detail","incomplete_other"]
  ])("reports only fixed incomplete reasons (%s)",async(reason,expected)=>{
    isolated();
    try{
      const {provider}=recording([[{type:"response.incomplete",response:{incomplete_details:{reason}}}],
        [text("Recovery answer."),completed]]);
      const result=await runAgentTurn({ownerText:"Help with supplier order.",context:{...context},provider});
      expect(result.providerFailureCodes).toEqual([expected]);
      expect(result.endReason).toBe("provider_error");
    }finally{vi.unstubAllEnvs()}
  });
  it("distinguishes a missing terminal frame from a failed recovery request",async()=>{
    isolated();
    try{
      const {provider,requests}=recording([[text("Partial")],[{type:"response.failed"}]]);
      const result=await runAgentTurn({ownerText:"Help with supplier order.",context:{...context},provider});
      expect(result.providerFailureCodes).toEqual(["missing_terminal","provider_failed"]);
      expect(result.endReason).toBe("provider_error");
      expect(result.text).toBe("");
      expect(requests).toHaveLength(2);
    }finally{vi.unstubAllEnvs()}
  });
  it("does not return diagnostic categories in ordinary owner turns",async()=>{
    vi.stubEnv("AI_CAFE_LIVE_ACCEPTANCE","");
    try{
      const {provider}=recording([[{type:"response.incomplete",response:{incomplete_details:{reason:"content_filter"}}}],
        [text("Recovery answer."),completed]]);
      const result=await runAgentTurn({ownerText:"Help with supplier order.",context:{...context},provider});
      expect(result.providerFailureCodes).toBeUndefined();
      expect(result.endReason).toBe("provider_error");
    }finally{vi.unstubAllEnvs()}
  });
});

describe("Luna tool reasoning stays within the owner-approved aggregate output allowance",()=>{
  const doneWith=(n:number)=>({type:"response.completed",response:{model:"gpt-6-luna",
    usage:{input_tokens:40,output_tokens:n}}});
  const menu=(id:string)=>call("get_menu_items",'{"query":null,"limit":null}',id);
  const limits=(requests:Record<string,unknown>[])=>requests.map(r=>[r.tool_choice,r.max_output_tokens]);
  it("allows 16384 then only the remaining work allocation, retaining final 8192",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    try{
      const {requests,provider}=recording([[menu("a"),doneWith(16384)],[menu("b"),doneWith(8192)],[text("Summary."),doneWith(8192)]]);
      const r=await runAgentTurn({ownerText:"Read my menu.",context:{...context},provider});
      expect(limits(requests)).toEqual([["auto",16384],["auto",8192],["none",8192]]);
      expect(r.usage.outputTokens).toBe(32768);
      expect(r.usage.toolCalls).toBe(2);
      expect(r.endReason).toBe("budget");
    }finally{vi.unstubAllEnvs()}
  });
  it("supplier reads retain the same 32768 aggregate limit",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    try{
      const {requests,provider}=recording([[call("get_supplier_purchase_orders","{}","po"),doneWith(16384)],
        [menu("b"),doneWith(8192)],[text("Summary."),doneWith(8192)]]);
      const ctx={...context,purchasing:{
        list:async()=>({orders:[],truncated:false,drafts:[],draftsTruncated:false,unresolvedApprovals:[],unresolvedApprovalsTruncated:false}),
        inspect:vi.fn(),propose:vi.fn()
      }} as AgentToolContext;
      const r=await runAgentTurn({ownerText:"Read my supplier orders.",context:ctx,provider});
      expect(r.tools).toContain("get_supplier_purchase_orders");
      expect(limits(requests)).toEqual([["auto",16384],["auto",8192],["none",8192]]);
      expect(r.usage.outputTokens).toBe(32768);
    }finally{vi.unstubAllEnvs()}
  });
  it("never exceeds a durable worker's remaining output",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    try{
      const {requests,provider}=recording([[menu("a"),doneWith(900)],[text("Summary."),doneWith(234)]]);
      const r=await withWorkerBudget({maxElapsedMs:60000,maxModelCalls:6,maxToolCalls:8,maxInputTokens:100000,maxOutputTokens:1700},
        ()=>runAgentTurn({ownerText:"Read the menu.",context:{...context},provider}));
      expect(limits(requests)).toEqual([["auto",1134],["auto",234]]);
      expect(r.usage.outputTokens).toBe(1134);
    }finally{vi.unstubAllEnvs()}
  });
  it("keeps the durable reservation ceiling while interactive Luna has the expanded allowance",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    const rpc=vi.fn(async()=>({data:null,error:null}));
    const scope={db:{rpc} as unknown as import("@supabase/supabase-js").SupabaseClient,
      businessId:"00000000-0000-4000-8000-000000000001",
      ownerUserId:"00000000-0000-4000-8000-000000000002",
      threadId:"00000000-0000-4000-8000-000000000003",
      runId:"00000000-0000-4000-8000-000000000004",
      ownerMessageId:"00000000-0000-4000-8000-000000000005",
      jobId:"00000000-0000-4000-8000-000000000006",
      claimToken:"00000000-0000-4000-8000-000000000007",
      budget:{maxElapsedMs:60000,maxModelCalls:6,maxToolCalls:8,maxInputTokens:60000,maxOutputTokens:7200},
      ownerDailyCap:600,authorize:async()=>{}};
    try{
      const {requests,provider}=recording([[menu("a"),doneWith(900)],[text("Summary."),doneWith(100)]]);
      const r=await withDurableProviderTurn(scope,()=>withWorkerBudget(scope.budget,
        ()=>runAgentTurn({ownerText:"Read my menu.",context:{...context},provider})));
      expect(r.endReason).toBe("complete");
      expect(limits(requests)).toEqual([["auto",1200],["auto",1200]]);
      expect(rpc.mock.calls).toHaveLength(4);
      expect(rpc).toHaveBeenCalledWith("supervisor_reserve_durable_model_call",expect.objectContaining({p_output_cap:1200}));
      expect(rpc).toHaveBeenCalledWith("supervisor_complete_investigation_model_call",expect.objectContaining({p_output_tokens:900}));
    }finally{vi.unstubAllEnvs()}
  });
  it.each([false,true])("preserves the actual scheduled investigation reservation and recovery caps (fault=%s)",async(fault)=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    const rpc=vi.fn(async()=>({data:null,error:null}));
    const db={rpc} as unknown as import("@supabase/supabase-js").SupabaseClient;
    const scope={businessId:"00000000-0000-4000-8000-000000000001",
      ownerUserId:"00000000-0000-4000-8000-000000000002",
      threadId:"00000000-0000-4000-8000-000000000003",
      sourceType:"alert" as const,sourceId:"00000000-0000-4000-8000-000000000004",
      leaseToken:"00000000-0000-4000-8000-000000000005"};
    try{
      const responses=recording(fault?
        [[{type:"response.failed"}],[text("Investigation summary."),doneWith(100)]]:
        [[menu("a"),doneWith(900)],[text("Investigation summary."),doneWith(100)]]);
      const metered=meteredInvestigationProvider(db,scope,responses.provider);
      const r=await withWorkerBudget({maxElapsedMs:55000,maxModelCalls:6,maxToolCalls:7,
        maxInputTokens:72000,maxOutputTokens:4800},()=>runAgentTurn({
          ownerText:"Investigate the saved alert.",context:{...context},provider:metered.provider,
          toolNames:["get_menu_items"]}));
      expect(metered.problem()).toBeNull();
      expect(limits(responses.requests)).toEqual([["auto",1200],[fault?"none":"auto",1200]]);
      expect(r.usage.modelCalls).toBe(2);
      expect(r.endReason).toBe(fault?"provider_error":"complete");
      expect(rpc).toHaveBeenCalledWith("supervisor_reserve_investigation_model_call",
        expect.objectContaining({p_output_cap:1200,p_source_id:scope.sourceId,p_lease_token:scope.leaseToken}));
      expect(rpc).toHaveBeenCalledWith("supervisor_complete_investigation_model_call",
        expect.objectContaining({p_output_tokens:100}));
      expect(rpc.mock.calls).toHaveLength(fault?3:4);
    }finally{vi.unstubAllEnvs()}
  });
  it("reserves unknown completed usage conservatively instead of claiming billed tokens",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    try{
      const {requests,provider}=recording([[menu("a"),{type:"response.completed",response:{model:"gpt-6-luna"}}],
        [menu("b"),doneWith(8192)],[text("Summary."),doneWith(8192)]]);
      const r=await runAgentTurn({ownerText:"Read the menu.",context:{...context},provider});
      expect(limits(requests)).toEqual([["auto",16384],["auto",8192],["none",8192]]);
      expect(r.usage.outputTokens).toBe(16384);
    }finally{vi.unstubAllEnvs()}
  });
  it("ordinary other models keep the prior 1200 cap even on recovery",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-4.1-mini");
    try{
      const {requests,provider}=recording([[{type:"response.failed"}],[text("Recovery."),completed]]);
      await runAgentTurn({ownerText:"Read the menu.",context:{...context},provider});
      expect(limits(requests)).toEqual([["auto",1200],["none",1200]]);
    }finally{vi.unstubAllEnvs()}
  });
});

describe("saved supplier order communication is distinct from creating a new PO",()=>{
  const po="77777777-7777-4777-8777-777777777777";
  function purchasing(){
    return {
      list:vi.fn().mockResolvedValue({
        orders:[{id:po,status:"approved_for_ordering"}],truncated:false,drafts:[],
        draftsTruncated:false,unresolvedApprovals:[],unresolvedApprovalsTruncated:false,
        vendorCommunications:[{purchaseOrderId:po,channel:"gmail",state:"not_prepared",providerVerified:false}],
        gmailConnection:{status:"active",connected:true,canRead:true,canSend:true}
      }),inspect:vi.fn(),propose:vi.fn(),recordOwnerOutcome:vi.fn(),
      proposeVendorSend:vi.fn().mockResolvedValue({proposalId:"33333333-3333-4333-8333-333333333333",
        revision:1,purchaseOrderId:po,supplierName:"Sample Dairy",
        recipient:"verified@supplier.example",account:"owner@example.com",note:"Awaiting owner click"})
    };
  }
  it("sends coherent stable instructions and executes a recorded read/prepare sequence without creating a PO",async()=>{
    const ports=purchasing();
    const {requests,provider}=recording([[call("get_supplier_purchase_orders","{}","read_po"),completed],
      [call("propose_supplier_vendor_email",JSON.stringify({purchaseOrderId:po}),"draft_email"),completed],
      [text("The email approval is prepared. Nothing has been sent."),completed]]);
    const result=await runAgentTurn({ownerText:"Prepare an email approval for my existing approved order "+po+
      ". Do not create another order or send anything.",
      context:{...context,purchasing:ports} as unknown as AgentToolContext,provider});
    expect(result.tools).toEqual(["get_supplier_purchase_orders","propose_supplier_vendor_email"]);
    expect(ports.list).toHaveBeenCalledTimes(1);
    expect(ports.proposeVendorSend).toHaveBeenCalledExactlyOnceWith({purchaseOrderId:po});
    expect(ports.propose).not.toHaveBeenCalled();
    expect(ports.inspect).not.toHaveBeenCalled();
    expect(ports.recordOwnerOutcome).not.toHaveBeenCalled();
    expect(result.results).toContainEqual(expect.objectContaining({
      source:"supplier_vendor_dispatch",proposalCreated:true,sent:false,approvalRequired:true}));
    expect(requests[0].tool_choice).toBe("auto");
    expect(requests[0].instructions).toBe(agentInstructions());
    expect(String(requests[0].instructions)).toContain("That prohibition does not forbid a separately requested, inert communication approval");
    expect(String(requests[0].instructions)).toContain("Only the exact separate owner click can authorize sending");
    expect(String(requests[0].instructions)).toContain("An empty Gmail history alone is not a barrier");
    expect(String(requests[0].instructions)).not.toContain("or an explicit 'do not create an order', use read-only tools only");
    const names=(requests[0].tools as Array<{name:string}>).map(x=>x.name);
    expect(names).toEqual((requests[1].tools as Array<{name:string}>).map(x=>x.name));
    expect(names).toEqual(expect.arrayContaining(["get_supplier_purchase_orders","propose_supplier_purchase_order","propose_supplier_vendor_email","get_menu_items"]));
  });
  it("preserves read-only comparison/status requests without preparing any action",async()=>{
    const ports=purchasing();
    const {requests,provider}=recording([[call("get_supplier_purchase_orders","{}","read_po"),completed],
      [text("The order is saved and approved internally."),completed]]);
    const r=await runAgentTurn({ownerText:"Review my saved order status only, no action.",
      context:{...context,purchasing:ports} as unknown as AgentToolContext,provider});
    expect(r.tools).toEqual(["get_supplier_purchase_orders"]);
    expect(ports.propose).not.toHaveBeenCalled();
    expect(ports.proposeVendorSend).not.toHaveBeenCalled();
    expect(ports.recordOwnerOutcome).not.toHaveBeenCalled();
    expect(requests[0].instructions).toBe(agentInstructions());
    expect(String(requests[0].instructions)).toContain("For comparison-only requests use read-only tools only.");
  });
});


describe("Task16E optional composition in the single existing agent loop",()=>{
 it("keeps ordinary prose, records the presentation result without treating it as numerical evidence",async()=>{
  const {requests,provider}=recording([
    [call("present_response",JSON.stringify({layout:"stack",panels:[],suggestions:["Compare costs"]}),"ui1"),completed],
    [text("You can compare your costs next."),completed]
  ]);
  const result=await runAgentTurn({ownerText:"How should I explore my costs?",context:{...context},provider});
  expect(result.text).toBe("You can compare your costs next.");
  expect(result.endReason).toBe("complete");
  expect(result.status).toEqual({status:"complete",missing:[]});
  expect(result.results).toContainEqual(expect.objectContaining({source:"response_presentation",accepted:true}));
  expect(JSON.stringify(requests[1].input)).toContain("Visual selection only");
  expect(result.evidence).toEqual([]);
  expect(requests).toHaveLength(2);
 });
 it("does not offer the optional composition tool to restricted unattended work",async()=>{
  const {requests,provider}=recording([[text("No action needed."),completed]]);
  await runAgentTurn({ownerText:"Routine summary",context:{...context},provider,serviceOrigin:true});
  expect((requests[0].tools as Array<{name:string}>).some(t=>t.name==="present_response")).toBe(false);
 });
});

it("advertises actual result references on the native continuation and preserves the plain answer",async()=>{
 const {requests,provider}=recording([
  [call("get_menu_items",'{"query":null,"limit":null}',"menu_read"),completed],
  [call("present_response",JSON.stringify({layout:"stack",panels:[{source:"menu_items",field:"rows",kind:"table",ref:"r1"}],groups:[{layout:"grid",items:["p0"]}],suggestions:[]}),"ui_read"),completed],
  [text("Latte is on the saved menu."),completed]
 ]);
 const result=await runAgentTurn({ownerText:"What is on my menu?",context:{...context,currency:"USD"},provider});
 expect(result.text).toBe("Latte is on the saved menu.");
 const output=(requests[1].input as Array<Record<string,unknown>>).find(x=>x.type==="function_call_output"&&x.call_id==="menu_read");
 expect(JSON.parse(String(output?.output))).toMatchObject({source:"menu_items",presentationRef:"r1"});
 expect(result.results).toContainEqual(expect.objectContaining({source:"response_presentation",accepted:true,presentation:expect.objectContaining({groups:[{layout:"grid",items:["table0"]}],tables:[expect.objectContaining({rows:[expect.arrayContaining(["Latte",450]) ]})]})}));
 expect(JSON.stringify(requests[2].input)).toContain("Visual selection only");
});

describe("U1 matched recorded incident — checkpoint and presentation variations",()=>{
  it.each([false,true])("returns the same honest answer with checkpoint=%s and optional presentation",async(useCheckpoint)=>{
    const period={from:"2026-10-20",to:"2026-10-20"};
    const checkpoint={
      assertLive:vi.fn(async()=>{}),beginProvider:vi.fn(async()=>{}),
      endProvider:vi.fn(async(_completed:boolean)=>{}),
      beginTool:vi.fn(async(_name:string,_raw:unknown,_repeatSafe:boolean)=>null),
      endTool:vi.fn(async(_result:import("./tools").AgentToolResult,_noEffect?:boolean)=>{}),
      resumeContext:vi.fn(async()=>null),canYield:()=>false,yieldForRetry:async()=>false,
    };
    const answer="Sales, hourly activity and profit are unavailable for that date.";
    const missing={available:false as const,value:null,quality:{level:"low" as const,
      missingInputs:["testSourceUnavailable"],estimatedInputs:[],staleInputs:[]}};
    for(const withPresentation of [false,true]){
      const {requests,provider}=recording([
        [call("get_sales",JSON.stringify({period,ownerInputs:null}),"u1-sales"),completed],
        [call("get_peak_hours",JSON.stringify(period),"u1-peak"),completed],
        [call("get_profit",JSON.stringify({period,ownerInputs:null}),"u1-profit"),completed],
        ...(withPresentation?[[call("present_response",JSON.stringify({layout:"stack",panels:[],suggestions:[]}),"u1-visual"),completed]]:[]),
        [text(answer),completed],
      ]);
      const sales=vi.fn(async()=>missing),peak=vi.fn(async()=>missing),profit=vi.fn(async()=>missing);
      const ctx:AgentToolContext={...context,tools:{...context.tools,getSalesTrend:sales,getPeakHours:peak,getProfitability:profit}};
      vi.clearAllMocks();
      const result=await runAgentTurn({ownerText:"For October 20, 2026, report sales, peak hours and profit.",context:ctx,provider,
        ...(useCheckpoint?{checkpoint}:{}),});
      expect(result.text).toBe(answer);
      expect(result.endReason).toBe("complete");
      expect(sales).toHaveBeenCalledExactlyOnceWith(period);
      expect(peak).toHaveBeenCalledExactlyOnceWith(period);
      expect(profit).toHaveBeenCalledExactlyOnceWith(period);
      expect(result.results.filter(r=>r.source!=="response_presentation").map(r=>({source:r.source,period:r.period,missing:r.missing}))).toEqual([
        {source:"daily_rollups",period,missing:["testSourceUnavailable"]},
        {source:"get_peak_hours",period,missing:["testSourceUnavailable"]},
        {source:"profitability",period,missing:["testSourceUnavailable"]},
      ]);
      expect(requests).toHaveLength(withPresentation?5:4);
      if(useCheckpoint){
        expect(checkpoint.beginProvider).toHaveBeenCalledTimes(requests.length);
        expect(checkpoint.endProvider.mock.calls).toEqual(Array.from({length:requests.length},()=>[true]));
        expect(checkpoint.beginTool).toHaveBeenCalledTimes(withPresentation?4:3);
        expect(checkpoint.endTool).toHaveBeenCalledTimes(withPresentation?4:3);
      }else expect(checkpoint.beginProvider).not.toHaveBeenCalled();
    }
  });
});

describe("one Supervisor native discovery transport",()=>{
 it("continues a hosted search using only canonical registered definitions and pairs the actual selected function",async()=>{
   vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
   try{
     const discovery={type:"output_item.done",item:{type:"tool_search_call",execution:"server",call_id:null,status:"completed",arguments:{paths:["get_menu_items"]}}};
     const loaded={type:"response.output_item.done",item:{type:"tool_search_output",execution:"server",call_id:null,status:"completed",tools:[{type:"function",name:"get_menu_items",description:"untrusted"}]}};
     const {requests,provider}=recording([[{...discovery,type:"response.output_item.done"},loaded,call("get_menu_items",'{"query":null,"limit":null}',"native_menu"),completed],[text("Menu reviewed."),completed]]);
     const result=await runAgentTurn({ownerText:"Read the menu.",context:{...context},provider});
     expect(result.endReason).toBe("complete");
     expect(result.tools).toContain("get_menu_items");
     expect(requests[0].tools).toContainEqual({type:"tool_search"});
     const second=JSON.stringify(requests[1].input);
     expect(second).toContain("native_menu");
     expect(second).toContain("function_call_output");
     expect(second).not.toContain('"description":"untrusted"');
     expect(result.usage.requests).toHaveLength(2);
   }finally{vi.unstubAllEnvs()}
 });
});

describe("U2 no-provider end-to-end execution receipts",()=>{
 const done=(outputTokens:number)=>({type:"response.completed",response:{model:"gpt-6-luna",usage:{
  input_tokens:400,output_tokens:outputTokens,input_tokens_details:{cached_tokens:100},
  output_tokens_details:{reasoning_tokens:Math.min(outputTokens,100)}},output:[]}});
 const menu=(id:string)=>call("get_menu_items",'{"query":null,"limit":null}',id);
 it("finishes an ordinary greeting with one request and no forced investigation",async()=>{
  vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
  try{
   const {provider,requests}=recording([[text("Hello."),done(5)]]);
   const result=await runAgentTurn({ownerText:"Hello",context:{...context},provider});
   expect(result.endReason).toBe("complete");
   expect(result.text).toBe("Hello.");
   expect(requests).toHaveLength(1);
   expect(result.usage.toolCalls).toBe(0);
   expect(result.usage.requests?.[0]).toMatchObject({inputTokens:400,cachedTokens:100,outputTokens:5,
    composition:{toolEvidenceBytes:0,toolCallBytes:0,reasoningReplayBytes:0}});
  }finally{vi.unstubAllEnvs();}
 });
 it("keeps a substantial synthesis after an incomplete provider call, with separately measured evidence growth",async()=>{
  vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
  try{
   const answer=("The saved menu can inform the study. The available records do not support a conclusion about a new location. Compare fixed operating expenses, demand, staffing capacity and the risks of spreading management attention across sites. Request reliable local evidence and make the assumptions explicit before choosing a site.\n\n").repeat(10);
   const {provider,requests}=recording([[menu("research_menu"),done(300)],
    [text("Discard this unfinished claim."),{type:"response.incomplete",response:{model:"gpt-6-luna",usage:{input_tokens:500,output_tokens:2000},incomplete_details:{reason:"max_output_tokens"}}}],
    [text(answer),done(1500)]]);
   const reset=vi.fn();
   const result=await runAgentTurn({ownerText:"Would another location make sense for our cafe? Research this thoroughly.",
    context:{...context},provider,onReset:reset});
   expect(result.endReason).toBe("provider_error");
   expect(result.text).toBe(answer);
   expect(result.text.length).toBeGreaterThan(1200);
   expect(reset).toHaveBeenCalledWith("Discard this unfinished claim.".length);
   expect(requests.map(p=>p.tool_choice)).toEqual(["auto","auto","none"]);
   expect(requests[2].max_output_tokens).toBe(8192);
   const receipts=result.usage.requests!;
   expect(receipts.map(x=>x.outcome)).toEqual(["completed","incomplete","completed"]);
   expect(receipts[0].composition?.toolEvidenceBytes).toBe(0);
   expect(receipts[1].composition!.toolEvidenceBytes).toBeGreaterThan(0);
   expect(receipts[2].composition?.toolEvidenceBytes).toBe(receipts[1].composition?.toolEvidenceBytes);
   expect(receipts[0].composition?.schemaBytes).toBe(receipts[2].composition?.schemaBytes);
   expect(JSON.stringify(receipts)).not.toContain("new location");
  }finally{vi.unstubAllEnvs();}
 });
 it("uses expanded migrated worker allowances through actual metered investigation transport",async()=>{
  vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
  const rpc=vi.fn(async()=>({data:null,error:null}));
  const db={rpc} as unknown as import("@supabase/supabase-js").SupabaseClient;
  const scope={businessId:"00000000-0000-4000-8000-000000000001",
   ownerUserId:"00000000-0000-4000-8000-000000000002",
   threadId:"00000000-0000-4000-8000-000000000003",
   sourceType:"alert" as const,sourceId:"00000000-0000-4000-8000-000000000004",
   leaseToken:"00000000-0000-4000-8000-000000000005"};
  try{
   const {provider,requests}=recording([[menu("worker_menu"),done(3500)],[text("Investigation finished."),done(1800)]]);
   const metered=meteredInvestigationProvider(db,scope,provider,8192);
   const result=await withWorkerBudget({maxElapsedMs:55000,maxModelCalls:8,maxToolCalls:24,
    maxInputTokens:240000,maxOutputTokens:32768},()=>runAgentTurn({ownerText:"Investigate this objective.",
     context:{...context},provider:metered.provider,toolNames:["get_menu_items"]}),8192);
   expect(result.endReason).toBe("complete");
   expect(requests.map(p=>p.max_output_tokens)).toEqual([8192,8192]);
   expect(result.usage.outputTokens).toBe(5300);
   expect(rpc).toHaveBeenCalledWith("supervisor_reserve_investigation_model_call",expect.objectContaining({p_output_cap:8192,p_lease_token:scope.leaseToken}));
   expect(rpc).toHaveBeenCalledWith("supervisor_complete_investigation_model_call",expect.objectContaining({p_output_tokens:1800,
    p_execution_metrics:expect.objectContaining({composition:expect.objectContaining({toolEvidenceBytes:expect.any(Number)})})}));
   expect(metered.problem()).toBeNull();
  }finally{vi.unstubAllEnvs();}
 });
 it("rejects provider discovery of a tool outside the admitted worker registry before dispatch",async()=>{
  vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
  try{
   const search={type:"response.output_item.done",item:{type:"tool_search_call",execution:"server",call_id:null,status:"completed",arguments:{paths:["get_menu_items"]}}};
   const fake={type:"response.output_item.done",item:{type:"tool_search_output",execution:"server",call_id:null,status:"completed",tools:[{type:"function",name:"propose_purchases"}]}};
   const {provider,requests}=recording([[search,fake,call("propose_purchases","{}","unsafe_call"),done(200)],[text("Unable to confirm evidence."),done(100)]]);
   const onTool=vi.fn();
   const result=await runAgentTurn({ownerText:"Read only",context:{...context},provider,toolNames:["get_menu_items"],onTool});
   expect(result.endReason).toBe("provider_error");
   expect(onTool).not.toHaveBeenCalled();
   expect(result.results).toEqual([]);
   expect(result.usage.requests?.map(x=>x.outcome)).toEqual(["failed","completed"]);
   expect(requests[1].tool_choice).toBe("none");
   expect(JSON.stringify(requests[1].input)).not.toContain("unsafe_call");
  }finally{vi.unstubAllEnvs();}
 });
});
