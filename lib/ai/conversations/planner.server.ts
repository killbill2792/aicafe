import "server-only";
import { z } from "zod";

const period = z.enum(["today", "month_to_date", "last_seven_days", "last_28_days", "yesterday", "previous_month", "other_period"]);
const financeMetric = z.enum(["monthly_bills", "accrued_fixed_bills", "recorded_spending", "total_business_costs", "owner_profit", "sales_revenue", "overview"]);
const menuOperation = z.enum(["product_count", "active_product_count", "category_summary", "active_products", "product_details"]);
const salesMetric = z.enum(["product_units", "drinks", "orders", "distinct_products", "best_seller", "least_seller", "named_product_units", "sales_revenue"]);
const agent = z.enum(["all", "supervisor", "alex", "olivia", "maya", "leo"]);
const taskStatus = z.enum(["all", "needs_you", "handled", "watching"]);
export const supervisorPlanSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("read_finances"), arguments: z.strictObject({ metric: financeMetric, period }) }),
  z.strictObject({ name: z.literal("read_menu"), arguments: z.strictObject({ operation: menuOperation, product_name: z.string().max(120).nullable() }) }),
  z.strictObject({ name: z.literal("read_sales"), arguments: z.strictObject({
    metric: salesMetric, period, category: z.enum(["all", "drink", "food", "coffee"]),
    product_name: z.string().max(120).nullable(),
  }) }),
  z.strictObject({ name: z.literal("read_team"), arguments: z.strictObject({ agent, status: taskStatus }) }),
  z.strictObject({ name: z.literal("read_pricing"), arguments: z.strictObject({ product_name: z.string().max(120).nullable() }) }),
  z.strictObject({ name: z.literal("read_rules"), arguments: z.strictObject({ agent }) }),
  z.strictObject({ name: z.literal("clarify"), arguments: z.strictObject({ topic: z.enum(["product", "period", "question", "unsupported"]) }) }),
]);
export type SupervisorPlan = z.infer<typeof supervisorPlanSchema>;
export type SupervisorUsage = { model: string; inputTokens: number; outputTokens: number };
export type SupervisorPlanResponse = { plan: SupervisorPlan; usage: SupervisorUsage };

const enumSchema = (values: readonly string[]) => ({ type: "string", enum: values });
const nullableString = { type: ["string", "null"], maxLength: 120 };
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({
  type: "function", name, description, strict: true,
  parameters: {
    type: "object", properties,
    required: Object.keys(properties), additionalProperties: false,
  },
});
export const SUPERVISOR_FUNCTIONS = [
  tool("read_finances", "Use for bills budgets, fixed-bill accrual, actual expense entries, full modeled business costs, profitability, revenue and overall café performance. Expenses are not interchangeable with bills.", {
    metric: enumSchema(financeMetric.options), period: enumSchema(period.options),
  }),
  tool("read_menu", "Use for menu catalog membership, total or active menu product counts, available-for-order listed products, categories and product details. Active is not proof of physical stock. Never query item sales to count catalog items.", {
    operation: enumSchema(menuOperation.options), product_name: nullableString,
  }),
  tool("read_sales", "Use for quantities, orders, drinks, individual product sales, best/least sellers and sales revenue. Quantities are never amounts of money. Do not infer that all drinks are coffee.", {
    metric: enumSchema(salesMetric.options), period: enumSchema(period.options),
    category: enumSchema(["all", "drink", "food", "coffee"]),
    product_name: nullableString,
  }),
  tool("read_team", "Use only for persisted Team tasks and statuses; never fabricate tasks from suggestions.", {
    agent: enumSchema(agent.options), status: enumSchema(taskStatus.options),
  }),
  tool("read_pricing", "Read canonical menu pricing recommendations, review only; never change prices.", {
    product_name: nullableString,
  }),
  tool("read_rules", "Read approved owner Team rules, not unapproved drafts.", {
    agent: enumSchema(agent.options),
  }),
  tool("clarify", "Use only if no reliable read-only tool can answer the question. Never guess business records.", {
    topic: enumSchema(["product", "period", "question", "unsupported"]),
  }),
] as const;

