import "server-only";
import { z } from "zod";
import type { CafeState, CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { OperatingTask } from "@/lib/operating/tasks";
import type { EvidenceReference, SupervisorIntent, GroundingStatus, SupervisorReplyBlock } from "./contracts";
import { compareCompleteValues } from "./periodComparison";
import { dateSelectionSchema, rangeExpectedDays, resolveCafeDateRange } from "./dateRange";

const agent = z.enum(["all", "alex", "olivia", "maya", "leo"]);
const status = z.enum(["all", "needs_you", "handled", "watching"]);
const date = dateSelectionSchema.shape;
const schemas = {
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
} as const;

export type SupervisorToolName = keyof typeof schemas;
export type SupervisorToolCall = { name: SupervisorToolName; arguments: Record<string, unknown>; call_id: string };
const enumField = (values: readonly string[]) => ({ type: "string", enum: values });
const nullableText = { type: ["string", "null"], maxLength: 120 };
const dateFields = {
  period: enumField(date.period.options), from: { type: ["string", "null"] },
  to: { type: ["string", "null"] },
};
function fn(name: SupervisorToolName, description: string, properties: Record<string, unknown>) {
  return { type: "function" as const, name, description, strict: true,
    parameters: { type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false } };
}
export const SUPERVISOR_FUNCTIONS = [
  fn("get_cafe_overview", "Bounded operating overview: current trusted sales/profit states and Team attention count. No raw database.", { focus: enumField(["today", "month_to_date"]) }),
  fn("get_sales", "Read recorded café sales, counts, day trends, item quantities, top/least sellers. Rankings require covered item-level order lines. Observed incomplete days are partial, never complete totals.", {
    metric: enumField(["net_sales", "orders", "units", "distinct_products"]),
    group_by: enumField(["total", "day", "product", "category"]), ...dateFields,
    category: enumField(["all", "drink", "food"]), product_name: nullableText,
    sort: enumField(["highest", "lowest"]), limit: { type: "integer", minimum: 1, maximum: 15 },
  }),
  fn("get_menu", "Read catalogue products, prices, active flags and verified cost evidence. Active means listed, not necessarily physically in stock.", {
    view: enumField(["count", "active_count", "category_summary", "products", "product_details"]),
    scope: enumField(["all", "active"]), product_name: nullableText,
    limit: { type: "integer", minimum: 1, maximum: 15 },
  }),
  fn("get_financials", "Canonical modeled owner profit, total business costs, full recurring monthly bills, actual expenses, break-even status, or cost detail. Do not conflate expense types.", {
    metric: enumField(["owner_profit", "total_business_costs", "monthly_bills", "recorded_spending", "break_even", "cost_breakdown"]), ...dateFields,
  }),
  fn("get_staff", "Employee-domain records: recorded current attendance, staffing, labor and persisted coverage issues. NOT AI Team agent tasks. Missing schedules remain unknown.", {
    view: enumField(["current_staffing", "attendance", "schedule", "labor_cost", "coverage_issues"]), ...dateFields,
  }),
  fn("get_team", "AI Team persisted tasks, active signals, and decisions, distinct from human staff facts.", {
    status: enumField(status.options), agent: enumField(agent.options),
    view: enumField(["tasks", "signals", "decisions"]), limit: { type: "integer", minimum: 1, maximum: 10 },
  }),
  fn("get_pricing", "Review-only canonical pricing-engine recommendations; never invent a replacement price.", {
    product_name: nullableText, limit: { type: "integer", minimum: 1, maximum: 10 },
  }),
  fn("get_owner_rules", "Active approved rules only; never expose drafts.", { agent: enumField(agent.options) }),
] as const;

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
  cafeName: string; timezone: string; readRules: () => Promise<TeamRule[]>;
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
function taskCard(task: OperatingTask, asOf: string): ServerTask {
  const tab = task.status === "handled" ? "handled" : task.status === "watching" ? "watching" : "needs_you";
  const item = task.payload.itemName ?? task.payload.employeeName ?? task.payload.categoryCode;
  return { type: "task_card", taskId: task.id.slice(0, 200), agent: task.agentId,
    title: limitText(task.kind.replaceAll("_", " ") + (typeof item === "string" ? ": " + item : ""), 160),
    status: task.status, href: "/operations?status=" + tab + "&agent=" + task.agentId,
    source: ref("task:" + task.id, asOf, "operating_tasks") };
}
export function intentForCalls(names: SupervisorToolName[]): SupervisorIntent {
  const unique = [...new Set(names)];
  if (unique.length !== 1) return "cafe_overview";
  const intents: Record<SupervisorToolName, SupervisorIntent> = { get_cafe_overview: "cafe_overview", get_sales: "sales_quantity", get_menu: "menu_catalog",
    get_financials: "profitability", get_staff: "staff", get_team: "operating_tasks",
    get_pricing: "menu_pricing", get_owner_rules: "owner_rules",
    compare_periods:"cafe_overview",conversation_control:"unknown" };
  return intents[unique[0]];
}

/** A fixed, authenticated, READ-ONLY domain registry. No user/model business selector or SQL capability. */
export function createSupervisorToolRegistry(context: Context) {
  const { tools, asOf } = context;
  let statePromise: Promise<CafeState> | null = null;
  const state = () => statePromise ??= tools.getCafeSummary();
  return async (call: SupervisorToolCall, index: number): Promise<ToolEvidence> => {
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
      if (tasks.available) addFact(result, prefix + "attention", "AI Team tasks needing owner", tasks.value.filter(t => t.status === "needs_owner" || t.status === "needs_response").length, "count",
        ref("persisted_team_tasks", asOf, "operating_tasks"));
      else result.missingInputs.push("teamTasksUnavailable");
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
      const label = a.metric === "orders" ? "Recorded orders" : "Recorded net sales";
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
      const profit = await tools.getProfitability(range);
      const result = quality(profit,[source],{from:range.from,to:range.to, arithmetic:"canonical-only"});
      if (profit.available) addFact(result,prefix+"value", a.metric === "owner_profit" ? "Owner profit" : "Total business costs",
        a.metric === "owner_profit" ? profit.value.ownerProfitCents : profit.value.totalCostsCents, "metric",source);
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
          addInsight(result,prefix+"status",
            "Current staffing uses the same on-shift calculation as the Staff screen; scheduled shifts may be predictions.",
            source);
          for(const [i,person] of current.value.people.slice(0,8).entries())
            addInsight(result,prefix+"person"+i,
              person.name+" — "+(person.role??"staff")+
              " ("+(person.isSchedulePrediction?"scheduled prediction":"recorded timecard")+
              ", break status: "+person.breakStatus+").",source);
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
          result.tasks = open.slice(0,5).map(t=>taskCard(t,asOf));
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
      for (const s of ["needs_owner","needs_response","handled","watching"]) {
        addFact(result,prefix+s, s.replaceAll("_"," ")+" Team tasks", rows.filter(t=>t.status === s).length,"count",source);
      }
      result.tasks = rows.slice(0,a.limit).map(t=>taskCard(t,asOf));
      result.evidence.push(...result.tasks.map(t=>t.source));
      result.data = { note:"Persisted AI Team task inbox, not a staff roster", returned:result.tasks.length };
      if(!rows.length)addInsight(result,prefix+"noTasks","No matching AI Team tasks are recorded.",source);
      return result;
    }
    if (call.name === "get_pricing") {
      const a = schemas.get_pricing.parse(call.arguments);
      const snapshot = await state(), source = ref("pricing_engine:" + asOf,asOf,"pricing_engine");
      const result = quality(snapshot.pricingRecommendations,[source],null);
      if (!snapshot.pricingRecommendations.available) return result;
      const products = sliceValue(snapshot.products) ?? [];
      const rows = Object.entries(snapshot.pricingRecommendations.value)
        .flatMap(([id,r]) => { const p = products.find(p=>p.id===id);
          return p && matchName(p.name,a.product_name) && r.status === "REVIEW_PRICE" &&
            r.recommendedPriceCents !== null && !r.dataQuality.missingInputs.length
            ? [{ name:p.name, rec:r }] : []; }).slice(0,a.limit);
      for (const [i,p] of rows.entries()) {
        const r = ref("price_review:" + p.name + ":" + asOf,asOf,"pricing_engine");
        if (p.rec.recommendedPriceCents !== null)
          addFact(result,prefix+"price"+i,p.name+" recommended price (review only)",p.rec.recommendedPriceCents,"metric",r);
        if (p.rec.dataQuality.estimatedInputs.length || p.rec.calculationMode === "BENCHMARK") {
          result.estimatedInputs.push("pricingBenchmark:" + p.name);
          result.status=result.status==="partial"?"partial":"estimated";
        }
      }
      result.data = { recommendations:rows.length, reviewOnly:true };
      if(rows.length)addInsight(result,prefix+"pricingReview","Pricing engine has review-only recommendations; prices have not been changed.",source);
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
