import "server-only";
import { randomUUID } from "node:crypto";
import { GOAL_DOMAINS, type RequestedGoal, type ScopeReconciliationOutcome } from "./requestScope";

/** Only this allow-listed metadata may reach the production log. Never log errors' messages,
 * OpenAI payloads, prompts, café data, employee data or credentials. */
export type SupervisorStage =
  | "conversation_auth" | "owner_message_persisted" | "cafe_tools_created"
  | "cafe_identity_loaded" | "provider_request" | "provider_response" | "provider_fallback"
  | "semantic_plan" | "capability_selected" | "grounded_answer" | "legacy_fallback"
  | "tool_call_parse" | "tool_execution" | "final_response_parse"
  | "final_response_validation" | "scope_reconciliation" | "reply_persistence"
  | "investigation_round" | "investigation_exhausted";
export type SupervisorErrorCategory =
  | "provider_http" | "provider_timeout" | "provider_incomplete"
  | "provider_invalid_payload" | "invalid_tool_call" | "tool_execution"
  | "final_output_missing" | "final_output_malformed" | "final_output_validation"
  | "reply_persistence" | "unexpected";
export type SupervisorDiagnostic = {
  stage:SupervisorStage; category?:SupervisorErrorCategory;
  model?:string;httpStatus?:number;providerStatus?:string;
  providerErrorType?:string;providerErrorCode?:string;providerRequestId?:string;
  fromModel?:string;toModel?:string;triggerHttpStatus?:number;
  triggerProviderErrorType?:string;triggerProviderErrorCode?:string;
  round?:number;attempt?:number;advertisedToolCount?:number;
  advertisedToolNames?:string[];modelCallCount?:number;toolCallCount?:number;
  timeout?:boolean;
  declaredGoalDomains?:RequestedGoal["domain"][];
  auditedGoalDomains?:RequestedGoal["domain"][];
  normalizedGoalDomains?:RequestedGoal["domain"][];
  scopeAuditComplete?:boolean;
  scopeAuditAmbiguous?:boolean;
  reconciliationOutcome?:ScopeReconciliationOutcome;
  groundedStatus?:"verified"|"estimated"|"partial"|"unavailable"|"insufficient_evidence";
  legacyFallbackReason?:"p3_not_completed"|"p3_failed";
  requestName?:string;
  invalidPayloadReason?:"wrong_text_shape"|"unparseable_json"|"schema_mismatch"|"multiple_function_calls"|"malformed_function_call";
  schemaIssuePath?:string;
  schemaIssueCode?:string;
  schemaIssueCount?:number;
  outputItemTypes?:string[];
  messagePartTypes?:string[];
  outputTextPartCount?:number;
  jsonTextLength?:number;
  jsonErrorPosition?:number;
  validPrefixPartCount?:number;
  validPrefixMatchesSchema?:boolean;
  /** Owner-safe "which AI Team member" label for an investigation round, never
   * a raw capability id or café data. */
  agent?:"alex"|"olivia"|"leo"|"maya"|"supervisor";
  capabilityId?:string;
  /** Exactly why runInvestigationTurn gave up and returned the budget/unavailable
   * reply, so a quiet "I reached the limit" no longer has to be reverse-engineered
   * from request duration alone. */
  /** "no_progress": the adaptive budget (protocol.ts INVESTIGATION_LIMITS)
   * stopped the loop immediately -- before exhausting the time/call budget
   * -- because a round exactly repeated a prior attempt (same tool
   * selection, or the identical already-rejected answer draft) with no new
   * information, rather than waiting out the remaining budget. */
  exhaustionReason?:"model_calls"|"operations"|"time"|"identity_mismatch"|"snapshot_mismatch"|
    "observations_too_large"|"no_progress";
  /** Why a direct-answer investigation round was rejected and retried, so a
   * run of otherwise-identical "investigation_round agent:supervisor" lines
   * (previously indistinguishable) says whether the model's own citations/
   * display tokens failed validation, an independently reviewed answer was
   * judged unsupported/incomplete, or the review itself never ran (budget
   * exhaustion or an unrecoverable malformed response) -- never conflated
   * with an actual negative verdict. */
  answerRejectedReason?:"render_failed"|"review_failed"|"review_unavailable";
  /** Set on investigation_exhausted when the turn still surfaced the model's
   * own last answer, labeled unverified, instead of the generic budget
   * message -- so a log of this failure says whether the owner actually saw
   * something or truly got nothing, without having to guess from the stored
   * reply itself. */
  rescuedUnverified?:boolean;
};
const investigationRequestNames=["supervisor_investigation_step","supervisor_investigation_review",
  "supervisor_calendar_context_review","supervisor_public_query_review"] as const;
