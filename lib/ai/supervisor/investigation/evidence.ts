import {presentInvestigatedTasks} from "./taskPresentation";
import {formatScenarioValue,formatScenarioAssumption} from "../p3/formatScenario";
import {unit as expressionUnit} from "../p3/expression";
import {registeredReadCautions} from "../p3/readEvidencePresentation";
import {createHash} from "node:crypto";
import type {EvidenceReference,GroundedSupervisorReply,SupervisorReplyBlock} from "@/lib/ai/conversations/contracts";
import type {InvestigationAnswer} from "./protocol";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
export type Locale="en"|"es"|"ar";
export type Observation={id:string;capabilityId:string;input:unknown;result:Record<string,unknown>;
  reference:EvidenceReference|null;requiresSnapshot?:boolean;sourceContract?:string;display:Record<string,string>;
  /** Only set for a path observationDisplay classified as money (cents) or a
   * percentage (basis points); used only to decide whether/how a cited number
   * also earns a boxed fact alongside the answer's sentence, never to invent
   * one. */
  displayKind?:Record<string,"money"|"percent">;displayRaw?:Record<string,number>;
  datasetFields?:unknown;calculation?:boolean};
export const investigationLabels=(locale:Locale)=>({en,es,ar}[locale].SupervisorInvestigation);
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const clean=(v:string)=>v.replace(/[\p{Cc}\p{Cf}]/gu," ").trim();
/** Token values come only from validated tool output. Numeric text, dates,
 * money and URLs cannot be introduced by the narration model. */
