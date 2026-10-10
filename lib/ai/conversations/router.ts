import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { CafeState, KnownSlice } from "@/lib/operating/types";
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
  totalExpenseIntro: string;
  spendingIntro: string;
  spendingLabel: string;
  spendingNone: string;
  fullMonthlyBills: string;
  operatingCostsSoFar: string;
  operatingCostsUnavailable: string;
  drinkUnits: string;
  recordedOrders: string;
  productSalesIntro: string;
  productSalesPartial: (observed: number, expected: number) => string;
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
  if (/\b(how many|number of|units? sold|quantity sold|products? (?:am i )?(?:selling|sold)|drinks? (?:am i )?(?:selling|sold)|orders? (?:so far|today|this month)|sales volume)\b|cuántos (?:productos|cafés|pedidos)|unidades vendidas|كم (?:منتج|طلب|مشروب)|عدد (?:المنتجات|الطلبات)/.test(text)) return "unit_sales";
  if (/\b(pric(e|es|ing)|menu|latte|cappuccino|markup)\b|precio|precios|menú|سعر|أسعار|قائمة/.test(text)) return "menu_pricing";
  if (/\b(staff|employee|labor|labour|shift|schedule|payroll)\b|personal|emplead|turno|موظف|عمال|دوام|مناوب/.test(text)) return "staff";
  if (/\b(attention|urgent|tasks?|needs you|team|handled|watching|issues?)\b|atención|tareas|equipo|الاهتمام|انتباه|المهام|الفريق/.test(text)) return "operating_tasks";
  if (/\b(bills?|expenses?|rent|utilities|running costs?|spent|paid|payments made)\b|facturas|gastos|alquiler|gastad|pagad|فواتير|مصاريف|إيجار|أنفقت/.test(text)) return "expenses";
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

