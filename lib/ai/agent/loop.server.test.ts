import { describe, expect, it } from "vitest";
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
      [call("get_menu_items","{}","call1"),completed],
      [text("Latte costs $4.50."),completed],
    ])});
    expect(result.usage.toolCalls).toBe(1);
    expect(result.status.status).toBe("complete");
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
    const input = requests[2].input;
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) throw new Error("expected message array");
    const recordIds = (type: string) => input.filter(v => v && typeof v === "object" && v.type === type)
      .map(v => v.call_id).sort();
    expect(recordIds("function_call")).toEqual(recordIds("function_call_output"));
    expect(result.endReason).toBe("tool_errors");
    expect(result.status).toMatchObject({status:"partial"});
  });
  it("keeps streamed text after provider error and makes no-tool fallback", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider: AgentProvider = async function* (params) {
      requests.push(params);
      if (requests.length === 1) {
        yield text("Sales are ");
        throw new Error("connection lost");
      }
      yield text("not confirmed.");yield completed;
    };
    const result = await runAgentTurn({ownerText:"Sales?",context,provider});
    expect(result.text).toBe("Sales are not confirmed.");
    expect(result.endReason).toBe("provider_error");
    expect(requests[1].tool_choice).toBe("none");
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
