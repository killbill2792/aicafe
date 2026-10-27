import { z } from "zod";
import {askOwnerTools} from "./askOwner";
import {resolveEntity,resolveChosenEntity,ownerNamedTarget,choicePayload,ownerChoiceGuard,periodChoicePayload,resolveOwnerPeriod} from "../resolve";

import {money,count} from "../explain";
import { initiativeToolDefinitions,isInitiativeTool,executeInitiativeTool } from "./initiatives";
import { staffTools } from "./staff";
import { attentionTools } from "./attention";
import {scheduleReadTools} from "./scheduleReads";
import { hoursTools } from "./hours";
import { moneyTools } from "./money";
import { suppliesTools } from "./supplies";
import { salesTools } from "./sales";
import {draftScheduleTools} from "./draftSchedule";
import {newItemPriceTools} from "./newItemPrice";
import {proposalTools} from "./proposals";
import {purchasesTools,purchaseToolInput} from "./purchases";
import {priceExperimentTools} from "./priceExperiment";
import {ownerInputsSchema,ownerAmountForPeriod,ownerConflict} from "./ownerInputs";
import {moneyChoiceCandidates,chosenMoneySource,replayedMoneyChoice} from "../resolveMoney";
import {staffProposalTools} from "./staffProposals";
import {memoryTools,type CafeMemoryPort} from "./memory";
import { netSalesCentsForPeriod } from "@/lib/calc/profit";
import {ToolError} from "../toolErrors";
import {requestedPeriod as calcRequestedPeriod} from "@/lib/calc/periods";
import {resolveCoveredSalesWindow} from "./coverage";
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
  menuPriceEvidence?:(items:ReadonlyArray<{id:string;priceCents:number}>)=>Promise<Record<string,import("@/lib/data/menuPriceEvidence.server").MenuPriceEvidence>>;
  proposals?: {proposePriceChange(input:{productId:string;newPriceCents:number}):Promise<{proposalId:string;revision:number;productName:string;oldPriceCents:number;newPriceCents:number}>;
    proposePriceExperiment?(input:{productId:string;newPriceCents:number|null;increaseCents:number|null;days:number}):Promise<{proposalId:string;revision:number;productName:string;oldPriceCents:number;newPriceCents:number}>;
    proposeStaff?(input:{name:import("./staffProposals").StaffProposalName;input:unknown}):Promise<{proposalId:string;revision:number;capabilityId:string}>;
    proposePurchases?(input:z.infer<typeof purchaseToolInput>):Promise<Array<{proposalId?:string;revision?:number;name:string;error?:string}>>;};
};
const periodSchema = z.strictObject({ period: z.union([z.string().min(1).max(32),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})]),ownerInputs:ownerInputsSchema.nullable().optional() });
// Nullable values are semantically optional while retaining the all-required OpenAI strict schema.
const menuSchema = z.strictObject({ query: z.string().max(120).nullable(), limit: z.number().int().min(1).max(25).nullable() });
const posPeriodSchema=z.strictObject({from:z.iso.date(),to:z.iso.date()});
const posReadTools={
  get_peak_hours:{schema:posPeriodSchema,description:"Read recorded hourly revenue and order counts for a date range."},
  get_employee_sales:{schema:posPeriodSchema,description:"Read recorded employee-attributed sales for a date range."},
  get_payroll_facts:{schema:posPeriodSchema,description:"Read imported pay-period facts without inferring missing wages or taxes."}
};
export const schemas = { ...askOwnerTools, ...posReadTools, ...attentionTools, get_profit: periodSchema, get_sales: periodSchema, get_menu_items: menuSchema,
  ...staffTools, ...scheduleReadTools, ...hoursTools, ...moneyTools, ...suppliesTools, ...salesTools,...draftScheduleTools,...newItemPriceTools,...proposalTools,...priceExperimentTools,...staffProposalTools,...purchasesTools } as const;
export type AgentToolName = keyof typeof schemas;
/** Input fields backed by the shared entity/period resolver. A new tool whose
 * strict schema accepts a target must declare the corresponding field here;
 * creation inputs have explicit exemptions below. */