const stages:readonly SupervisorStage[]=[
  "conversation_auth","owner_message_persisted","cafe_tools_created","cafe_identity_loaded",
  "provider_request","provider_response","provider_fallback","semantic_plan",
  "capability_selected","grounded_answer","legacy_fallback","tool_call_parse","tool_execution",
  "final_response_parse","final_response_validation","scope_reconciliation","reply_persistence",
  "investigation_round","investigation_exhausted",
];
const agents=new Set(["alex","olivia","leo","maya","supervisor"]);
const exhaustionReasons=new Set(["model_calls","operations","time","identity_mismatch",
  "snapshot_mismatch","observations_too_large","no_progress"]);
const answerRejectedReasons=new Set(["render_failed","review_failed","review_unavailable"]);
const categories:readonly SupervisorErrorCategory[]=[
  "provider_http","provider_timeout","provider_incomplete","provider_invalid_payload",
  "invalid_tool_call","tool_execution","final_output_missing","final_output_malformed",
  "final_output_validation","reply_persistence","unexpected",
];
const outcomes:readonly ScopeReconciliationOutcome[]=[
  "accepted","audit_incomplete","audit_ambiguous","declared_goal_missing","semantic_conflict",
];
const validDomains=new Set<string>(GOAL_DOMAINS);
const safeDomains=(x:unknown):RequestedGoal["domain"][]=>Array.isArray(x)
  ? x.filter((v):v is RequestedGoal["domain"]=>typeof v==="string"&&validDomains.has(v)).slice(0,10)
  : [];
const safeModel=(s?:string)=>typeof s==="string"?s.replace(/[^a-zA-Z0-9_.-]/g,"").slice(0,80):undefined;
const safeCount=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:undefined;
/** Reject non-identifier strings, never log provider messages or arbitrary properties. */
const safeProviderIdentifier=(value:unknown):string|undefined=>{
  if(typeof value!=="string")return undefined;
  const limited=value.slice(0,64);
  return /^[a-zA-Z0-9_.-]+$/.test(limited)?limited:undefined;
};
/** This path inspects a payload the server has already judged malformed or
 * untrustworthy; a value there is never assumed to actually be one of OpenAI's
 * documented output/content "type" tags just because it is identifier-shaped
 * (a secret made only of letters/digits/._- would pass a syntax check). Only
 * exact membership in the Responses API's own fixed, documented enum may ever
 * reach the log; every other value is dropped, never merely truncated. */
const outputItemTypeEnum=new Set(["message","reasoning","function_call","file_search_call",
  "web_search_call","computer_call","code_interpreter_call","image_generation_call",
  "local_shell_call","mcp_call","mcp_list_tools","mcp_approval_request","custom_tool_call"]);
const messagePartTypeEnum=new Set(["output_text","refusal"]);
const safeEnumTagArray=(arr:unknown,allowed:ReadonlySet<string>):string[]=>Array.isArray(arr)
  ?[...new Set(arr.filter((v):v is string=>typeof v==="string"&&allowed.has(v)))].slice(0,8):[];
