import { describe, expect, it, vi } from "vitest";
import { agentInstructions, agentPromptCacheKey, runAgentTurn, type AgentProvider, type OwnerFollowUp } from "./loop.server";
import { STYLE_RULES } from "./style";
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
    expect(tools.map(t=>t.name)).toContain("manage_routine");
    expect(tools.map(t=>t.name)).toContain("remember_cafe_fact");
    expect(tools.length).toBeLessThanOrEqual(128);
    expect(new Set(tools.map(t=>t.name)).size).toBe(tools.length);
    const schemaObject=(value:unknown):value is Record<string,unknown> =>
      value!==null&&typeof value==="object"&&!Array.isArray(value);
    const assertStrict=(schema:unknown,path:string):void=>{
      if(Array.isArray(schema)){schema.forEach((v,i)=>assertStrict(v,path+"["+i+"]"));return;}
      if(!schemaObject(schema))return;
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
    expect(requests[0].prompt_cache_key).toBe("cafe-agent-v9-stale-po-recovery");
    expect(String(requests[0].instructions)).toContain(STYLE_RULES);
    expect(String(requests[0].instructions)).toContain("replaceProposalId=null");
    expect(String(requests[0].instructions)).toContain("NEVER infer replacement authority");
    expect(String(requests[0].instructions)).toContain("A genuinely uncertain result requires receipt-only reconciliation");
    expect(agentPromptCacheKey()).toBe("cafe-agent-v9-stale-po-recovery");
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
