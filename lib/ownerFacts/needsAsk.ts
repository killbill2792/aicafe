import type {AgentToolResult} from "@/lib/ai/agent/tools";
export type AskReason={kind:"missing"|"empty"|"failed"|"uncertain"|"number";key:string;tool?:string};
/** All uncertain/refusal strings are centralized, by supported locale. */
export const uncertaintyPhrases={
 en:[/\bno data\b/i,/\b(?:don't|do not) have\b/i,/\bnot available\b/i,/\b(?:can't|cannot) tell\b/i,/\b(?:can't|cannot) (?:access|find)\b/i,/\bi don't know\b/i,/\bconnect your (?:pos|toast)\b/i,/something went wrong/i],
 es:[/no tengo/i,/no hay datos/i,/no disponible/i,/no puedo (?:decir|saber|acceder)/i,/no sé/i,/conecta (?:tu|su) (?:pos|caja)/i],
 ar:[/لا توجد بيانات/u,/لا أعرف/u,/ليس متاح/u,/غير متوفر/u,/لا أستطيع/u,/لا أملك/u,/اربط نظام/u],
} as const;
const numericQuestion=/(?:\b(?:how much|how many|what (?:is|was|were) (?:the )?(?:price|cost|total|rate|revenue|sales|profit|percentage|amount))\b|cuánto|cuántos|precio|تكلفة|كم|سعر|إجمالي|مبيعات|نسبة)/iu;
const numericAnswer=/[\d\u0660-\u0669\u06f0-\u06f9]/u;
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
export function classifyNeedsAsk(results:readonly AgentToolResult[],finalText:string,ownerText:string):AskReason[]{
 const reasons:AskReason[]=[];
 for(const r of results){
  if(r.source==="ask_owner"&&!r.error)continue;
  if(typeof r.error==="string")reasons.push({kind:"failed",key:r.source,tool:r.source});
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
 if(!finalText.trim()&&ownerText.trim())reasons.push({kind:"uncertain",key:"owner_question"});
 if(Object.values(uncertaintyPhrases).some(phrases=>phrases.some(pattern=>pattern.test(finalText))))
   reasons.push({kind:"uncertain",key:"owner_question"});
 if(numericQuestion.test(ownerText)&&!numericAnswer.test(finalText)&&
    !results.some(r=>r.source==="ask_owner"&&r.missing.length===0))
   reasons.push({kind:"number",key:"owner_question"});
 return [...new Map(reasons.map(r=>[r.kind+":"+r.key,r])).values()];
}
