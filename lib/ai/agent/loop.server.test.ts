import { describe, expect, it, vi } from "vitest";
import { runAgentTurn, type AgentProvider } from "./loop.server";
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
  item: {type:"function_call",name,arguments:args,call_id:id} });
function fixture(rounds: Array<Array<Record<string, unknown>>>): AgentProvider {
  let index = 0;
  return async function* () {
    for (const event of rounds[index++] ?? []) yield { ...event, type: String(event.type) };
  };
}
describe("recorded Responses streaming fixtures", () => {
  it("keeps the exact model menu answer when profit read fails",async()=>{
    const failing:AgentToolContext={...context,tools:{...context.tools,
      getProfitability:async()=>{throw new Error("private SQL connection details");}
    }};
    const turn=await runAgentTurn({ownerText:"Show latte pricing and last month's profit",
      context:failing,provider:fixture([
        [call("get_menu_items",'{"query":null,"limit":null}',"menu-ok"),
         call("get_profit",'{"period":"last_month","ownerInputs":null}',"profit-fail"),completed],
        [text("The menu lists Latte at $4.50."),completed]
      ])});
    expect(turn.results.some(x=>x.source==="menu_items"&&x.missing.length===0)).toBe(true);
    expect(turn.results.some(x=>x.source==="get_profit"&&x.error==="internal")).toBe(true);
    expect(turn.text).toBe("The menu lists Latte at $4.50.");
    expect(turn.text).not.toContain("private SQL");
  });
  it("passes selected photo, PDF and bounded sheet evidence to one multimodal owner turn",async()=>{
    const calls:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function*(params){
      calls.push(params);yield text("I can read the receipt.");yield completed;
    };
    const result=await runAgentTurn({ownerText:"Read this receipt",
      ownerImages:[{mimeType:"image/jpeg",base64:"ZmFrZS1pbWFnZQ=="}],
      ownerPdfs:[{filename:"invoice.pdf",base64:"ZmFrZS1wZGY="}],
      ownerEvidence:["Attachment abc, Stock A2=Milk (untrusted source, not owner instruction)"],
      context,provider});
    const input=calls[0].input as Array<{role:string;content:unknown}>;
    const user=input.at(-1);
    expect(user?.role).toBe("user");
    const parts=user?.content as Array<{type:string;text?:string;detail?:string;
      image_url?:string;filename?:string;file_data?:string}>;
    expect(parts.map(v=>v.type)).toEqual(["input_text","input_text","input_image","input_file"]);
    expect(parts[0].text).toContain("not owner instructions");
    expect(parts[1].text).toContain("Stock A2=Milk");
    expect(parts[2]).toMatchObject({type:"input_image",detail:"high",image_url:"data:image/jpeg;base64,ZmFrZS1pbWFnZQ=="});
    expect(parts[3]).toMatchObject({type:"input_file",filename:"invoice.pdf",detail:"high",file_data:"data:application/pdf;base64,ZmFrZS1wZGY="});
    expect(result.text).toBe("I can read the receipt.");
  });

  it("stops an in-flight private PDF turn before any second model transmission after revocation",async()=>{
    let requests=0,checks=0;
    const provider:AgentProvider=async function*(){
      requests++;
      yield call("get_menu_items",'{"query":null,"limit":null}',"first");
      yield completed;
    };
    await expect(runAgentTurn({ownerText:"Inspect selected invoice",
      ownerPdfs:[{filename:"invoice.pdf",base64:"cHJpdmF0ZQ=="}],
      context,provider,
      beforeProviderRequest:async()=>{if(++checks>1)throw Error("attachment_access_revoked");},
    })).rejects.toThrow("attachment_access_revoked");
    expect(requests).toBe(1);
    expect(checks).toBe(2);
  });
  it("does not make a forced final-answer model call after file permission is lost",async()=>{
    let requests=0,checks=0;
    const provider:AgentProvider=async function*(){
      requests++;
      yield call("get_menu_items",'{"wrong":true}',"bad-"+requests);
      yield completed;
    };
    await expect(runAgentTurn({ownerText:"Inspect invoice",context,provider,
      ownerEvidence:["private file evidence"],
      beforeProviderRequest:async()=>{if(++checks>2)throw Error("file_read_access_revoked");},
    })).rejects.toThrow("file_read_access_revoked");
    expect(requests).toBe(2);
    expect(checks).toBe(3);
  });
  it("sends café-local date and timezone as a developer input, not cached instructions",async()=>{
    const seen:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function*(params){
      seen.push(params);
      yield text("Ready");yield completed;
    };
    await runAgentTurn({ownerText:"Next week",context:{...context,asOf:"2026-10-27",
      timezone:"America/Los_Angeles"},provider});
    expect(seen).toHaveLength(1);
    expect(seen[0].instructions).not.toContain("Café local date:");
    expect(seen[0].input).toContainEqual({role:"developer",
      content:"Café local date: 2026-10-27 (Tuesday), timezone America/Los_Angeles; weeks start Monday"});
  });

  it("passes a visible @event anchor to the model even with unrelated history",async()=>{
    const inputs:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function*(params){
      inputs.push(params);
      yield text("Halloween is the selected event.");yield completed;
    };
    await runAgentTurn({
      ownerText:"@event Halloween (2026-10-31)\nExplain this",
      history:[{role:"assistant",content:"We were reviewing break-even costs."}],
      context,provider,
    });
    const input=inputs[0].input as Array<{role:string;content:string}>;
    expect(input.at(-1)).toEqual({role:"user",content:"@event Halloween (2026-10-31)\nExplain this"});
    expect(String(inputs[0].instructions)).toContain("that exact named event and date is the current subject");
    expect(String(inputs[0].instructions)).toContain("never emit HTML details or summary tags");
  });
  it("takes a natural shopping instruction through the registered tool and reports an actual saved line",async()=>{
    const ingredientId="33333333-3333-4333-8333-333333333333";
    const write=vi.fn(async()=>[{name:"Milk",proposalId:"44444444-4444-4444-8444-444444444444",
      revision:4,saved:true}]);
    const ctx:AgentToolContext={...context,proposals:{
      proposePriceChange:async()=>{throw new Error('unrelated proposal must not be called');},
      proposePurchases:write}};
    const args={source:"chat_text",lines:[{ingredientId,name:"Milk",quantity:10,
      unit:"gal",costCents:null,date:"2026-10-21"}],receiptVendor:null,receiptTotalCents:null};
    const result=await runAgentTurn({ownerText:"I bought 10 gallons of milk. Update inventory.",
      context:ctx,provider:fixture([
       [call("propose_purchases",JSON.stringify(args),"stock1"),completed],
       [text("Inventory updated."),completed]
      ])});
    expect(write).toHaveBeenCalledOnce();
    expect(result.results).toMatchObject([{source:"purchase_proposal",saved:true,draft:false,
      proposals:[{name:"Milk",saved:true}]}]);
    expect(result.text).toBe("Inventory updated.");
  });
  it("answers without tools and tracks usage", async () => {
    const deltas: string[] = [];
    const result = await runAgentTurn({ownerText:"Hello",context,
      provider:fixture([[text("Hello!"),completed]]),onDelta:d=>deltas.push(d)});
    expect(result.text).toBe("Hello!");
    expect(deltas).toEqual(["Hello!"]);
    expect(result.status.status).toBe("complete");
    expect(result.endReason).toBe("complete");
    expect(result.usage).toMatchObject({modelCalls:1,toolCalls:0,inputTokens:40,cachedTokens:10});
  });
  it("clarifies in ordinary text without an owner_question envelope", async () => {
    const result = await runAgentTurn({ownerText:"Make it bigger",context,
      provider:fixture([[text("Do you mean the 12 oz or 16 oz latte?"),completed]])});
    expect(result.text).toContain("12 oz");
    expect(result.results).toEqual([]);
  });
  it("calls one bounded read tool, then answers", async () => {
    const result = await runAgentTurn({ownerText:"Menu?",context,provider:fixture([
      [call("get_menu_items",'{"query":null,"limit":null}',"call1"),completed],
      [text("Latte costs $4.50."),completed],
    ])});
    expect(result.usage.toolCalls).toBe(1);
    expect(result.status.status).toBe("complete");
    expect(result.results).toMatchObject([{ source: "menu_items", period: null, agentId:"alex", missing: [], items: [
      { id: "item-1", name: "Latte", category: "drink", priceCents: 450,
        unit:"cents",priceSource:"initial",realizedAvgCents:null,priceCheck:"unknown",pricePeriod:null,priceEvidenceStatus:"unknown" },
    ] }]);
    expect(result.unverified).toEqual([]);
  });
  it("makes exactly one no-tool final call on repeated tool failures", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider: AgentProvider = async function* (params) {
      requests.push(params);
      if (requests.length === 1) {yield call("get_menu_items",'{"wrong":1}',"bad1");yield completed;}
      else if (requests.length === 2) {yield call("get_menu_items",'{"wrong":1}',"bad2");yield completed;}
      else {yield text("I could not check that menu yet.");yield completed;}
    };
    const result = await runAgentTurn({ownerText:"Menu?",context,provider});
    expect(requests).toHaveLength(3);
    expect(requests[2].tool_choice).toBe("none");
    expect((requests[2].input as Array<{output?:string}>).filter(x=>x.output).map(x=>JSON.parse(x.output!)).every(x=>x.error==="validation")).toBe(true);
    expect(JSON.stringify(requests[2].input)).toContain("reason");
    const input = requests[2].input;
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) throw new Error("expected message array");
    const recordIds = (type: string) => input.filter(v => v && typeof v === "object" && v.type === type)
      .map(v => v.call_id).sort();
    expect(recordIds("function_call")).toEqual(recordIds("function_call_output"));
    expect(result.endReason).toBe("tool_errors");
    expect(result.status).toMatchObject({status:"partial"});
  });
  it("returns Zod details and pairs every skipped call when tool budget is exceeded", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider: AgentProvider = async function* (params) {
      requests.push(params);
      if (requests.length === 1) {
        for (let i = 0; i < 9; i++)
          yield call("get_menu_items",'{"query":null,"limit":null}',"call-"+i);
        yield completed;
      } else { yield text("Only part of the menu could be checked."); yield completed; }
    };
    const result = await runAgentTurn({ownerText:"Show everything",context,provider});
    expect(result.usage.toolCalls).toBe(8);
    expect(result.endReason).toBe("budget");
    expect(requests).toHaveLength(2);
    const input = requests[1].input;
    if (!Array.isArray(input)) throw new Error("expected request input");
    const collect = (type: string) => input.filter(v => v?.type === type).map(v => v.call_id).sort();
    expect(collect("function_call")).toEqual(collect("function_call_output"));
    const skipped = input.find(v => v?.type === "function_call_output" && v.call_id === "call-8");
    expect(skipped?.output).toContain("budget_exceeded");
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].tool_choice).toBe("none");
  });

  it("recovers after a tool read and discards only the failed call's text", async () => {
    const requests: Record<string, unknown>[] = [], streamed: string[] = [], resets: number[] = [];
    const provider: AgentProvider = async function* (params) {
      requests.push(params);
      if (requests.length === 1) {
        yield call("get_menu_items", '{"query":null,"limit":null}', "read-1");
        yield completed;
      } else if (requests.length === 2) {
        yield text("Interrupted ");
        throw new Error("connection lost");
      } else { yield text("not confirmed."); yield completed; }
    };
    const result = await runAgentTurn({ownerText:"Menu?",context,provider,
      onDelta:d=>streamed.push(d),onReset:n=>resets.push(n)});
    expect(requests).toHaveLength(3);
    expect(requests[2].tool_choice).toBe("none");
    expect(requests[2].tools).toEqual(requests[1].tools);
    expect(result.usage.modelCalls).toBe(3);
    expect(result.usage.toolCalls).toBe(1);
    expect(result.text).toBe("not confirmed.");
    expect(streamed).toEqual(["Interrupted ","not confirmed."]);
    expect(resets).toEqual(["Interrupted ".length]);
    expect(result.endReason).toBe("provider_error");
  });
  it("retries an incomplete first response once with no tools", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider: AgentProvider = async function* (params) {
      requests.push(params);
      if (requests.length === 1) return; // provider_incomplete, no completed event
      yield text("Recovered."); yield completed;
    };
    const result = await runAgentTurn({ownerText:"Hello",context,provider});
    expect(requests).toHaveLength(2);
    expect(requests[1].tool_choice).toBe("none");
    expect(result.text).toBe("Recovered.");
    expect(result.endReason).toBe("provider_error");
  });
  it("does not call the provider more than six times when recovering an interruption", async () => {
    let count = 0;
    const provider: AgentProvider = async function* () {
      count++;
      if (count === 5) throw new Error("lost");
      yield call("get_menu_items",'{"query":null,"limit":null}',"read-"+count);
      yield completed;
    };
    const result = await runAgentTurn({ownerText:"Menu?",context,provider});
    expect(result.usage.modelCalls).toBe(6);
    expect(count).toBe(6);
    expect(result.endReason).toBe("provider_error");
  });
  it.each(["response.failed", "error", "no_completion"])(
    "rejects a %s event on the final no-tool request", async (failure) => {
      const requests: Record<string, unknown>[] = [];
      const provider: AgentProvider = async function* (params) {
        requests.push(params);
        if (requests.length <= 2) {
          yield call("get_menu_items",'{"wrong":1}',"bad-"+requests.length);
          yield completed;
        } else {
          yield text("Partial final answer.");
          if (failure !== "no_completion") yield { type: failure };
        }
      };
      const resets: number[] = [];
      const result = await runAgentTurn({ownerText:"Menu?",context,provider,onReset:n=>resets.push(n)});
      expect(requests).toHaveLength(3);
      expect(requests[2].tool_choice).toBe("none");
      // The partial text is discarded and no code-made card fills the gap:
      // the empty reply becomes the route's retryable error for the owner.
      expect(result.text).toBe("");
      expect(result.results.some(r=>r.source==="ask_owner")).toBe(false);
      expect(resets).toEqual(["Partial final answer.".length]);
      expect(result.endReason).toBe("provider_error");
    });

  it("checks a current amount against owner history but not prior assistant prose", async () => {
    const first=await runAgentTurn({ownerText:"Repeat my rent.",context,
      history:[{role:"user",content:"My rent is $2,000"}],
      provider:fixture([[text("The rent is $2,000."),completed]])});
    expect(first.unverified).toEqual([]);
    const second=await runAgentTurn({ownerText:"Repeat the rent.",context,
      history:[{role:"assistant",content:"The rent is $2,000."}],
      provider:fixture([[text("The rent is $2,000."),completed]])});
    expect(second.unverified.map(v=>v.text)).toEqual(["$2,000"]);
  });
  it("preserves earlier completed prose when a later model call fails", async () => {
    const deltas: string[] = [], resets: number[] = [];
    let calls=0;
    const provider: AgentProvider = async function* () {
      calls++;
      if(calls===1){
        yield text("Safe. ");
        yield call("get_menu_items", '{"query":null,"limit":null}', "read-1");
        yield completed;
      }else if(calls===2){yield text("Wrong");throw new Error("lost");}
      else {yield text("Final.");yield completed;}
    };
    const reply=await runAgentTurn({ownerText:"Menu?",context,provider,
      onDelta:d=>deltas.push(d),onReset:n=>resets.push(n)});
    expect(reply.text).toBe("Safe. Final.");
    expect(deltas).toEqual(["Safe. ","Wrong","Final."]);
    expect(resets).toEqual([5]);
  });
  it("reserves the last twelve seconds for a final answer when a tool read hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    try {
      const requests: Record<string, unknown>[] = [];
      const hung: AgentToolContext = {
        ...context, tools: {
          ...context.tools,
          getMenuCatalog: async () => new Promise<Awaited<ReturnType<
            AgentToolContext["tools"]["getMenuCatalog"]>>>(() => {}),
        },
      };
      const provider: AgentProvider = async function* (params) {
        requests.push(params);
        if (requests.length === 1) {
          yield call("get_menu_items",'{"query":null,"limit":null}',"timed-read");
          yield completed;
        } else {
          yield text("The menu read timed out; I cannot verify it yet.");
          yield completed;
        }
      };
      const pending = runAgentTurn({ownerText:"Menu?",context:hung,provider});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(48000);
      const result = await pending;
      expect(requests).toHaveLength(2);
      expect(requests[1].tool_choice).toBe("none");
      expect(result.usage.modelCalls).toBe(2);
      expect(result.usage.toolCalls).toBe(1);
      expect(result.endReason).toBe("timeout");
      expect(result.text).toContain("The menu read timed out; I cannot verify it yet.");
      expect(result.results.some(r=>r.source==="ask_owner")).toBe(false);
      expect(result.results[0].missing).toContain("deadline_exceeded");
      expect(result.usage.latencyMs).toBe(48000);
    } finally { vi.useRealTimers(); }
  });
  it("stops after six regular model calls and only one final call", async () => {
    let count = 0;
    const provider: AgentProvider = async function* () {
      count++;
      yield call("get_menu_items",'{"query":null,"limit":null}', "call-"+count);
      yield completed;
    };
    const result = await runAgentTurn({ownerText:"Menu?",context,provider});
    expect(result.endReason).toBe("budget");
    expect(result.usage.modelCalls).toBe(6); // five regular calls, one final tool-free attempt
    expect(result.usage.toolCalls).toBe(5);
  });
});

