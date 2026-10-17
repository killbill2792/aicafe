import "server-only";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import type { CafeState, CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { OperatingTask } from "@/lib/operating/tasks";
import type { EvidenceReference, SupervisorIntent, GroundingStatus, SupervisorReplyBlock } from "./contracts";
import { compareCompleteValues } from "./periodComparison";
import { dateSelectionSchema, rangeExpectedDays, resolveCafeDateRange } from "./dateRange";
import { requestScopeSchema } from "./requestScope";
import { businessCostLimitations } from "@/lib/operating/businessCostMessages";
import { executeOliviaReadCapability } from "@/lib/scheduling/oliviaCapabilities.server";
import type { OliviaWhatIfOverride } from "@/lib/calc/scheduling/oliviaWhatIfOverlay";
import { createP2Registry } from "@/lib/ai/supervisor/p2/registry";
import { buildAlexPricingRegistrations, ALEX_REVIEW_ID, ALEX_SIMULATE_ID } from "@/lib/pricing/alexCapabilities.server";
import { authorizedOwnerP1 } from "@/lib/metrics/p1Readers.server";

const agent = z.enum(["all", "alex", "olivia", "maya", "leo"]);
const oliviaOverride = z.strictObject({
  kind: z.enum(["temporary_unavailable", "reduce_weekly_minutes", "reduce_daily_minutes"]),
  employee_id: z.string().uuid(),
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  start_local: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  end_local: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  overnight: z.boolean().nullable(),
  max_weekly_minutes: z.number().int().min(0).max(10080).nullable(),
  max_minutes: z.number().int().min(0).max(1440).nullable(),
});
const alexChange = z.strictObject({
  kind: z.enum(["ingredient_multiplier", "ingredient_unit_cost", "supplier_package",
    "replace_ingredient", "set_quantity"]),
  ingredient_id: z.string().uuid().nullable(),
  from_ingredient_id: z.string().uuid().nullable(),
  to_ingredient_id: z.string().uuid().nullable(),
  multiplier_basis_points: z.number().int().min(0).max(100000).nullable(),
  cost_per_base_unit_micros: z.number().int().min(0).max(100000000).nullable(),
  package_cost_cents: z.number().int().min(0).max(100000000).nullable(),
  package_count: z.number().int().min(1).max(1000000).nullable(),
  package_unit: z.enum(["gal", "fl_oz", "ml", "g", "each"]).nullable(),
  quantity_value: z.number().finite().positive().max(1000000).nullable(),
  quantity_unit: z.enum(["g", "ml", "fl_oz", "each"]).nullable(),
});
const status = z.enum(["all", "needs_you", "handled", "watching"]);
const date = dateSelectionSchema.shape;
const schemas = {
  declare_request_scope: requestScopeSchema,
  get_cafe_overview: z.strictObject({ focus: z.enum(["today", "month_to_date"]) }),
  get_sales: z.strictObject({
    metric: z.enum(["net_sales", "orders", "units", "distinct_products"]),
    group_by: z.enum(["total", "day", "product", "category"]),
    period: date.period, from: date.from, to: date.to,
    category: z.enum(["all", "drink", "food"]), product_name: z.string().max(120).nullable(),
    sort: z.enum(["highest", "lowest"]), limit: z.number().int().min(1).max(15),
  }),
  get_menu: z.strictObject({
    view: z.enum(["count", "active_count", "category_summary", "products", "product_details"]),
    scope: z.enum(["all", "active"]), product_name: z.string().max(120).nullable(),
    limit: z.number().int().min(1).max(15),
  }),
  get_financials: z.strictObject({
    metric: z.enum(["owner_profit", "total_business_costs", "monthly_bills",
      "recorded_spending", "break_even", "cost_breakdown"]),
    period: date.period, from: date.from, to: date.to,
  }),
  get_staff: z.strictObject({
    view: z.enum(["current_staffing", "attendance", "schedule", "labor_cost", "coverage_issues"]),
    period: date.period, from: date.from, to: date.to,
  }),
  get_team: z.strictObject({
    status, agent, view: z.enum(["tasks", "signals", "decisions"]),
    limit: z.number().int().min(1).max(10),
  }),
  get_pricing: z.strictObject({ product_name: z.string().max(120).nullable(), limit: z.number().int().min(1).max(10) }),
  get_owner_rules: z.strictObject({ agent }),
  compare_periods: z.strictObject({
    metric:z.enum(["net_sales","orders","loaded_labor","owner_profit","total_business_costs"]),
    current_period:date.period,current_from:date.from,current_to:date.to,
    comparison_period:date.period,comparison_from:date.from,comparison_to:date.to,
  }),
  conversation_control:z.strictObject({intent:z.enum(["greeting","clarification","unsupported"])}),
  olivia_availability: z.strictObject({ employee_name: z.string().max(120).nullable() }),
  olivia_schedule: z.strictObject({
    action: z.enum(["preview", "what_if"]),
    week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    objective: z.enum(["cash", "owner_time", "balanced"]).nullable(),
    overrides: z.array(oliviaOverride).max(20).nullable(),
  }),
  alex_pricing_review: z.strictObject({
    selection: z.enum(["all_active", "specific_name", "specific_id"]),
    product_name: z.string().max(120).nullable(),
    product_id: z.string().uuid().nullable(),
    offset: z.number().int().min(0).max(500),
    limit: z.number().int().min(1).max(25),
  }),
  alex_pricing_what_if: z.strictObject({
    product_name: z.string().max(120).nullable(),
    product_id: z.string().uuid().nullable(),
    changes: z.array(alexChange).max(20),
    selling_price_delta_cents: z.number().int().min(-100000).max(100000).nullable(),
    selling_price_replace_cents: z.number().int().min(0).max(100000000).nullable(),
    target_cost_ratio_bps: z.number().int().min(1).max(10000).nullable(),
    target_ingredient_margin_bps: z.number().int().min(0).max(9999).nullable(),
  }),
} as const;

export type SupervisorToolName = keyof typeof schemas;
export type SupervisorToolCall = { name: SupervisorToolName; arguments: Record<string, unknown>; call_id: string };
// One shared, exact Responses function catalogue for production and live evaluation.
export { SUPERVISOR_FUNCTIONS } from "./supervisorFunctions.mjs";

export function parseSupervisorCalls(output: unknown): SupervisorToolCall[] {
  if (!Array.isArray(output)) throw new Error("Invalid Supervisor output");
  return output.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" &&
    (x as { type?: unknown }).type === "function_call").map((call) => {
    if (typeof call.name !== "string" || !(call.name in schemas) ||
        typeof call.arguments !== "string" || call.arguments.length > 3000 ||
        typeof call.call_id !== "string" || !call.call_id || call.call_id.length > 150) {
      throw new Error("Unapproved Supervisor tool call");
    }
    const name = call.name as SupervisorToolName;
    return { name, arguments: schemas[name].parse(JSON.parse(call.arguments)) as Record<string, unknown>, call_id: call.call_id };
  });
}

