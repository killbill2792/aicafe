import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { planSupervisorQuestion, validateResponsePlan, SUPERVISOR_FUNCTIONS } from "./planner.server";

const cases = [
  ["Hi, what are my total expenses for the month?", "read_finances", { metric: "total_business_costs", period: "month_to_date" }],
  ["What are my monthly bills?", "read_finances", { metric: "monthly_bills", period: "month_to_date" }],
  ["How much have I spent so far this month?", "read_finances", { metric: "recorded_spending", period: "month_to_date" }],
  ["How much of my fixed bills has accrued so far?", "read_finances", { metric: "accrued_fixed_bills", period: "month_to_date" }],
  ["What's my profit this month?", "read_finances", { metric: "owner_profit", period: "month_to_date" }],
  ["How many products am I selling so far?", "read_sales", { metric: "product_units", period: "month_to_date", category: "all", product_name: null }],
  ["How many orders did we receive today?", "read_sales", { metric: "orders", period: "today", category: "all", product_name: null }],
  ["What is my best-selling drink?", "read_sales", { metric: "best_seller", period: "month_to_date", category: "drink", product_name: null }],
  ["Which products sell the least?", "read_sales", { metric: "least_seller", period: "month_to_date", category: "all", product_name: null }],
  ["What needs my attention?", "read_team", { agent: "all", status: "needs_you" }],
] as const;
const mockResponse = (name: string, args: object) => ({
  output: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: "call_1" }],
  usage: { input_tokens: 120, output_tokens: 35 }, model: "gpt-4.1-mini",
});

describe("Responses-only Supervisor tool planner", () => {
  it.each(cases)("accepts a validated function plan for: %s", async (_question, name, args) => {
    const parsed = validateResponsePlan(mockResponse(name, args));
    expect(parsed).toEqual({ name, arguments: args });
  });
  it("sends exactly the read-only functions, no tenant ID, arbitrary query, mutation or business evidence", async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only";
    let payload: Record<string, unknown> = {};
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      payload = JSON.parse(String(init.body));
      return new Response(JSON.stringify(mockResponse("read_finances",
        { metric: "total_business_costs", period: "month_to_date" })), { status: 200 });
    });
    try {
      const result = await planSupervisorQuestion({
        text: cases[0][0], asOf: "2026-10-10", locale: "en", history: [],
      }, transport);
      expect(result.plan).toEqual({ name: "read_finances",
        arguments: { metric: "total_business_costs", period: "month_to_date" } });
      expect(result.usage).toEqual({ model: "gpt-4.1-mini", inputTokens: 120, outputTokens: 35 });
      expect(payload.tool_choice).toBe("required");
      expect(payload.parallel_tool_calls).toBe(false);
      expect(payload.store).toBe(false);
      expect((payload.tools as unknown[]).length).toBe(6);
      expect(JSON.stringify(payload.tools)).not.toContain("business_id");
      expect(JSON.stringify(payload.tools)).not.toContain("write_");
      expect(transport).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({ method: "POST" }));
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });
  it("does not trust text, unexpected functions, multiple calls or malformed arguments", () => {
    expect(() => validateResponsePlan({ output: [{ type: "message", content: [{ type: "output_text", text: "Costs are $8000" }] }] })).toThrow();
    expect(() => validateResponsePlan(mockResponse("transfer_money", { amount: 100 }))).toThrow();
    expect(() => validateResponsePlan({ output: [
      mockResponse("read_finances", { metric: "monthly_bills", period: "today" }).output[0],
      mockResponse("read_sales", { metric: "orders", period: "today", category: "all", product_name: null }).output[0],
    ] })).toThrow();
    expect(() => validateResponsePlan(mockResponse("read_finances", {
      metric: "total_business_costs", period: "month_to_date", business_id: "different-cafe",
    }))).toThrow();
    expect(() => validateResponsePlan(mockResponse("read_sales", {
      metric: "product_units", period: "month_to_date", category: "all", product_name: "x".repeat(121),
    }))).toThrow();
  });
  it("never exposes an unscoped generic SQL or mutation tool", () => {
    const names = SUPERVISOR_FUNCTIONS.map((x) => x.name);
    expect(names).toEqual(["read_finances", "read_sales", "read_team", "read_pricing", "read_rules", "clarify"]);
  });
});
