import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { CafeState } from "@/lib/operating/types";
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
  pricingIntro: string;
  pricingNone: string;
  pricingUnavailable: string;
  pricingCaution: string;
  priceLabel: (name: string) => string;
  tasks: (needs: number, handled: number, watching: number) => string;
  staffingTasks: (count: number) => string;
  staffingNone: string;
};

export function detectSupervisorIntent(raw: string): SupervisorIntent {
  const text = raw.normalize("NFKC").toLocaleLowerCase().trim();
  if (/\b(pric(e|es|ing)|menu|latte|cappuccino|markup)\b|precio|precios|menú|سعر|أسعار|قائمة/.test(text)) return "menu_pricing";
  if (/\b(staff|employee|labor|labour|shift|schedule|payroll)\b|personal|emplead|turno|موظف|عمال|دوام|مناوب/.test(text)) return "staff";
  if (/\b(attention|urgent|tasks?|needs you|team|handled|watching|issues?)\b|atención|tareas|equipo|الاهتمام|انتباه|المهام|الفريق/.test(text)) return "operating_tasks";
  if (/\b(bills?|expenses?|rent|utilities|running costs?)\b|facturas|gastos|alquiler|فواتير|مصاريف|إيجار/.test(text)) return "expenses";
  if (/\b(profit|sales|revenue|costs?|earning|money|today|week|month|doing|business|overview)\b|ganancia|beneficio|ventas|hoy|semana|mes|negocio|cómo vamos|ربح|مبيعات|اليوم|الأسبوع|الشهر|كيف الحال/.test(text)) return "profitability";
  return "unknown";
}

function replyForSlice(
  intent: SupervisorIntent,
  slice: CafeState["profitability"] | CafeState["expenses"] | CafeState["pricingRecommendations"] | CafeState["labor"] | CafeState["sales"] | Awaited<ReturnType<BusinessScopedCafeTools["getTeamTasks"]>>,
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
  input: { text: string; state: CafeState; tools: BusinessScopedCafeTools },
  copy: SupervisorReplyCopy,
): Promise<GroundedSupervisorReply> {
  const intent = detectSupervisorIntent(input.text);
  const { state, tools } = input;
  const { from, to, label, unsupported } = periodFor(input.text, state);
  if (unsupported && (intent === "profitability" || intent === "expenses")) {
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
    const recommended = Object.entries(result.value).filter(([, price]) =>
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
