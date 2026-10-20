import "server-only";
import { randomUUID } from "node:crypto";
import {recordSupervisorPrivateTrace,activeSupervisorTraceRequestId} from "./privateTrace.server";
import { GOAL_DOMAINS, type RequestedGoal, type ScopeReconciliationOutcome } from "./requestScope";
import { SupervisorReplyValidationError, type ReplyValidationFailureReason } from "./replyValidation";

/** Only this allow-listed metadata may reach the production log. Never log errors' messages,
 * OpenAI payloads, prompts, café data, employee data or credentials. */
export type SupervisorStage =
  | "conversation_auth" | "owner_message_persisted" | "cafe_tools_created"
  | "cafe_identity_loaded" | "provider_request" | "provider_response" | "provider_fallback"
  | "semantic_plan" | "capability_selected" | "grounded_answer" | "legacy_fallback"
  | "tool_call_parse" | "tool_execution" | "final_response_parse"
  | "final_response_validation" | "scope_reconciliation" | "reply_persistence"
  | "investigation_round" | "investigation_exhausted" | "reply_validation";
export type SupervisorErrorCategory =
  | "provider_http" | "provider_timeout" | "provider_incomplete"
  | "provider_invalid_payload" | "invalid_tool_call" | "tool_execution"
  | "final_output_missing" | "final_output_malformed" | "final_output_validation"
  | "reply_persistence" | "reply_validation" | "unexpected";
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
  /** Set on stage "reply_validation": exactly which validateGroundedReply
   * check rejected the final reply before it could be persisted/shown. This
   * gate firing always indicates a genuine upstream bug (a reply asserting a
   * fact with no real grounding behind it), never a normal "couldn't verify"
   * case -- those are handled earlier. Never carries the reply's own text,
   * evidence or café data; see SupervisorReplyValidationError. */
  replyValidationReason?:ReplyValidationFailureReason;
};
const investigationRequestNames=["supervisor_investigation_step","supervisor_investigation_review",
  "supervisor_calendar_context_review","supervisor_public_query_review"] as const;
const stages:readonly SupervisorStage[]=[
  "conversation_auth","owner_message_persisted","cafe_tools_created","cafe_identity_loaded",
  "provider_request","provider_response","provider_fallback","semantic_plan",
  "capability_selected","grounded_answer","legacy_fallback","tool_call_parse","tool_execution",
  "final_response_parse","final_response_validation","scope_reconciliation","reply_persistence",
  "investigation_round","investigation_exhausted","reply_validation",
];
const agents=new Set(["alex","olivia","leo","maya","supervisor"]);
const exhaustionReasons=new Set(["model_calls","operations","time","identity_mismatch",
  "snapshot_mismatch","observations_too_large","no_progress"]);
const answerRejectedReasons=new Set(["render_failed","review_failed","review_unavailable"]);
const replyValidationReasons=new Set<ReplyValidationFailureReason>(
  ["missing_evidence","insufficient_evidence_with_metrics","missing_grounding_reference"]);
const categories:readonly SupervisorErrorCategory[]=[
  "provider_http","provider_timeout","provider_incomplete","provider_invalid_payload",
  "invalid_tool_call","tool_execution","final_output_missing","final_output_malformed",
  "final_output_validation","reply_persistence","reply_validation","unexpected",
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
export function createSupervisorDiagnosticLogger(sink:(line:string)=>void=console.info,
  requestId=randomUUID().slice(0,12)) {
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
        ...(d.replyValidationReason&&replyValidationReasons.has(d.replyValidationReason)?
          {replyValidationReason:d.replyValidationReason}:{}),
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
      recordSupervisorPrivateTrace({point:"diagnostic",...data});
      sink(JSON.stringify(data));
    },
  };
}
/** Bounded operational detail for short-lived Vercel logs.
 * Deliberately DO NOT emit owner/model prose, raw tool args/results, or source
 * values: a model-provided string is never trusted to be credential-free.
 * This is not a replacement for an authorized raw-evidence inspection.
 */
