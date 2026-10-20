import { randomUUID } from "node:crypto";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { isSupervisorChatConfigured } from "@/lib/ai/conversations/enabled.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { runSupervisorTurn, type SupervisorUsage } from "@/lib/ai/conversations/runSupervisorTurn.server";
import { latestInvestigationMemory } from "@/lib/ai/conversations/investigationMemory";
import { compactConversationContext } from "@/lib/ai/conversations/context";
import { labelSupervisorThread, recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { getExistingSupervisorReply, persistGroundedSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { SupervisorReplyValidationError, buildReplyValidationFallbackReply } from "@/lib/ai/conversations/replyValidation";
import { addOwnerMessageInput, pageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { createSupervisorDiagnosticLogger, classifySupervisorError, logSupervisorDebugPayload, type SupervisorStage } from "@/lib/ai/conversations/diagnostics.server";
import { recordSupervisorProgress, progressFromDiagnostic } from "@/lib/ai/conversations/progress.server";
import {withSupervisorPrivateTrace,persistSupervisorPrivateTrace} from "@/lib/ai/conversations/privateTrace.server";

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
  const debugRequestId=randomUUID().slice(0,12);
  let traceOwner:{scope:{businessId:string;ownerUserId:string};threadId:string;ownerMessageId:string}|null=null;
  return withSupervisorPrivateTrace(async()=>{
  const diagnostics=createSupervisorDiagnosticLogger(console.info,debugRequestId);
  const model=process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna";
  let stage:SupervisorStage="conversation_auth";
  diagnostics.emit({stage,model});
  try {
    requireSameOrigin(request);
    if (!isSupervisorChatConfigured()) throw new ConversationApiError(503, "supervisor_not_enabled");
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
    logSupervisorDebugPayload({point:"turn_received",requestId:debugRequestId,
      threadId:id,ownerQuestion:input.text});
    const { service, scope } = await authenticatedConversationContext();
    const thread = await service.getThread(id);
    const message = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    traceOwner={scope,threadId:id,ownerMessageId:message.id};
    logSupervisorDebugPayload({point:"owner_message_persisted",requestId:debugRequestId,
      threadId:id,ownerMessageId:message.id,clientMessageId:input.clientMessageId,
      message,ownerRequest:input,ownerScope:{businessId:scope.businessId,ownerUserId:scope.ownerUserId}});
    stage="owner_message_persisted";
    diagnostics.emit({stage,model});
    const previousReply = await getExistingSupervisorReply(scope, message);
    if (previousReply) {
      // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
      logSupervisorDebugPayload({point:"http_response_sent",requestId:debugRequestId,
        httpStatus:200,replyStatus:previousReply.grounding?.status,replayed:true,
        ownerMessage:message,returnedReply:previousReply,
        replyStatusBody:"complete"});
      return conversationJson({ message, reply: previousReply, replyStatus: "complete" }, 200);
    }
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
    // attempt happened to leave behind. Epoch milliseconds (not a random
    // id) so a strictly later attempt always outranks an earlier one. See
    // recordSupervisorProgress.
    const progressAttempt = Date.now();
    let reply;
    try {
      const completed = await runSupervisorTurn({
        text: input.text, locale: input.locale, asOf: identity.asOf,
        timezone: identity.timezone, cafeName: identity.cafeName,
        tools, history,
        investigationMemory: latestInvestigationMemory(messages,scope.businessId,message.id),
        debugRequestId,
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
    let stored: Awaited<ReturnType<typeof persistGroundedSupervisorReply>>;
    try {
      stored = await persistGroundedSupervisorReply(scope, message, reply);
      // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
      logSupervisorDebugPayload({point:"persistence_result",requestId:debugRequestId,
        ok:true,ownerMessage:message,replyInput:reply,storedReply:stored});
    } catch (persistError) {
      if (!(persistError instanceof SupervisorReplyValidationError)) {
        // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
        logSupervisorDebugPayload({point:"persistence_result",requestId:debugRequestId,ok:false});
        throw persistError;
      }
      // This gate firing always indicates a genuine upstream bug (a reply
      // asserting a fact with no real grounding behind it), never a normal
      // "couldn't verify" case -- those are already handled earlier in the
      // pipeline. It must stay loud internally (full raw detail, same
      // temporary debug mechanism as every investigation round) while
      // degrading gracefully for the owner: no raw/generic error, just a
      // safe, minimal, honest fallback reply in the same spirit as the
      // investigation loop's own exhaustion fallback.
      stage="reply_validation";
      diagnostics.emit({...classifySupervisorError(persistError,stage),model});
      // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
      logSupervisorDebugPayload({point:"reply_validation_failed",requestId:debugRequestId,
        reason:persistError.reason,reply:persistError.reply});
      const fallback = buildReplyValidationFallbackReply(input.locale);
      stage="reply_persistence";
      try {
        stored = await persistGroundedSupervisorReply(scope, message, fallback);
        // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
        logSupervisorDebugPayload({point:"persistence_result",requestId:debugRequestId,
          ok:true,fallback:true,ownerMessage:message,storedReply:stored});
      } catch (fallbackPersistError) {
        // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
        logSupervisorDebugPayload({point:"persistence_result",requestId:debugRequestId,
          ok:false,fallback:true});
        throw fallbackPersistError;
      }
    }
    // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
    logSupervisorDebugPayload({point:"http_response_sent",requestId:debugRequestId,
      httpStatus:201,replyStatus:stored.grounding?.status,
      responseBody:{message,reply:stored,replyStatus:"complete"},aggregatedUsage});
    return conversationJson({ message, reply: stored, replyStatus: "complete" }, 201);
  } catch(error) {
    diagnostics.emit({...classifySupervisorError(error,stage),model});
    const response=conversationError(error);
    logSupervisorDebugPayload({point:"http_response_error",requestId:debugRequestId,
      httpStatus:response.status,stage,errorName:error instanceof Error?error.name:"unknown",
      errorCode:error instanceof ConversationApiError?error.code:undefined});
    return response;
  }
  },async(trace)=>{
    if(traceOwner)await persistSupervisorPrivateTrace({...traceOwner,requestId:debugRequestId,trace});
  });
}