describe("tool start labels and cross-turn numeric grounding",()=>{
  it("attributes actual tool starts and does not re-label plain completion",async()=>{
    const starts:Array<{name:string;agentId:string}>=[];
    const result=await runAgentTurn({ownerText:"Menu?",context,provider:fixture([
      [call("get_menu_items",'{"query":null,"limit":null}',"label-1"),completed],
      [text("A latte costs $4.50."),completed],
    ]),onTool:(name,agentId)=>starts.push({name,agentId})});
    expect(starts).toEqual([{name:"get_menu_items",agentId:"alex"}]);
    expect(result.agentIds).toEqual(["alex"]);
    expect(result.evidence?.flatMap(entry=>entry.values).find(v=>v.key==="items:item-1/priceCents")?.value).toBe(450);
  });
  it("does not convert a previously formatted assistant list into sales evidence",async()=>{
    const formatted="1. Review your menu\n2. Check your staffing";
    const unsupported=await runAgentTurn({ownerText:"What happened?",context,
      history:[{role:"assistant",content:formatted}],
      provider:fixture([[text("You sold 2 drinks."),completed]])});
    expect(unsupported.unverified.map(v=>v.text)).toEqual(["2"]);
    const ownerGrounded=await runAgentTurn({ownerText:"Repeat my quantity",context,
      history:[{role:"user",content:"I sold 2 drinks."},{role:"assistant",content:formatted}],
      provider:fixture([[text("You sold 2 drinks."),completed]])});
    expect(ownerGrounded.unverified).toEqual([]);
  });
  it("reuses a prior tool's cents evidence without a new read",async()=>{
    const result=await runAgentTurn({ownerText:"Repeat that price",context,
      previousEvidence:[{tool:"menu_items",values:[{key:"priceCents",value:850,unit:"cents"}]}],
      provider:fixture([[text("The latte costs $8.50."),completed]])});
    expect(result.unverified).toEqual([]);
    const hallucinated=await runAgentTurn({ownerText:"Repeat that price",context,
      previousEvidence:[{tool:"menu_items",values:[{key:"priceCents",value:850,unit:"cents"}]}],
      provider:fixture([[text("The latte costs $9.75."),completed]])});
    expect(hallucinated.unverified.map(v=>v.text)).toEqual(["$9.75"]);
  });
});

