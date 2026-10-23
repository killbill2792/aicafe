import {compactEvidence,type NumericEvidence} from "./checkNumbers";
import type {AgentToolResult} from "./tools";

/** A successful complete usage snapshot replaces previously verified group
 * quantities for the same period and ingredient. The raw tool result sent
 * to the model is unchanged; null tombstones are appended only for numeric
 * verification and persisted evidence. An incomplete/truncated refresh must
 * not erase groups it never observed, but an explicitly unknown expected
 * total invalidates every previously known group for that ingredient. */
export function usageEvidenceRefresh(
 results:readonly AgentToolResult[],previous:readonly NumericEvidence[]=[]
):AgentToolResult[]{
 const processed:AgentToolResult[]=[];
 for(const result of results){
  if(result.source!=="usage_variance"||!result.period||
   !Array.isArray(result.rows)||!Array.isArray(result.items)){
   processed.push(result);
   continue;
  }
  const period=result.period.from+"/"+result.period.to+"/items:";
  // Process the already-refreshed results in sequence so a second usage
  // call in this same turn observes tombstones from the earlier call.
  const observations=[...previous,...compactEvidence(processed,Infinity)]
   .filter(entry=>entry.tool==="usage_variance");
  const live=new Set<string>();
  for(const item of result.items){
   if(!item||typeof item!=="object"||Array.isArray(item))continue;
   const entry=item as Record<string,unknown>;
   if(entry.metric==="expected_group"&&typeof entry.id==="string"&&
    typeof entry.quantity==="number"&&Number.isFinite(entry.quantity))
    live.add(entry.id);
  }
  const revoked=new Set<string>();
  for(const item of result.rows){
   if(!item||typeof item!=="object"||Array.isArray(item))continue;
   const row=item as Record<string,unknown>;
   if(typeof row.ingredientId!=="string")continue;
   // Known-null totals are authoritative about absence of valid numeric
   // groups. Non-null totals are authoritative about group absence ONLY if
   // the projection included every group for this specific ingredient.
   if(row.expected!==null&&row.groupsComplete!==true)continue;
   const prefix=period+row.ingredientId+":group:";
   for(const old of observations){
    for(const v of old.values){
     if(v.unit!=="count"||!v.key.startsWith(prefix)||
      !v.key.endsWith("/quantity"))continue;
     const id=v.key.slice(period.length,-"/quantity".length);
     if(!live.has(id))revoked.add(id);
    }
   }
  }
  const refreshed=revoked.size?{...result,items:[
   ...result.items,
   ...[...revoked].sort().map(id=>({id,quantity:null}))
  ]}:result;
  processed.push(refreshed);
 }
 return processed;
}
