import {createHash} from "node:crypto";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {catalogForMissing} from "./catalog";
import {savedValue,type SavedFact} from "./inject";
import type {AskReason} from "./needsAsk";
import type {AgentToolResult,AgentLocale} from "@/lib/ai/agent/tools";
const copyByLocale={en:en.OwnerQuestions,es:es.OwnerQuestions,ar:ar.OwnerQuestions};
const labels:Record<string,keyof typeof en.OwnerQuestions>={
 payroll:"payroll",bills:"bills",cardFee:"cardFee",payrollExtras:"payrollExtras",
 cardSalesShare:"cardSalesShare",cardTransactionsShare:"cardTransactionsShare",
 cardFixedFee:"cardFixedFee",averageTicket:"averageTicket",processor:"processor",
 itemCost:"itemCost",hours:"hours",schedule:"schedule",generic:"generic",
 milkBase:"milkBase",milkTarget:"milkTarget",milkVolume:"milkVolume",milkBaseCost:"milkBaseCost",milkOatCost:"milkOatCost",milkTargetCost:"milkTargetCost"
};
export function ownerFactLabel(key:string,labelKey:string,locale:AgentLocale):string{
 const copy=copyByLocale[locale];
 const match=/^milk_([a-z0-9_]+)_serving_cost_cents:([0-9]{1,2})oz$/u.exec(key);
 const type=match?.[1].replace(/_milk$/u,"");
 const milkName=match?({
  oat:copy.milkTypeOat,almond:copy.milkTypeAlmond,
  soy:copy.milkTypeSoy,coconut:copy.milkTypeCoconut
 } as Record<string,string>)[type??""]??type?.replace(/_/g," ")??"":"";
 const label=match&&match[1]!=="base"?
  copy.milkTargetCost.replace("{milk}",milkName):
  copy[labels[labelKey]??"generic"];
 const size=/^milk_(?:ml|[a-z0-9_]+_serving_cost_cents):([0-9]{1,2})oz$/u.exec(key);
 return size?label+" ("+size[1]+" oz)":label;
}
export function readableSource(source:string,locale:AgentLocale):string{
 const key: keyof typeof en.OwnerQuestions=/schedule|shift|coverage|staff|team/.test(source)?"shifts":
  /payroll|labor|employee|clock/.test(source)?"labor":
  /fees|processing/.test(source)?"fees":
  /price|menu|item|product|ingredient/.test(source)?"menu":
  /profit|break_even/.test(source)?"profit":
  /expense|bill|cost/.test(source)?"expenses":
  /inventory|stock|usage/.test(source)?"inventory":
  /sale|order|hour/.test(source)?"sales":"generic";
 return copyByLocale[locale][key];
}
export function genericQuestionKey(question:string):string{
 return "owner_question_"+createHash("sha256").update(question.trim().toLowerCase()).digest("hex").slice(0,20);
}
/** Questions about dated shifts must be scoped to the requested window.
 * One week's answer is not evidence for any other week's schedule. */