export function validateResponsePlan(payload: unknown): SupervisorPlan {
  if (typeof payload !== "object" || payload === null || !("output" in payload)) {
    throw new Error("Supervisor planner returned no tool output");
  }
  if ((payload as { status?: unknown }).status === "incomplete") throw new Error("Supervisor planner incomplete");
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) throw new Error("Supervisor planner output invalid");
  const calls = output.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && (item as { type?: unknown }).type === "function_call");
  // A one-operation response is the maximum authority granted to a planner turn.
  if (calls.length !== 1 || typeof calls[0].name !== "string" || typeof calls[0].arguments !== "string") {
    throw new Error("Supervisor planner must select exactly one read-only tool");
  }
  if (calls[0].arguments.length > 2400) throw new Error("Supervisor planner arguments too large");
  const args: unknown = JSON.parse(calls[0].arguments);
  return supervisorPlanSchema.parse({ name: calls[0].name, arguments: args });
}

type ResponsesTransport = (url: string, init: RequestInit) => Promise<Response>;
/** No private business facts or tenant identity are put in the planner prompt.
 * Function arguments can never choose a tenant or a SQL table.
 */
export async function planSupervisorQuestion(input: {
  text: string; locale: "en" | "es" | "ar"; asOf: string;
  history: { role: "owner" | "supervisor"; text: string }[];
}, transport: ResponsesTransport = fetch): Promise<SupervisorPlanResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Supervisor planner unavailable");
  const model = process.env.SUPERVISOR_OPENAI_MODEL || "gpt-6-luna";
  const instructions = [
    "You plan one read-only AI CAFE tool call for a café owner. Choose exactly one tool.",
    "Do NOT answer from general knowledge or invent figures. Do NOT issue writes.",
    "Interpret owner intent semantically, including paraphrases, follow-ups and en/es/ar.",
    "Choose month_to_date for 'so far this month'; today for 'today'.",
    "For 'monthly bills' use monthly_bills, for 'total expenses this month' use total_business_costs,",
    "for 'spent this month' use recorded_spending and for 'fixed bills accrued' use accrued_fixed_bills.",
    "For a count or listing of menu products choose read_menu, regardless of item-sales backfill.",
    "For active/available menu products choose read_menu/active_products or active_product_count; active does not mean in stock.",
    "For different products sold choose read_sales/distinct_products; for units sold choose read_sales/product_units.",
    "For product quantities choose read_sales/product_units, NEVER revenue or order count.",
    "For general 'how are my sales doing' use sales_revenue.",
    "For total sales today use read_sales/sales_revenue with today.",
    "For what needs my attention use read_team/needs_you; for what the team handled use read_team/handled.",
    "For yesterday choose yesterday, for last month choose previous_month, and for any other unrepresented dates choose other_period. Never relabel historic periods as current.",
    "Use clarify only for unrelated requests or genuinely unresolved ambiguity.",
    "The data tool is authoritative and may return unavailable.",
    "The output MUST be a function call, never a free-form answer.",
    "Date in café timezone: " + input.asOf + ". Locale: " + input.locale,
  ].join(" ");
  const history = input.history.slice(-6).filter((h) => h.text.trim()).map((h) => ({
    role: h.role === "owner" ? "user" as const : "assistant" as const,
    content: h.text.slice(0, 600),
  }));
  let lastFailure: unknown;
  // One bounded retry for transient OpenAI failures, incomplete responses and invalid tool output.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18_000);
    let retryable = true;
    try {
      const response = await transport("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          model, instructions,
          input: [...history, { role: "user", content: input.text.slice(0, 4000) }],
          tools: SUPERVISOR_FUNCTIONS,
          tool_choice: "required", parallel_tool_calls: false,
          reasoning: { effort: "none" }, max_output_tokens: 800, store: false,
        }),
      });
      if (!response.ok) {
        // Bad credentials, unavailable models and invalid parameters will not improve on retry.
        retryable = response.status === 408 || response.status === 409 ||
          response.status === 429 || response.status >= 500;
        throw new Error("Supervisor planner unavailable");
      }
      const payload: unknown = await response.json();
      const plan = validateResponsePlan(payload);
      const u = payload as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const sane = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
      return { plan, usage: {
        model: (u.model || model).slice(0, 80),
        inputTokens: sane(u.usage?.input_tokens), outputTokens: sane(u.usage?.output_tokens),
      } };
    } catch (error) {
      lastFailure = error;
      if (attempt === 1 || !retryable) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  // Never surface raw provider payloads or request headers to owners.
  void lastFailure;
  throw new Error("Supervisor planner unavailable");
}