export function observationDisplay(result:Record<string,unknown>,locale:Locale):
  {display:Record<string,string>;kind:Record<string,"money"|"percent">;raw:Record<string,number>}{
  const display:Record<string,string>={};
  const kind:Record<string,"money"|"percent">={};
  const raw:Record<string,number>={};
  const labels=investigationLabels(locale);
  const walk=(v:unknown,path:string,depth:number)=>{
    if(Object.keys(display).length>=400||depth>7)return;
    const key=path.split(".").at(-1)??"";
    if(/^(?:id|.*Id|.*Ids|sourceRevision|contract|selectorContractId|capabilityId|reason|purpose|source|formula)$/u.test(key))return;
    if(v===null||v===undefined)return;
    if(typeof v==="number"&&Number.isFinite(v)){
      const money=/Cents$|_cents$/u.test(key)||key==="value"&&result.unit==="USD_cents";
      const parentUnit=isRecord(result.value)?result.value.unit:undefined;
      const datasetUnit=expressionUnit.safeParse(parentUnit);
      if(result.id==="platform.dataset.analysis"&&key==="value"&&datasetUnit.success){
        display[path]=formatScenarioValue(v,datasetUnit.data,locale);
        if(datasetUnit.data==="USD_cents"){kind[path]="money";raw[path]=v;}
        return;
      }
      if(/(?:Bps|BasisPoints)$/u.test(key)){
        display[path]=new Intl.NumberFormat(locale,{style:"percent",maximumFractionDigits:2}).format(v/10000);
        kind[path]="percent";raw[path]=v;
        return;
      }
      if(money||key==="value"&&parentUnit==="USD_cents"){
        display[path]=new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(v/100);
        kind[path]="money";raw[path]=v;
      }else{
        display[path]=new Intl.NumberFormat(locale,{maximumFractionDigits:6}).format(v);
      }
    }else if(typeof v==="boolean")display[path]=v?labels.yes:labels.no;
    else if(typeof v==="string"){
      if(v.length>600||/^[a-f\d]{8}-[a-f\d-]{27,}$/iu.test(v))return;
      if(/https?:\/\/|www\./iu.test(v)){
        if(key!=="url"||result.id!=="public.research")return;
        try{if(new URL(v).protocol!=="https:")return;}catch{return;}
      }
      display[path]=clean(v);
    }else if(Array.isArray(v))v.slice(0,100).forEach((x,i)=>walk(x,path+"."+i,depth+1));
    else if(isRecord(v))for(const [k,x] of Object.entries(v))
      if(/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(k))walk(x,path?path+"."+k:k,depth+1);
  };
  walk(result.value,"value",0);
  if(isRecord(result.query))walk(result.query,"query",0);
  if(isRecord(result.provenance)&&typeof result.provenance.asOf==="string")
    display["provenance.asOf"]=clean(result.provenance.asOf);
  if(result.capabilityId==="platform.scenario.expression.v1"&&Array.isArray(result.assumptions))
    result.assumptions.forEach((a,i)=>{if(typeof a==="string")display["assumptions."+i]=formatScenarioAssumption(a,locale);});
  return {display,kind,raw};
}
export function observationReference(businessId:string,asOf:string,capabilityId:string,result:unknown,inheritedSource?:EvidenceReference["source"]):EvidenceReference{
  const provenance=isRecord(result)&&isRecord(result.provenance)?result.provenance:null;
  const source:EvidenceReference["source"]=inheritedSource==="unverified_external"?inheritedSource:provenance?.sourceId==="public.search"&&
    provenance.canonicalReaderId==="public.brave.search"?"unverified_external":"cafe_state";
  return {source,identifier:"investigation:"+createHash("sha256")
    .update(JSON.stringify({businessId,asOf,capabilityId,result})).digest("hex").slice(0,32),asOf};
}
export function renderInvestigationAnswer(answer:InvestigationAnswer,observations:readonly Observation[],locale:Locale):
  {blocks:SupervisorReplyBlock[];evidence:EvidenceReference[];adviceOnly:boolean}|null{
  const byId=new Map(observations.map(o=>[o.id,o]));
  if(!["en","es","ar"].includes(locale))return null;
  const labels=investigationLabels(locale);
  const blocks:SupervisorReplyBlock[]=[],refs:EvidenceReference[]=[];
  let boxedCount=0;const boxedSignatures=new Set<string>();
  let adviceOnly=true;
  for(const paragraph of answer.paragraphs){
    if(paragraph.kind==="evidence"&&!paragraph.citations.length)return null;
    if(paragraph.kind!=="evidence"&&paragraph.citations.length)return null;
    const cited=paragraph.citations.map(id=>byId.get(id));
    if(cited.some(o=>!o||o.result.status==="unavailable"))return null;
    if(paragraph.kind==="evidence")adviceOnly=false;
    let invalid=false;
    const plain=paragraph.text.replace(/\{\{(r\d+):([a-zA-Z0-9_.]+)\}\}/gu,(_m,id:string,path:string)=>{
      const observation=byId.get(id);
      if(!paragraph.citations.includes(id)||!observation||!Object.hasOwn(observation.display,path))invalid=true;
      return "";
    });
    if(invalid||/[\p{N}$€£¥%]|https?:\/\/|www\.|\{\{|\}\}/iu.test(plain))return null;
    const matched:{id:string;path:string}[]=[];
    const text=paragraph.text.replace(/\{\{(r\d+):([a-zA-Z0-9_.]+)\}\}/gu,
      (_m,id:string,path:string)=>{matched.push({id,path});return byId.get(id)!.display[path];});
    if(text.length>1200||!clean(text))return null;
    blocks.push({type:"text",text:clean(text)});
    for(const o of cited)if(o?.reference&&!refs.some(r=>r.identifier===o.reference!.identifier))refs.push(o.reference);
    // A boxed fact echoes a number already stated in the sentence just
    // pushed above -- immediately after it, never batched at the end, so a
    // multi-paragraph answer (revenue, then cost, then margin) keeps each
    // box next to the sentence it belongs to instead of an ambiguous pile.
    // Never introduces a value the sentence didn't already cite. Capped so
    // one answer never turns into a wall of boxes.
    if(paragraph.kind==="evidence")for(const {id,path} of matched){
      if(boxedCount>=4)break;
      const observation=byId.get(id);
      const kind=observation?.displayKind?.[path];
      const rawValue=observation?.displayRaw?.[path];
      if(!observation?.reference||!kind||typeof rawValue!=="number")continue;
      const signature=observation.reference.identifier+":"+path;
      if(boxedSignatures.has(signature))continue;
      boxedSignatures.add(signature);boxedCount++;
      blocks.push(kind==="money"
        ?{type:"metric",label:labels.factAmount,valueCents:rawValue,source:observation.reference}
        :{type:"percent",label:labels.factPercent,valueBps:rawValue,source:observation.reference});
    }
  }
  return {blocks,evidence:refs,adviceOnly};
}
/** Last-resort text for when the investigation is about to give up with a
 * genuine model answer in hand that merely failed our mechanical display-
 * token formatting gate -- never thrown away silently just because the
 * model wrote "$5.25" instead of the exact placeholder syntax. Strips every
 * `{{rN:path}}` token outright (we have no validated display value to trust
 * there, so it must never reach the owner as literal syntax or as a raw
 * unverified number).
 * Deliberately narrower than a plain formatting check: an "advice" paragraph
 * carries no evidence requirement at all, so it is the one channel where the
 * model could assert something false (an action it never took) with nothing
 * to ground it -- that must still go through the full independent review,
 * never this safety net. Only evidence paragraphs whose every citation
 * resolves to a real, available observation, and clarification paragraphs
 * (a question, never a claim), are eligible. */
