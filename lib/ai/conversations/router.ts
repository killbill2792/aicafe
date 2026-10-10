import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { CafeState, KnownSlice } from "@/lib/operating/types";
import { roundHalfUpToCent, runningCostsForPeriodCents } from "@/lib/calc";
import type { GroundedSupervisorReply, SupervisorIntent, EvidenceReference, SupervisorReplyBlock } from "./contracts";
import { assessGrounding } from "./grounding";

export type SupervisorReplyCopy = {
  unsupported: string;
  missingEvidence: string;
  estimatedNotice: string;
  todayOverview: string;
  monthOverview: string;
  weekOverview: string;
  periodUnavailable: string;
  sales: string;
  totalCosts: string;
  ownerProfit: string;
  recurringBills: string;
  billsIntro: string;
  monthlyBillsIntro: string;
  accruedBillsIntro: string;
  actualExpensesIntro: string;
  businessCostsIntro: string;
  actualExpensesLabel: string;
  accruedBillsLabel: string;
  periodRange: (from: string, to: string) => string;
  salesQuantityIntro: string;
  unitsSold: string;
  ordersCount: string;
  drinksCount: string;
  distinctProducts: string;
  bestSeller: (name: string) => string;
  leastSeller: (name: string) => string;
  matchedProduct: (name: string) => string;
  productNotFound: string;
  productUnitsUnavailable: string;
  pricingIntro: string;
  pricingNone: string;
  pricingUnavailable: string;
  pricingCaution: string;
  priceLabel: (name: string) => string;
  tasks: (needs: number, handled: number, watching: number) => string;
  staffingTasks: (count: number) => string;
  staffingNone: string;
  rulesIntro: string;
  rulesNone: string;
  ruleItem: (agent: string, instruction: string) => string;
};

export function detectSupervisorIntent(raw: string): SupervisorIntent {
  const text = raw.normalize("NFKC").toLocaleLowerCase().trim();
  if (/\b(rules?|instructions?|guidelines?|policies)\b|reglas|instrucciones|normas|قواعد|تعليمات/.test(text)) return "owner_rules";
  if (/(how many|number of|units?|quantit|sold|selling|best.sell|least.sell|most.sell|top.sell|\bmost\b|\bleast\b|popular|cuánt|vendid|unidades|más vendid|menos vendid|كم|الأكثر مبيع|الأقل مبيع)/.test(text) &&
      /(products?|items?|drinks?|coffees?|coffee|orders?|cups?|beverages?|latte|cappuccino|sold|selling|productos?|bebidas?|cafés?|pedidos|منتج|مشروب|قهو|طلبات)/.test(text)) return "sales_quantity";
  if (/\b(pric(e|es|ing)|menu|latte|cappuccino|markup)\b|precio|precios|menú|سعر|أسعار|قائمة/.test(text)) return "menu_pricing";
  if (/\b(staff|employee|labor|labour|shift|schedule|payroll)\b|personal|emplead|turno|موظف|عمال|دوام|مناوب/.test(text)) return "staff";
  if (/\b(attention|urgent|tasks?|needs you|team|handled|watching|issues?)\b|atención|tareas|equipo|الاهتمام|انتباه|المهام|الفريق/.test(text)) return "operating_tasks";
  if (/\b(profit|profits|margin|earnings?)\b|ganancia|beneficio|ربح/.test(text)) return "profitability";
  if (/\b(bills?|expenses?|rent|utilities|running costs?|total costs?|spent|spending|fixed costs?)\b|facturas|gastos|alquiler|فواتير|مصاريف|إيجار|أنفقت/.test(text)) return "expenses";
  if (/\b(profit|sales|revenue|costs?|earning|money|today|week|month|doing|business|overview)\b|ganancia|beneficio|ventas|hoy|semana|mes|negocio|cómo vamos|ربح|مبيعات|اليوم|الأسبوع|الشهر|كيف الحال/.test(text)) return "profitability";
  return "unknown";
}