export function scopedOwnerQuestionKey(
 reason:AskReason,results:readonly AgentToolResult[],ownerText:string
):string{
 const tool=reason.tool??"";
 const period=results.find(r=>r.source===tool)?.period;
 if(period&&/^\d{4}-\d{2}-\d{2}$/.test(period.from)&&
   /^\d{4}-\d{2}-\d{2}$/.test(period.to)&&
   /(?:schedule|shift|coverage)/iu.test(tool+" "+reason.key))
   return "schedule:"+period.from+":"+period.to;
 if(reason.kind==="uncertain"||reason.kind==="number")return genericQuestionKey(ownerText);
 if((reason.kind==="empty"||reason.kind==="failed"||
     reason.kind==="missing"&&reason.key===tool)&&
    tool!=="suggest_new_item_price")
   return genericQuestionKey(tool+"|"+ownerText);
 return reason.key;
}
export function questionFromReasons(
 reasons:readonly AskReason[],results:readonly AgentToolResult[],
 ownerText:string,locale:AgentLocale,savedFacts:readonly SavedFact[]
){
 const copy=copyByLocale[locale];
 const effective=reasons.some(reason=>reason.tool)?
  reasons.filter(reason=>reason.kind!=="uncertain"&&reason.kind!=="number"):reasons;
 const wanted=Array.from(new Map(effective.flatMap(reason=>{
  const key=scopedOwnerQuestionKey(reason,results,ownerText);
  const definition=catalogForMissing(key);
  const keys=definition.factKey==="card_fee_rate_percent"?[
    "card_fee_rate_percent","card_sales_share_percent","card_transactions_share_percent",
    "card_fixed_fee_cents","card_processor_label","card_average_ticket_cents"]:[definition.factKey];
  return keys.map(factKey=>[factKey,{reason,definition:catalogForMissing(factKey)}] as const);
 })).values()).filter(x=>savedValue(savedFacts,x.definition.factKey)===undefined).slice(0,6);
 if(!wanted.length)return null;
 const first=wanted[0],r=results.find(x=>x.source===first.reason.tool);
 const period=r?.period?String(r.period.from)+" – "+String(r.period.to):"";
 const detail=first.reason.kind==="failed"?copy.failed:first.reason.kind==="empty"?copy.empty:copy.missing;
 const word=(x:typeof first)=>{
  return ownerFactLabel(x.definition.factKey,x.definition.labelKey,locale);
 };
 const question=copy.question.replace("{source}",readableSource(first.reason.tool??"",locale)+(period?" ("+period+")":""))
  .replace("{detail}",detail).replace("{what}",wanted.map(word).join(", ")).slice(0,200);
 return {kind:"facts" as const,question,options:[] as [],allowOther:false as const,
  fields:wanted.map(x=>({
   key:x.definition.factKey,label:word(x),inputType:x.definition.type,
   units:[] as string[],defaultUnit:"",
   ...(x.definition.type==="choice"?{choices:[
    {label:copy.generic,value:"other"},{label:copy.schedule,value:"scheduled"}]}:{})
  }))};
}
export function localizedToolNote(results:readonly AgentToolResult[],locale:AgentLocale):string{
 const failed=results.find(r=>typeof r.error==="string");
 if(!failed)return "";
 if(typeof failed.reason==="string"&&failed.reason.includes(readableSource(failed.source,locale)))
   return failed.reason;
 const copy=copyByLocale[locale],period=failed.period?
  String(failed.period.from)+" – "+String(failed.period.to):copy.period;
 return copy.error.replace("{source}",readableSource(failed.source,locale)).replace("{period}",period);
}

/** A saved answer must not suppress an owner card while leaving a refusal.
 * Render the stored value with explicit owner provenance, never as a POS actual. */
export function answerFromSavedReasons(
 reasons:readonly AskReason[],results:readonly AgentToolResult[],
 ownerText:string,facts:readonly SavedFact[],locale:AgentLocale
):string|null{
 const copy=copyByLocale[locale];
 const seen=new Set<string>();
 const found=reasons.flatMap(reason=>{
  const key=catalogForMissing(scopedOwnerQuestionKey(reason,results,ownerText)).factKey;
  if(seen.has(key))return [];
  seen.add(key);
  const value=savedValue(facts,key);
  if(value===undefined)return [];
  const def=catalogForMissing(key);
  const label=ownerFactLabel(key,def.labelKey,locale);
  let display:string;
  if(typeof value==="number"&&Number.isFinite(value)){
   const number=def.type==="money"?value/100:value;
   display=new Intl.NumberFormat(locale==="en"?"en-US":locale==="es"?"es-ES":"ar",
    def.type==="money"?{style:"currency",currency}:
     {maximumFractionDigits:2}).format(number)+(def.type==="percent"?"%":"");
  }else if(typeof value==="string")display=value;
  else return [];
  return [label+": "+display];
 }).slice(0,3);
 if(!found.length)return null;
 return ({en:en.SupervisorChat,es:es.SupervisorChat,ar:ar.SupervisorChat}[locale]
  .provenanceOwner)+": "+found.join("; ");
}
