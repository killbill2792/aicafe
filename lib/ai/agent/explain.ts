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
 const sources:Record<string,string>={get_item_sales:"item_sales",get_profit:"profitability",
  get_break_even:"break_even",get_cost_summary:"business_costs",
  get_labor:"labor_and_attendance",get_price_recommendation:"pricing_engine",
  suggest_new_item_price:"new_item_price",propose_price_change:"price_change_proposal",
  get_shift_cost:"employees+shiftCost"};
 const relevant=(line:ExplainLine)=>evidence.filter(e=>e.tool===(sources[line.source]??line.source));
 const selected:ExplainLine[]=[];
 for(const line of lines){
  const result=numeric(line.result);
  if(!result||!relevant(line).some(e=>e.values.some(v=>
    v.unit===result.unit&&v.value===result.value&&
    (!line.period||v.key.startsWith(line.period.from+"/"+line.period.to+"/")||
      line.source==="get_labor"&&v.key.includes(line.period.from)))))continue;
  const quantity=result.unit==="cents"?result.value/100:
    result.unit==="bps"?result.value/100:result.value;
  const tokens=new Set<string>([
   new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(quantity),
   new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(quantity),
   String(quantity),
  ]);
  const matched=[...tokens].some(token=>{
   if(!token)return false;
   let from=0;
   while(from<reply.length){
     const start=reply.indexOf(token,from);
     if(start<0)break;
     const previous=start>0?reply[start-1]:"";
     const following=reply[start+token.length]??"";
     // Reject a suffix inside 156,000 or a prefix inside 56,000,000.
     const boundary=!/[\\p{N}.,٬٫]/u.test(previous)&&!/[\\p{N}.,٬٫]/u.test(following);
     if(boundary&&!unverified.some(span=>
       span.start<start+token.length&&span.end>start))return true;
     from=start+token.length;
   }
   return false;
  });
  if(!matched)continue;
  selected.push(line);
  if(selected.length===20)break;
 }
 return selected;
}