export const resolverCoverage:Partial<Record<AgentToolName,readonly string[]>>={
  get_profit:["period"],get_sales:["period"],get_menu_items:["query"],
  get_labor:["period"],get_team:["name"],get_shift_cost:["employee_id"],
  get_expenses:["period","category"],get_cost_summary:["period"],
  get_item_sales:["period","query"],get_price_recommendation:["itemId"],
  get_ingredient_costs:["query"],get_product_costs:["itemId"],
  propose_price_change:["product_id"],propose_price_experiment:["product_id"],propose_staff_change:["employee_id"],
  propose_schedule:["shifts.employee_id"],propose_shift_change:["shift.employee_id"],
  get_peak_hours:["from","to"],get_employee_sales:["from","to"],
  get_payroll_facts:["from","to"],
  propose_availability_change:["instruction"]
};
export const resolverExemptions:Partial<Record<AgentToolName,readonly string[]>>={
  // These fields describe NEW values, not names or IDs of existing records.
  propose_add_staff:["name"],propose_staff_change:["name"],
  suggest_new_item_price:["category"]
};

export function agentForTool(name:string):"alex"|"olivia"|"maya"|"leo"{return name==="get_payroll_facts"||name in staffTools||name in scheduleReadTools||name in hoursTools||name in draftScheduleTools||name in staffProposalTools?"olivia":name in moneyTools||name==="get_profit"?"leo":name in suppliesTools||name in purchasesTools?"maya":"alex";}
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

export const requestedPeriod=calcRequestedPeriod;

