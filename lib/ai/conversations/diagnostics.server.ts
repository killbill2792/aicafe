import "server-only";
import { randomUUID } from "node:crypto";

/** Only this allow-listed metadata may reach the production log. Never log errors' messages,
 * OpenAI payloads, prompts, café data, employee data or credentials. */
export type SupervisorStage =
  | "conversation_auth" | "owner_message_persisted" | "cafe_tools_created"
  | "cafe_identity_loaded" | "provider_request" | "provider_response"
  | "tool_call_parse" | "tool_execution" | "final_response_parse"
  | "final_response_validation" | "reply_persistence";
export type SupervisorErrorCategory =
  | "provider_http" | "provider_timeout" | "provider_incomplete"
  | "provider_invalid_payload" | "invalid_tool_call" | "tool_execution"
  | "final_output_missing" | "final_output_malformed" | "final_output_validation"
  | "reply_persistence" | "unexpected";
export type SupervisorDiagnostic = {
  stage:SupervisorStage; category?:SupervisorErrorCategory;
  model?:string;httpStatus?:number;providerStatus?:string;
  round?:number;attempt?:number;advertisedToolCount?:number;
  advertisedToolNames?:string[];modelCallCount?:number;toolCallCount?:number;
  timeout?:boolean;
};
const stages:readonly SupervisorStage[]=[
  "conversation_auth","owner_message_persisted","cafe_tools_created","cafe_identity_loaded",
  "provider_request","provider_response","tool_call_parse","tool_execution",
  "final_response_parse","final_response_validation","reply_persistence",
];
const categories:readonly SupervisorErrorCategory[]=[
  "provider_http","provider_timeout","provider_incomplete","provider_invalid_payload",
  "invalid_tool_call","tool_execution","final_output_missing","final_output_malformed",
  "final_output_validation","reply_persistence","unexpected",
];
const safeModel=(s?:string)=>typeof s==="string"?s.replace(/[^a-zA-Z0-9_.-]/g,"").slice(0,80):undefined;
const safeCount=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:undefined;
export class SupervisorStageError extends Error {
  readonly stage:SupervisorStage;
  readonly category:SupervisorErrorCategory;
  readonly httpStatus?:number;
  readonly providerStatus?:string;
  readonly round?:number;
  readonly attempt?:number;
  readonly timeout:boolean;
  constructor(category:SupervisorErrorCategory,stage:SupervisorStage,meta:Partial<SupervisorDiagnostic>={}) {
    super("Supervisor internal failure: "+category);
    this.name="SupervisorStageError";
    this.category=category;this.stage=stage;
    this.httpStatus=meta.httpStatus;this.providerStatus=meta.providerStatus;
    this.round=meta.round;this.attempt=meta.attempt;this.timeout=meta.timeout===true;
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
        ...(safeCount(d.round)!==undefined?{round:d.round}:{}),
        ...(safeCount(d.attempt)!==undefined?{attempt:d.attempt}:{}),
        ...(safeCount(d.advertisedToolCount)!==undefined?{advertisedToolCount:d.advertisedToolCount}:{}),
        ...(d.advertisedToolNames?{advertisedToolNames:d.advertisedToolNames.filter(s=>
          /^[a-z][a-z0-9_]{0,63}$/.test(s)).slice(0,16)}:{}),
        ...(safeCount(d.modelCallCount)!==undefined?{modelCallCount:d.modelCallCount}:{}),
        ...(safeCount(d.toolCallCount)!==undefined?{toolCallCount:d.toolCallCount}:{}),
        ...(d.timeout===true?{timeout:true}:{}),
      };
      sink(JSON.stringify(data));
    },
  };
}
export function classifySupervisorError(error:unknown,stage:SupervisorStage):SupervisorDiagnostic {
  if(error instanceof SupervisorStageError) return {
    stage:error.stage,category:error.category,httpStatus:error.httpStatus,
    providerStatus:error.providerStatus,round:error.round,attempt:error.attempt,timeout:error.timeout,
  };
  return {stage,category:stage==="reply_persistence"?"reply_persistence":"unexpected"};
}