function replyForSlice(
  intent: SupervisorIntent,
  slice: KnownSlice<unknown>,
  evidence: EvidenceReference[],
  blocks: SupervisorReplyBlock[],
  copy: SupervisorReplyCopy,
): GroundedSupervisorReply {
  const assessment = assessGrounding(intent, slice, evidence);
  if (assessment.status === "insufficient_evidence") {
    return {
      intent, status: assessment.status, evidence: [],
      blocks: [{ type: "warning", code: "insufficient_evidence", text: copy.missingEvidence }],
    };
  }
  return {
    intent, status: assessment.status, evidence: assessment.evidence,
    blocks: [...blocks, ...(assessment.status === "estimated" ? [{
      type: "warning" as const, code: "estimated", text: copy.estimatedNotice,
    }] : [])],
  };
}

function periodFor(text: string, state: CafeState, defaultMonth = false) {
  const q = text.normalize("NFKC").toLocaleLowerCase();
  // Phase 2 does not have authoritative prior-month bill histories.
  // Refuse historical/future requests rather than silently showing today.
  const unsupported = /\b(yesterday|tomorrow|previous|last month|last week|prior month|next month|next week)\b|mes pasado|semana pasada|ayer|mañana|الأمس|غدا|غداً|الشهر الماضي|الأسبوع الماضي|الأسبوع السابق|الشهر السابق|\b20\d{2}[-/]\d{1,2}\b/i.test(q);
  const wantsWeek = /\b(this week|past seven days|last seven days|7 days|week|weekly)\b|esta semana|últimos siete días|آخر سبعة أيام|هذا الأسبوع/.test(q);
  const wantsToday = /\b(today|this morning)\b|hoy|اليوم/.test(q);
  const wantsMonth = /\b(this month|current month|monthly|month|so far|to date|month-to-date)\b|este mes|mensual|hasta ahora|الشهر|شهري|حتى الآن/.test(q) ||
    (defaultMonth && !wantsToday && !wantsWeek);
  const from = wantsMonth ? state.period.from
    : wantsWeek ? new Date(Date.parse(state.asOf + "T12:00:00Z") - 6 * 86400000)
      .toISOString().slice(0, 10)
    : state.asOf;
  return { from, to: state.asOf, label: wantsMonth ? "month" as const :
    wantsWeek ? "week" as const : "today" as const, unsupported };
}

/** This is intentionally a finite, deterministic router, NOT a free-form LLM.
 * Values come exclusively from Phase 2 typed tools and are never guessed.
 */