function periodFor(text: string, state: CafeState) {
  const q = text.normalize("NFKC").toLocaleLowerCase();
  // Phase 2 does not have authoritative prior-month bill histories.
  // Refuse historical/future requests rather than silently showing today.
  const unsupported = /\b(yesterday|tomorrow|previous|last month|last week|prior month|next month|next week)\b|mes pasado|semana pasada|ayer|mañana|الأمس|غدا|غداً|الشهر الماضي|الأسبوع الماضي|الأسبوع السابق|الشهر السابق|\b20\d{2}[-/]\d{1,2}\b/i.test(q);
  const wantsMonth = /\b(this month|current month|monthly|month)\b|este mes|mensual|الشهر|شهري/.test(q);
  const wantsWeek = /\b(this week|past seven days|last seven days|7 days|week|weekly)\b|esta semana|últimos siete días|آخر سبعة أيام|هذا الأسبوع/.test(q);
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
  const { from, to, label, unsupported } = periodFor(input.text, state);
  if (unsupported && (intent === "profitability" || intent === "expenses" || intent === "unit_sales")) {
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

  if (intent === "unit_sales") {
    // The canonical daily rollups record orders and *drinks*, not all food and
    // merchandise units. Never label drinks as every product sold.
    const start = /\b(today|hoy|اليوم)\b/.test(input.text.toLocaleLowerCase()) ? state.asOf
      : /\b(week|7 days|semana|أسبوع)\b/.test(input.text.toLocaleLowerCase()) ? from
      : state.period.from;
    const expected = Math.round((Date.parse(state.asOf + "T00:00:00Z") -
      Date.parse(start + "T00:00:00Z")) / 86400000) + 1;
    const sales = state.sales;
    const observed = sales.available ? sales.value.filter(day =>
      day.date >= start && day.date <= state.asOf && day.salesDataStatus !== "missing") : [];
    if (observed.length === 0) return {
      intent, status: "insufficient_evidence", evidence: [],
      blocks: [{ type: "warning", code: "sales_unavailable", text: copy.missingEvidence }],
    };
    const valid = observed.every(day => [day.drinksCount, day.ordersCount].every(n =>
      Number.isSafeInteger(n) && n >= 0));
    if (!valid) return {
      intent, status: "insufficient_evidence", evidence: [],
      blocks: [{ type: "warning", code: "invalid_sales_units", text: copy.missingEvidence }],
    };
    const salesSource: EvidenceReference = {
      source: "cafe_state", identifier: "sales-counts:" + start + ":" + state.asOf,
      asOf: state.asOf,
    };
    const uniqueDays = new Set(observed.map(day => day.date)).size;
    const partial = uniqueDays !== expected;
    return {
      intent, status: "verified", evidence: [salesSource],
      blocks: [
        { type: "text", text: copy.productSalesIntro },
        { type: "count", label: copy.drinkUnits,
          value: observed.reduce((sum, day) => sum + day.drinksCount, 0), source: salesSource },
        { type: "count", label: copy.recordedOrders,
          value: observed.reduce((sum, day) => sum + day.ordersCount, 0), source: salesSource },
        ...(partial ? [{ type: "warning" as const, code: "partial_sales_coverage",
          text: copy.productSalesPartial(uniqueDays, expected) }] : []),
      ],
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
    const accrued = /\b(accrued|prorat|per day|so far in bills)\b|prorratead|تناسبي/.test(q);
    const spent = /\b(spent|paid|payments made|actually spent)\b|gastad|pagad|أنفقت|مدفوع/.test(q);
    if (spent) {
      const actual = await tools.getRecordedExpenses({ from: state.period.from, to: state.asOf });
      const ref: EvidenceReference = {
        source: "cafe_state", identifier: "expense-ledger:" + state.period.from + ":" + state.asOf,
        asOf: state.asOf,
      };
      if (!actual.available) return replyForSlice(intent, actual, [ref], [], copy);
      return replyForSlice(intent, actual, [ref], [
        { type: "text", text: actual.value.rows ? copy.spendingIntro : copy.spendingNone },
        { type: "metric", label: copy.spendingLabel, valueCents: actual.value.amountCents, source: ref },
      ], copy);
    }
    if (!accrued) {
      const bills = await tools.getMonthlyRecurringBills();
      const ref: EvidenceReference = {
        source: "cafe_state", identifier: "recurring-bills:" + state.asOf.slice(0, 7),
        asOf: state.asOf,
      };
      if (!bills.available) return replyForSlice(intent, bills, [ref], [], copy);
      const qOnlyBills = /\b(bills?|rent|utilities|monthly bills?|recurring)\b|facturas|alquiler|فواتير|إيجار/.test(q) &&
        !/\b(total expenses?|business expenses?|total costs?|all costs?)\b|gastos totales|المصاريف الكلية/.test(q);
      const blocks: SupervisorReplyBlock[] = [
        { type: "text", text: qOnlyBills ? copy.monthlyBillsIntro : copy.totalExpenseIntro },
        { type: "metric", label: copy.fullMonthlyBills, valueCents: bills.value.amountCents, source: ref },
      ];
      const references: EvidenceReference[] = [ref];
      if (!qOnlyBills) {
        const costs = await tools.getProfitability({ from: state.period.from, to: state.asOf });
        if (costs.available && costs.quality.missingInputs.length === 0 &&
          costs.quality.staleInputs.length === 0) {
          const costSource: EvidenceReference = { source: "cafe_state",
            identifier: "operating-costs:" + state.period.from + ":" + state.asOf, asOf: state.asOf };
          references.push(costSource);
          blocks.push({ type: "metric", label: copy.operatingCostsSoFar,
            valueCents: costs.value.totalCostsCents, source: costSource });
        } else {
          blocks.push({ type: "warning", code: "total_costs_incomplete",
            text: copy.operatingCostsUnavailable });
        }
      }
      return replyForSlice(intent, bills, references, blocks, copy);
    }
    const result = await tools.getExpenseSummary(dates);
    if (!result.available) return replyForSlice(intent, result, [source], [], copy);
    // Use already period-prorated cents from the existing pure running-cost model.
    // This is a recurring-bills summary, not an invented total business expense.
    const amount = result.value.reduce((sum, row) => sum + row.amountCents, 0);
    return replyForSlice(intent, result, [source], [
      { type: "text", text: copy.billsIntro },
      { type: "metric", label: copy.recurringBills, valueCents: amount, source },
    ], copy);
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