function absent(source: string, period: CafeStatePeriod | null, missing: string[]): AgentToolResult {
  return { source, period, agentId:source==="profitability"?"leo":"alex",
    missing: missing.length ? missing : ["sourceUnavailable"] };
}
export async function executeAgentTool(name: string, raw: unknown, ctx: AgentToolContext): Promise<AgentToolResult> {
  // Backend-only: do not register proposal creation until a real approval surface is available.
  if(name==="propose_initiative")throw new ToolError("not_supported");
  if(isInitiativeTool(name))return executeInitiativeTool(name,raw,ctx);
  // Flag-gated extra tool: only offered to the model when CHAT_MEMORY is on.
  if(name==="remember_cafe_fact")return memoryTools.remember_cafe_fact.execute(raw,ctx);
  if (!Object.hasOwn(schemas, name)) throw new ToolError("not_supported");
  if(name==="ask_owner")return askOwnerTools.ask_owner.execute(raw,ctx);
  if(name==="draft_week_schedule")return draftScheduleTools.draft_week_schedule.execute(raw,ctx);
  if(name==="suggest_new_item_price")return newItemPriceTools.suggest_new_item_price.execute(raw,ctx);
  if(name==="propose_price_change")return proposalTools.propose_price_change.execute(raw,ctx);
   if(name==="propose_purchases")return purchasesTools.propose_purchases.execute(raw,ctx);
  if(name==="propose_price_experiment")return priceExperimentTools.propose_price_experiment.execute(raw,ctx);
  if(Object.hasOwn(staffProposalTools,name))return staffProposalTools[name as keyof typeof staffProposalTools].execute(raw,ctx);
  if(name==="get_attention_items")return attentionTools.get_attention_items.execute(raw,ctx);
  if(name==="get_staff")return staffTools.get_staff.execute(raw,ctx);
  if(name==="get_schedule")return staffTools.get_schedule.execute(raw,ctx);
  if(name==="get_labor")return staffTools.get_labor.execute(raw,ctx);
  if(name==="get_team")return scheduleReadTools.get_team.execute(raw,ctx);
  if(name==="get_week_schedule")return scheduleReadTools.get_week_schedule.execute(raw,ctx);
  if(name==="get_labor_rules")return scheduleReadTools.get_labor_rules.execute(raw);
  if(name==="get_coverage_gaps")return scheduleReadTools.get_coverage_gaps.execute(raw,ctx);
  if(name==="get_shift_cost")return scheduleReadTools.get_shift_cost.execute(raw,ctx);
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
    const input=posPeriodSchema.parse(raw);
    const checked=resolveOwnerPeriod(input,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"},ctx.resolveState);
    if(checked.status!=="resolved")return periodChoicePayload(name,checked);
    const period={from:checked.value.from,to:checked.value.to};
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
    const [slice,ownerCosts,labor,toastScopes]=await Promise.all([
      ctx.tools.getPayrollFacts?.(period),
      ctx.tools.getOwnerMonthlyPayrollExtras?.(),
      ctx.tools.getLaborMetrics?.(period),
      ctx.tools.getToastScopeCoverage?.(),
    ]);
    const ownerMonthlyPayrollExtrasCents=ownerCosts?.available?
      ownerCosts.value.monthlyCents:null;
    const unknownWageDates=labor?.available?
      labor.value.filter(day=>day.wagesCents===null).map(day=>day.date):[];
    const observedToastWagesCents=labor?.available&&unknownWageDates.length===0&&
      labor.value.every(day=>day.wagesCents!==null)?
      labor.value.reduce((total,day)=>total+day.wagesCents!,0):null;
    const costEvidence={
      toastLaborScopeAvailable:toastScopes?.available?toastScopes.value.labor:null,
      ownerMonthlyPayrollExtrasCents,ownerMonthlyPayrollSource:ownerMonthlyPayrollExtrasCents===null?
        null:"You told me" as const,
      ownerMonthlyPayrollStatus:ownerMonthlyPayrollExtrasCents===null?"missing":"estimate",
      observedToastWagesCents,
      observedWageStatus:unknownWageDates.length?"unknown":"recorded",
    };
    if(!slice?.available)return {source:name,period,agentId:"olivia",
      missing:[...(slice?.quality.missingInputs??["toastPayrollRunsNotAvailable"]),
        ...(ownerMonthlyPayrollExtrasCents===null?["ownerMonthlyPayrollExtrasNotSet"]:[]),
        ...unknownWageDates.map(day=>"laborWageUnknown:"+day),
        ...(toastScopes?.available&&toastScopes.value.labor===false?["toastLaborScopeMissing"]:[])],
      ...costEvidence};
    return {source:name,period,agentId:"olivia",
      missing:[...slice.quality.missingInputs,
        ...(ownerMonthlyPayrollExtrasCents===null?["ownerMonthlyPayrollExtrasNotSet"]:[]),
        ...unknownWageDates.map(day=>"laborWageUnknown:"+day),
        ...(toastScopes?.available&&toastScopes.value.labor===false?["toastLaborScopeMissing"]:[])],
      ...costEvidence,...summarizePayrollFacts(slice.value)};
  }
  if(name==="get_item_sales")return salesTools.get_item_sales.execute(raw,ctx);
  if(name==="get_price_recommendation")return salesTools.get_price_recommendation.execute(raw,ctx);
  if (name === "get_menu_items") {
    const input = menuSchema.parse(raw);
    const [slice,toastScopes] = await Promise.all([
      ctx.tools.getMenuCatalog(),ctx.tools.getToastScopeCoverage?.(),
    ]);
    if (!slice.available) return absent("menu_items", null, [
      ...slice.quality.missingInputs,
      ...(toastScopes?.available&&toastScopes.value.menus===false?["toastMenuScopeMissing"]:[])
    ]);
    const active=slice.value.filter(item=>item.active);
    let filtered=active;
    if(input.query){
      const chosen=resolveChosenEntity(ctx.resolveState,active,i=>i.id);
      if(chosen)filtered=[chosen];
      else{
        const resolved=resolveEntity("product",input.query,active,{nameOf:i=>i.name,idOf:i=>i.id,
          describe:i=>i.category+" · "+(i.priceCents===null?"open price":(i.priceCents/100).toFixed(2))});
        if(resolved.status!=="resolved")return {...choicePayload(resolved,"menu_items",null),agentId:"alex"};
        filtered=[resolved.value];
      }
    }
    if(input.query&&filtered.length===1&&!ownerNamedTarget(ctx.resolveState,filtered[0].id,filtered[0].name))
      return {source:"menu_items",period:null,agentId:"alex",missing:["targetNotConfirmed"]};
    const limit = input.limit ?? 8;
    const visible=filtered.slice(0,limit);
    let facts:Record<string,import("@/lib/data/menuPriceEvidence.server").MenuPriceEvidence>={};
    let evidenceUnavailable=false;
    try {if(ctx.menuPriceEvidence)facts=await ctx.menuPriceEvidence(visible.filter(
      (item):item is typeof item & {priceCents:number}=>item.priceCents!==null));}
    catch {evidenceUnavailable=true;}
    return { source: "menu_items", period: null, agentId:"alex",
      missing: [...slice.quality.missingInputs, ...(filtered.length > limit ? ["moreMenuItems"] : []),
        ...(evidenceUnavailable?["menuPriceEvidenceUnavailable"]:[]),
        ...(toastScopes?.available&&toastScopes.value.menus===false?["toastMenuScopeMissing"]:[])],
      toastMenuScopeAvailable:toastScopes?.available?toastScopes.value.menus:null,
      items: visible.map(item => ({
        id: item.id, name: item.name, category: item.category, priceCents: item.priceCents,unit:"cents",
        baseName:item.baseName,sizeLabel:item.sizeLabel,description:item.description,
        menuGroup:item.menuGroup,visibility:item.visibility,pricingStrategy:item.pricingStrategy,
        priceStatus:item.priceCents===null?"open_or_unknown":"fixed",
        modifierGroups:item.modifierGroups,
        priceSource:item.priceCents===null?"unknown":evidenceUnavailable?"unknown":facts[item.id]?.priceSource??"initial",
        realizedAvgCents:facts[item.id]?.realizedAvgCents??null,
        priceCheck:facts[item.id]?.priceCheck??"unknown",pricePeriod:facts[item.id]?.pricePeriod??null,
        priceEvidenceStatus:facts[item.id]?.priceEvidenceStatus??"unknown",
      })) };
  }
  const {period:choice,ownerInputs}=periodSchema.parse(raw);
  const resolved=resolveOwnerPeriod(choice,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"},ctx.resolveState);
  if(resolved.status!=="resolved")return periodChoicePayload(name,resolved);
  const requested={from:resolved.value.from,to:resolved.value.to};
  // An explicitly requested historical period must never be silently replaced.
  const canFallback=typeof choice==="string"&&["today","week","month"].includes(choice);
  const selection=canFallback?await resolveCoveredSalesWindow(ctx,requested):{period:requested,label:null,coverageFallback:null};
  const period=selection.period;
  if(name==="get_profit"){
    const slice=await ctx.tools.getProfitability(period);
    const identity=period.from+"/"+period.to;
    const recordedSales=slice.available?slice.value.netSalesCents:null;
    const replay=recordedSales!==null?
      replayedMoneyChoice(ctx.resolveState,"sales",identity,recordedSales):null;
    const hasPriorSalesChoice=[...(ctx.resolveState?.chosenIds??[])].some(id=>
      id.startsWith("sales:"+identity.toLowerCase()+":"));
    if(slice.available&&hasPriorSalesChoice&&!replay)
      return {source:"profitability",period,agentId:"leo",
        missing:["sourceChoiceExpired"],needsOwnerChoice:false,
        coverageLabel:selection.label,coverageFallback:selection.coverageFallback};
    const suppliedSales=ownerInputs?.netSalesCents!=null?
      ownerAmountForPeriod(ownerInputs.netSalesCents,ownerInputs.salesPeriod,period,ctx.asOf):null;
    const ownerSales=suppliedSales??(ownerInputs?.netSalesCents==null?replay?.ownerCents??null:null);
    if(!slice.available)return {source:"profitability",period,agentId:"leo",
      coverageLabel:selection.label,coverageFallback:selection.coverageFallback,unit:"cents",ownerInputs:ownerInputs??null,
      ownerReportedSalesCents:ownerInputs?.netSalesCents??null,
      ownerReportedSalesPeriod:ownerInputs?.salesPeriod??null,
      netSalesCents:suppliedSales,netSalesProvenance:suppliedSales!==null?"ownerProvided":null,
      totalCostsCents:null,ownerProfitCents:null,operatingMargin:null,
      missing:[...slice.quality.missingInputs,...(ownerInputs?.netSalesCents!=null?["costsUnverified"]:[]),
        ...(ownerInputs?.netSalesCents!=null&&suppliedSales===null?["ownerSalesPeriodMismatch"]:[])]};
    const conflict=ownerConflict(recordedSales,ownerSales);
    const candidates=conflict&&recordedSales!==null&&ownerSales!==null?
      moneyChoiceCandidates("sales",identity,recordedSales,ownerSales,ctx.locale):null;
    const selected=candidates?
      chosenMoneySource(ctx.resolveState,candidates)??(replay?.ownerCents===ownerSales?replay.source:null):null;
    if(conflict&&selected===null)return {source:"profitability",period,coverageLabel:selection.label,coverageFallback:selection.coverageFallback,
      agentId:"leo",unit:"cents",ownerInputs:ownerInputs??null,
      ownerSalesConflict:{recordedCents:recordedSales,ownerCents:ownerSales},
      recordedNetSalesCents:recordedSales,ownerReportedSalesCents:ownerSales,
      netSalesCents:null,totalCostsCents:null,ownerProfitCents:null,operatingMargin:null,
      needsOwnerChoice:true,candidates,missing:[...slice.quality.missingInputs,"ownerChoiceRequired"],
      estimated:slice.quality.estimatedInputs,explain:[]};
    if(conflict&&selected==="owner")return {source:"profitability",period,coverageLabel:selection.label,coverageFallback:selection.coverageFallback,
      agentId:"leo",unit:"cents",ownerInputs:ownerInputs??null,
      selectedMoneySource:"ownerProvided",ownerReportedSalesCents:ownerSales,
      recordedNetSalesCents:recordedSales,netSalesCents:ownerSales,netSalesProvenance:"ownerProvided",
      totalCostsCents:null,ownerProfitCents:null,operatingMargin:null,
      needsOwnerChoice:false,missing:[...slice.quality.missingInputs,"recordedProfitNotApplicable"],
      estimated:slice.quality.estimatedInputs,explain:[]};
    return {source:"profitability",period,coverageLabel:selection.label,coverageFallback:selection.coverageFallback,agentId:"leo",unit:"cents",
      missing:[...slice.quality.missingInputs,
        ...(ownerInputs?.netSalesCents!=null&&suppliedSales===null?["ownerSalesPeriodMismatch"]:[])],
      ownerReportedSalesCents:ownerInputs?.netSalesCents??replay?.ownerCents??null,
      ownerReportedSalesPeriod:ownerInputs?.salesPeriod??null,
      ownerSalesConflict:conflict?{recordedCents:recordedSales,ownerCents:ownerSales}:null,
      selectedMoneySource:conflict?"recorded":null,
      needsOwnerChoice:false,estimated:slice.quality.estimatedInputs,
      netSalesCents:slice.value.netSalesCents,totalCostsCents:slice.value.totalCostsCents,
      ownerProfitCents:slice.value.ownerProfitCents,operatingMargin:slice.value.operatingMargin,
      ownerInputs:ownerInputs??null,
      explain:[{label:"Owner profit",inputs:[
        {name:"netSales",value:money(slice.value.netSalesCents)},
        {name:"cost",value:money(slice.value.totalCostsCents)}],
        formula:"subtract",result:money(slice.value.ownerProfitCents),period,source:"get_profit",
        provenance:slice.quality.estimatedInputs.length?"estimate":"recorded"}],
      coveredSalesDays:slice.value.coveredSalesDays,expectedSalesDays:slice.value.expectedSalesDays};
  }
  if(name!=="get_sales")throw new ToolError("not_supported");
  const slice=await ctx.tools.getSalesTrend(period);
  if(!slice.available)return {...absent("daily_rollups",period,slice.quality.missingInputs),coverageLabel:selection.label,coverageFallback:selection.coverageFallback};
  return {source:"daily_rollups",period,coverageLabel:selection.label,coverageFallback:selection.coverageFallback,agentId:"alex",unit:"cents",
    missing:slice.quality.missingInputs,netSalesCents:netSalesCentsForPeriod(slice.value),
    days:slice.value.slice(-7).map(day=>({date:day.date,netSalesCents:day.netSalesCents}))};
}
