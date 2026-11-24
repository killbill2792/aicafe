import {randomUUID} from "node:crypto";
import type {AgentToolResult} from "./tools";

// These errors describe an unsuccessful SELECT attempt, not observed missing
// café facts. A later scoped SELECT may repair them without making an earlier
// unrelated source failure or partial result disappear.
const repairable=new Set(["invalid_query","query_syntax_error","query_execution_error",
 "query_timeout","row_exceeds_page_budget","duplicate_result_columns","stable_order_required","research_snapshot_changed"]);
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

/** Only complete contiguous sequences from the same server-issued result
 * snapshot may clear transport truncation. Keep the original row/receipt
 * identity; do not concatenate unrelated queries or mark a final page alone
 * as exhaustive. The copies below are for internal evidence consumers only. */
export function completeResearchResults(results:readonly AgentToolResult[]):AgentToolResult[]{
 type Page={result:AgentToolResult;start:number;end:number;total:number;final:boolean};
 const groups=new Map<string,Page[]>();
 const candidates=new Set<AgentToolResult>();
 for(const result of results){
  if(result.source!=="u3_canonical_research"||result.page_consistency!=="verified_same_result"||
   result.error||!Array.isArray(result.rows)||!result.evidence||
   typeof result.evidence!=="object"||Array.isArray(result.evidence))continue;
  const e=result.evidence as Record<string,unknown>;
  const start=result.page_offset,total=result.total_rows;
  if(e.scope!=="verified_owner_cafe_lease"||typeof e.snapshot_id!=="string"||
   !/^[a-f0-9-]{36}$/i.test(e.snapshot_id)||typeof e.snapshot_digest!=="string"||
   !/^[a-f0-9]{64}$/i.test(e.snapshot_digest)||typeof e.query_fingerprint!=="string"||
   !/^[a-f0-9]{64}$/i.test(e.query_fingerprint)||typeof e.catalog_version!=="string"||
   typeof e.as_of!=="string"||typeof start!=="number"||typeof total!=="number"||
   !Number.isSafeInteger(start)||!Number.isSafeInteger(total)||start<0||total<0)continue;
  const end=start+result.rows.length;
  if(end>total||!Number.isSafeInteger(end)||result.rowCount!==result.rows.length||
   result.page_complete!==(end===total)||result.truncated!==(end<total)||
   (end<total&&(end===start||typeof result.next_cursor!=="string"))||
   (end===total&&result.next_cursor!==null))continue;
  candidates.add(result);
  // Source coverage and transport completeness are separate. Preserve all
  // genuine missing-input flags when joining verified contiguous pages.
  const key=JSON.stringify([e.snapshot_id,e.snapshot_digest,e.query_fingerprint,e.catalog_version,e.as_of,total]);
  const pages=groups.get(key)??[];
  pages.push({result,start,end,total,final:end===total});groups.set(key,pages);
 }
 const complete=new Set<AgentToolResult>();
 for(const pages of groups.values()){
  pages.sort((a,b)=>a.start-b.start||a.end-b.end);
  let covered=0,final=false;
  for(const page of pages){
   if(page.start>covered)break;
   covered=Math.max(covered,page.end);
   final||=page.final;
  }
  if(final&&covered===pages[0].total)for(const page of pages)complete.add(page.result);
 }
 return results.map(result=>{
  if(complete.has(result))return result.truncated||result.missing.includes("result_truncated")?
   {...result,truncated:false,missing:result.missing.filter(x=>x!=="result_truncated")}:result;
  if(candidates.has(result)&&result.page_complete===true&&Number(result.page_offset)>0)
   return {...result,truncated:true,missing:[...new Set([...result.missing,"result_truncated"])]};
  return result;
 });
}
export function completeResearchAttempts<T extends Attempt>(attempts:readonly T[]):T[]{
 const normalized=completeResearchResults(attempts.map(a=>a.result));
 return attempts.map((a,i)=>normalized[i]===a.result?a:{...a,result:normalized[i]});
}
