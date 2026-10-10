import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { OperatingTask } from "@/lib/operating/tasks";
import type { CafeState, KnownSlice } from "@/lib/operating/types";
import { runningCostsForPeriodCents, roundHalfUpToCent } from "@/lib/calc";
import type { EvidenceReference, GroundedSupervisorReply, SupervisorIntent, SupervisorReplyBlock } from "./contracts";
import type { SupervisorReplyCopy } from "./replyCopy";
import type { SupervisorPlan } from "./planner.server";
import { assessGrounding } from "./grounding";

type ExecutorCopy = SupervisorReplyCopy & {
  taskCard: (kind: string, name: string) => string;
  taskGroup: (status: string, count: number) => string;
  clarifyPeriod: string; clarifyProduct: string; clarifyQuestion: string;
};
export type PlanExecutorInput = {
  plan: SupervisorPlan; state: CafeState; tools: BusinessScopedCafeTools;
  copy: ExecutorCopy; readRules: () => Promise<TeamRule[]>;
};

const validCents = (value: number) => Number.isSafeInteger(value);
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
function datesFor(state: CafeState, period: "today" | "month_to_date" | "last_seven_days" | "last_28_days" | "yesterday" | "previous_month" | "other_period") {
  const to = state.asOf;
  const from = period === "month_to_date" ? state.asOf.slice(0, 7) + "-01"
    : period === "today" ? to
    : new Date(Date.parse(to + "T12:00:00Z") - (period === "last_seven_days" ? 6 : 27) * 86_400_000)
      .toISOString().slice(0, 10);
  return { from, to };
}
const ref = (id: string, asOf: string, source: EvidenceReference["source"] = "cafe_state"): EvidenceReference =>
  ({ source, identifier: id.slice(0, 160), asOf });
function noEvidence(intent: SupervisorIntent, message: string, code = "insufficient_evidence"): GroundedSupervisorReply {
  return { intent, status: "insufficient_evidence", evidence: [],
    blocks: [{ type: "warning", code, text: message }] };
}
function fromEvidence(intent: SupervisorIntent, slice: KnownSlice<unknown>, refs: EvidenceReference[],
  blocks: SupervisorReplyBlock[], copy: SupervisorReplyCopy): GroundedSupervisorReply {
  const assessment = assessGrounding(intent, slice, refs);
  if (assessment.status === "insufficient_evidence")
    return noEvidence(intent, copy.missingEvidence);
  return {
    intent, evidence: assessment.evidence, status: assessment.status,
    blocks: [...blocks, ...(assessment.status === "estimated"
      ? [{ type: "warning" as const, code: "estimated", text: copy.estimatedNotice }] : [])],
  };
}
function periodIntro(text: string, from: string, to: string, copy: ExecutorCopy) {
  return { type: "text" as const, text: (text + " " + copy.periodRange(from, to)).slice(0, 1200) };
}
function known<T>(value: T): KnownSlice<T> {
  return { available: true, value, quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] } };
}
function taskTitle(task: OperatingTask, copy: ExecutorCopy) {
  const entityName = task.payload.itemName ?? task.payload.employeeName ?? task.payload.categoryCode ?? "";
  return copy.taskCard(task.kind, typeof entityName === "string" ? entityName.slice(0, 65) : "").slice(0, 160);
}

/** The model never authors business numbers, evidence IDs, task status, links or replies.
 * Those are projected strictly from existing authorized tools and canonical calculations.
 */
