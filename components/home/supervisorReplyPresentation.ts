import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type { EvidenceReference, SupervisorReplyBlock } from "@/lib/ai/conversations/contracts";
export type Locale="en"|"es"|"ar";
export type FactBlock=Extract<SupervisorReplyBlock,{type:"metric"|"count"|"percent"}>;
export type ReplyGroup={kind:"facts";blocks:FactBlock[]} | {kind:"single";block:unknown};
const labels:Record<Locale,Record<EvidenceReference["source"],string>>={
  en:{cafe_state:"Café records",historical_rollups:"Sales records",
    staff_timecards:"Staff records",pricing_engine:"Menu pricing",operating_tasks:"AI Team",
    owner_rules:"Owner rules",unverified_external:en.SupervisorInvestigation.externalUnverified,verified_external:"Verified external source"},
  es:{cafe_state:"Registros del café",historical_rollups:"Registros de ventas",
    staff_timecards:"Registros del personal",pricing_engine:"Precios del menú",
    operating_tasks:"Equipo de IA",owner_rules:"Reglas del propietario",
    unverified_external:es.SupervisorInvestigation.externalUnverified,verified_external:"Fuente externa verificada"},
  ar:{cafe_state:"سجلات المقهى",historical_rollups:"سجلات المبيعات",
    staff_timecards:"سجلات الموظفين",pricing_engine:"تسعير القائمة",
    operating_tasks:"فريق الذكاء الاصطناعي",owner_rules:"قواعد المالك",
    unverified_external:ar.SupervisorInvestigation.externalUnverified,verified_external:"مصدر خارجي موثوق"},
};
export function sourceLabel(source:EvidenceReference["source"],locale:Locale){
  return labels[locale][source];
}
const isFact=(value:unknown):value is FactBlock=>{
  if(!value||typeof value!=="object")return false;
  const b=value as Record<string,unknown>;
  const src=b.source;
  if(!src||typeof src!=="object")return false;
  const r=src as Record<string,unknown>;
  if(typeof r.source!=="string" || !Object.hasOwn(labels.en,r.source) ||
    typeof r.asOf!=="string" || typeof r.identifier!=="string")return false;
  if(typeof b.label!=="string" || !b.label.trim())return false;
  if(b.type==="metric")return Number.isSafeInteger(b.valueCents);
  if(b.type==="percent")return Number.isSafeInteger(b.valueBps);
  return b.type==="count"&&Number.isSafeInteger(b.value)&&Number(b.value)>=0;
};
export function groupReplyBlocks(blocks:unknown[]):ReplyGroup[]{
  const groups:ReplyGroup[]=[];
  for(const block of blocks){
    const last=groups.at(-1);
    if(isFact(block)&&last?.kind==="facts")last.blocks.push(block);
    else if(isFact(block))groups.push({kind:"facts",blocks:[block]});
    else groups.push({kind:"single",block});
  }
  return groups;
}
export function uniqueSources(blocks:FactBlock[]){
  const seen=new Set<string>();
  return blocks.map(b=>b.source).filter(s=>{
    const key=s.source+"|"+s.asOf;
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
}
