import { z } from "zod";
import {askOwnerTools} from "./askOwner";
import {resolveEntity,choicePayload,ownerChoiceGuard} from "../resolve";
import {resolvePeriod} from "@/lib/calc/periods";
import { initiativeToolDefinitions,isInitiativeTool,executeInitiativeTool } from "./initiatives";
import { staffTools } from "./staff";
import {scheduleReadTools} from "./scheduleReads";
import { hoursTools } from "./hours";
import { moneyTools } from "./money";
import { suppliesTools } from "./supplies";
import { salesTools } from "./sales";
import {draftScheduleTools} from "./draftSchedule";
import {newItemPriceTools} from "./newItemPrice";
import {proposalTools} from "./proposals";
import {staffProposalTools} from "./staffProposals";
import {memoryTools,type CafeMemoryPort} from "./memory";
import { netSalesCentsForPeriod } from "@/lib/calc/profit";
import {summarizePeakHours,summarizeEmployeeSales,summarizePayrollFacts} from "@/lib/calc/posFactSummaries";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { CafeStatePeriod } from "@/lib/operating/types";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type AgentLocale = "en" | "es" | "ar";
export type AgentToolResult = {
  source: string; period: CafeStatePeriod | null; missing: string[]; agentId?: "alex"|"olivia"|"maya"|"leo";
  [field: string]: unknown;
};
export type AgentToolContext = {
  tools: Partial<BusinessScopedCafeTools> & Pick<BusinessScopedCafeTools,"getProfitability"|"getSalesTrend"|"getMenuCatalog">;
  timezone?:string;
  resolveState?:import("../resolve").ResolveState;
  asOf: string; locale: AgentLocale;
  threadId?:string;ownerMessageId?:string;
  /** CHAT_MEMORY only: drafts a café fact for owner approval (RLS, owner-scoped). */
  memory?: CafeMemoryPort;
  proposals?: {proposePriceChange(input:{productId:string;newPriceCents:number}):Promise<{proposalId:string;revision:number;productName:string;oldPriceCents:number;newPriceCents:number}>;
    proposeStaff?(input:{name:import("./staffProposals").StaffProposalName;input:unknown}):Promise<{proposalId:string;revision:number;capabilityId:string}>};
};
const periodSchema = z.strictObject({ period: z.union([z.enum(["today","week","month","last_week","last_month","ytd"]),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})]) });
// Nullable values are semantically optional while retaining the all-required OpenAI strict schema.
const menuSchema = z.strictObject({ query: z.string().max(120).nullable(), limit: z.number().int().min(1).max(25).nullable() });
const posPeriodSchema=z.strictObject({from:z.iso.date(),to:z.iso.date()});
const posReadTools={
  get_peak_hours:{schema:posPeriodSchema,description:"Read recorded hourly revenue and order counts for a date range."},
  get_employee_sales:{schema:posPeriodSchema,description:"Read recorded employee-attributed sales for a date range."},
  get_payroll_facts:{schema:posPeriodSchema,description:"Read imported pay-period facts without inferring missing wages or taxes."}
};
export const schemas = { ...askOwnerTools, ...posReadTools, get_profit: periodSchema, get_sales: periodSchema, get_menu_items: menuSchema,
  ...staffTools, ...scheduleReadTools, ...hoursTools, ...moneyTools, ...suppliesTools, ...salesTools,...draftScheduleTools,...newItemPriceTools,...proposalTools,...staffProposalTools } as const;
export type AgentToolName = keyof typeof schemas;
export function agentForTool(name:string):"alex"|"olivia"|"maya"|"leo"{return name==="get_payroll_facts"||name in staffTools||name in scheduleReadTools||name in hoursTools||name in draftScheduleTools||name in staffProposalTools?"olivia":name in moneyTools||name==="get_profit"?"leo":name in suppliesTools?"maya":"alex";}
const descriptions: Record<string, string> = {
  get_profit: "Read profit for today, trailing seven days or the calendar month. Report missing inputs.",
  get_sales: "Read covered daily sales in a current calendar period.",
  get_menu_items: "Search active menu items by optional query, with optional limit up to 25. Send null when omitted.",
};
const baseToolDefinitions = (Object.keys(schemas) as AgentToolName[]).map(name => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema("schema" in schemas[name] ? schemas[name].schema as z.ZodType : schemas[name], { target: "draft-07" });
  void _schema;
  // Empty strict Zod objects omit required in JSON Schema; OpenAI needs it explicitly.
  const properties=parameters.properties;
  const required=properties && typeof properties==="object" ? Object.keys(properties) : [];
  return { type: "function" as const, name,
    description: "description" in schemas[name] ? schemas[name].description : descriptions[name],
    strict: true as const, parameters:{...parameters,required} };
});
export const agentToolDefinitions=[...baseToolDefinitions,
  ...initiativeToolDefinitions.filter(tool=>tool.name!=="propose_initiative")];