export async function answerSupervisorQuestion(
  input: { text: string; state: CafeState; tools: BusinessScopedCafeTools; activeRules?: TeamRule[] | null },
  copy: SupervisorReplyCopy,
): Promise<GroundedSupervisorReply> {
  const intent = detectSupervisorIntent(input.text);
  const { state, tools } = input;
  const { from, to, label, unsupported } = periodFor(input.text, state,
    intent === "expenses" || (intent === "sales_quantity" && /\b(so far|to date|month-to-date)\b|hasta ahora|حتى الآن/i.test(input.text)));
  if (unsupported && (intent === "profitability" || intent === "expenses" || intent === "sales_quantity")) {
    return {
      intent, status: "insufficient_evidence", evidence: [],
      blocks: [{ type: "warning", code: "unsupported_period", text: copy.periodUnavailable }],
    };
  }
  const dates = { from, to };
  const observedAt = state.asOf;
  const source: EvidenceReference = {
    source: "cafe_state", identifier: "profitability:" + from + ":" + to, asOf: observedAt,
  };

  if (intent === "owner_rules") {
    if (!input.activeRules) {
      return {
        intent, status: "insufficient_evidence", evidence: [],
        blocks: [{ type: "warning", code: "rules_unavailable", text: copy.missingEvidence }],
      };
    }
    const source: EvidenceReference = {
      source: "owner_rules", identifier: "approved-guidance", asOf: new Date().toISOString(),
    };
    const normalizedText = input.text.normalize("NFKC").toLocaleLowerCase();
    const named = (["supervisor", "alex", "olivia", "maya", "leo"] as const)
      .find((agent) => normalizedText.includes(agent));
    const active = input.activeRules.filter((rule) =>
      rule.status === "active" && (!named || rule.agentId === named));
    return {
      intent, status: "verified", evidence: [source],
      blocks: active.length === 0
        ? [{ type: "text", text: copy.rulesNone }]
        : [{ type: "text", text: copy.rulesIntro },
            ...active.slice(0, 3).map((rule) => ({
              type: "text" as const, text: copy.ruleItem(rule.agentId, rule.instruction),
            }))],
    };
  }

  if (intent === "profitability" || intent === "cafe_overview") {
    const result = await tools.getProfitability(dates);
    if (!result.available) return replyForSlice(intent, result, [source], [], copy);
    const data = result.value;
    return replyForSlice(intent, result, [source], [
      { type: "text", text: label === "month" ? copy.monthOverview : label === "week" ? copy.weekOverview : copy.todayOverview },
      { type: "metric", label: copy.sales, valueCents: data.netSalesCents, source },
      { type: "metric", label: copy.totalCosts, valueCents: data.totalCostsCents, source },
      { type: "metric", label: copy.ownerProfit, valueCents: data.ownerProfitCents, source },
    ], copy);
  }

  if (intent === "expenses") {
    const q = input.text.normalize("NFKC").toLocaleLowerCase();
    const isAccrual = /\b(accru\w*|prorat\w*|elapsed fixed|fixed bills so far)\b|devengad|prorrate|مستحق|المتراكمة/.test(q);
    const isRecorded = /\b(spent|spending|paid|actual expenses?|recorded expenses?|spent so far)\b|gastad|pagad|أنفقت|المدفوعة/.test(q);
    const isBills = !isRecorded && !isAccrual && /\b(bills?|rent|utilities|recurring|fixed)\b|facturas|alquiler|فواتير|إيجار/.test(q);
    if (isBills || isAccrual) {
      const result = await tools.getMonthlyBills();
      const ref: EvidenceReference = {
        source: "cafe_state", identifier: "recurring_budget:" + state.asOf.slice(0, 7), asOf: observedAt,
      };
      if (!result.available) return replyForSlice(intent, result, [ref], [], copy);
      const monthKey = state.asOf.slice(0, 7);
      const monthEnd = new Date(Date.UTC(Number(monthKey.slice(0, 4)),
        Number(monthKey.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const amount = isAccrual
        ? roundHalfUpToCent(runningCostsForPeriodCents([{
            categoryCode: "bills", monthKey, amountCents: result.value.totalCents,
            isEstimate: false, isMissing: false,
          }], from, to))
        : result.value.totalCents;
      return replyForSlice(intent, result, [ref], [
        { type: "text", text: (isAccrual ? copy.accruedBillsIntro : copy.monthlyBillsIntro)
          + " " + copy.periodRange(isAccrual ? from : monthKey + "-01", isAccrual ? to : monthEnd) },
        { type: "metric", label: isAccrual ? copy.accruedBillsLabel : copy.recurringBills,
          valueCents: amount, source: ref },
      ], copy);
    }
    if (isRecorded) {
      const result = await tools.getRecordedExpenses(dates);
      const ref: EvidenceReference = { source: "cafe_state", identifier: "actual_expense_entries:" + from + ":" + to, asOf: observedAt };
      if (!result.available) return replyForSlice(intent, result, [ref], [], copy);
      return replyForSlice(intent, result, [ref], [
        { type: "text", text: copy.actualExpensesIntro + " " + copy.periodRange(from, to) },
        { type: "metric", label: copy.actualExpensesLabel, valueCents: result.value.totalCents, source: ref },
      ], copy);
    }
    // Total business costs: ONLY the canonical period-scoped financial engine,
    // not the snapshot's hybrid actual-or-recurring category values re-prorated.
    const result = await tools.getProfitability(dates);
    if (!result.available) return replyForSlice(intent, result, [source], [], copy);
    return replyForSlice(intent, result, [source], [
      { type: "text", text: copy.businessCostsIntro + " " + copy.periodRange(from, to) },
      { type: "metric", label: copy.totalCosts, valueCents: result.value.totalCostsCents, source },
    ], copy);
  }

  if (intent === "sales_quantity") {
    const q = input.text.normalize("NFKC").toLocaleLowerCase();
    const wantsOrders = /\borders?\b|pedidos|طلبات/.test(q);
    const wantsDrinks = /\bdrinks?\b|bebidas|مشروب|مشروبات/.test(q);
    const wantsRanking = /\b(best|most|top|least|worst|lowest|popular)\b|más vendid|menos vendid|الأكثر|الأقل/.test(q);
    const wantsLeast = /\b(least|worst|lowest)\b|menos vendid|الأقل/.test(q);
    const wantsDistinct = /\b(distinct|different|unique|variety)\b|diferentes|مختلف/.test(q);
    const ref: EvidenceReference = { source: "cafe_state", identifier: "sales_units:" + from + ":" + to, asOf: observedAt };
    const trend = await tools.getSalesTrend(dates);
    if (!trend.available) return replyForSlice(intent, trend, [ref], [], copy);
    const intro: SupervisorReplyBlock = { type: "text", text: copy.salesQuantityIntro + " " + copy.periodRange(from, to) };
    if (wantsOrders || (wantsDrinks && !wantsRanking)) {
      const value = trend.value.reduce((sum, d) => sum + (wantsOrders ? d.ordersCount : d.drinksCount), 0);
      return replyForSlice(intent, trend, [ref], [intro, {
        type: "count", label: wantsOrders ? copy.ordersCount : copy.drinksCount,
        value, source: ref,
      }], copy);
    }
    const products = await tools.getProductSales(dates);
    if (!products.available) {
      // Daily aggregate counts may still be trustworthy even when item-level
      // backfill is missing. Name the distinction rather than guess a total.
      const aggregateRef: EvidenceReference = {
        source: "cafe_state", identifier: "rollup_orders_drinks:" + from + ":" + to, asOf: observedAt,
      };
      return replyForSlice(intent, trend, [aggregateRef], [
        intro,
        { type: "warning", code: "item_units_unavailable", text: copy.productUnitsUnavailable },
        { type: "count", label: copy.drinksCount,
          value: trend.value.reduce((sum, d) => sum + d.drinksCount, 0), source: aggregateRef },
        { type: "count", label: copy.ordersCount,
          value: trend.value.reduce((sum, d) => sum + d.ordersCount, 0), source: aggregateRef },
      ], copy);
    }
    let rows = products.value;
    // There is no trustworthy "coffee" category in the menu schema: it only
    // distinguishes drink vs food. A coffee-name substring is not a full taxonomy.
    const coffeeRequest = /\bcoffee(s)?\b|cafés?|قهو/.test(q);
    const requestedNames = rows.filter((p) => q.includes(p.name.normalize("NFKC").toLocaleLowerCase()));
    if (coffeeRequest && requestedNames.length === 0) {
      return { intent, status: "insufficient_evidence", evidence: [],
        blocks: [{ type: "warning", code: "product_not_identified", text: copy.productNotFound }] };
    }
    if (wantsDrinks || coffeeRequest) rows = rows.filter((p) => p.category === "drink");
    const named = rows.filter((p) => q.includes(p.name.normalize("NFKC").toLocaleLowerCase()));
    if (named.length) rows = named;
    if (!rows.length) return { intent, status: "insufficient_evidence", evidence: [],
      blocks: [{ type: "warning", code: "product_not_identified", text: copy.productNotFound }] };
    if (wantsRanking) {
      const ranked = [...rows].sort((a, b) => wantsLeast ? a.units - b.units || a.name.localeCompare(b.name)
        : b.units - a.units || a.name.localeCompare(b.name));
      const first = ranked[0];
      return replyForSlice(intent, products, [ref], [intro, {
        type: "count", label: wantsLeast ? copy.leastSeller(first.name) : copy.bestSeller(first.name),
        value: first.units, source: ref,
      }], copy);
    }
    const count = wantsDistinct ? rows.filter((p) => p.units > 0).length :
      rows.reduce((sum, p) => sum + p.units, 0);
    return replyForSlice(intent, products, [ref], [intro, {
      type: "count", label: wantsDistinct ? copy.distinctProducts :
        named.length ? copy.matchedProduct(named.map((p) => p.name).join(", ")) : copy.unitsSold,
      value: count, source: ref,
    }], copy);
  }

  if (intent === "staff" || intent === "operating_tasks") {
    const tasks = await tools.getTeamTasks();
    const ref: EvidenceReference = {
      source: "operating_tasks", identifier: "persisted-inbox", asOf: new Date().toISOString(),
    };
    if (!tasks.available) return replyForSlice(intent, tasks, [ref], [], copy);
    if (intent === "staff") {
      const outstanding = tasks.value.filter((task) => task.agentId === "olivia" &&
        (task.status === "needs_owner" || task.status === "needs_response"));
      return replyForSlice(intent, tasks, [ref], [{
        type: "text", text: outstanding.length ? copy.staffingTasks(outstanding.length) : copy.staffingNone,
      }], copy);
    }
    const needs = tasks.value.filter((t) => t.status === "needs_owner" || t.status === "needs_response").length;
    const handled = tasks.value.filter((t) => t.status === "handled").length;
    const watching = tasks.value.filter((t) => t.status === "watching").length;
    return replyForSlice(intent, tasks, [ref], [{
      type: "text", text: copy.tasks(needs, handled, watching),
    }], copy);
  }

  if (intent === "menu_pricing") {
    const result = state.pricingRecommendations;
    const ref: EvidenceReference = {
      source: "pricing_engine", identifier: "canonical-menu-recommendations", asOf: observedAt,
    };
    if (!result.available) return replyForSlice(intent, result, [ref], [], copy);
    const normalizedRequest = input.text.normalize("NFKC").toLocaleLowerCase();
    const namedItems = state.products.available ? state.products.value
      .filter((p) => p.name.length > 1 &&
        normalizedRequest.includes(p.name.normalize("NFKC").toLocaleLowerCase()))
      .map((p) => p.id) : [];
    const recommended = Object.entries(result.value).filter(([id, price]) =>
      (namedItems.length === 0 || namedItems.includes(id)) &&
      price.status === "REVIEW_PRICE" && price.recommendedPriceCents !== null &&
      price.recommendedPriceCents > 0 && price.dataQuality.missingInputs.length === 0,
    );
    const evidence: EvidenceReference[] = [ref];
    const blocks: SupervisorReplyBlock[] = [{
      type: "text",
      text: recommended.length === 0 ? copy.pricingNone : copy.pricingIntro,
    }];
    for (const [id, price] of recommended.slice(0, 3)) {
      const item = state.products.available ? state.products.value.find((p) => p.id === id) : null;
      if (!item || price.recommendedPriceCents === null) continue;
      const itemSource: EvidenceReference = {
        source: "pricing_engine", identifier: "product:" + id, asOf: observedAt,
      };
      evidence.push(itemSource);
      blocks.push({
        type: "metric", label: copy.priceLabel(item.name),
        valueCents: price.recommendedPriceCents, source: itemSource,
      });
    }
    if (recommended.length) blocks.push({
      type: "warning", code: "review_only", text: copy.pricingCaution,
    });
    // Pricing is at least estimated whenever it uses a benchmark/default profile.
    const estimated = recommended.some(([, p]) =>
      p.calculationMode === "BENCHMARK" || p.dataQuality.estimatedInputs.length > 0);
    const evidenceQuality = {
      available: true as const, value: result.value,
      quality: {
        level: estimated ? "medium" as const : "high" as const,
        missingInputs: [] as string[],
        estimatedInputs: estimated ? ["pricingBenchmark"] : [],
        staleInputs: [] as string[],
      },
    };
    return replyForSlice(intent, evidenceQuality, evidence, blocks, copy);
  }

  return {
    intent: "unknown", status: "insufficient_evidence", evidence: [],
    blocks: [{ type: "warning", code: "unsupported_question", text: copy.unsupported }],
  };
}
