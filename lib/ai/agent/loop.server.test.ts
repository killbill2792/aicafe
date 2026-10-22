import { describe, expect, it, vi } from "vitest";
import { runAgentTurn, type AgentProvider } from "./loop.server";
import type { AgentToolContext } from "./tools";

const context: AgentToolContext = {
  locale: "en", asOf: "2026-10-21",
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
    expect(result.results).toEqual([{ source: "menu_items", period: null, missing: [], items: [
      { id: "item-1", name: "Latte", category: "drink", priceCents: 450 },
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
    expect(JSON.stringify(requests[2].input)).toContain("invalid_arguments");
    expect(JSON.stringify(requests[2].input)).toContain("issues");
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
      expect(result.text).toBe("");
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
      expect(result.text).toBe("The menu read timed out; I cannot verify it yet.");
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
