import {compactEvidence,type NumericEvidence} from "./checkNumbers";
import type {AgentToolResult} from "./tools";

/** Invalidate only previously persisted group quantities for refreshed
 * ingredient/date scopes with unknown expected use. The model still receives
 * the strictly budgeted tool result; these null tombstones are appended only
 * when checking/persisting numeric evidence, not to model context. */
export function usageEvidenceRefresh(
 results:readonly AgentToolResult[],previous:readonly NumericEvidence[]=[]
):AgentToolResult[]{
 return results.map((result,index)=>{
  if(result.source!=="usage_variance"||!result.period||
   !Array.isArray(result.rows)||!Array.isArray(result.items))return result;
  const period=result.period.from+"/"+result.period.to+"/items:";
  const invalidated=new Set<string>();
  for(const item of result.rows){
   if(!item||typeof item!=="object"||Array.isArray(item))continue;
   const row=item as Record<string,unknown>;
   if(typeof row.ingredientId!=="string"||row.expected!==null)continue;
   const prefix=period+row.ingredientId+":group:";
   const knownEvidence=[...previous,...compactEvidence(results.slice(0,index),Infinity)];
   for(const old of knownEvidence){
    if(old.tool!=="usage_variance")continue;
    for(const v of old.values){
     if(v.unit!=="count"||!v.key.startsWith(prefix)||!v.key.endsWith("/quantity"))continue;
     const id=v.key.slice(period.length,-"/quantity".length);
     invalidated.add(id);
    }
   }
  }
  if(invalidated.size===0)return result;
  const items=[...result.items,...[...invalidated].sort().map(id=>({id,quantity:null}))];
  return {...result,items};
 });
}