/** Inspect only the provider's error.type and error.code in a non-2xx response.
 * No raw error body or error.message escapes this function. Malformed JSON is safe. */
export async function readSafeProviderError(response:Response):Promise<Pick<SupervisorDiagnostic,
  "providerErrorType"|"providerErrorCode"|"providerRequestId">>{
  const providerRequestId=safeProviderIdentifier(response.headers.get("x-request-id"));
  let providerErrorType:string|undefined,providerErrorCode:string|undefined;
  try{
    const body:unknown=await response.json();
    if(body!==null&&typeof body==="object"&&!Array.isArray(body)&&
      "error" in body&&body.error!==null&&typeof body.error==="object"&&!Array.isArray(body.error)){
      const error=body.error as Record<string,unknown>;
      providerErrorType=safeProviderIdentifier(error.type);
      providerErrorCode=safeProviderIdentifier(error.code);
    }
  }catch{
    // Non-JSON or broken provider responses retain the status without leaking content.
  }
  return {providerErrorType,providerErrorCode,providerRequestId};
}
export class SupervisorStageError extends Error {
  readonly stage:SupervisorStage;
  readonly category:SupervisorErrorCategory;
  readonly httpStatus?:number;
  readonly providerErrorType?:string;
  readonly providerErrorCode?:string;
  readonly providerRequestId?:string;
  readonly providerStatus?:string;
  readonly round?:number;
  readonly attempt?:number;
  readonly timeout:boolean;
  readonly invalidPayloadReason?:"wrong_text_shape"|"unparseable_json"|"schema_mismatch"|"multiple_function_calls"|"malformed_function_call";
  readonly schemaIssuePath?:string;
  readonly schemaIssueCode?:string;
  readonly schemaIssueCount?:number;
  readonly outputItemTypes?:string[];
  readonly messagePartTypes?:string[];
  readonly outputTextPartCount?:number;
  readonly jsonTextLength?:number;
  readonly jsonErrorPosition?:number;
  readonly validPrefixPartCount?:number;
  readonly validPrefixMatchesSchema?:boolean;
  constructor(category:SupervisorErrorCategory,stage:SupervisorStage,meta:Partial<SupervisorDiagnostic>={}) {
    super("Supervisor internal failure: "+category);
    this.name="SupervisorStageError";
    this.category=category;this.stage=stage;
    this.httpStatus=meta.httpStatus;this.providerStatus=meta.providerStatus;
    this.providerErrorType=safeProviderIdentifier(meta.providerErrorType);
    this.providerErrorCode=safeProviderIdentifier(meta.providerErrorCode);
    this.providerRequestId=safeProviderIdentifier(meta.providerRequestId);
    this.round=meta.round;this.attempt=meta.attempt;this.timeout=meta.timeout===true;
    this.invalidPayloadReason=["wrong_text_shape","unparseable_json","schema_mismatch","multiple_function_calls","malformed_function_call"]
      .includes(meta.invalidPayloadReason as string)?meta.invalidPayloadReason:undefined;
    this.schemaIssuePath=safeProviderIdentifier(meta.schemaIssuePath);
    this.schemaIssueCode=safeProviderIdentifier(meta.schemaIssueCode);
    this.schemaIssueCount=typeof meta.schemaIssueCount==="number"&&
      Number.isSafeInteger(meta.schemaIssueCount)&&meta.schemaIssueCount>=0?
      meta.schemaIssueCount:undefined;
    const outputItemTypes=safeEnumTagArray(meta.outputItemTypes,outputItemTypeEnum);
    const messagePartTypes=safeEnumTagArray(meta.messagePartTypes,messagePartTypeEnum);
    this.outputItemTypes=outputItemTypes.length?outputItemTypes:undefined;
    this.messagePartTypes=messagePartTypes.length?messagePartTypes:undefined;
    this.outputTextPartCount=typeof meta.outputTextPartCount==="number"&&
      Number.isSafeInteger(meta.outputTextPartCount)&&meta.outputTextPartCount>=0?
      meta.outputTextPartCount:undefined;
    this.jsonTextLength=typeof meta.jsonTextLength==="number"&&
      Number.isSafeInteger(meta.jsonTextLength)&&meta.jsonTextLength>=0?meta.jsonTextLength:undefined;
    this.jsonErrorPosition=typeof meta.jsonErrorPosition==="number"&&
      Number.isSafeInteger(meta.jsonErrorPosition)&&meta.jsonErrorPosition>=0?
      meta.jsonErrorPosition:undefined;
    this.validPrefixPartCount=typeof meta.validPrefixPartCount==="number"&&
      Number.isSafeInteger(meta.validPrefixPartCount)&&meta.validPrefixPartCount>=0?
      meta.validPrefixPartCount:undefined;
    this.validPrefixMatchesSchema=typeof meta.validPrefixMatchesSchema==="boolean"?
      meta.validPrefixMatchesSchema:undefined;
  }
}
/** Called with a fresh correlation ID for every POST, not an owner or café identifier. */
export function createSupervisorDiagnosticLogger(sink:(line:string)=>void=console.info) {
  const requestId=randomUUID().slice(0,12);
  return {
    requestId,
    emit(d:SupervisorDiagnostic) {
      const data={
        event:"supervisor_turn",
        requestId,
        stage:stages.includes(d.stage)?d.stage:"conversation_auth",
        ...(d.category&&categories.includes(d.category)?{category:d.category}:{}),
        ...(d.model?{model:safeModel(d.model)}:{}),
        ...(safeCount(d.httpStatus)!==undefined?{httpStatus:d.httpStatus}:{}),
        ...(d.providerStatus&&["completed","incomplete","failed","cancelled","queued","in_progress","unknown"].includes(d.providerStatus)?
          {providerStatus:d.providerStatus}:{}),
        ...(safeProviderIdentifier(d.providerErrorType)?{providerErrorType:safeProviderIdentifier(d.providerErrorType)}:{}),
        ...(safeProviderIdentifier(d.providerErrorCode)?{providerErrorCode:safeProviderIdentifier(d.providerErrorCode)}:{}),
        ...(safeProviderIdentifier(d.providerRequestId)?{providerRequestId:safeProviderIdentifier(d.providerRequestId)}:{}),
        ...(safeProviderIdentifier(d.fromModel)?{fromModel:safeProviderIdentifier(d.fromModel)}:{}),
        ...(safeProviderIdentifier(d.toModel)?{toModel:safeProviderIdentifier(d.toModel)}:{}),
        ...(safeCount(d.triggerHttpStatus)!==undefined?{triggerHttpStatus:d.triggerHttpStatus}:{}),
        ...(safeProviderIdentifier(d.triggerProviderErrorType)?
          {triggerProviderErrorType:safeProviderIdentifier(d.triggerProviderErrorType)}:{}),
        ...(safeProviderIdentifier(d.triggerProviderErrorCode)?
          {triggerProviderErrorCode:safeProviderIdentifier(d.triggerProviderErrorCode)}:{}),
        ...(safeCount(d.round)!==undefined?{round:d.round}:{}),
        ...(safeCount(d.attempt)!==undefined?{attempt:d.attempt}:{}),
        ...(safeCount(d.advertisedToolCount)!==undefined?{advertisedToolCount:d.advertisedToolCount}:{}),
        ...(d.advertisedToolNames?{advertisedToolNames:d.advertisedToolNames.filter(s=>
          /^[a-z][a-z0-9_]{0,63}$/.test(s)).slice(0,16)}:{}),
        ...(safeCount(d.modelCallCount)!==undefined?{modelCallCount:d.modelCallCount}:{}),
        ...(safeCount(d.toolCallCount)!==undefined?{toolCallCount:d.toolCallCount}:{}),
        ...(d.timeout===true?{timeout:true}:{}),
        ...(d.groundedStatus && ["verified","estimated","partial","unavailable","insufficient_evidence"].includes(d.groundedStatus)?
          {groundedStatus:d.groundedStatus}:{}),
        ...(d.legacyFallbackReason && ["p3_not_completed","p3_failed"].includes(d.legacyFallbackReason)?
          {legacyFallbackReason:d.legacyFallbackReason}:{}),
        ...(d.requestName && (investigationRequestNames as readonly string[]).includes(d.requestName)?
          {requestName:d.requestName}:{}),
        ...(d.invalidPayloadReason && ["wrong_text_shape","unparseable_json","schema_mismatch","multiple_function_calls","malformed_function_call"]
          .includes(d.invalidPayloadReason)?{invalidPayloadReason:d.invalidPayloadReason}:{}),
        ...(safeProviderIdentifier(d.schemaIssuePath)?{schemaIssuePath:safeProviderIdentifier(d.schemaIssuePath)}:{}),
        ...(safeProviderIdentifier(d.schemaIssueCode)?{schemaIssueCode:safeProviderIdentifier(d.schemaIssueCode)}:{}),
        ...(safeCount(d.schemaIssueCount)!==undefined?{schemaIssueCount:d.schemaIssueCount}:{}),
        ...(d.outputItemTypes&&safeEnumTagArray(d.outputItemTypes,outputItemTypeEnum).length?
          {outputItemTypes:safeEnumTagArray(d.outputItemTypes,outputItemTypeEnum)}:{}),
        ...(d.messagePartTypes&&safeEnumTagArray(d.messagePartTypes,messagePartTypeEnum).length?
          {messagePartTypes:safeEnumTagArray(d.messagePartTypes,messagePartTypeEnum)}:{}),
        ...(safeCount(d.outputTextPartCount)!==undefined?{outputTextPartCount:d.outputTextPartCount}:{}),
        ...(safeCount(d.jsonTextLength)!==undefined?{jsonTextLength:d.jsonTextLength}:{}),
        ...(safeCount(d.jsonErrorPosition)!==undefined?{jsonErrorPosition:d.jsonErrorPosition}:{}),
        ...(safeCount(d.validPrefixPartCount)!==undefined?{validPrefixPartCount:d.validPrefixPartCount}:{}),
        ...(typeof d.validPrefixMatchesSchema==="boolean"?
          {validPrefixMatchesSchema:d.validPrefixMatchesSchema}:{}),
        ...(d.agent&&agents.has(d.agent)?{agent:d.agent}:{}),
        ...(safeProviderIdentifier(d.capabilityId)?{capabilityId:safeProviderIdentifier(d.capabilityId)}:{}),
        ...(d.exhaustionReason&&exhaustionReasons.has(d.exhaustionReason)?
          {exhaustionReason:d.exhaustionReason}:{}),
        ...(d.answerRejectedReason&&answerRejectedReasons.has(d.answerRejectedReason)?
          {answerRejectedReason:d.answerRejectedReason}:{}),
        ...(typeof d.rescuedUnverified==="boolean"?{rescuedUnverified:d.rescuedUnverified}:{}),
        ...(d.stage==="scope_reconciliation"?{
          declaredGoalDomains:safeDomains(d.declaredGoalDomains),
          auditedGoalDomains:safeDomains(d.auditedGoalDomains),
          normalizedGoalDomains:safeDomains(d.normalizedGoalDomains),
          ...(typeof d.scopeAuditComplete==="boolean"?{scopeAuditComplete:d.scopeAuditComplete}:{}),
          ...(typeof d.scopeAuditAmbiguous==="boolean"?{scopeAuditAmbiguous:d.scopeAuditAmbiguous}:{}),
          ...(d.reconciliationOutcome&&outcomes.includes(d.reconciliationOutcome)?
            {reconciliationOutcome:d.reconciliationOutcome}:{}),
        }:{}),
      };
      sink(JSON.stringify(data));
    },
  };
}
/** ============================================================
 * TEMPORARY. DELETE THIS FUNCTION AND EVERY CALL SITE ONCE A REAL OWNER
 * USES THIS APP.
 * ==============================================================
 * Every other diagnostic in this file is deliberately sanitized -- never
 * the owner's question, never café/employee data, never the model's own
 * text -- because that is what reaches a general-purpose, exportable log
 * stream. This function is the one deliberate exception, added only to
 * let this pre-launch deployment's investigation failures be reconstructed
 * end to end (the exact question, the model's literal answer text with its
 * citations unresolved, and the real values behind every observation it
 * had available) instead of guessed at round by round from metadata alone.
 * There are no real owners on this deployment yet, so the one flag below
 * is the only gate: flip SUPERVISOR_DEBUG_RAW_LOGGING off (or delete this
 * function) before any real owner's data ever flows through.
 *
 * The caller (runInvestigation.server.ts) logs one of these points for
 * EVERY round of the loop, not only the final attempt and the exhaustion
 * summary, all sharing one `requestId` per turn so a single owner
 * question's entire trace -- which capability/tool was attempted, what
 * came back, what retry feedback was given, and which gate
 * (render/review/formula-verification) accepted or rejected the draft and
 * why -- can be reconstructed end to end from a log export:
 * - "capability_round": a read/calculate tool actually dispatched this
 *   round, with its capabilityId and result status.
 * - "retry_feedback": the specific feedback text carried INTO a round
 *   (set by whatever gate rejected the previous round's attempt).
 * - "claim_issues_retry": the claim-level issues (ClaimIssue[] from
 *   evidence.ts) found in a direct-answer draft that is being retried
 *   rather than accepted, with which gate (render/formula) found each one.
 * - "direct_answer_attempt": the raw model-authored draft for this round
 *   (unchanged from before).
 * - "review_verdict": the independent reviewer's supported/complete
 *   verdict for a clean (zero-issue) draft.
 * - "investigation_exhausted": the final summary (unchanged from before). */