export async function executeSupervisorPlan(input: PlanExecutorInput): Promise<GroundedSupervisorReply> {
  const { plan, state, tools, copy } = input;
  const asOf = state.asOf;
  if (plan.name === "clarify") {
    const msg = plan.arguments.topic === "period" ? copy.clarifyPeriod
      : plan.arguments.topic === "product" ? copy.clarifyProduct : copy.clarifyQuestion;
    return noEvidence("unknown", msg, "clarification");
  }
  if (plan.name === "read_menu") {
    // Menu catalog comes from the authenticated current café snapshot, never sales backfill.
    const products = state.products;
    const source = ref("menu:catalog:" + asOf, asOf);
    if (!products.available) return noEvidence("menu_catalog", copy.missingEvidence);
    const { operation, product_name } = plan.arguments;
    const all = products.value;
    const active = all.filter((item) => item.active !== false);
    const data = known(all.map((item) => ({ id: item.id, name: item.name, category: item.category, active: item.active })));
    const countBlock = (label: string, value: number): SupervisorReplyBlock =>
      ({ type: "count", label, value, source });
    if (operation === "product_count") return fromEvidence("menu_catalog", data, [source], [
      countBlock(copy.menuTotal, all.length),
    ], copy);
    if (operation === "active_product_count") return fromEvidence("menu_catalog", data, [source], [
      countBlock(copy.menuActive, active.length),
      { type: "text", text: copy.menuStockNotice },
    ], copy);
    if (operation === "category_summary") return fromEvidence("menu_catalog", data, [source], [
      countBlock(copy.menuTotal, all.length),
      countBlock(copy.menuCategoryDrink, all.filter((item) => item.category === "drink").length),
      countBlock(copy.menuCategoryFood, all.filter((item) => item.category === "food").length),
    ], copy);
    if (operation === "active_products") return fromEvidence("menu_catalog", data, [source], [
      countBlock(copy.menuActive, active.length),
      { type: "text", text: (copy.menuListIntro + " " + active.slice(0, 15).map((item) => item.name).join(", ")).slice(0, 1200) },
      { type: "text", text: copy.menuStockNotice },
    ], copy);
    if (!product_name?.trim()) return noEvidence("menu_catalog", copy.clarifyProduct, "product_not_identified");
    const query = product_name.normalize("NFKC").toLocaleLowerCase().trim();
    const exact = all.filter((item) => item.name.normalize("NFKC").toLocaleLowerCase() === query);
    const partial = all.filter((item) => item.name.normalize("NFKC").toLocaleLowerCase().includes(query));
    const match = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : null;
    if (!match) return noEvidence("menu_catalog", copy.productNotFound, "product_not_identified");
    return fromEvidence("menu_catalog", data, [source], [
      { type: "text", text: copy.menuProductDetails(match.name, match.category) },
      { type: "metric", label: match.name, valueCents: match.priceCents, source },
      { type: "text", text: copy.menuStockNotice },
    ], copy);
  }
  if (plan.name === "read_finances") {
    const { metric, period } = plan.arguments;
    if (period === "yesterday" || period === "previous_month" || period === "other_period") {
      return noEvidence("expenses", copy.periodUnavailable, "unsupported_period");
    }
    const { from, to } = datesFor(state, period);
    if (metric !== "monthly_bills" && from < state.period.from) {
      return noEvidence("expenses", copy.periodUnavailable, "unsupported_period");
    }
    const identifier = "finance:" + metric + ":" + from + ":" + to;
    const source = ref(identifier, asOf);
    if (metric === "monthly_bills" || metric === "accrued_fixed_bills") {
      const bills = await tools.getMonthlyBills();
      if (!bills.available) return fromEvidence("expenses", bills, [source], [], copy);
      const monthKey = asOf.slice(0, 7);
      const lastDay = new Date(Date.UTC(Number(monthKey.slice(0,4)), Number(monthKey.slice(5,7)), 0))
        .toISOString().slice(0, 10);
      // The monthly figure is the Bills screen's *full budget*, not a prorated
      // snapshot category that may already contain recorded actual expenses.
      const accrued = metric === "accrued_fixed_bills";
      const cents = accrued ? roundHalfUpToCent(runningCostsForPeriodCents([{
        categoryCode: "bills", monthKey, amountCents: bills.value.totalCents,
        isMissing: false, isEstimate: false,
      }], from, to)) : bills.value.totalCents;
      if (!validCents(cents)) return noEvidence("expenses", copy.missingEvidence);
      return fromEvidence("expenses", bills, [source], [
        periodIntro(accrued ? copy.accruedBillsIntro : copy.monthlyBillsIntro,
          accrued ? from : monthKey + "-01", accrued ? to : lastDay, copy),
        { type: "metric", label: accrued ? copy.accruedBillsLabel : copy.recurringBills,
          valueCents: cents, source },
      ], copy);
    }
    if (metric === "recorded_spending") {
      const expenses = await tools.getRecordedExpenses({ from, to });
      if (!expenses.available) return fromEvidence("expenses", expenses, [source], [], copy);
      return fromEvidence("expenses", expenses, [source], [
        periodIntro(copy.actualExpensesIntro, from, to, copy),
        { type: "metric", label: copy.actualExpensesLabel, valueCents: expenses.value.totalCents, source },
      ], copy);
    }
    if (metric === "sales_revenue") {
      const trend = await tools.getSalesTrend({ from, to });
      if (!trend.available) return fromEvidence("profitability", trend, [source], [], copy);
      const sales = trend.value.reduce((sum, d) => sum + d.netSalesCents, 0);
      if (!validCents(sales)) return noEvidence("profitability", copy.missingEvidence);
      return fromEvidence("profitability", trend, [source], [
        periodIntro(copy.salesQuantityIntro, from, to, copy),
        { type: "metric", label: copy.sales, valueCents: sales, source },
      ], copy);
    }
    const profit = await tools.getProfitability({ from, to });
    if (!profit.available) return fromEvidence("profitability", profit, [source], [], copy);
    const p = profit.value;
    const values = metric === "total_business_costs"
      ? [{ label: copy.totalCosts, valueCents: p.totalCostsCents }]
      : metric === "owner_profit"
        ? [{ label: copy.ownerProfit, valueCents: p.ownerProfitCents }]
        : [
            { label: copy.sales, valueCents: p.netSalesCents },
            { label: copy.totalCosts, valueCents: p.totalCostsCents },
            { label: copy.ownerProfit, valueCents: p.ownerProfitCents },
          ];
    if (values.some((v) => !validCents(v.valueCents))) return noEvidence("profitability", copy.missingEvidence);
    return fromEvidence("profitability", profit, [source], [
      periodIntro(metric === "total_business_costs" ? copy.businessCostsIntro
        : period === "today" ? copy.todayOverview : copy.monthOverview, from, to, copy),
      ...values.map((v) => ({ type: "metric" as const, ...v, source })),
    ], copy);
  }
  if (plan.name === "read_sales") {
    const { metric, period, category, product_name } = plan.arguments;
    if (period === "yesterday" || period === "previous_month" || period === "other_period") {
      return noEvidence("sales_quantity", copy.periodUnavailable, "unsupported_period");
    }
    // No today rollup is not a verified $0 sale. Home explicitly distinguishes
    // todayHasData=false; the current-month CaféState preserves its absence.
    if (period === "today" && metric === "sales_revenue" &&
      (!state.sales.available || !state.sales.value.some((day) => day.date === asOf))) {
      if (!state.sales.available && state.sales.quality.missingInputs.includes("periodOutsideLoadedMonth")) {
        return noEvidence("sales_quantity", copy.periodUnavailable, "unsupported_period");
      }
      const source = ref("sales:no_recorded_row:" + asOf, asOf);
      return fromEvidence("sales_quantity", known({ date: asOf, hasRecordedSales: false }), [source], [
        { type: "text", text: copy.noSalesToday },
      ], copy);
    }
    const { from, to } = datesFor(state, period);
    const source = ref("sales:" + metric + ":" + from + ":" + to, asOf);
    const intro = periodIntro(copy.salesQuantityIntro, from, to, copy);
    if (metric === "orders" || metric === "drinks" || metric === "sales_revenue") {
      const trend = await tools.getSalesTrend({ from, to });
      if (!trend.available) return fromEvidence("sales_quantity", trend, [source], [], copy);
      const value = trend.value.reduce((sum, d) =>
        sum + (metric === "orders" ? d.ordersCount : metric === "drinks" ? d.drinksCount : d.netSalesCents), 0);
      if (metric === "sales_revenue") {
        if (!validCents(value)) return noEvidence("sales_quantity", copy.missingEvidence);
        return fromEvidence("sales_quantity", trend, [source], [intro,
          { type: "metric", label: copy.sales, valueCents: value, source }], copy);
      }
      if (!validCount(value)) return noEvidence("sales_quantity", copy.missingEvidence);
      return fromEvidence("sales_quantity", trend, [source], [intro,
        { type: "count", label: metric === "orders" ? copy.ordersCount : copy.drinksCount, value, source }], copy);
    }
    const products = await tools.getProductSales({ from, to });
    if (!products.available) {
      // No last-28-day substitution. Only fully covered day aggregates may be shown,
      // and they are explicitly labeled as NOT product-unit totals.
      const trend = await tools.getSalesTrend({ from, to });
      if (!trend.available) return noEvidence("sales_quantity", copy.missingEvidence);
      const drinks = trend.value.reduce((sum, d) => sum + d.drinksCount, 0);
      const orders = trend.value.reduce((sum, d) => sum + d.ordersCount, 0);
      if (!validCount(drinks) || !validCount(orders)) return noEvidence("sales_quantity", copy.missingEvidence);
      return fromEvidence("sales_quantity", trend, [source], [intro,
        { type: "warning", code: "item_units_unavailable", text: copy.productUnitsUnavailable },
        { type: "count", label: copy.drinksCount, value: drinks, source },
        { type: "count", label: copy.ordersCount, value: orders, source },
      ], copy);
    }
    let rows = products.value;
    if (category === "coffee" && !product_name?.trim()) {
      // There is no complete "coffee" taxonomy beyond drink/food.
      return noEvidence("sales_quantity", copy.productNotFound, "product_category_unavailable");
    }
    if (metric === "named_product_units" && !product_name?.trim()) {
      return noEvidence("sales_quantity", copy.productNotFound, "product_not_identified");
    }
    if (category === "coffee" || category === "drink" || category === "food") {
      rows = rows.filter((p) => p.category === (category === "coffee" ? "drink" : category));
    }
    if (product_name?.trim()) {
      const q = product_name.normalize("NFKC").toLocaleLowerCase().trim();
      const exact = rows.filter((p) => p.name.normalize("NFKC").toLocaleLowerCase() === q);
      const partial = rows.filter((p) => p.name.normalize("NFKC").toLocaleLowerCase().includes(q));
      rows = exact.length ? exact : partial.length === 1 ? partial : [];
    }
    if (!rows.length) return noEvidence("sales_quantity", copy.productNotFound, "product_not_identified");
    let name = copy.unitsSold;
    let count: number;
    if (metric === "distinct_products") {
      name = copy.distinctProducts;
      count = rows.filter((p) => p.units > 0).length;
    } else if (metric === "best_seller" || metric === "least_seller") {
      const rank = [...rows].sort((a, b) => metric === "least_seller"
        ? a.units - b.units || a.name.localeCompare(b.name) : b.units - a.units || a.name.localeCompare(b.name));
      const first = rank[0];
      name = metric === "best_seller" ? copy.bestSeller(first.name) : copy.leastSeller(first.name);
      count = first.units;
    } else {
      if (product_name && rows.length === 1) name = copy.matchedProduct(rows[0].name);
      count = rows.reduce((sum, p) => sum + p.units, 0);
    }
    if (!validCount(count)) return noEvidence("sales_quantity", copy.missingEvidence);
    return fromEvidence("sales_quantity", products, [source], [intro,
      { type: "count", label: name, value: count, source }], copy);
  }
  if (plan.name === "read_team") {
    const result = await tools.getTeamTasks();
    const source = ref("persisted_team_tasks", asOf, "operating_tasks");
    if (!result.available) return fromEvidence("operating_tasks", result, [source], [], copy);
    const { agent, status } = plan.arguments;
    const filtered = result.value.filter((task) =>
      (agent === "all" || agent === task.agentId) && (status === "all" ||
        (status === "needs_you" ? task.status === "needs_owner" || task.status === "needs_response"
          : task.status === status)));
    const needs = filtered.filter((t) => t.status === "needs_owner" || t.status === "needs_response").length;
    const handled = filtered.filter((t) => t.status === "handled").length;
    const watching = filtered.filter((t) => t.status === "watching").length;
    const blocks: SupervisorReplyBlock[] = [
      { type: "text", text: status === "all" ? copy.tasks(needs, handled, watching)
        : copy.taskGroup(status, filtered.length) },
    ];
    const refs: EvidenceReference[] = [source];
    for (const task of filtered.slice(0, 6)) {
      const taskRef = ref("task:" + task.id, asOf, "operating_tasks");
      refs.push(taskRef);
      const tab = task.status === "handled" ? "handled"
        : task.status === "watching" ? "watching" : "needs_you";
      blocks.push({
        type: "task_card", taskId: task.id.slice(0, 200), agent: task.agentId,
        title: taskTitle(task, copy), status: task.status,
        href: "/operations?status=" + tab + "&agent=" + task.agentId, source: taskRef,
      });
    }
    return fromEvidence("operating_tasks", result, refs, blocks, copy);
  }
  if (plan.name === "read_pricing") {
    const result = state.pricingRecommendations;
    const source = ref("current_pricing_reviews", asOf, "pricing_engine");
    if (!result.available) return fromEvidence("menu_pricing", result, [source], [], copy);
    const q = plan.arguments.product_name?.normalize("NFKC").toLocaleLowerCase().trim();
    const items = state.products.available ? state.products.value : [];
    const rows = Object.entries(result.value).filter(([id, v]) => {
      const item = items.find((p) => p.id === id);
      return item && (!q || item.name.normalize("NFKC").toLocaleLowerCase().includes(q)) &&
        v.status === "REVIEW_PRICE" && v.recommendedPriceCents !== null &&
        v.recommendedPriceCents > 0 && !v.dataQuality.missingInputs.length;
    });
    const blocks: SupervisorReplyBlock[] = [{ type: "text", text: rows.length ? copy.pricingIntro : copy.pricingNone }];
    const refs: EvidenceReference[] = [source];
    for (const [id, v] of rows.slice(0, 3)) {
      const product = items.find((item) => item.id === id);
      if (!product || v.recommendedPriceCents === null) continue;
      const r = ref("product:" + id, asOf, "pricing_engine");
      refs.push(r);
      blocks.push({ type: "metric", label: copy.priceLabel(product.name), valueCents: v.recommendedPriceCents, source: r });
    }
    if (rows.length) blocks.push({ type: "warning", code: "review_only", text: copy.pricingCaution });
    const isEstimated = rows.some(([,v]) => v.calculationMode === "BENCHMARK" || v.dataQuality.estimatedInputs.length > 0);
    return fromEvidence("menu_pricing", {
      available: true, value: result.value,
      quality: { level: isEstimated ? "medium" : "high", missingInputs: [],
        estimatedInputs: isEstimated ? ["pricingBenchmark"] : [], staleInputs: [] },
    }, refs, blocks, copy);
  }
  const rules = (await input.readRules()).filter((r) => r.status === "active" &&
    (plan.arguments.agent === "all" || r.agentId === plan.arguments.agent));
  const source = ref("approved_owner_rules", asOf, "owner_rules");
  return fromEvidence("owner_rules", known(rules), [source], rules.length ? [
    { type: "text", text: copy.rulesIntro },
    ...rules.slice(0, 3).map((r) => ({ type: "text" as const,
      text: copy.ruleItem(r.agentId, r.instruction).slice(0, 1200) })),
  ] : [{ type: "text", text: copy.rulesNone }], copy);
}
