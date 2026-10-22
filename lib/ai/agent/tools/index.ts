import { z } from "zod";
import { netSalesCentsForPeriod } from "@/lib/calc/profit";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { CafeStatePeriod } from "@/lib/operating/types";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type AgentLocale = "en" | "es" | "ar";
export type AgentToolResult = {
  source: string; period: CafeStatePeriod | null; missing: string[];
  labels: Record<string, string>; [field: string]: unknown;
};
export type AgentToolContext = {
  tools: Pick<BusinessScopedCafeTools, "getProfitability" | "getSalesTrend" | "getMenuCatalog">;
  asOf: string; locale: AgentLocale;
};
const periodSchema = z.strictObject({ period: z.enum(["today", "week", "month"]) });
const menuSchema = z.strictObject({});
const schemas = { get_profit: periodSchema, get_sales: periodSchema, get_menu_items: menuSchema } as const;
export type AgentToolName = keyof typeof schemas;
const descriptions: Record<AgentToolName, string> = {
  get_profit: "Read actual profit and costs for a current calendar period; reports missing inputs.",
  get_sales: "Read recorded daily sales with coverage for a current calendar period.",
  get_menu_items: "Read up to eight active menu items, IDs and current prices.",
};
export const agentToolDefinitions = (Object.keys(schemas) as AgentToolName[]).map(name => ({
  type: "function" as const, name, description: descriptions[name], strict: true as const,
  parameters: z.toJSONSchema(schemas[name], { target: "draft-07" }),
}));

function requestedPeriod(choice: "today" | "week" | "month", asOf: string): CafeStatePeriod {
  const start = choice === "today" ? asOf
    : choice === "month" ? asOf.slice(0, 7) + "-01"
    : new Date(Date.parse(asOf + "T12:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
  return { from: start, to: asOf };
}
const labelFiles = { en, es, ar };
function labels(locale: AgentLocale): Record<string, string> {
  return labelFiles[locale].AgentFields;
}
function absent(source: string, period: CafeStatePeriod | null, missing: string[], locale: AgentLocale): AgentToolResult {
  return { source, period, missing: missing.length ? missing : ["sourceUnavailable"], labels: labels(locale) };
}

/** Only pre-authorized, tenant-bound readers reach these handlers. No model-supplied business ID. */
export async function executeAgentTool(name: string, raw: unknown, ctx: AgentToolContext): Promise<AgentToolResult> {
  if (!Object.hasOwn(schemas, name)) throw new Error("unknown_tool");
  const validName = name as AgentToolName;
  const input = schemas[validName].parse(raw);
  if (validName === "get_menu_items") {
    const slice = await ctx.tools.getMenuCatalog();
    if (!slice.available) return absent("menu_items", null, slice.quality.missingInputs, ctx.locale);
    const items = slice.value.filter(item => item.active).slice(0, 8).map(item => ({
      id: item.id, name: item.name, category: item.category, priceCents: item.priceCents,
    }));
    return { source: "menu_items", period: null, labels: labels(ctx.locale),
      missing: [...slice.quality.missingInputs, ...(slice.value.filter(item => item.active).length > 8 ? ["moreMenuItems"] : [])],
      items };
  }
  const period = requestedPeriod((input as z.infer<typeof periodSchema>).period, ctx.asOf);
  if (validName === "get_profit") {
    // The existing canonical profit calculation supports only current-month snapshots.
    if (period.from < ctx.asOf.slice(0, 7) + "-01")
      return absent("profitability", period, ["profitPeriodOutsideCurrentMonth"], ctx.locale);
    const slice = await ctx.tools.getProfitability(period);
    if (!slice.available) return absent("profitability", period, slice.quality.missingInputs, ctx.locale);
    return { source: "profitability", period, labels: labels(ctx.locale),
      missing: slice.quality.missingInputs, estimated: slice.quality.estimatedInputs,
      netSalesCents: slice.value.netSalesCents, totalCostsCents: slice.value.totalCostsCents,
      ownerProfitCents: slice.value.ownerProfitCents, operatingMargin: slice.value.operatingMargin,
      coveredSalesDays: slice.value.coveredSalesDays, expectedSalesDays: slice.value.expectedSalesDays };
  }
  const slice = await ctx.tools.getSalesTrend(period);
  if (!slice.available) return absent("daily_rollups", period, slice.quality.missingInputs, ctx.locale);
  return { source: "daily_rollups", period, labels: labels(ctx.locale),
    missing: slice.quality.missingInputs,
    netSalesCents: netSalesCentsForPeriod(slice.value),
    days: slice.value.slice(-7).map(day => ({ date: day.date, netSalesCents: day.netSalesCents })) };
}