export type SupervisorDebugPoint="capability_round"|"retry_feedback"|"claim_issues_retry"|
  "direct_answer_attempt"|"review_verdict"|"investigation_exhausted";
export function logSupervisorDebugPayload(payload:Record<string,unknown>,
  sink:(line:string)=>void=(line)=>console.info(line)):void{
  if(process.env.SUPERVISOR_DEBUG_RAW_LOGGING!=="true")return;
  sink(JSON.stringify({event:"supervisor_turn_debug_test_only",...payload}));
}
export function classifySupervisorError(error:unknown,stage:SupervisorStage):SupervisorDiagnostic {
  if(error instanceof SupervisorStageError) return {
    stage:error.stage,category:error.category,httpStatus:error.httpStatus,
    providerStatus:error.providerStatus,round:error.round,attempt:error.attempt,timeout:error.timeout,
    providerErrorType:error.providerErrorType,providerErrorCode:error.providerErrorCode,
    providerRequestId:error.providerRequestId,
    invalidPayloadReason:error.invalidPayloadReason,
    schemaIssuePath:error.schemaIssuePath,schemaIssueCode:error.schemaIssueCode,
    schemaIssueCount:error.schemaIssueCount,
    outputItemTypes:error.outputItemTypes,messagePartTypes:error.messagePartTypes,
    outputTextPartCount:error.outputTextPartCount,
    jsonTextLength:error.jsonTextLength,jsonErrorPosition:error.jsonErrorPosition,
    validPrefixPartCount:error.validPrefixPartCount,
    validPrefixMatchesSchema:error.validPrefixMatchesSchema,
  };
  return {stage,category:stage==="reply_persistence"?"reply_persistence":"unexpected"};
}