export const agentLabelsPrompt = "Field labels by language (use matching language, not translated numeric units): " +
  JSON.stringify({ en: en.AgentFields, es: es.AgentFields, ar: ar.AgentFields });

export function requestedPeriod(choice: "today" | "week" | "month", asOf: string): CafeStatePeriod {
  const start = choice === "today" ? asOf
    : choice === "month" ? asOf.slice(0, 7) + "-01"
    : new Date(Date.parse(asOf + "T12:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
  return { from: start, to: asOf };
}
function absent(source: string, period: CafeStatePeriod | null, missing: string[]): AgentToolResult {
  return { source, period, agentId:source==="profitability"?"leo":"alex",
    missing: missing.length ? missing : ["sourceUnavailable"] };
}
export async function executeAgentTool(name: string, raw: unknown, ctx: AgentToolContext): Promise<AgentToolResult> {
  // Backend-only: do not register proposal creation until a real approval surface is available.
  if(name==="propose_initiative")throw new Error("initiative_approval_surface_not_available");
  if(isInitiativeTool(name))return executeInitiativeTool(name,raw,ctx);
  // Flag-gated extra tool: only offered to the model when CHAT_MEMORY is on.
  if(name==="remember_cafe_fact")return memoryTools.remember_cafe_fact.execute(raw,ctx);
  if (!Object.hasOwn(schemas, name)) throw new Error("unknown_tool");
  if(name==="ask_owner")return askOwnerTools.ask_owner.execute(raw,ctx);
  if(name==="draft_week_schedule")return draftScheduleTools.draft_week_schedule.execute(raw,ctx);
  if(name==="suggest_new_item_price")return newItemPriceTools.suggest_new_item_price.execute(raw,ctx);
  if(name==="propose_price_change")return proposalTools.propose_price_change.execute(raw,ctx);
  if(Object.hasOwn(staffProposalTools,name))return staffProposalTools[name as keyof typeof staffProposalTools].execute(raw,ctx);
  if(name==="get_staff")return staffTools.get_staff.execute(raw,ctx);
  if(name==="get_schedule")return staffTools.get_schedule.execute(raw,ctx);
  if(name==="get_labor")return staffTools.get_labor.execute(raw,ctx);
  if(name==="get_team")return scheduleReadTools.get_team.execute(raw,ctx);
  if(name==="get_week_schedule")return scheduleReadTools.get_week_schedule.execute(raw,ctx);
  if(name==="get_labor_rules")return scheduleReadTools.get_labor_rules.execute(raw);
  if(name==="get_coverage_gaps")return scheduleReadTools.get_coverage_gaps.execute(raw,ctx);
  if(name==="get_shift_cost")return scheduleReadTools.get_shift_cost.execute(raw);
  if(name==="get_business_hours")return hoursTools.get_business_hours.execute(raw,ctx);
  if(name==="get_expenses")return moneyTools.get_expenses.execute(raw,ctx);
  if(name==="get_bills")return moneyTools.get_bills.execute(raw,ctx);
  if(name==="get_break_even")return moneyTools.get_break_even.execute(raw,ctx);
  if(name==="get_cost_summary")return moneyTools.get_cost_summary.execute(raw,ctx);
  if(name==="get_product_costs")return suppliesTools.get_product_costs.execute(raw,ctx);
  if(name==="get_ingredient_costs")return suppliesTools.get_ingredient_costs.execute(raw,ctx);
  if(name==="get_usage_variance")return suppliesTools.get_usage_variance.execute(raw,ctx);
  if(name==="get_inventory")return suppliesTools.get_inventory.execute(raw);
  if(name==="get_peak_hours"||name==="get_employee_sales"||name==="get_payroll_facts"){
    const period=posPeriodSchema.parse(raw);
    if(period.from>period.to)throw new Error("Invalid reporting range");
    if(name==="get_peak_hours"){
      const slice=await ctx.tools.getPeakHours?.(period);
      if(!slice?.available)return {source:name,period,agentId:"alex",missing:slice?.quality.missingInputs??["posFactsReaderUnavailable"]};
      return {source:name,period,agentId:"alex",missing:slice.quality.missingInputs,...summarizePeakHours(slice.value)};
    }
    if(name==="get_employee_sales"){
      const slice=await ctx.tools.getEmployeeSales?.(period);
      if(!slice?.available)return {source:name,period,agentId:"alex",missing:slice?.quality.missingInputs??["posFactsReaderUnavailable"]};
      return {source:name,period,agentId:"alex",missing:slice.quality.missingInputs,...summarizeEmployeeSales(slice.value)};
    }
    const slice=await ctx.tools.getPayrollFacts?.(period);
    if(!slice?.available)return {source:name,period,agentId:"olivia",missing:slice?.quality.missingInputs??["posFactsReaderUnavailable"]};
    return {source:name,period,agentId:"olivia",missing:slice.quality.missingInputs,...summarizePayrollFacts(slice.value)};
  }
  if(name==="get_item_sales")return salesTools.get_item_sales.execute(raw,ctx);
  if(name==="get_price_recommendation")return salesTools.get_price_recommendation.execute(raw,ctx);
  if (name === "get_menu_items") {
    const input = menuSchema.parse(raw);
    const slice = await ctx.tools.getMenuCatalog();
    if (!slice.available) return absent("menu_items", null, slice.quality.missingInputs);
    const active=slice.value.filter(item=>item.active);
    let filtered=active;
    if(input.query){
      const resolved=resolveEntity("product",input.query,active,{nameOf:i=>i.name,idOf:i=>i.id,
        describe:i=>i.category+" · "+(i.priceCents/100).toFixed(2)});
      if(resolved.status!=="resolved")return {...choicePayload(resolved,"menu_items",null),agentId:"alex"};
      filtered=[resolved.value];
    }
    const limit = input.limit ?? 8;
    return { source: "menu_items", period: null, agentId:"alex",
      missing: [...slice.quality.missingInputs, ...(filtered.length > limit ? ["moreMenuItems"] : [])],
      items: filtered.slice(0, limit).map(item => ({
        id: item.id, name: item.name, category: item.category, priceCents: item.priceCents,
      })) };
  }
  const {period:choice}=periodSchema.parse(raw);
  const resolved=resolvePeriod(choice,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"});
  if(resolved.status!=="resolved")return {source:name,period:null,missing:resolved.status==="ambiguous"?[]:resolved.missing,
    needsOwnerChoice:resolved.status==="ambiguous",candidates:resolved.status==="ambiguous"?resolved.candidates:[]};
  const period={from:resolved.value.from,to:resolved.value.to};
  if (name === "get_profit") {
    const slice = await ctx.tools.getProfitability(period);
    if (!slice.available) return absent("profitability", period, slice.quality.missingInputs);
    return { source: "profitability", period, agentId:"leo", missing: slice.quality.missingInputs,
      estimated: slice.quality.estimatedInputs,
      netSalesCents: slice.value.netSalesCents, totalCostsCents: slice.value.totalCostsCents,
      ownerProfitCents: slice.value.ownerProfitCents, operatingMargin: slice.value.operatingMargin,
      coveredSalesDays: slice.value.coveredSalesDays, expectedSalesDays: slice.value.expectedSalesDays };
  }
  if (name !== "get_sales") throw new Error("unknown_tool");
  const slice = await ctx.tools.getSalesTrend(period);
  if (!slice.available) return absent("daily_rollups", period, slice.quality.missingInputs);
  return { source: "daily_rollups", period, agentId:"alex", missing: slice.quality.missingInputs,
    netSalesCents: netSalesCentsForPeriod(slice.value),
    days: slice.value.slice(-7).map(day => ({ date: day.date, netSalesCents: day.netSalesCents })) };
}