function supervisorVercelDetail(payload:Record<string,unknown>):Record<string,unknown>|null{
  const point=payload.point;
  const allowed=new Set(["model_request","model_response","model_response_error",
    "model_usage","calculator_rejected","calculator_input","calculator_result",
    "parallel_batch","tool_request","tool_result","tool_rejected",
    "capability_round","review_verdict","rescue_review_verdict",
    "accumulated_rescue_review_verdict","claim_issues_retry",
    "direct_answer_attempt","answer_rendered","investigation_exhausted",
    "persistence_result","reply_validation_failed","http_response_sent",
    "http_response_error","trace_summary","round_context","retry_feedback"]);
  if(typeof point!=="string"||!allowed.has(point))return null;
  const detail:Record<string,unknown>={event:"supervisor_diagnostic_detail",point};
  for(const key of ["requestId","capabilityId","observationId"]){
    const id=safeProviderIdentifier(payload[key]);
    if(id)detail[key]=id;
  }
  for(const key of ["round","attempt","modelCallCount","toolCallCount",
    "durationMs","maxOutputTokens","providerTimeoutMs","httpStatus"]){
    const value=safeCount(payload[key]);
    if(value!==undefined)detail[key]=value;
  }
  for(const key of ["model","requestedModel"]){
    if(typeof payload[key]==="string")detail[key]=safeModel(payload[key] as string);
  }
  for(const key of ["supported","complete","dispatched","parallel",
    "successful","executed","ok","fallback","replayed","captureComplete","tokenCostComplete"]){
    if(typeof payload[key]==="boolean")detail[key]=payload[key];
  }
  const safeTags:Record<string,ReadonlySet<string>>={
    reasonCode:new Set(["unsupported_currency","invalid_plan","unknown_operand",
      "invalid_arguments_json","invalid_source_context","simulation_input_rejected",
      "calculator_invalid_result","invalid_calculator_result","calculation_unavailable",
      "source_context_error","calendar_scope_mismatch","financial_scope_unavailable",
      "duplicate_attempt","unknown_tool","not_a_read_capability","invalid_result_envelope"]),
    outcome:new Set(["concurrent","rejected_preflight"]),
    status:new Set(["verified","partial","estimated","conditional","unavailable","failed",
      "completed","incomplete","cancelled","in_progress"]),
    replyStatus:new Set(["verified","partial","estimated","conditional","unavailable",
      "insufficient_evidence"]),
    pricingSource:new Set(["openai_standard_short_context_2026_10_19",
      "environment_configured","unpriced"]),
    pricingStatus:new Set(["usage_unavailable","missing_or_mismatched_rate",
      "configured_estimate"]),
    requestName:new Set(["supervisor_investigation_step","supervisor_investigation_review",
      "supervisor_formula_extraction","supervisor_public_query_review",
      "supervisor_calendar_context_review"]),
    exhaustionReason:new Set(["model_calls","operations","time","no_progress",
      "identity_mismatch","snapshot_mismatch","observations_too_large"]),
  };
  for(const [key,options] of Object.entries(safeTags)){
    if(typeof payload[key]==="string"&&options.has(payload[key] as string))
      detail[key]=payload[key];
  }
  const raw=payload.raw;
  if(point==="model_response"&&raw&&typeof raw==="object"&&!Array.isArray(raw)){
    const response=raw as Record<string,unknown>;
    if(Array.isArray(response.output))
      detail.responseTypes=response.output.slice(0,20).map(item=>{
        const kind=item&&typeof item==="object"&&!Array.isArray(item)?
          (item as Record<string,unknown>).type:null;
        return typeof kind==="string"&&outputItemTypeEnum.has(kind)?kind:"other";
      });
    if(typeof response.status==="string"&&safeTags.status.has(response.status))
      detail.providerStatus=response.status;
  }
  if(point==="calculator_rejected"||point==="claim_issues_retry"){
    const allowedIssueCodes=new Set(["invalid_type","invalid_union","invalid_value",
      "invalid_format","too_small","too_big","not_multiple_of","unrecognized_keys",
      "invalid_key","invalid_element","custom"]);
    const allowedIssueFields=new Set(["purpose","nodes","op","unit","handle","amount",
      "value","left","right","target","currency","result","source","period",
      "from","to","mode","assumptions","input","index","type"]);
    if(Array.isArray(payload.issues)){
      detail.issueCount=payload.issues.length;
      detail.schemaIssues=payload.issues.slice(0,12).map(issue=>{
        const entry=issue&&typeof issue==="object"&&!Array.isArray(issue)?
          issue as Record<string,unknown>:{};
        const path=Array.isArray(entry.path)?entry.path.slice(0,8).map(seg=>
          typeof seg==="number"&&Number.isSafeInteger(seg)&&seg>=0?seg:
            typeof seg==="string"&&allowedIssueFields.has(seg)?seg:"[field]"):[];
        return {path,code:typeof entry.code==="string"&&allowedIssueCodes.has(entry.code)?
          entry.code:"other"};
      });
    }
    const args=payload.toolArguments;
    if(args&&typeof args==="object"&&!Array.isArray(args)){
      const nodes=(args as Record<string,unknown>).nodes;
      if(Array.isArray(nodes)){
        detail.nodeCount=nodes.length;
        const allowedOps=new Set(["source","hypothetical","add","subtract","multiply",
          "divide","convert","sum","ratio","round","literal"]);
        detail.nodeOps=nodes.slice(0,24).map(node=>{
          const op=node&&typeof node==="object"&&!Array.isArray(node)?
            (node as Record<string,unknown>).op:null;
          return typeof op==="string"&&allowedOps.has(op)?op:"unknown";
        });
      }
    }
  }
  if(point==="parallel_batch"){
    const preflight=payload.preflight;
    if(preflight&&typeof preflight==="object"&&!Array.isArray(preflight)){
      const p=preflight as Record<string,unknown>;
      const checks:Record<string,unknown>={};
      for(const field of ["allCallsSupported","withinOperationBudget",
        "canonicalSelectorsUnique","canonicalSourcesUnique","neverAttemptedBefore",
        "registeredInputsValid"]){
        if(typeof p[field]==="boolean")checks[field]=p[field];
      }
      if(Array.isArray(p.perCall))
        checks.perCall=p.perCall.slice(0,8).map(call=>{
          const x=call&&typeof call==="object"&&!Array.isArray(call)?
            call as Record<string,unknown>:{};
          const entry:Record<string,unknown>={};
          for(const key of ["currencyAndSnapshotPermitted","datesMatch",
            "noPendingCalendarCorrection","registryPreflight"]){
            if(typeof x[key]==="boolean")entry[key]=x[key];
          }
          if(safeProviderIdentifier(x.capabilityId))
            entry.capabilityId=safeProviderIdentifier(x.capabilityId);
          return entry;
        });
      detail.preflight=checks;
    }
  }
  if(point==="tool_result"||point==="capability_round"||point==="calculator_result"){
    const result=payload.result??payload.rawResult;
    if(result&&typeof result==="object"&&!Array.isArray(result)){
      const r=result as Record<string,unknown>;
      if(typeof r.status==="string"&&safeTags.status.has(r.status))
        detail.resultStatus=r.status;
      if(Array.isArray(r.value))detail.resultRowCount=r.value.length;
      if(typeof r.value==="number")detail.resultValueType="number";
      else if(r.value&&typeof r.value==="object")detail.resultValueType="structured";
    }
  }
  if(point==="direct_answer_attempt"){
    const paragraphs=payload.rawAnswerParagraphs;
    if(Array.isArray(paragraphs)){
      detail.paragraphCount=paragraphs.length;
      detail.paragraphKinds=paragraphs.slice(0,20).map(p=>{
        const kind=p&&typeof p==="object"&&!Array.isArray(p)?
          (p as Record<string,unknown>).kind:null;
        return ["evidence","advice","clarification"].includes(String(kind))?kind:"unknown";
      });
    }
  }
  if(point==="review_verdict"||point==="rescue_review_verdict"||
    point==="accumulated_rescue_review_verdict"){
    if(typeof payload.reason==="string")detail.reasonLength=payload.reason.length;
  }
  if(point==="model_usage"||point==="trace_summary"){
    for(const key of ["modelCalls","inputTokens","cachedInputTokens","outputTokens",
      "reasoningOutputTokens","unpricedCalls","expectedModelRequests",
      "observedUsageResponses","missingUsageResponses","priorDroppedCount","droppedCount"]){
      const value=safeCount(payload[key]);
      if(value!==undefined)detail[key]=value;
    }
    if(payload.estimatedCostMicros===null)detail.estimatedCostMicros=null;
    else{
      const value=safeCount(payload.estimatedCostMicros);
      if(value!==undefined)detail.estimatedCostMicros=value;
    }
    const u=payload.usage;
    if(u&&typeof u==="object"&&!Array.isArray(u)){
      const counts:Record<string,number>={};
      for(const key of ["inputTokens","cachedInputTokens","uncachedInputTokens",
        "outputTokens","reasoningOutputTokens"]){
        const value=safeCount((u as Record<string,unknown>)[key]);
        if(value!==undefined)counts[key]=value;
      }
      detail.usage=counts;
    }
  }
  return detail;
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
 * The investigation loop (runInvestigation.server.ts) logs one of these
 * points for EVERY round of the loop, not only the final attempt and the
 * exhaustion summary; the API route (messages/route.ts) logs the remaining
 * points that cover the rest of the request lifecycle -- the moment the
 * owner's turn starts, the final reply-validation gate's outcome, whether
 * persistence succeeded, and what was actually sent back in the HTTP
 * response. ALL of these share one `debugRequestId` per turn (generated once
 * in the route and passed down into the investigation loop, never a second,
 * separately-generated id) so a single owner question's entire trace --
 * from the raw request in, through every round's capability/tool/retry/
 * review decision, to the exact reply persisted and returned -- can be
 * reconstructed end to end from one log export:
 * - "turn_received": the route has parsed the owner's POST and is about to
 *   start the turn, with the raw owner message text and thread id.
 * - "capability_round": a read/calculate tool actually dispatched this
 *   round, with its capabilityId and result status.
 * - "retry_feedback": the specific feedback text carried INTO a round
 *   (set by whatever gate rejected the previous round's attempt).
 * - "claim_issues_retry": the claim-level issues (ClaimIssue[] from
 *   evidence.ts) found in a direct-answer draft that is being retried
 *   rather than accepted, with which gate (render/formula) found each one.
 * - "direct_answer_attempt": the raw model-authored draft for this round
 *   (unchanged from before).
 * - "review_verdict": the independent reviewer's supported/complete verdict
 *   AND its reason, for a clean (zero-issue) draft -- the main, in-loop
 *   review that can still retry with that reason as specific feedback.
 * - "rescue_review_verdict": the independent reviewer's verdict and reason
 *   for the narrow last-resort renderUnverifiedAnswer rescue (a draft that
 *   failed strict rendering but may still be a genuine, honest answer).
 *   Terminal -- there is no further retry for this specific candidate, but
 *   the reason still explains why it was or was not used as the fallback.
 * - "accumulated_rescue_review_verdict": the independent reviewer's verdict
 *   and reason for the §7 best-accumulated-candidate rescue, checked only
 *   once the loop has already exhausted its budget.
 * - "investigation_exhausted": the final summary (unchanged from before).
 * - "reply_validation_failed": validateGroundedReply's final gate rejected
 *   the reply the investigation loop produced -- which exact check failed,
 *   and the full reply shape that tripped it. Always a bug signal; the
 *   turn still degrades gracefully for the owner (see replyValidation.ts's
 *   buildReplyValidationFallbackReply and messages/route.ts).
 * - "persistence_result": whether the reply (the real one, or the graceful
 *   fallback built after a reply_validation_failed) was actually written to
 *   the database.
 * - "http_response_sent": the final reply status/shape actually returned to
 *   the owner in the HTTP response, not just "the request succeeded". */
export type SupervisorDebugPoint="turn_received"|"capability_round"|"tool_request"|"tool_result"|"parallel_batch"|"retry_feedback"|
  "claim_issues_retry"|"direct_answer_attempt"|"review_verdict"|"rescue_review_verdict"|
  "accumulated_rescue_review_verdict"|"investigation_exhausted"|
  "reply_validation_failed"|"persistence_result"|"http_response_sent";
/** Raw debugging is allowed ONLY under NODE_ENV=test, even when a stale
 * feature flag is accidentally enabled on a deployment. Production emits
 * a minimal, strictly allowlisted step trace with no prompts, values,
 * employee names, wages, argument JSON, or raw OpenAI reply text.
 * Owner-private complete traces require a separate access-controlled store. */
export function logSupervisorDebugPayload(payload:Record<string,unknown>,
  sink:(line:string)=>void=(line)=>console.info(line)):void{
  // Private RLS-backed capture is independent of console diagnostic verbosity.
  if(!payload.requestId){const id=activeSupervisorTraceRequestId();if(id)payload={...payload,requestId:id};}
  recordSupervisorPrivateTrace(payload);
  if(process.env.SUPERVISOR_DEBUG_RAW_LOGGING!=="true")return;
  if(process.env.NODE_ENV==="test"){
    sink(JSON.stringify({event:"supervisor_turn_debug_test_only",...payload}));
    return;
  }
  const safe:Record<string,unknown>={event:"supervisor_turn_debug_metadata"};
  const allowId=(v:unknown)=>typeof v==="string"&&/^[a-zA-Z0-9_.:-]{1,80}$/u.test(v);
  const points:ReadonlySet<string>=new Set([
    "turn_received","capability_round","tool_request","tool_result","parallel_batch",
    "model_request","model_response","model_response_error","calculator_rejected","calculator_result","round_context",
    "retry_feedback","claim_issues_retry","direct_answer_attempt","review_verdict",
    "rescue_review_verdict","accumulated_rescue_review_verdict","investigation_exhausted",
    "reply_validation_failed","persistence_result","http_response_sent"]);
  if(typeof payload.point==="string"&&points.has(payload.point))safe.point=payload.point;
  for(const key of ["requestId","capabilityId","observationId","callId"])
    if(allowId(payload[key]))safe[key]=payload[key];
  for(const key of ["round","modelCallCount","toolCallCount"])
    if(typeof payload[key]==="number"&&Number.isSafeInteger(payload[key])&&payload[key]>=0)
      safe[key]=payload[key];
  if(typeof payload.status==="string"&&
    ["verified","partial","estimated","conditional","unavailable","failed"].includes(payload.status))
    safe.status=payload.status;
  if(typeof payload.outcome==="string"&&
    ["rejected_preflight","concurrent"].includes(payload.outcome))
    safe.outcome=payload.outcome;
  // Named reason codes are safe to emit in production; arbitrary reason text is not.
  const calculatorReasons=new Set(["unsupported_currency","invalid_plan","unknown_operand",
    "invalid_arguments_json",
    "invalid_source_context","simulation_input_rejected","calculator_invalid_result",
    "invalid_calculator_result","calculation_unavailable","source_context_error"]);
  if(typeof payload.reasonCode==="string"&&calculatorReasons.has(payload.reasonCode))
    safe.reasonCode=payload.reasonCode;
  for(const key of ["successful","supported","complete","dispatched","parallel"])
    if(typeof payload[key]==="boolean")safe[key]=payload[key];
  sink(JSON.stringify(safe));
  const detail=supervisorVercelDetail(payload);
  if(detail)sink(JSON.stringify(detail));
}
export function classifySupervisorError(error:unknown,stage:SupervisorStage):SupervisorDiagnostic {
  // A genuinely new failure category (never the catch-all "unexpected"):
  // validateGroundedReply's final safety gate rejected a reply that should
  // never have reached it. Only the machine-readable reason is carried here
  // -- never the reply's own text, evidence or café data (see
  // SupervisorReplyValidationError and the raw debug capture alongside it).
  if(error instanceof SupervisorReplyValidationError) return {
    stage:"reply_validation",category:"reply_validation",replyValidationReason:error.reason,
  };
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