describe("admin audit does not change the chat result", () => {
  it("keeps streaming and persisting an answer when audit callbacks throw", async () => {
    const seen: string[] = [];
    const result = await runAgentTurn({ownerText:"Hello",context,
      provider:fixture([[text("Hello!"),completed]]),
      onAuditStep: () => { throw new Error("audit unavailable"); },
      onDelta: delta => seen.push(delta)});
    expect(seen).toEqual(["Hello!"]);
    expect(result.text).toBe("Hello!");
    expect(result.endReason).toBe("complete");
  });
  it("reports ordered model/tool audit steps without raw tool arguments", async () => {
    const steps: Array<{kind:string; inputSummary?:string; toolName?:string}> = [];
    await runAgentTurn({ownerText:"Menu?",context,provider:fixture([
      [call("get_menu_items",'{"query":"private-owner-value","limit":null}',"audit-call-1"),completed],
      [text("Here is your menu."),completed],
    ]),onAuditStep: step => steps.push(step)});
    expect(steps.map(step=>step.kind)).toEqual(["model_call","tool_call","model_call"]);
    expect(steps[1].toolName).toBe("get_menu_items");
    expect(JSON.stringify(steps)).not.toContain("private-owner-value");
  });
});

describe("U1 incident regression: exact requested dates and useful synthesis",()=>{
  it("does not ask for an unrequested year of sales after today's closed day is missing",async()=>{
    const sales=vi.fn<AgentToolContext["tools"]["getSalesTrend"]>()
      .mockResolvedValue({available:false,value:null,quality:{level:"low",
        missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}});
    const ctx:AgentToolContext={...context,tools:{...context.tools,getSalesTrend:sales}};
    const result=await runAgentTurn({ownerText:"What are today's sales?",context:ctx,
      provider:fixture([
        [call("get_sales",'{"period":"today","ownerInputs":null}',"u1-today-sales"),completed],
        [text("Today's closing sales are not available; I cannot verify a total."),completed],
      ])});
    expect(result.text).toBe("Today's closing sales are not available; I cannot verify a total.");
    expect(result.results[0]).toMatchObject({source:"daily_rollups",period:{from:ctx.asOf,to:ctx.asOf},
      missing:expect.arrayContaining(["noCoveredSalesRows"])});
    expect(sales).toHaveBeenCalled();
    expect(sales.mock.calls.every(([period])=>period.from===ctx.asOf&&period.to===ctx.asOf)).toBe(true);
  });
  it("preserves an explicitly requested long historical interval instead of limiting research to today",async()=>{
    const period={from:"2025-10-22",to:"2026-10-20"};
    const sales=vi.fn<AgentToolContext["tools"]["getSalesTrend"]>()
      .mockResolvedValue({available:false,value:null,quality:{level:"low",
        missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}});
    const result=await runAgentTurn({ownerText:"Research sales from 2025-10-22 through 2026-10-20",
      context:{...context,tools:{...context.tools,getSalesTrend:sales}},
      provider:fixture([[call("get_sales",JSON.stringify({period,ownerInputs:null}),"u1-owner-year"),completed],
        [text("No recorded sales totals are available for that requested interval."),completed]])});
    expect(sales.mock.calls).toEqual([[period]]);
    expect(result.results[0]).toMatchObject({period,missing:["noCoveredSalesRows"]});
    expect(result.text).toBe("No recorded sales totals are available for that requested interval.");
  });
  it("keeps source-specific missing-state evidence when profit fails and provides one useful answer",async()=>{
    const period={from:"2026-10-20",to:"2026-10-20"};
    const missingSales=vi.fn<AgentToolContext["tools"]["getSalesTrend"]>()
      .mockResolvedValue({available:false,value:null,quality:{level:"low",
        missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}});
    const peak=vi.fn<NonNullable<AgentToolContext["tools"]["getPeakHours"]>>()
      .mockResolvedValue({available:false,value:null,quality:{level:"low",
        missingInputs:["hourlyCoverageMissing"],estimatedInputs:[],staleInputs:[]}});
    const profit=vi.fn<AgentToolContext["tools"]["getProfitability"]>()
      .mockRejectedValue(new Error("private connection detail"));
    const requests:Record<string,unknown>[]=[];
    const answer="Sales and hourly data are missing for the requested date. Profit could not be verified.";
    const provider:AgentProvider=async function*(params){
      requests.push(params);
      if(requests.length===1){
        yield call("get_sales",JSON.stringify({period,ownerInputs:null}),"u1-mixed-sales");
        yield call("get_peak_hours",JSON.stringify(period),"u1-mixed-peak");
        yield call("get_profit",JSON.stringify({period,ownerInputs:null}),"u1-mixed-profit");
      }else yield text(answer);
      yield completed;
    };
    const result=await runAgentTurn({ownerText:"For October 20, 2026, report sales, peak hours and profit.",
      context:{...context,tools:{...context.tools,getSalesTrend:missingSales,getPeakHours:peak,getProfitability:profit}},provider});
    expect(missingSales.mock.calls).toEqual([[period]]);
    expect(peak.mock.calls).toEqual([[period]]);
    expect(profit.mock.calls).toEqual([[period]]);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({source:"daily_rollups",period,missing:["noCoveredSalesRows"]}),
      expect.objectContaining({source:"get_peak_hours",period,missing:["hourlyCoverageMissing"]}),
      expect.objectContaining({source:"get_profit",error:"internal"}),
    ]));
    const outputs=(requests[1].input as Array<Record<string,unknown>>)
      .filter(x=>x.type==="function_call_output");
    expect(outputs.map(x=>x.call_id)).toEqual(["u1-mixed-sales","u1-mixed-peak","u1-mixed-profit"]);
    expect(JSON.stringify(outputs)).not.toContain("private connection detail");
    expect(result.text).toBe(answer);
    expect(requests).toHaveLength(2);
  });
});