export type ServerFact = { id: string; label: string; value: number; kind: "metric" | "count"; source: EvidenceReference };
export type ServerInsight={id:string;text:string;source:EvidenceReference};
export type ServerTask = Extract<SupervisorReplyBlock, {type:"task_card"}>;
export type ToolEvidence = {
  status: GroundingStatus; coverage: Record<string, string | number | boolean | null>;
  missingInputs: string[]; estimatedInputs: string[];
  data: unknown; facts: ServerFact[]; tasks: ServerTask[]; insights:ServerInsight[];
  evidence: EvidenceReference[]; control?:"greeting"|"clarification"|"unsupported";
};
type Context = {
  tools: BusinessScopedCafeTools; asOf: string;
  cafeName: string; timezone: string; locale?:"en"|"es"|"ar"; readRules: () => Promise<TeamRule[]>;
};
const limitText = (s: string, max = 140) => s.slice(0, max);
function ref(name: string, asOf: string, source: EvidenceReference["source"] = "cafe_state"): EvidenceReference {
  return { identifier: limitText(name, 160), asOf, source };
}
function quality<T>(slice: KnownSlice<T>, evidence: EvidenceReference[],
  data: unknown, coverage: ToolEvidence["coverage"] = {}): ToolEvidence {
  const missingInputs = [...new Set(slice.quality.missingInputs.concat(slice.quality.staleInputs.map(x => "stale:" + x)))].slice(0, 12);
  const estimatedInputs = slice.quality.estimatedInputs.slice(0, 12);
  return { status: !slice.available ? "unavailable" : missingInputs.length ? "partial"
    : estimatedInputs.length ? "estimated" : "verified",
    missingInputs, estimatedInputs, coverage, data: slice.available ? data : null,
    facts: [], tasks: [], insights:[], evidence: slice.available ? evidence : [] };
}
function absent(reason: string): ToolEvidence {
  return { status: "unavailable", coverage: {}, missingInputs: [reason],
    estimatedInputs: [], data: null, facts: [], tasks: [], insights:[], evidence: [] };
}
function addFact(result: ToolEvidence, id: string, label: string, value: number, kind: ServerFact["kind"],
  source: EvidenceReference) {
  if (!Number.isSafeInteger(value) || (kind === "count" && value < 0)) return;
  result.facts.push({id, label: limitText(label), value, kind, source});
  if (!result.evidence.some(x => x.identifier === source.identifier && x.source === source.source)) result.evidence.push(source);
}
function addInsight(result:ToolEvidence,id:string,text:string,source:EvidenceReference) {
  result.insights.push({id,text:text.slice(0,450),source});
  if(!result.evidence.some(x=>x.identifier===source.identifier && x.source===source.source))
    result.evidence.push(source);
}
function sliceValue<T>(slice: KnownSlice<T>): T | null { return slice.available ? slice.value : null; }
function matchName(name: string, pattern: string | null) {
  return !pattern || name.normalize("NFKC").toLowerCase().includes(pattern.normalize("NFKC").toLowerCase().trim());
}
function dateArgs(args: Record<string, unknown>, asOf: string): CafeStatePeriod {
  return resolveCafeDateRange(dateSelectionSchema.parse({
    period: args.period, from: args.from, to: args.to,
  }), asOf);
}
/** Only authenticated, persisted tasks enter this function. Names come from the task's
 * own evidence; no inferred person, product, or action is ever inserted. */
function taskCard(task:OperatingTask,asOf:string,locale:"en"|"es"|"ar"="en"):ServerTask {
  const tab=task.status==="handled"?"handled":task.status==="watching"?"watching":"needs_you";
  const label=(name:unknown)=>typeof name==="string"&&name.trim()?name.trim().slice(0,85):null;
  const item=label(task.payload.itemName),employee=label(task.payload.employeeName);
  const category=label(task.payload.categoryCode)?.replaceAll("_"," ")??null;
  const l={
    en:{price:"Review price",shift:"Review shift",cost:"Add missing cost",supply:"Check supply",money:"Review business costs"},
    es:{price:"Revisar precio",shift:"Revisar turno",cost:"Añadir costo faltante",supply:"Revisar suministro",money:"Revisar costos del negocio"},
    ar:{price:"مراجعة السعر",shift:"مراجعة الوردية",cost:"إضافة تكلفة مفقودة",supply:"فحص المخزون",money:"مراجعة تكاليف العمل"},
  }[locale];
  const withName=(base:string,detail:string|null)=>limitText(detail?base+": "+detail:base,160);
  const title=task.kind==="price_review"?withName(l.price,item):
    task.kind==="staff_coverage"?withName(l.shift,employee):
    task.kind==="data_quality"?withName(l.cost,category):
    task.kind==="supply_check"?withName(l.supply,item):l.money;
  const query=new URLSearchParams({status:tab,agent:task.agentId,task:task.id});
  return {type:"task_card",taskId:task.id.slice(0,200),agent:task.agentId,
    title,status:task.status,href:"/operations?"+query.toString()+"#selected-task",
    source:ref("task:"+task.id,asOf,"operating_tasks")};
}
export function intentForCalls(names: SupervisorToolName[]): SupervisorIntent {
  const unique = [...new Set(names)];
  if (unique.length !== 1) return "cafe_overview";
  const intents: Record<SupervisorToolName, SupervisorIntent> = { get_cafe_overview: "cafe_overview", get_sales: "sales_quantity", get_menu: "menu_catalog",
    get_financials: "profitability", get_staff: "staff", get_team: "operating_tasks", declare_request_scope:"unknown",
    get_pricing: "menu_pricing", get_owner_rules: "owner_rules",
    compare_periods:"cafe_overview",conversation_control:"unknown",
    olivia_availability:"staff",olivia_schedule:"staff",
    alex_pricing_review:"menu_pricing",alex_pricing_what_if:"menu_pricing" };
  return intents[unique[0]];
}

