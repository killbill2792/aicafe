import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import { randomUUID } from "node:crypto";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { isSupervisorChatConfigured } from "@/lib/ai/conversations/enabled.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { runSupervisorTurn, type SupervisorUsage } from "@/lib/ai/conversations/runSupervisorTurn.server";
import { latestInvestigationMemory } from "@/lib/ai/conversations/investigationMemory";
import {submitOwnerInputMessage} from "@/lib/ai/conversations/ownerInputSubmit.server";
import {pendingOwnerInputSchema} from "@/lib/ai/supervisor/ownerInput/contracts";
import {ownerInputWrites} from "@/lib/ai/supervisor/ownerInput/writeRegistry.server";
import {resumeOwnerResolution} from "@/lib/ai/supervisor/ownerInput/resolution";
import {commitConfirmedOwnerInput} from "@/lib/ai/supervisor/ownerInput/commit.server";
import {buildOwnerQuestionReply,confirmOwnerQuestion,declinedOwnerQuestion,unresolvedOwnerSave} from "@/lib/ai/supervisor/ownerInput/response";
import type {GroundedSupervisorReply} from "@/lib/ai/conversations/contracts";
import { compactConversationContext } from "@/lib/ai/conversations/context";
import { labelSupervisorThread, recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { getExistingSupervisorReply, persistGroundedSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { SupervisorReplyValidationError, buildReplyValidationFallbackReply } from "@/lib/ai/conversations/replyValidation";
import { addOwnerMessageInput, pageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { createSupervisorDiagnosticLogger, classifySupervisorError, logSupervisorDebugPayload, type SupervisorStage } from "@/lib/ai/conversations/diagnostics.server";
import { recordSupervisorProgress, progressFromDiagnostic } from "@/lib/ai/conversations/progress.server";
import {withSupervisorPrivateTrace} from "@/lib/ai/conversations/privateTrace.server";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {capabilityToolName} from "@/lib/ai/supervisor/investigation/runInvestigation.server";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {validatePriceProposalCandidate,priceProposalToolJsonSchema,ambiguousPriceProposalOptions} from "@/lib/ai/supervisor/loop/priceIntent";
import {supervisorLoopRegistry,priceExperimentCapabilityId} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

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
  return withSupervisorPrivateTrace(async()=>{
  const diagnostics=createSupervisorDiagnosticLogger(console.info,debugRequestId);
  const model=configuredSupervisorModel();
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
    if(input.ownerInputResponse){
      // This RPC commits the owner message + structured answer atomically under
      // a per-thread lock. Distinct clients cannot consume one prompt twice.
      const submitted=await submitOwnerInputMessage(scope,id,input.clientMessageId,
        input.text,input.ownerInputResponse);
      if(!submitted.ok)throw new ConversationApiError(409,submitted.reason);
    }
    const message = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    const ownerResponse=input.ownerInputResponse??message.ownerInputResponse;
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
    // The prior assistant's validated server-grounded question is the only
    // resumable state. A client-supplied question ID or target never grants a write.
    let resumedOriginalText=input.text;
    let directReply:GroundedSupervisorReply|null=null;
    if(ownerResponse){
      const prior=messages.filter(m=>m.role==="supervisor"&&
        m.createdAt<=message.createdAt&&m.id!==message.id)
        .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
      const pending=pendingOwnerInputSchema.safeParse(prior?.grounding?.ownerInput);
      const response=ownerResponse;
      if(!pending.success||pending.data.businessId!==scope.businessId||
        pending.data.questionId!==response.questionId)
        throw new ConversationApiError(409,"owner_input_not_pending");
      const state=pending.data;
      if(response.action==="dismiss"){
        directReply=declinedOwnerQuestion(input.locale);
      }else if(response.action==="supply"&&state.stage==="answer"){
        const value=response.value??"";
        if(state.request.mode==="resolve"){
          const resumed=resumeOwnerResolution(state.originalText,state.request,value);
          if(!resumed){
            directReply=buildOwnerQuestionReply({businessId:scope.businessId,
              originalText:state.originalText,readCapabilityId:state.readCapabilityId,
              readInput:JSON.parse(state.readInputJson),request:state.request,questionId:state.questionId});
          }else if(state.request.writeContext.domain==="menu"&&
            state.request.writeContext.catalogRevision){
            // A once-valid option must be rechecked against the current
            // authenticated catalog epoch before it can guide a new read.
            const fresh=await readAuthorizedAtomicP1SourceSnapshot();
            if(fresh.status!=="available"||fresh.snapshot.businessId!==scope.businessId||
              fresh.snapshot.truncated.menu||
              fresh.snapshot.revision!==state.request.writeContext.catalogRevision||
              (state.request.input.kind==="options"&&
                !fresh.snapshot.sources.menu.some(m=>m.is_active&&m.id===value))){
              // Ignore stale pin; rediscover current options from the original
              // question instead of reusing stale IDs or silently committing.
              resumedOriginalText=state.originalText;
            }else resumedOriginalText=resumed;
          }else resumedOriginalText=resumed;
        }else{
          const prepared=ownerInputWrites.prepare(state.request,value);
          directReply=prepared?confirmOwnerQuestion(state,value,prepared.summary):
            buildOwnerQuestionReply({businessId:scope.businessId,originalText:state.originalText,
              readCapabilityId:state.readCapabilityId,readInput:JSON.parse(state.readInputJson),
              request:state.request,questionId:state.questionId});
        }
      }else if(response.action==="confirm"&&state.stage==="confirm"&&state.answer){
        const applied=await commitConfirmedOwnerInput(scope,state);
        if(applied.ok){
          // The next investigation MUST re-read; no cached figure is replayed.
          resumedOriginalText=state.originalText;
        }else if(applied.reason==="confirmation_in_progress"){
          // An earlier request is still completing the approved write. Do not
          // attach a misleading final reply to this persisted owner message.
          // Retrying this client key reconciles the one-shot claim safely.
          throw new ConversationApiError(409,"confirmation_in_progress");
        }else{
          directReply=unresolvedOwnerSave(input.locale);
        }
      }else throw new ConversationApiError(409,"owner_input_stage_mismatch");
    }
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
      let reviewedVariantOptions:Array<{id:string;label:{en:string;es:string;ar:string}}>=[];
      const olderOwnerTexts=messages.filter(m=>m.role==="owner"&&m.id!==message.id&&
        typeof m.text==="string").sort((a,b)=>(b.createdAt??"").localeCompare(a.createdAt??""))
        .map(m=>m.text!).slice(0,5);
      // The normal semantic investigation can discover the registered inert
      // proposal tool in ANY owner language. Model output never authorizes
      // approval/commit/POS writes, never supplies trusted money or tenant IDs.
      const proposalTools=supervisorLoopRegistry.list().map(capabilityId=>{
        const definition=supervisorLoopRegistry.get(capabilityId);
        return {name:capabilityToolName(capabilityId),
          description:definition.proposalDescription,
          parameters:capabilityId===priceExperimentCapabilityId?priceProposalToolJsonSchema:definition.proposalInputJsonSchema};
      });
      const completed=directReply?null:await runSupervisorTurn({
        text: resumedOriginalText, locale: input.locale, asOf: identity.asOf,
        timezone: identity.timezone, cafeName: identity.cafeName,
        tools, history,
        inertProposal:{tools:proposalTools,
          knownClarificationOptions:()=>reviewedVariantOptions,
          create:async(name,rawArgs)=>{
          const capabilityId=supervisorLoopRegistry.list().find(id=>capabilityToolName(id)===name);
          const authorized=await authorizedOwnerP1();
          if(!capabilityId||authorized.identity.businessId!==scope.businessId||
            authorized.identity.currency!=="USD")return null;
          const definition=supervisorLoopRegistry.get(capabilityId);
          if(capabilityId!==priceExperimentCapabilityId)return null;
          const catalog=await getMenuControlCenter();
          const checked=validatePriceProposalCandidate(rawArgs,
            catalog,[input.text,...olderOwnerTexts]);
          if(!checked){
            // The pricing domain alone inspects trusted catalog cardinality.
            // The investigation dispatcher turns the resulting options into
            // the SAME persisted requires_owner_input state as every other gap.
            reviewedVariantOptions=ambiguousPriceProposalOptions(rawArgs,catalog,
              [input.text,...olderOwnerTexts]);
            return null;
          }
          const proposed=await proposeLoop({businessId:scope.businessId,
            ownerUserId:scope.ownerUserId,threadId:id,locale:input.locale},
            supervisorLoopRegistry,new SupabaseLoopRepository(),capabilityId,
            checked,input.clientMessageId);
          const copy=({en,es,ar} as const)[input.locale].SupervisorExperiment;
          const effect=definition.parseEffect(proposed.canonicalEffectPayload);
          const cents=effect.newPriceCents;
          const nameValue=effect.productName;
          if(typeof cents!=="number"||!Number.isSafeInteger(cents)||
            typeof nameValue!=="string")return null;
          const text=copy.proposedFromChat.replace("{item}",nameValue).replace("{price}",
            new Intl.NumberFormat(input.locale,{style:"currency",currency:"USD"}).format(cents/100));
          return {id:proposed.id,text};
        }},
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
      reply = completed?.reply??directReply;
      if(!reply)throw new Error("Missing owner-input reply");
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
    // The Vercel Free console is the short-lived diagnostic export surface.
    // Never persist a full source/model/owner payload to the database or logs.
    // Structured, allowlisted operational details and cost estimates are
    // already emitted during the turn by logSupervisorDebugPayload().
    const summary=trace.events.findLast(e=>e.point==="trace_summary");
    logSupervisorDebugPayload({point:"trace_summary",
      ...(summary??{}),requestId:debugRequestId,droppedCount:trace.droppedCount});
  },debugRequestId);
}