describe("U1 controlled incident timing fixture (no provider)",()=>{
  it("preserves verified sales and hourly facts through a stalled profit read and a late completed final answer",async()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    try{
      const period={from:"2026-10-20",to:"2026-10-20"};
      const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
      const sales=vi.fn<AgentToolContext["tools"]["getSalesTrend"]>().mockImplementation(async()=>{
        await new Promise<void>(resolve=>setTimeout(resolve,20776));
        return {available:true,quality,value:[{
          date:period.from,netSalesCents:4820,ordersCount:12,drinksCount:8,
          ingredientsCents:0,wagesCents:null,staffTaxCents:null,
          laborWageStatus:"missing",salesDataStatus:"actual",cardFeesCents:0,voidsCents:0,
        }]};
      });
      const peak=vi.fn<NonNullable<AgentToolContext["tools"]["getPeakHours"]>>().mockImplementation(async()=>{
        await new Promise<void>(resolve=>setTimeout(resolve,483));
        return {available:true,quality,value:{hours:[
          {date:period.from,hourLocal:10,locationId:null,netSalesCents:3000,ordersCount:8},
          {date:period.from,hourLocal:14,locationId:null,netSalesCents:1820,ordersCount:4},
        ]}};
      });
      const profit=vi.fn<AgentToolContext["tools"]["getProfitability"]>().mockImplementation(
        ()=>new Promise<Awaited<ReturnType<AgentToolContext["tools"]["getProfitability"]>>>(()=>{}));
      const ctx:AgentToolContext={...context,currency:"USD",tools:{...context.tools,
        getSalesTrend:sales,getPeakHours:peak,getProfitability:profit}};
      const requests:Record<string,unknown>[]=[];
      const answer="Recorded sales were $48.20. Hourly activity is available, but I could not verify profit.";
      const provider:AgentProvider=async function*(params){
        requests.push(params);
        if(requests.length===1){
          yield call("get_sales",JSON.stringify({period,ownerInputs:null}),"u1-delayed-sales");
          yield call("get_peak_hours",JSON.stringify(period),"u1-delayed-peak");
          yield call("get_profit",JSON.stringify({period,ownerInputs:null}),"u1-delayed-profit");
        }else{
          // Reproduce a late but completed final synthesis, not a real network wait.
          await new Promise<void>(resolve=>setTimeout(resolve,11684));
          yield text(answer);
        }
        yield completed;
      };
      const pending=runAgentTurn({ownerText:"For October 20, 2026, report sales, peak hours and profit.",context:ctx,provider});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60000);
      const result=await pending;
      expect(result.text).toBe(answer);
      expect(result.endReason).toBe("timeout");
      expect(result.usage.modelCalls).toBe(2);
      expect(result.usage.toolCalls).toBe(3);
      expect(result.usage.latencyMs).toBe(59684);
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({source:"daily_rollups",period,netSalesCents:4820}),
        expect.objectContaining({source:"get_peak_hours",period,totalNetSalesCents:4820,
          totalOrdersCount:12,topHours:[{hourLocal:10,netSalesCents:3000,ordersCount:8},{hourLocal:14,netSalesCents:1820,ordersCount:4}]}),
        expect.objectContaining({source:"get_profit",period,missing:["deadline_exceeded"]}),
      ]));
      expect(requests[1].tool_choice).toBe("none");
      expect((requests[1].input as Array<Record<string,unknown>>).filter(x=>x.type==="function_call_output")
        .map(x=>x.call_id)).toEqual(["u1-delayed-sales","u1-delayed-peak","u1-delayed-profit"]);
    }finally{vi.useRealTimers();}
  });
});