/** A fixed, authenticated, READ-ONLY domain registry. No user/model business selector or SQL capability. */
export function createSupervisorToolRegistry(context: Context) {
  const { tools, asOf } = context;
  let statePromise: Promise<CafeState> | null = null;
  const state = () => statePromise ??= tools.getCafeSummary();
  // Independently re-authenticates (never trusts context.tools' caller-chosen
  // business/currency) and lazily builds the exact TrustedReadScope Alex's
  // reviewed P2 registrations require. A fresh instance per turn; never shared
  // across requests, never caller/model supplied.
  let alexScopePromise: ReturnType<typeof authorizedOwnerP1> | null = null;
  const alexScope = async () => {
    const { tools: ownerTools, identity } = await (alexScopePromise ??= authorizedOwnerP1());
    return { role: "owner" as const, businessId: identity.businessId,
      identity: { ...identity }, tools: ownerTools, shadowEnabled: true as const };
  };
  const alexRegistry = createP2Registry(buildAlexPricingRegistrations());
  const oliviaTime = (iso: string) => formatInTimeZone(new Date(iso), context.timezone, "EEE HH:mm");
  return async (call: SupervisorToolCall, index: number): Promise<ToolEvidence> => {
    // Metadata-only declaration is never a café reader, even if called directly.
    if(call.name==="declare_request_scope")throw new Error("Scope metadata is not a café read");
    schemas[call.name].parse(call.arguments);
    const prefix = "t" + index + ":";
    if(call.name==="conversation_control") {
      const a=schemas.conversation_control.parse(call.arguments);
      const result=absent("conversationControl");
      result.control=a.intent;
      return result;
    }
    if(call.name==="compare_periods") {
      const a=schemas.compare_periods.parse(call.arguments);
      const current=dateArgs({period:a.current_period,from:a.current_from,to:a.current_to},asOf);
      const previous=dateArgs({period:a.comparison_period,from:a.comparison_from,to:a.comparison_to},asOf);
      const money=a.metric!=="orders";
      const source=ref("comparison:"+a.metric+":"+current.from+":"+previous.from,asOf);
      const metricReader=async (range:CafeStatePeriod):Promise<KnownSlice<number>>=>{
        if(a.metric==="net_sales"||a.metric==="orders") {
          const slice=await tools.getSalesTrend(range);
          if(!slice.available) return slice;
          const coverage=new Set(slice.value.map(x=>x.date)).size;
          const expected=rangeExpectedDays(range);
          const missing=coverage===expected?[]:["salesCoverage:"+coverage+"/"+expected];
          return {available:true,value:slice.value.reduce((n,d)=>n+
            (a.metric==="orders"?d.ordersCount:d.netSalesCents),0),quality:{
              ...slice.quality,missingInputs:[...slice.quality.missingInputs,...missing]}};
        }
        if(a.metric==="loaded_labor") {
          const slice=await tools.getLaborMetrics(range);
          if(!slice.available) return slice;
          const covered=new Set(slice.value.map(x=>x.date)).size;
          return {available:true,value:slice.value.reduce((n,d)=>n+d.loadedStaffCostCents,0),
            quality:{...slice.quality,missingInputs:[...slice.quality.missingInputs,
              ...(covered===rangeExpectedDays(range)?[]:["laborCoverage"])]}};
        }
        const slice=await tools.getProfitability(range);
        if(!slice.available) return slice;
        return {available:true,value:a.metric==="owner_profit"?slice.value.ownerProfitCents:
          slice.value.totalCostsCents,quality:slice.quality};
      };
      const [curr,prev]=await Promise.all([metricReader(current),metricReader(previous)]);
      const comparison=compareCompleteValues(curr,prev);
      const result=quality(comparison,[source],{current,comparison:previous,metric:a.metric,
        completeComparison:comparison.available});
      if(!comparison.available){
        result.missingInputs.push(...comparison.quality.missingInputs);
        if(curr.available){
          addFact(result,prefix+"observedCurrent","Recorded current "+a.metric.replaceAll("_"," "),
            curr.value,money?"metric":"count",source);
        }
        if(prev.available){
          addFact(result,prefix+"observedPrevious","Recorded comparison "+a.metric.replaceAll("_"," "),
            prev.value,money?"metric":"count",source);
        }
        result.status=result.facts.length?"partial":"unavailable";
        addInsight(result,prefix+"incomplete","A complete comparison is not supported by the available period coverage.",source);
        return result;
      }
      const c=comparison.value, kind=money?"metric":"count";
      addFact(result,prefix+"current","Current "+a.metric.replaceAll("_"," "),c.current,kind,source);
      addFact(result,prefix+"previous","Comparison "+a.metric.replaceAll("_"," "),c.previous,kind,source);
      if(money) addFact(result,prefix+"difference","Change in "+a.metric.replaceAll("_"," "),c.difference,"metric",source);
      result.data={metric:a.metric,direction:c.direction,percentageChange:c.changePercent,
        difference:c.difference};
      addInsight(result,prefix+"direction",
        a.metric.replaceAll("_"," ")+" "+(c.direction==="unchanged"?"was unchanged":
        c.direction==="up"?"increased":"decreased")+" versus the comparison period"+
        (c.changePercent===null?" (percentage unavailable).":" by "+Math.abs(c.changePercent)+"%."),
        source);
      return result;
    }
    if (call.name === "get_cafe_overview") {
      const a = schemas.get_cafe_overview.parse(call.arguments);
      const snapshot = await state();
      const days = a.focus === "today" ? { from: asOf, to: asOf } : { from: asOf.slice(0,7) + "-01", to: asOf };
      const [sales, profit, tasks] = await Promise.all([
        tools.getSalesTrend(days), tools.getProfitability(days), tools.getTeamTasks(),
      ]);
      const reference = ref("overview:" + a.focus + ":" + asOf, asOf);
      const result = quality(sales, [reference], { cafeName: context.cafeName, asOf, focus: a.focus,
        profitabilityAvailable: profit.available, productInventoryKnown: snapshot.inventory.available });
      if (sales.available) addFact(result, prefix + "sales", "Recorded net sales", sales.value.reduce((s,x)=>s+x.netSalesCents,0), "metric", reference);
      if (profit.available) {
        addFact(result, prefix + "profit", "Owner profit", profit.value.ownerProfitCents, "metric", reference);
        addFact(result, prefix + "costs", "Total business costs", profit.value.totalCostsCents, "metric", reference);
        if (profit.quality.estimatedInputs.length) {
          result.status = result.status === "partial" ? "partial" : "estimated";
          result.estimatedInputs.push(...profit.quality.estimatedInputs.slice(0, 5));
        }
      } else result.missingInputs.push(...profit.quality.missingInputs.slice(0, 5));
      if(tasks.available){
        const needsYou=tasks.value.filter(t=>t.status==="needs_owner"||t.status==="needs_response");
        addFact(result,prefix+"attention","AI Team tasks needing owner",needsYou.length,"count",
          ref("persisted_team_tasks",asOf,"operating_tasks"));
        result.tasks=needsYou.slice(0,3).map(t=>taskCard(t,asOf,context.locale));
        result.evidence.push(...result.tasks.map(t=>t.source));
      }else result.missingInputs.push("teamTasksUnavailable");
      if (result.facts.length && result.missingInputs.length) result.status = "partial";
      return result;
    }
    if (call.name === "get_sales") {
      const a = schemas.get_sales.parse(call.arguments);
      const range = dateArgs(a, asOf);
      const itemBased = a.metric === "units" || a.metric === "distinct_products" ||
        a.group_by === "product" || a.group_by === "category" || !!a.product_name || a.category !== "all";
      const source = ref("sales:" + range.from + ":" + range.to, asOf, "historical_rollups");
      if (itemBased) {
        if (a.metric === "net_sales" || a.metric === "orders")
          return absent("itemRevenueOrOrderBreakdownNotAvailable");
        const [items, coverage] = await Promise.all([
          tools.getProductSales(range),tools.getItemSalesCoverage(range),
        ]);
        const result = quality(items, [source], null, {
          from:range.from,to:range.to,kind:"itemOrderLines",
          providers:coverage.available ? coverage.value.sources.join(", ") : "unproven",
          coveredFrom:coverage.available ? coverage.value.from : null,
          coveredThrough:coverage.available ? coverage.value.through : null,
        });
        // Canonical item-line coverage is required independently of a returned
        // product list. Do not infer coverage from rows, a provider, or a date guess.
        if (!coverage.available || !coverage.value.covered ||
          !coverage.value.from || coverage.value.from > range.from ||
          !coverage.value.through || coverage.value.through < range.to ||
          !coverage.value.sources.length) return absent("itemSalesCoverageNotProven");
        if (!items.available) return result;
        const rows = items.value.filter(x => (a.category === "all" || x.category === a.category) && matchName(x.name, a.product_name));
        const ordered = [...rows].sort((x,y) => a.sort === "lowest" ? x.units-y.units || x.name.localeCompare(y.name)
          : y.units-x.units || x.name.localeCompare(y.name));
        const counted = rows.filter(x => x.units > 0);
        if (a.metric === "distinct_products") addFact(result, prefix+"distinct", "Distinct products sold", counted.length, "count", source);
        else if (a.group_by === "total") addFact(result, prefix+"units", "Units sold", rows.reduce((s,x)=>s+x.units,0), "count", source);
        else if (a.group_by === "category") {
          for (const category of ["drink", "food"] as const) addFact(result, prefix+category, category+" units",
            rows.filter(x=>x.category === category).reduce((s,x)=>s+x.units,0), "count", source);
        } else for (const [i,p] of ordered.slice(0,a.limit).entries())
          addFact(result,prefix+"rank"+i, p.name+" units sold", p.units, "count", source);
        result.data = { ranking: ordered.slice(0,a.limit).map(p=>({ name:p.name, units:p.units, category:p.category })),
          note:"Only provider-covered canonical item order lines; no implied physical stock" };
        return result;
      }
      const sales = await tools.getSalesTrend(range);
      const observed = sliceValue(sales) ?? [];
      const dates = new Set(observed.map(x=>x.date));
      const days = rangeExpectedDays(range);
      const r = quality(sales, [source], null, {
        from: range.from, to: range.to, coveredDays: dates.size, expectedDays: days, missingDays: days-dates.size,
        totalIsRecordedOnly: dates.size !== days,
      });
      if (!sales.available) return r;
      if (dates.size !== days) {
        r.status = "partial"; r.missingInputs.push("salesCoverage:" + dates.size + "/" + days);
        addInsight(r,prefix+"partial","Only recorded sales are shown; some calendar days lack sales coverage.",source);
      }
      const field = a.metric === "orders" ? "ordersCount" : "netSalesCents";
      const kind = a.metric === "orders" ? "count" : "metric";
      const label=a.metric==="orders" ? (range.from===asOf&&range.to===asOf?"Today's recorded orders so far":"Recorded orders")
        : (range.from===asOf&&range.to===asOf?"Today's recorded net sales so far":"Recorded net sales");
      if (a.group_by === "total") addFact(r,prefix+"total",label,observed.reduce((s,x)=>s+x[field],0),kind,source);
      else if (a.group_by === "day") {
        const sorted = [...observed].sort((x,y)=>a.sort === "lowest" ? x[field]-y[field] : y[field]-x[field]);
        for (const [i,x] of sorted.slice(0,a.limit).entries())
          addFact(r,prefix+"day"+i,x.date+" "+label,x[field],kind,source);
      } else return absent("itemGroupingRequiresCanonicalOrderLines");
      r.data = { observedDays: observed.slice(0,15).map(x=>({date:x.date,
        netSalesCents:x.netSalesCents,orders:x.ordersCount})) };
      return r;
    }
    if (call.name === "get_menu") {
      const a = schemas.get_menu.parse(call.arguments);
      const catalog = await tools.getMenuCatalog();
      const source = ref("menu:catalog:" + asOf,asOf);
      const result = quality(catalog,[source],null,{ physicalStockKnown:false });
      if (!catalog.available) return result;
      const rows = catalog.value.filter(x => (a.scope === "all" || x.active) && matchName(x.name,a.product_name));
      const active = catalog.value.filter(x=>x.active);
      if (a.view === "count") addFact(result,prefix+"count","Menu products",rows.length,"count",source);
      if (a.view === "active_count") addFact(result,prefix+"active","Active menu products",active.length,"count",source);
      if (a.view === "category_summary") {
        for (const category of ["drink","food"] as const)
          addFact(result,prefix+category,category+" menu products",rows.filter(p=>p.category===category).length,"count",source);
      }
      if (a.view === "products" || a.view === "product_details") {
        const snapshot = await state();
        const selected = rows.slice(0,a.view === "product_details" ? 3 : a.limit);
        result.data = { products: selected.map(p => {
          const current = snapshot.products.available ? snapshot.products.value.find(x=>x.id===p.id) : undefined;
          return { name:p.name,category:p.category, active:p.active,priceCents:p.priceCents,
            costCents:current?.costStatus === "READY" ? current.ingredientsCentsToday : null,
            costEstimated:current?.costQuality === "estimated",
            physicalStockKnown:false };
        }) };
        for (const [i,p] of selected.entries()) addFact(result,prefix+"price"+i,p.name+" price",p.priceCents,"metric",source);
      }
      return result;
    }
    if (call.name === "get_financials") {
      const a = schemas.get_financials.parse(call.arguments);
      const range = dateArgs(a,asOf);
      const source = ref("financials:" + a.metric + ":" + range.from + ":" + range.to,asOf);
      if (a.metric === "monthly_bills") {
        if (range.to.slice(0,7) !== asOf.slice(0,7)) return absent("HistoricalMonthlyBillsNotVerified");
        const bills = await tools.getMonthlyBills();
        const result = quality(bills,[source],{ month:asOf.slice(0,7), periodMeaning:"FULL MONTH, not prorated", rangeNotApplied:true });
        if (bills.available) addFact(result,prefix+"bills","Recurring monthly bills",bills.value.totalCents,"metric",source);
        if (result.status==="estimated") addInsight(result,prefix+"billsEstimate",
          "Recurring monthly bills include estimated entries.",source);
        return result;
      }
      if (a.metric === "recorded_spending") {
        const spent = await tools.getRecordedExpenses(range);
        const result = quality(spent,[source],{ from:range.from,to:range.to, description:"Recorded ACTUAL expense entries only" });
        if (spent.available) addFact(result,prefix+"spent","Recorded actual spending",spent.value.totalCents,"metric",source);
        return result;
      }
      if(a.metric==="break_even"){
        if(range.to!==asOf) return absent("HistoricalBreakEvenSnapshotUnavailable");
        const be=await tools.getBreakEven(),r=quality(be,[source],
          {calculation:"buildBreakEvenViewModel (same as Break-even screen)"});
        if(!be.available)return r;
        addFact(r,prefix+"drinks","Drinks needed per day",be.value.drinksNeededPerDay,"count",source);
        addFact(r,prefix+"hour","Approximate drinks per hour",be.value.drinksPerHour,"count",source);
        addFact(r,prefix+"daily","Daily costs to cover",be.value.dailyCostsToCoverCents,"metric",source);
        addFact(r,prefix+"left","Average money left per drink",be.value.averageMoneyLeftPerDrinkCents,"metric",source);
        if(be.value.todayDrinks!==null) addFact(r,prefix+"today","Today's recorded drinks",be.value.todayDrinks,"count",source);
        return r;
      }
      if (a.metric === "cost_breakdown") {
        const expenses = await tools.getExpenseSummary(range);
        const result = quality(expenses,[source],null,{from:range.from,to:range.to});
        if (expenses.available) for (const [i,line] of expenses.value.filter(x=>!x.isMissing).slice(0,12).entries())
          addFact(result,prefix+"cost"+i,line.label,line.amountCents,"metric",source);
        result.data = { distinction:"Modeled/prorated running costs, not actual cash spending" };
        return result;
      }
      if(a.metric==="total_business_costs"){
        const costs=await tools.getBusinessCostSummary(range);
        const available=costs.completeness!=="unavailable";
        const result:ToolEvidence={
          status:costs.completeness==="complete"?
            (costs.estimatedInputs.length?"estimated":"verified"):costs.completeness,
          coverage:{from:range.from,to:range.to,
            salesDays:costs.coverage.salesDays,laborDays:costs.coverage.laborDays,
            expectedDays:costs.coverage.expectedDays},
          missingInputs:costs.missingInputs.slice(0,12),
          estimatedInputs:costs.estimatedInputs.slice(0,12),
          data:{costCompleteness:costs.completeness,components:costs.components,
            missingProductCostCount:costs.coverage.missingProductCostCount},
          facts:[],tasks:[],insights:[],evidence:available?[source]:[],
        };
        if(available)addFact(result,prefix+"value",
          costs.completeness==="complete"?"Total business costs":"Known business costs",
          costs.knownTotalCents,"metric",source);
        if(costs.completeness!=="complete")addInsight(result,prefix+"coverage",
          businessCostLimitations(costs,context.locale??"en"),source);
        return result;
      }
      const profit = await tools.getProfitability(range);
      const result = quality(profit,[source],{from:range.from,to:range.to, arithmetic:"canonical-only"});
      if (profit.available) addFact(result,prefix+"value","Owner profit",profit.value.ownerProfitCents,"metric",source);
      return result;
    }
    if (call.name === "get_staff") {
      const a = schemas.get_staff.parse(call.arguments);
      const futureLimit=new Date(asOf+"T12:00:00Z");futureLimit.setUTCDate(futureLimit.getUTCDate()+90);
      const range=a.view==="schedule"&&a.period==="custom" ?
        resolveCafeDateRange({period:"custom",from:a.from,to:a.to},futureLimit.toISOString().slice(0,10)) : dateArgs(a,asOf);
      const source = ref("staff:" + a.view + ":" + range.from + ":" + range.to,asOf,"staff_timecards");
      if(a.view==="schedule"){
        const row=await tools.getRecurringSchedule(range,asOf);
        const result=quality(row,[source],row.available?row.value:null);
        if(row.available){
          addFact(result,prefix+"scheduled","Owner-entered active weekly schedule rows",
            row.value.shifts.length,"count",source);
          addInsight(result,prefix+"scheduledInsight",
            "The displayed shifts are owner-entered recurring plans, not confirmed attendance.",source);
          for(const [i,shift] of row.value.shifts.slice(0,8).entries())
            addInsight(result,prefix+"shift"+i,
              (shift.displayName??"Employee")+" — weekly weekday "+shift.dayOfWeek+
              ", "+shift.startTime+" to "+shift.endTime+
              " (recurring planned shift; not confirmed clock-in).",source);
        }
        return result;
      }
      if(a.view==="current_staffing") {
        if(range.from!==asOf||range.to!==asOf) return absent("CurrentStaffingOnlyForToday");
        const current=await tools.getCurrentStaff();
        const result=quality(current,[source],current.available?current.value:null);
        if(current.available){
          addFact(result,prefix+"current","People shown on shift by Staff",current.value.count,"count",source);
          if (current.value.people.some(person=>person.isSchedulePrediction))
            addInsight(result,prefix+"status","Some people shown on shift are based on the schedule rather than a recorded clock-in.",source);
          for(const [i,person] of current.value.people.slice(0,8).entries())
            addInsight(result,prefix+"person"+i,
              person.name+" — "+(person.role??"staff")+
              " ("+(person.isSchedulePrediction?"scheduled shift":"recorded clock-in")+")"+
              (person.breakStatus && person.breakStatus!=="ok" ? "; break: "+person.breakStatus : "")+".",source);
        }
        return result;
      }
      if (a.view === "coverage_issues") {
        const tasks = await tools.getTeamTasks();
        const result = quality(tasks,[ref("staff_coverage_tasks",asOf,"operating_tasks")],
          { source:"Persisted coverage tasks only; this is not proof of all staffing issues" });
        if (tasks.available) {
          const open = tasks.value.filter(t=>t.kind === "staff_coverage" && ["needs_owner","needs_response","watching"].includes(t.status));
          addFact(result,prefix+"issues","Recorded open staff coverage tasks",open.length,"count",result.evidence[0]);
          result.tasks = open.slice(0,5).map(t=>taskCard(t,asOf,context.locale));
          result.evidence.push(...result.tasks.map(t=>t.source));
          if(open.length===0)addInsight(result,prefix+"noCoverage","No open staff coverage tasks are recorded; this does not prove the roster is fully covered.",result.evidence[0]);
        }
        return result;
      }
      if (a.view === "labor_cost") {
        const labor = await tools.getLaborMetrics(range);
        const result = quality(labor,[source],{from:range.from,to:range.to});
        if (labor.available) {
          const covered = new Set(labor.value.map(x=>x.date)).size, expected = rangeExpectedDays(range);
          result.coverage = { coveredDays:covered,expectedDays:expected, missingDays:expected-covered };
          if (covered !== expected) { result.status="partial"; result.missingInputs.push("laborCoverage"); }
          addFact(result,prefix+"labor","Recorded loaded staff cost",labor.value.reduce((n,x)=>n+x.loadedStaffCostCents,0),"metric",source);
        }
        return result;
      }
      const attendance = await tools.getStaffAttendance(range,context.timezone);
      const result = quality(attendance,[source],{from:range.from,to:range.to,
        note:"Observed timecards are not a complete employee roster or schedule"});
      if (attendance.available) {
        addFact(result,prefix+"timecards","Recorded timecards",attendance.value.timecardCount,"count",source);
        if (range.to === asOf && range.from === asOf)
          addFact(result,prefix+"now","Currently clocked-in timecards",attendance.value.onClockCount,"count",source);
      }
      return result;
    }
    if (call.name === "get_team") {
      const a = schemas.get_team.parse(call.arguments);
      if (a.view === "signals") {
        const signals = (await tools.getActiveSignals()).slice(0,a.limit);
        const source = ref("current_signals",asOf,"cafe_state");
        const r = quality({available:true,value:signals,quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}},
          [source], {signals:signals.map(x=>({type:x.type,severity:x.severity,confidence:x.confidence}))});
        addFact(r,prefix+"signals","Active signals (returned)",signals.length,"count",source);
        return r;
      }
      if (a.view === "decisions") {
        const decisions = (await tools.getDecisionHistory()).slice(-a.limit);
        const source = ref("decision_history",asOf,"cafe_state");
        const r = quality({available:true,value:decisions,quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}},
          [source],{decisions:decisions.map(x=>({type:x.type,status:x.status}))});
        addFact(r,prefix+"decisions","Returned decisions",decisions.length,"count",source);
        return r;
      }
      const tasks = await tools.getTeamTasks();
      const source = ref("persisted_team_tasks",asOf,"operating_tasks");
      const result = quality(tasks,[source],null);
      if (!tasks.available) return result;
      const rows = tasks.value.filter(t=>(a.agent === "all" || t.agentId === a.agent) &&
        (a.status === "all" || (a.status === "needs_you" ? ["needs_owner","needs_response"].includes(t.status) : t.status === a.status)));
      const need=rows.filter(t=>t.status==="needs_owner"||t.status==="needs_response");
      addFact(result,prefix+"needsYou","Needs you",need.length,"count",source);
      for (const s of ["needs_owner","needs_response","handled","watching"]) {
        addFact(result,prefix+s, s.replaceAll("_"," ")+" Team tasks", rows.filter(t=>t.status === s).length,"count",source);
      }
      const shown=a.status==="all"?need:rows;
      result.tasks=shown.slice(0,a.limit).map(t=>taskCard(t,asOf,context.locale));
      result.evidence.push(...result.tasks.map(t=>t.source));
      result.data = { note:"Persisted AI Team task inbox, not a staff roster", returned:result.tasks.length, filterStatus:a.status, view:"tasks" };
      if(!shown.length)addInsight(result,prefix+"noTasks","No matching AI Team tasks are recorded.",source);
      return result;
    }
    if (call.name === "get_pricing") {
      const a = schemas.get_pricing.parse(call.arguments);
      const snapshot = await state(), source = ref("pricing_engine:" + asOf,asOf,"pricing_engine");
      const result = quality(snapshot.pricingRecommendations,[source],null);
      if (!snapshot.pricingRecommendations.available) return result;
      const recommendations = snapshot.pricingRecommendations.value;
      if (!snapshot.products.available) {
        result.status = "partial";
        result.missingInputs.push("pricingProductCatalog");
        addInsight(result,prefix+"pricingBlocked","Product information is unavailable, so price revisions cannot be verified.",source);
        return result;
      }
      const candidates = snapshot.products.value.filter(p=>matchName(p.name,a.product_name))
        .map(p=>({id:p.id,name:p.name,rec:recommendations[p.id]}));
      if (!candidates.length) {
        result.status = "partial";
        result.missingInputs.push("noMatchingPricingProducts");
        addInsight(result,prefix+"pricingNotEvaluated","There are no matching products with pricing evidence to evaluate.",source);
        return result;
      }
      const reviewReady = candidates.filter(({rec})=>rec &&
        rec.status==="REVIEW_PRICE" && rec.recommendedPriceCents!==null &&
        !rec.dataQuality.missingInputs.length && !rec.dataQuality.staleInputs.length);
      const keepPrice = candidates.filter(({rec})=>rec?.status==="KEEP_CURRENT_PRICE" &&
        !rec.dataQuality.missingInputs.length && !rec.dataQuality.staleInputs.length);
      const newPriceReady = candidates.filter(({rec})=>rec?.status==="NEW_PRICE" &&
        rec.recommendedPriceCents!==null && !rec.dataQuality.missingInputs.length &&
        !rec.dataQuality.staleInputs.length);
      const fullyEvaluated = new Set([...keepPrice,...reviewReady,...newPriceReady].map(x=>x.id));
      const blocked = candidates.filter(x=>!fullyEvaluated.has(x.id));
      addFact(result,prefix+"pricingCount","Verified price changes",reviewReady.length,"count",source);
      addFact(result,prefix+"pricingExamined","Products examined for pricing",candidates.length,"count",source);
      addFact(result,prefix+"pricingEvaluated","Products fully evaluated",fullyEvaluated.size,"count",source);
      addFact(result,prefix+"pricingKeepCount","Products with no current price change",keepPrice.length,"count",source);
      addFact(result,prefix+"pricingNewCount","Products with first-price recommendations",newPriceReady.length,"count",source);
      for (const [i,p] of reviewReady.slice(0,a.limit).entries()) {
        const r = ref("price_review:" + p.name + ":" + asOf,asOf,"pricing_engine");
        if (p.rec?.recommendedPriceCents !== null && p.rec?.recommendedPriceCents !== undefined)
          addFact(result,prefix+"price"+i,p.name+" recommended price (review only)",p.rec.recommendedPriceCents,"metric",r);
        if (p.rec?.dataQuality.estimatedInputs.length || p.rec?.calculationMode==="BENCHMARK") {
          result.estimatedInputs.push("pricingBenchmark:" + p.name);
          if (result.status==="verified") result.status="estimated";
        }
      }
      if (reviewReady.length) addInsight(result,prefix+"pricingReview",
        "Verified review-ready recommendations are available. Menu prices have not been changed.",source);
      if (blocked.length) {
        addFact(result,prefix+"pricingBlockedCount","Products still needing complete pricing data",blocked.length,"count",source);
        addInsight(result,prefix+"pricingBlocked",
          "Price revisions cannot be verified for products with incomplete cost or pricing inputs.",source);
        result.status="partial";
        result.missingInputs.push("incompleteProductPricingInputs");
      } else if (!reviewReady.length) {
        if (result.status==="verified" || result.status==="estimated") {
          addInsight(result,prefix+"pricingZero",
            "No verified review-ready price changes are currently recommended.",source);
        } else {
          addInsight(result,prefix+"pricingIncomplete",
            "Pricing coverage is incomplete, so no definitive no-change conclusion is supported.",source);
        }
      }
      result.data={reviewReady:reviewReady.length,blocked:blocked.length,examined:candidates.length,
        evaluated:fullyEvaluated.size,noChange:keepPrice.length,newPrice:newPriceReady.length,reviewOnly:true};
      return result;
    }
    if (call.name === "olivia_availability") {
      const a = schemas.olivia_availability.parse(call.arguments);
      const source = ref("olivia:availability:" + asOf, asOf, "staff_timecards");
      const response = await executeOliviaReadCapability({ capability: "olivia.availability.read", version: 1 });
      if (!response.ok) return absent("olivia:" + response.error.code);
      if (response.capability !== "olivia.availability.read") return absent("oliviaInvalidRecord");
      let employees = response.employees;
      if (a.employee_name) employees = employees.filter(e => matchName(e.displayName, a.employee_name));
      const result = quality({ available: true, value: employees,
        quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] } },
        [source], { employees: employees.map(e => ({ id: e.employeeId, name: e.displayName,
          active: e.active, state: e.state })) });
      addFact(result, prefix + "count", "Matching employees", employees.length, "count", source);
      if (a.employee_name && employees.length > 1) {
        result.status = "partial";
        addInsight(result, prefix + "ambiguous",
          "More than one employee matches \"" + a.employee_name + "\": " +
          employees.map(e => e.displayName).join(", ") +
          ". Ask the owner exactly which person they mean before scheduling around that name.", source);
      } else if (!employees.length) {
        result.status = "partial";
        addInsight(result, prefix + "noMatch", a.employee_name
          ? "No employee matches \"" + a.employee_name + "\"."
          : "No employees are recorded.", source);
      } else {
        for (const [i, e] of employees.slice(0, 10).entries())
          addInsight(result, prefix + "emp" + i, e.displayName + " — availability: " +
            e.state.replaceAll("_", " ") + (e.active ? "" : " (inactive)"), source);
      }
      return result;
    }
    if (call.name === "olivia_schedule") {
      const a = schemas.olivia_schedule.parse(call.arguments);
      const monday = new Date(a.week + "T00:00:00Z");
      if (Number.isNaN(monday.getTime()) || monday.toISOString().slice(0,10)!==a.week ||
          monday.getUTCDay() !== 1) return absent("oliviaInvalidWeek");
      const source = ref("olivia:schedule:" + a.action + ":" + a.week, asOf, "staff_timecards");
      const options = a.objective ? { objective: a.objective } : {};
      let response;
      if (a.action === "preview") {
        response = await executeOliviaReadCapability({
          capability: "olivia.schedule.preview", version: 1, week: a.week, options });
      } else {
        if (!a.overrides?.length) return absent("oliviaWhatIfRequiresOverrides");
        const mapped: (OliviaWhatIfOverride | null)[] = a.overrides.map(o => {
          if (o.kind === "temporary_unavailable") {
            if (!o.local_date) return null;
            const hasWindow = o.start_local !== null && o.end_local !== null && o.overnight !== null;
            return { kind: "temporary_unavailable", employeeId: o.employee_id, localDate: o.local_date,
              ...(hasWindow ? { window: { startLocal: o.start_local as string,
                endLocal: o.end_local as string, overnight: o.overnight as boolean } } : {}) };
          }
          if (o.kind === "reduce_weekly_minutes")
            return o.max_weekly_minutes === null ? null :
              { kind: "reduce_weekly_minutes", employeeId: o.employee_id, maxWeeklyMinutes: o.max_weekly_minutes };
          if (!o.local_date || o.max_minutes === null) return null;
          return { kind: "reduce_daily_minutes", employeeId: o.employee_id, localDate: o.local_date,
            maxMinutes: o.max_minutes };
        });
        if (mapped.some(m => m === null)) return absent("oliviaInvalidOverride");
        response = await executeOliviaReadCapability({
          capability: "olivia.schedule.whatIf", version: 1, week: a.week,
          overrides: mapped as OliviaWhatIfOverride[], options });
      }
      if (!response.ok) {
        const result = absent("olivia:" + response.error.code);
        for (const [i, b] of (response.blockers ?? []).slice(0, 5).entries())
          addInsight(result, prefix + "blocker" + i, "Setup needed: " + b.code.replaceAll("_", " ") +
            (b.employeeName ? " (" + b.employeeName + ")" : "") + ".", source);
        return result;
      }
      const result = quality({ available: true, value: response,
        quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] } }, [source], null);
      const names = response.capability === "olivia.schedule.preview" ? response.employeeNames :
        response.capability === "olivia.schedule.whatIf" ? response.employeeNames : {};
      const shiftLine = (shift: { employeeId: string; startAt: string; endAt: string; pinned: boolean }) =>
        (names[shift.employeeId] ?? "Employee") + ": " + oliviaTime(shift.startAt) + " to " +
          formatInTimeZone(new Date(shift.endAt), context.timezone, "HH:mm") +
          (shift.pinned ? " (already published)" : "");
      if (response.capability === "olivia.schedule.preview") {
        const scenario = response.selectedScenario;
        result.data = { status: response.plan.status, employeeNames: names, locationNames: response.locationNames };
        if (scenario) {
          if (scenario.cost.costState !== "unavailable" && scenario.cost.loadedPayrollCents !== null)
            addFact(result, prefix + "laborCost", "Loaded weekly labor cost", scenario.cost.loadedPayrollCents, "metric", source);
          addFact(result, prefix + "gaps", "Uncovered coverage slots", scenario.gaps.length, "count", source);
          addFact(result, prefix + "shifts", "Planned shifts", scenario.shifts.length, "count", source);
          addFact(result, prefix + "ownerMinutes", "Owner minutes in this plan", scenario.ownerMinutes, "count", source);
          for (const [i, shift] of scenario.shifts.slice(0, 15).entries())
            addInsight(result, prefix + "shift" + i, shiftLine(shift), source);
          for (const [i, gap] of scenario.gaps.slice(0, 8).entries())
            addInsight(result, prefix + "gap" + i, "Uncovered: " + (response.locationNames[gap.locationId] ?? "location") +
              " " + oliviaTime(gap.startAt) + "–" + formatInTimeZone(new Date(gap.endAt), context.timezone, "HH:mm") +
              " (" + gap.reason.replaceAll("_", " ") + ")", source);
          if (!scenario.completeCoverage) { result.status = "partial"; result.missingInputs.push("oliviaIncompleteCoverage"); }
          if (scenario.cost.costState === "unavailable") { result.status = "partial"; result.missingInputs.push("oliviaWageUnknown"); }
          if (scenario.legalReview === "unverified_profile")
            addInsight(result, prefix + "legal", "Labor rules for this schedule are unverified; have them reviewed before publishing.", source);
        } else {
          result.status = "partial"; result.missingInputs.push("oliviaNoFeasibleScenario");
          addInsight(result, prefix + "infeasible", "No feasible schedule could be produced for the requested objective.", source);
        }
        for (const [i, n] of response.notices.slice(0, 6).entries())
          addInsight(result, prefix + "notice" + i, "Note: " + n.code.replaceAll("_", " ") +
            (n.employeeName ? " (" + n.employeeName + ")" : "") + ".", source);
        addInsight(result, prefix + "disposition", "This is a proposed schedule preview, not a saved or published schedule.", source);
      } else if (response.capability === "olivia.schedule.whatIf") {
        const { alternateScenario, comparison, alternateStatus } = response;
        result.data = { comparison, baselineStatus: response.baselineStatus, alternateStatus, employeeNames: names };
        if (comparison) {
          addFact(result, prefix + "changed", "Schedule changed by this scenario", comparison.changed ? 1 : 0, "count", source);
          addFact(result, prefix + "gapsDelta", "Change in uncovered slots", comparison.gapsDifference, "count", source);
          if (comparison.cashWagesDifferenceCents !== null)
            addFact(result, prefix + "costDelta", "Change in cash wages", comparison.cashWagesDifferenceCents, "metric", source);
          addFact(result, prefix + "ownerMinutesDelta", "Change in owner minutes", comparison.ownerMinutesDifference, "count", source);
        }
        if (!comparison?.changed)
          addInsight(result, prefix + "noEffect", "This hypothetical change does not affect the proposed schedule or its cost.", source);
        if (alternateStatus === "infeasible")
          addInsight(result, prefix + "infeasible", "With this change, the requested coverage cannot be fully met.", source);
        else if (alternateStatus === "unproven")
          addInsight(result, prefix + "unproven", "The effect of this change could not be fully proven within solver limits; treat this as inconclusive, not a confirmed result.", source);
        if (alternateScenario) {
          addFact(result, prefix + "altGaps", "Uncovered slots with this change", alternateScenario.gaps.length, "count", source);
          for (const [i, shift] of alternateScenario.shifts.slice(0, 15).entries())
            addInsight(result, prefix + "altShift" + i, shiftLine(shift), source);
        }
        addInsight(result, prefix + "disposition", "This is a hypothetical simulation only, not a saved or published schedule change.", source);
      }
      return result;
    }
    if (call.name === "alex_pricing_review") {
      const a = schemas.alex_pricing_review.parse(call.arguments);
      const selection = a.selection === "all_active"
        ? { kind: "all_active" as const, offset: a.offset, limit: a.limit }
        : a.selection === "specific_id" && a.product_id
        ? { kind: "specific" as const, items: [{ productId: a.product_id }] }
        : a.selection === "specific_name" && a.product_name
        ? { kind: "specific" as const, items: [{ exactName: a.product_name }] }
        : null;
      if (!selection) return absent("alexInvalidSelection");
      const source = ref("alex:review:" + asOf, asOf, "pricing_engine");
      let raw: Awaited<ReturnType<typeof alexRegistry.invoke>>;
      try {
        const scope = await alexScope();
        raw = await alexRegistry.invoke(scope, ALEX_REVIEW_ID, { purpose: "pricing_review", selection });
      } catch { return absent("alexUnauthorized"); }
      const data = raw as { status: string; value: unknown; reason?: string;
        quality?: { missingInputs: string[]; estimatedInputs: string[]; staleInputs: string[] } };
      if (data.status === "unavailable" || data.status === "conflict" || !data.value)
        return absent("alex:" + (data.reason ?? data.status));
      const value = data.value as { items: Array<{ productId: string | null; name: string;
        status: string; currentPriceCents: number | null; ingredientCostCents: number | null;
        ingredientCostRatioBps: number | null; ingredientContributionCents: number | null;
        costSource: string | null; ownerTotalCostStatus: string | null;
        missingInputs: string[]; staleInputs: string[] }>; totalSelected: number;
        hasMore: boolean; omittedUnsupported: number };
      const result: ToolEvidence = { status: data.status === "partial" ? "partial" :
        (data.quality?.estimatedInputs.length ? "estimated" : "verified"),
        coverage: {}, missingInputs: (data.quality?.missingInputs ?? []).slice(0, 12),
        estimatedInputs: (data.quality?.estimatedInputs ?? []).slice(0, 12),
        data: { items: value.items.map(it => ({ productId: it.productId, name: it.name, status: it.status })),
          hasMore: value.hasMore, nextOffset: a.offset + value.items.length },
        facts: [], tasks: [], insights: [], evidence: [source] };
      addFact(result, prefix + "count", "Products reviewed", value.items.length, "count", source);
      addFact(result, prefix + "total", "Matching products found", value.totalSelected, "count", source);
      if (value.omittedUnsupported > 0)
        addFact(result, prefix + "omitted", "Unsupported products omitted", value.omittedUnsupported, "count", source);
      for (const [i, it] of value.items.slice(0, 15).entries()) {
        if (it.status === "unavailable") {
          addInsight(result, prefix + "item" + i, it.name + ": pricing data unavailable." +
            (it.missingInputs.length ? " Missing: " + it.missingInputs.slice(0, 3).join(", ") + "." : ""), source);
          continue;
        }
        const parts = [it.name];
        if (it.currentPriceCents !== null) parts.push("price $" + (it.currentPriceCents / 100).toFixed(2));
        if (it.ingredientCostCents !== null) parts.push("ingredient cost $" + (it.ingredientCostCents / 100).toFixed(2));
        if (it.ingredientCostRatioBps !== null) parts.push("cost ratio " + (it.ingredientCostRatioBps / 100).toFixed(1) + "%");
        if (it.ingredientContributionCents !== null)
          parts.push("ingredient-only contribution $" + (it.ingredientContributionCents / 100).toFixed(2));
        if (it.costSource === "owner_total")
          parts.push("(owner-entered total cost, " + (it.ownerTotalCostStatus === "estimated" ? "estimated" : "confirmed") + ")");
        if (it.status === "partial") {
          const notes = [...it.missingInputs, ...it.staleInputs].slice(0, 2);
          if (notes.length) parts.push("(partial: " + notes.join(", ") + ")");
        }
        addInsight(result, prefix + "item" + i, parts.join(" — ") + ".", source);
      }
      if (value.hasMore)
        addInsight(result, prefix + "more", "More matching products exist beyond this page; ask to see the next page.", source);
      return result;
    }
    if (call.name === "alex_pricing_what_if") {
      const a = schemas.alex_pricing_what_if.parse(call.arguments);
      const product = a.product_id ? { productId: a.product_id }
        : a.product_name ? { exactName: a.product_name } : null;
      if (!product) return absent("alexInvalidSelection");
      const changes: (Record<string, unknown> | null)[] = a.changes.map(c => {
        if (c.kind === "ingredient_multiplier")
          return c.ingredient_id && c.multiplier_basis_points !== null
            ? { kind: c.kind, ingredientId: c.ingredient_id, multiplierBasisPoints: c.multiplier_basis_points } : null;
        if (c.kind === "ingredient_unit_cost")
          return c.ingredient_id && c.cost_per_base_unit_micros !== null
            ? { kind: c.kind, ingredientId: c.ingredient_id, costPerBaseUnitMicros: c.cost_per_base_unit_micros } : null;
        if (c.kind === "supplier_package")
          return c.ingredient_id && c.package_cost_cents !== null && c.package_count !== null && c.package_unit
            ? { kind: c.kind, ingredientId: c.ingredient_id, packageCostCents: c.package_cost_cents,
                packageCount: c.package_count, packageUnit: c.package_unit } : null;
        if (c.kind === "replace_ingredient")
          return c.from_ingredient_id && c.to_ingredient_id
            ? { kind: c.kind, fromIngredientId: c.from_ingredient_id, toIngredientId: c.to_ingredient_id,
                ...(c.quantity_value !== null && c.quantity_unit
                  ? { quantity: { value: c.quantity_value, unit: c.quantity_unit } } : {}) } : null;
        return c.ingredient_id && c.quantity_value !== null && c.quantity_unit
          ? { kind: c.kind, ingredientId: c.ingredient_id,
              quantity: { value: c.quantity_value, unit: c.quantity_unit } } : null;
      });
      if (!a.changes.length || changes.some(c => c === null)) return absent("alexInvalidChange");
      if (a.target_cost_ratio_bps !== null && a.target_ingredient_margin_bps !== null)
        return absent("alexInvalidTarget");
      const sellingPrice = a.selling_price_delta_cents !== null
        ? { kind: "delta" as const, deltaCents: a.selling_price_delta_cents }
        : a.selling_price_replace_cents !== null
        ? { kind: "replace" as const, priceCents: a.selling_price_replace_cents } : undefined;
      const source = ref("alex:whatif:" + asOf, asOf, "pricing_engine");
      let raw: Awaited<ReturnType<typeof alexRegistry.invokeSimulation>>;
      try {
        const scope = await alexScope();
        raw = await alexRegistry.invokeSimulation(scope, ALEX_SIMULATE_ID, {
          purpose: "pricing_simulate", product, changes,
          ...(sellingPrice ? { sellingPrice } : {}),
          ...(a.target_cost_ratio_bps !== null ? { targetCostRatioBps: a.target_cost_ratio_bps } : {}),
          ...(a.target_ingredient_margin_bps !== null ? { targetIngredientMarginBps: a.target_ingredient_margin_bps } : {}),
        }, { bindings: [], operands: [] });
      } catch { return absent("alexUnauthorized"); }
      const data = raw as { status: string; value: unknown; reason?: string };
      if (data.status === "unavailable" || !data.value) return absent("alex:" + (data.reason ?? data.status));
      const value = data.value as { name: string; before: { ingredientCostCents: number | null };
        after: { ingredientCostCents: number | null }; priceDeltaCents: number | null;
        ingredientCostDeltaCents: number | null; ingredientContributionDeltaCents: number | null;
        targetPriceCents: number | null; assumptions: string[] };
      const result: ToolEvidence = { status: data.status === "partial" ? "partial" : "estimated",
        coverage: {}, missingInputs: [], estimatedInputs: ["hypotheticalScenario"],
        data: { name: value.name, persisted: false }, facts: [], tasks: [], insights: [], evidence: [source] };
      if (value.before.ingredientCostCents !== null)
        addFact(result, prefix + "before", value.name + " current ingredient cost", value.before.ingredientCostCents, "metric", source);
      if (value.after.ingredientCostCents !== null)
        addFact(result, prefix + "after", value.name + " scenario ingredient cost", value.after.ingredientCostCents, "metric", source);
      if (value.priceDeltaCents !== null)
        addFact(result, prefix + "priceDelta", "Price change", value.priceDeltaCents, "metric", source);
      if (value.ingredientCostDeltaCents !== null)
        addFact(result, prefix + "costDelta", "Ingredient cost change", value.ingredientCostDeltaCents, "metric", source);
      if (value.ingredientContributionDeltaCents !== null)
        addFact(result, prefix + "contribDelta", "Ingredient-only contribution change", value.ingredientContributionDeltaCents, "metric", source);
      if (value.targetPriceCents !== null)
        addInsight(result, prefix + "target", "Conditional target price to hit the requested ratio: $" +
          (value.targetPriceCents / 100).toFixed(2) + ".", source);
      for (const [i, assumption] of value.assumptions.slice(0, 6).entries())
        addInsight(result, prefix + "assumption" + i, assumption, source);
      addInsight(result, prefix + "disposition", "This is a conditional what-if only; no price or recipe has been changed.", source);
      return result;
    }
    const a = schemas.get_owner_rules.parse(call.arguments);
    const rules = (await context.readRules()).filter(r=>r.status === "active" &&
      (a.agent === "all" || r.agentId === a.agent)).slice(0,10);
    const source = ref("approved_owner_rules",asOf,"owner_rules");
    return quality({available:true,value:rules,quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}},
      [source],{rules:rules.map(r=>({agent:r.agentId,instruction:limitText(r.instruction,300)}))});
  };
}
