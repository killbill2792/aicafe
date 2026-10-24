import {z} from "zod";
import {cardValueSchema,type CardValue} from "@/lib/format/values";
import type {NumericEvidence} from "./checkNumbers";

/** The only source of calculation disclosures is trusted deterministic tool output. */
export const explainLineSchema=z.strictObject({
 label:z.string().trim().min(1).max(120),
 inputs:z.array(z.strictObject({name:z.string().trim().min(1).max(50),value:cardValueSchema})).min(1).max(8),
 formula:z.enum(["multiply","sum","divide","ratio","prorate","subtract"]),
 result:cardValueSchema,
 period:z.strictObject({from:z.iso.date(),to:z.iso.date()}).nullable(),
 source:z.string().min(1).max(100),
 provenance:z.enum(["recorded","ownerProvided","estimate"]),
});
export type ExplainLine=z.infer<typeof explainLineSchema>;
export const money=(cents:number):CardValue=>({kind:"money",cents});
export const count=(n:number):CardValue=>({kind:"count",n});
export const percent=(bps:number):CardValue=>({kind:"percent",bps});
function numeric(value:CardValue):{unit:"cents"|"bps"|"count";value:number}|null{
 switch(value.kind){
  case "money":return {unit:"cents",value:value.cents};
  case "percent":return {unit:"bps",value:value.bps};
  case "count":return {unit:"count",value:value.n};
  default:return null;
 }
}
/** Accept only numbers with a matching numeric-evidence key and a verified prose
 * token. Tool disclosures never arise by parsing model-proposed formulas. */
export function acceptedExplainLines(lines:readonly ExplainLine[],evidence:readonly NumericEvidence[],
 reply:string,unverified:readonly {start:number;end:number}[],locale:"en"|"es"|"ar"):ExplainLine[]{
 const verified=new Set(evidence.flatMap(e=>e.values.map(v=>v.unit+":"+v.value)));
 const selected:ExplainLine[]=[];
 for(const line of lines){
  const result=numeric(line.result);
  if(!result||!verified.has(result.unit+":"+result.value))continue;
  const quantity=result.unit==="cents"?result.value/100:
    result.unit==="bps"?result.value/100:result.value;
  const tokens=new Set<string>([
   new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(quantity),
   new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(quantity),
   String(quantity),
  ]);
  const matched=[...tokens].some(token=>{
   if(!token)return false;
   const start=reply.indexOf(token);
   if(start<0)return false;
   return !unverified.some(span=>span.start<start+token.length&&span.end>start);
  });
  if(!matched)continue;
  selected.push(line);
  if(selected.length===20)break;
 }
 return selected;
}
