import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { isSupervisorChatConfigured } from "@/lib/ai/conversations/enabled.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { runSupervisorTurn, type SupervisorUsage } from "@/lib/ai/conversations/runSupervisorTurn.server";
import { latestInvestigationMemory } from "@/lib/ai/conversations/investigationMemory";
import { compactConversationContext } from "@/lib/ai/conversations/context";
import { labelSupervisorThread, recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { getExistingSupervisorReply, persistGroundedSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { addOwnerMessageInput, pageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { createSupervisorDiagnosticLogger, classifySupervisorError, type SupervisorStage } from "@/lib/ai/conversations/diagnostics.server";
import { recordSupervisorProgress, progressFromDiagnostic } from "@/lib/ai/conversations/progress.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
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

/** Bounded Responses tool loop. Only server-authorized read-only evidence enters model context. */
export async function POST(request: Request, context: RouteContext) {
  const diagnostics=createSupervisorDiagnosticLogger();
  const model=process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna";
  let stage:SupervisorStage="conversation_auth";
  diagnostics.emit({stage,model});
  try {
    requireSameOrigin(request);
    if (!isSupervisorChatConfigured()) throw new ConversationApiError(503, "supervisor_not_enabled");
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    const { service, scope } = await authenticatedConversationContext();
    const thread = await service.getThread(id);
    const message = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    stage="owner_message_persisted";
    diagnostics.emit({stage,model});
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
    stage="cafe_tools_created";
    diagnostics.emit({stage,model});
    const identity = await readSupervisorCafeIdentity(scope.businessId);
    stage="cafe_identity_loaded";
    diagnostics.emit({stage,model});
    const messages = (await service.listMessages(id, 0)).items;
    const history = compactConversationContext(messages, message.id);
    let aggregatedUsage: SupervisorUsage | null = null;
    let progressStep = 0;
    // Fresh per POST invocation, not per browser retry click: a retried
    // turn reuses the same clientMessageId (and progress row), but its
    // writes must not be blocked by whatever step the previous, failed
    // attempt happened to leave behind. See recordSupervisorProgress.
    const progressAttempt = crypto.randomUUID();
    let reply;
    try {
      const completed = await runSupervisorTurn({
        text: input.text, locale: input.locale, asOf: identity.asOf,
        timezone: identity.timezone, cafeName: identity.cafeName,
        tools, history,
        investigationMemory: latestInvestigationMemory(messages,scope.businessId,message.id),
        readRules: async () => (await authenticatedTeamRulesService()).listActiveRules(),
        onUsage: (usage) => { aggregatedUsage = usage; },
        onDiagnostic: (event) => {
          stage=event.stage;
          diagnostics.emit(event);
          const progress=progressFromDiagnostic(event);
          // Fire-and-forget: a stale or missing status bar must never slow
          // down or fail the owner's actual turn. progressStep is strictly
          // increasing per call, so the step-ordered write (see
          // recordSupervisorProgress) can never let a slower earlier round
          // overwrite a later one that happened to finish first.
          if (progress) void recordSupervisorProgress({
            scope, threadId: id, clientMessageId: input.clientMessageId,
            step: ++progressStep, attempt: progressAttempt, ...progress,
          });
        },
      });
      reply = completed.reply;
    } finally {
      // Also record the usage already incurred if a later provider round failed.
      // A failed owner turn remains unanswered and can be retried idempotently.
      if (aggregatedUsage) {
        try { await recordSupervisorUsage({
          scope, threadId: id, ownerMessageId: message.id, usage: aggregatedUsage,
        }); } catch { /* telemetry is nonblocking on deployments awaiting migration */ }
      }
    }
    stage="reply_persistence";
    diagnostics.emit({stage,model});
    const stored = await persistGroundedSupervisorReply(scope, message, reply);
    return conversationJson({ message, reply: stored, replyStatus: "complete" }, 201);
  } catch(error) {
    diagnostics.emit({...classifySupervisorError(error,stage),model});
    return conversationError(error);
  }
}
