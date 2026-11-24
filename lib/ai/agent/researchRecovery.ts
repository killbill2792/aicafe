import {randomUUID} from "node:crypto";
import type {AgentToolResult} from "./tools";

// These errors describe an unsuccessful SELECT attempt, not observed missing
// café facts. A later scoped SELECT may repair them without making an earlier
// unrelated source failure or partial result disappear.
const repairable=new Set(["invalid_query","query_syntax_error","query_execution_error",
 "query_timeout","row_exceeds_page_budget","stable_order_required"]);
type Attempt={name:string;result:AgentToolResult};
export function recordResearchAttempt(result:AgentToolResult,retryOf:unknown,
 prior:readonly Attempt[]):AgentToolResult{
 const repairableFailure=result.source==="u3_canonical_research"&&
  typeof result.error==="string"&&repairable.has(result.error)&&
  Array.isArray(result.rows)&&result.rows.length===0;
 if(result.source!=="u3_canonical_research")return result;
 const previous=typeof retryOf==="string"?prior.find(a=>a.name==="query_data"&&
  a.result.query_attempt_id===retryOf&&typeof a.result.error==="string"&&
  repairable.has(a.result.error)&&a.result.source==="u3_canonical_research"&&
  Array.isArray(a.result.rows)&&a.result.rows.length===0):undefined;
 // The link is generated only here, from actual same-turn results, never
 // copied from model arguments as trusted metadata. A failed repair remains
 // unresolved; the current attempt replaces the earlier diagnostic only.
 return {...result,...(repairableFailure?{query_attempt_id:randomUUID()}:{}),
  ...(previous&&(repairableFailure||!result.error)?{replaces_query_attempt_id:retryOf}:{})};
}
export function unreplacedResearchAttempts<T extends Attempt>(attempts:readonly T[]):T[]{
 const replaced=new Set(attempts.flatMap(a=>a.name==="query_data"&&
  a.result.source==="u3_canonical_research"&&typeof a.result.replaces_query_attempt_id==="string"?
  [a.result.replaces_query_attempt_id]:[]));
 return attempts.filter(a=>a.name!=="query_data"||a.result.source!=="u3_canonical_research"||
  typeof a.result.query_attempt_id!=="string"||!replaced.has(a.result.query_attempt_id));
}
