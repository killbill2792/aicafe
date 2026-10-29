import type {AgentToolResult} from "@/lib/ai/agent/tools";
export type AskReason={kind:"missing"|"empty"|"failed"|"uncertain"|"number";key:string;tool?:string};
function hasUncertainBasis(value:unknown):boolean{
 // Canonical tools can return hundreds of rows with deeply nested basis
 // labels. Never drop an estimate just because it is after the first 40.
 const work:unknown[]=[value];
 const seen=new WeakSet<object>();
 while(work.length){
  const next=work.pop();
  if(!next||typeof next!=="object"||seen.has(next))continue;
  seen.add(next);
  if(Array.isArray(next)){work.push(...next);continue;}
  for(const [key,v] of Object.entries(next)){
   if(((key==="basis"||key==="sourceBasis")&&
      (v==="missing"||v==="unknown"||v==="default_estimate"))||
     (key==="default_estimate"&&v===true))return true;
   if(v&&typeof v==="object")work.push(v);
  }
 }
 return false;
}
const emptyCollectionKeys=new Set(["rows","shifts","entries","items","orders","results","employees","timeEntries","data"]);
export function classifyNeedsAsk(results:readonly AgentToolResult[],_finalText:string,_ownerText:string):AskReason[]{
 const reasons:AskReason[]=[];
 for(const r of results){
  if(r.source==="ask_owner"&&!r.error)continue;
  if(typeof r.error==="string"&&!(r.source==="ask_owner"&&r.error==="invalidFactFields"&&r.missing.includes("unitCostCents")))
   reasons.push({kind:"failed",key:r.source,tool:r.source});
  for(const missing of r.missing)if(missing && missing!=="none"){
    reasons.push({kind:"missing",key:missing,tool:r.source});
  }
  if(hasUncertainBasis(r)){
    reasons.push({kind:"missing",key:r.source,tool:r.source});
  }
  if(!r.missing.length&&!r.error&&
    (r.available===false||r.status==="unavailable"||r.status==="empty"||r.value===null||
      Object.entries(r).some(([key,value])=>
        emptyCollectionKeys.has(key)&&Array.isArray(value)&&value.length===0))){
    reasons.push({kind:"empty",key:r.source,tool:r.source});
  }
 }
 return [...new Map(reasons.map(r=>[r.kind+":"+r.key,r])).values()];
}
