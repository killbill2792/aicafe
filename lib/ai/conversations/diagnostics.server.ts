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
  | "final_response_validation" | "scope_reconciliation" | "reply_persistence";
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
  invalidPayloadReason?:"wrong_text_shape"|"unparseable_json"|"schema_mismatch";
  schemaIssuePath?:string;
  schemaIssueCode?:string;
};
const investigationRequestNames=["supervisor_investigation_step","supervisor_investigation_review",
  "supervisor_calendar_context_review","supervisor_public_query_review"] as const;
const stages:readonly SupervisorStage[]=[
  "conversation_auth","owner_message_persisted","cafe_tools_created","cafe_identity_loaded",
  "provider_request","provider_response","provider_fallback","semantic_plan",
  "capability_selected","grounded_answer","legacy_fallback","tool_call_parse","tool_execution",
  "final_response_parse","final_response_validation","scope_reconciliation","reply_persistence",
];
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
  readonly invalidPayloadReason?:"wrong_text_shape"|"unparseable_json"|"schema_mismatch";
  readonly schemaIssuePath?:string;
  readonly schemaIssueCode?:string;
  constructor(category:SupervisorErrorCategory,stage:SupervisorStage,meta:Partial<SupervisorDiagnostic>={}) {
    super("Supervisor internal failure: "+category);
    this.name="SupervisorStageError";
    this.category=category;this.stage=stage;
    this.httpStatus=meta.httpStatus;this.providerStatus=meta.providerStatus;
    this.providerErrorType=safeProviderIdentifier(meta.providerErrorType);
    this.providerErrorCode=safeProviderIdentifier(meta.providerErrorCode);
    this.providerRequestId=safeProviderIdentifier(meta.providerRequestId);
    this.round=meta.round;this.attempt=meta.attempt;this.timeout=meta.timeout===true;
    this.invalidPayloadReason=["wrong_text_shape","unparseable_json","schema_mismatch"]
      .includes(meta.invalidPayloadReason as string)?meta.invalidPayloadReason:undefined;
    this.schemaIssuePath=safeProviderIdentifier(meta.schemaIssuePath);
    this.schemaIssueCode=safeProviderIdentifier(meta.schemaIssueCode);
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
        ...(d.invalidPayloadReason && ["wrong_text_shape","unparseable_json","schema_mismatch"]
          .includes(d.invalidPayloadReason)?{invalidPayloadReason:d.invalidPayloadReason}:{}),
        ...(safeProviderIdentifier(d.schemaIssuePath)?{schemaIssuePath:safeProviderIdentifier(d.schemaIssuePath)}:{}),
        ...(safeProviderIdentifier(d.schemaIssueCode)?{schemaIssueCode:safeProviderIdentifier(d.schemaIssueCode)}:{}),
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
export function classifySupervisorError(error:unknown,stage:SupervisorStage):SupervisorDiagnostic {
  if(error instanceof SupervisorStageError) return {
    stage:error.stage,category:error.category,httpStatus:error.httpStatus,
    providerStatus:error.providerStatus,round:error.round,attempt:error.attempt,timeout:error.timeout,
    providerErrorType:error.providerErrorType,providerErrorCode:error.providerErrorCode,
    providerRequestId:error.providerRequestId,
    invalidPayloadReason:error.invalidPayloadReason,
    schemaIssuePath:error.schemaIssuePath,schemaIssueCode:error.schemaIssueCode,
  };
  return {stage,category:stage==="reply_persistence"?"reply_persistence":"unexpected"};
}
