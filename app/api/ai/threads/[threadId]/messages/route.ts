import { getTranslations } from "next-intl/server";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { isSupervisorChatConfigured } from "@/lib/ai/conversations/enabled.server";
import { createAuthenticatedCafeTools } from "@/lib/ai/cafeTools.server";
import { planSupervisorQuestion } from "@/lib/ai/conversations/planner.server";
import { executeSupervisorPlan } from "@/lib/ai/conversations/executePlan";
import { labelSupervisorThread, recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { getExistingSupervisorReply, persistGroundedSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { addOwnerMessageInput, pageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ threadId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const page = parseInput(pageInput, { offset: new URL(request.url).searchParams.get("offset") ?? undefined });
    const { service } = await authenticatedConversationContext();
    return conversationJson(await service.listMessages(id, page.offset));
  } catch (error) {
    return conversationError(error);
  }
}

/** Strict OpenAI planner -> ONE typed owner-scoped read tool -> deterministic evidence-validated reply.
 * The model has no raw database connection, financial arithmetic, permissions or write tools.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    if (!isSupervisorChatConfigured()) throw new ConversationApiError(503, "supervisor_not_enabled");
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    const { service, scope } = await authenticatedConversationContext();
    const thread = await service.getThread(id);
    const message = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    const previousReply = await getExistingSupervisorReply(scope, message);
    if (previousReply) return conversationJson({ message, reply: previousReply, replyStatus: "complete" }, 200);
    if (thread.title === null) {
      try {
        await labelSupervisorThread(scope, id, message.text ?? input.text);
      } catch {
        // A title is decorative metadata; failure must not interrupt durable conversation.
      }
    }
    const tools = await createAuthenticatedCafeTools();
    const state = await tools.getCafeSummary();
    if (state.business.id !== scope.businessId) throw new ConversationApiError(403, "business_scope_mismatch");
    const historyPage = await service.listMessages(id, 0);
    const history = historyPage.items
      .filter((row) => row.role === "owner" && row.id !== message.id && row.text)
      .slice(-6)
      .map((row) => ({ role: "owner" as const, text: row.text ?? "" }));
    const { plan, usage } = await planSupervisorQuestion({
      text: input.text, locale: input.locale, asOf: state.asOf, history,
    });
    // Each OpenAI call incurs usage regardless of reply availability.
    // Missing/unapplied telemetry migration must not turn a successful grounded read into a loss of chat.
    try { await recordSupervisorUsage({ scope, threadId: id, ownerMessageId: message.id, usage }); }
    catch { /* deployed databases must apply reviewed migration 38 before usage reporting */ }
    const t = await getTranslations({ locale: input.locale, namespace: "SupervisorChat" });
    const reply = await executeSupervisorPlan({
      plan, state, tools,
      readRules: async () => (await authenticatedTeamRulesService()).listActiveRules(),
      copy: {
        unsupported: t("unknownRequest"),
        missingEvidence: t("insufficient"),
        estimatedNotice: t("estimation"),
        todayOverview: t("todayOverview"),
        monthOverview: t("monthOverview"),
        weekOverview: t("weekOverview"),
        periodUnavailable: t("periodUnavailable"),
        sales: t("sales"),
        totalCosts: t("costs"),
        ownerProfit: t("profit"),
        recurringBills: t("recurringBills"),
        billsIntro: t("billsIntro"),
        monthlyBillsIntro: t("monthlyBillsIntro"),
        accruedBillsIntro: t("accruedBillsIntro"),
        actualExpensesIntro: t("actualExpensesIntro"),
        businessCostsIntro: t("businessCostsIntro"),
        actualExpensesLabel: t("actualExpensesLabel"),
        accruedBillsLabel: t("accruedBillsLabel"),
        periodRange: (from, to) => t("periodRange", { from, to }),
        salesQuantityIntro: t("salesQuantityIntro"),
        unitsSold: t("unitsSold"),
        ordersCount: t("ordersCount"),
        drinksCount: t("drinksCount"),
        distinctProducts: t("distinctProducts"),
        menuTotal: t("menuTotal"), menuActive: t("menuActive"),
        menuCategoryDrink: t("menuCategoryDrink"), menuCategoryFood: t("menuCategoryFood"),
        menuStockNotice: t("menuStockNotice"), menuListIntro: t("menuListIntro"),
        menuProductDetails: (name, category) => t("menuProductDetails", { name, category }),
        noSalesToday: t("noSalesToday"),
        bestSeller: (name) => t("bestSeller", { name }),
        leastSeller: (name) => t("leastSeller", { name }),
        matchedProduct: (name) => t("matchedProduct", { name }),
        productNotFound: t("productNotFound"),
        productUnitsUnavailable: t("productUnitsUnavailable"),
        pricingIntro: t("pricingIntro"),
        pricingNone: t("pricingNone"),
        pricingUnavailable: t("insufficient"),
        pricingCaution: t("pricingCaution"),
        priceLabel: (name) => t("priceItem", { item: name }),
        tasks: (needs, handled, watching) => t("tasksSummary", { needs, handled, watching }),
        staffingTasks: (count) => t("staffSummary", { count }),
        staffingNone: t("staffNone"),
        rulesIntro: t("rulesIntro"),
        rulesNone: t("rulesNone"),
        ruleItem: (agent, instruction) => t("ruleItem", { agent, instruction }),
        taskCard: (kind, name) => {
          const kinds: Record<string, string> = {
            price_review: t("taskPrice"), staff_coverage: t("taskStaff"),
            supply_check: t("taskSupply"), money_update: t("taskMoney"),
            data_quality: t("taskData"),
          };
          const label = kinds[kind] ?? t("taskGeneral");
          return name.trim() ? t("taskCard", { kind: label, name }) : label;
        },
        taskGroup: (status, count) => t("taskGroup", {
          status: status === "needs_you" ? t("needsYou") :
            status === "handled" ? t("handled") :
            status === "watching" ? t("watching") : status,
          count,
        }),
        clarifyPeriod: t("clarifyPeriod"),
        clarifyProduct: t("clarifyProduct"),
        clarifyQuestion: t("clarifyQuestion"),
      },
    });
    const stored = await persistGroundedSupervisorReply(scope, message, reply);
    return conversationJson({ message, reply: stored, replyStatus: "complete" }, 201);
  } catch (error) {
    return conversationError(error);
  }
}