export function renderUnverifiedAnswer(answer:InvestigationAnswer,observations:readonly Observation[],locale:Locale):string|null{
  const byId=new Map(observations.map(o=>[o.id,o]));
  for(const paragraph of answer.paragraphs){
    if(paragraph.kind==="advice")return null;
    if(paragraph.kind==="evidence"){
      if(!paragraph.citations.length)return null;
      for(const id of paragraph.citations){
        const observation=byId.get(id);
        if(!observation||observation.result.status==="unavailable")return null;
      }
    }
  }
  const labels=investigationLabels(locale);
  const text=answer.paragraphs
    .map(p=>clean(p.text.replace(/\{\{r\d+:[a-zA-Z0-9_.]+\}\}/gu,labels.unverifiedValue)))
    .filter(Boolean).join(" ");
  const cleaned=clean(text);
  return cleaned?cleaned.slice(0,1100):null;
}
export function investigationReply(answer:InvestigationAnswer,observations:readonly Observation[],locale:Locale):GroundedSupervisorReply|null{
  const rendered=renderInvestigationAnswer(answer,observations,locale);
  if(!rendered)return null;
  const labels=investigationLabels(locale);
  const cited=observations.filter(o=>answer.paragraphs.some(p=>p.citations.includes(o.id)));
  const pure=cited.length>0&&cited.every(o=>o.calculation&&!o.reference);
  const status=rendered.adviceOnly&&!answer.paragraphs.some(p=>p.kind==="advice")?"insufficient_evidence":"partial";
  const warnings:SupervisorReplyBlock[]=pure?[{type:"warning",code:"P3_CONDITIONAL",text:labels.conditional}]:
    rendered.adviceOnly?(answer.paragraphs.some(p=>p.kind==="advice")?[{type:"warning",code:"SUPERVISOR_ADVICE",text:labels.advice}]:[]):
      [{type:"warning",code:"SUPERVISOR_EVIDENCE_LIMITS",text:labels.partial}];
  if(cited.some(o=>o.reference?.source==="unverified_external"))warnings.push({type:"warning",code:"SUPERVISOR_PUBLIC_RESEARCH",text:labels.research});
  if(cited.some(o=>isRecord(o.result.quality)&&Array.isArray(o.result.quality.missingInputs)&&
    o.result.quality.missingInputs.includes("monetary_fields_unavailable")))
    warnings.push({type:"warning",code:"SUPERVISOR_MONETARY_UNAVAILABLE",text:labels.financialUnavailable});
  if(cited.some(o=>{
    const q=o.result.quality;
    return isRecord(q)&&Array.isArray(q.estimatedInputs)&&q.estimatedInputs.length>0;
  }))warnings.push({type:"warning",code:"SUPERVISOR_ESTIMATED",text:labels.estimated});
  for(const caution of new Set(cited.flatMap(o=>registeredReadCautions(o.result,locale))))
    warnings.push({type:"warning",code:"SUPERVISOR_SOURCE_CAUTION",text:caution});
  const cards=cited.flatMap(o=>o.reference?presentInvestigatedTasks(o.sourceContract,o.result.value,o.reference,locale):[])
    .filter((card,i,all)=>card.type!=="task_card"||all.findIndex(c=>c.type==="task_card"&&c.taskId===card.taskId)===i).slice(0,3);
  return {intent:pure?"profitability":"unknown",status,evidence:rendered.evidence,blocks:[...warnings,...rendered.blocks,...cards]};
}
