import { getTranslations } from "next-intl/server";
import { authenticatedConversationService, authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { isSupervisorChatConfigured } from "@/lib/ai/conversations/enabled.server";
import { createAuthenticatedCafeTools } from "@/lib/ai/cafeTools.server";
import { answerSupervisorQuestion } from "@/lib/ai/conversations/router";
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
    const query = new URL(request.url).searchParams;
    const page = parseInput(pageInput, { offset: query.get("offset") ?? undefined });
    const service = await authenticatedConversationService();
    const messages = await service.listMessages(id, page.offset);
    return conversationJson(messages);
  } catch (error) {
    return conversationError(error);
  }
}

/** Records the owner's message, then obtains a deterministic, evidence-grounded
 * Supervisor reply. No user-supplied role, café, tool name or answer is accepted.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    if (!isSupervisorChatConfigured()) {
      throw new ConversationApiError(503, "supervisor_not_enabled");
    }
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    const { service, scope } = await authenticatedConversationContext();
    // This checks that the thread belongs to the authenticated owner. Owner text
    // is persisted idempotently even if downstream evidence is temporarily missing.
    const message = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    const previousReply = await getExistingSupervisorReply(scope, message);
    if (previousReply) return conversationJson({ message, reply: previousReply, replyStatus: "complete" }, 200);
    const tools = await createAuthenticatedCafeTools();
    const state = await tools.getCafeSummary();
    if (state.business.id !== scope.businessId) {
      throw new ConversationApiError(403, "business_scope_mismatch");
    }
    const t = await getTranslations({ locale: input.locale, namespace: "SupervisorChat" });
    const reply = await answerSupervisorQuestion({ text: input.text, tools, state }, {
      unsupported: t("unknownRequest"),
      missingEvidence: t("insufficient"),
      estimatedNotice: t("estimation"),
      todayOverview: t("todayOverview"),
      monthOverview: t("monthOverview"),
      sales: t("sales"),
      totalCosts: t("costs"),
      ownerProfit: t("profit"),
      recurringBills: t("recurringBills"),
      billsIntro: t("billsIntro"),
      pricingIntro: t("pricingIntro"),
      pricingNone: t("pricingNone"),
      pricingUnavailable: t("insufficient"),
      pricingCaution: t("pricingCaution"),
      priceLabel: (name) => t("priceItem", { item: name }),
      tasks: (needs, handled, watching) => t("tasksSummary", { needs, handled, watching }),
      staffingTasks: (count) => t("staffSummary", { count }),
      staffingNone: t("staffNone"),
    });
    const stored = await persistGroundedSupervisorReply(scope, message, reply);
    return conversationJson({ message, reply: stored, replyStatus: "complete" }, 201);
  } catch (error) {
    return conversationError(error);
  }
}
