"use client";
import {formatCardValue} from "@/lib/format/values";
import type {ExplainLine} from "@/lib/ai/agent/explain";
type Locale="en"|"es"|"ar";
type Copy={howIGotThis:string;explainYouToldMe:string;explainEstimate:string;explainSold:string;
 explainMultiply:string;explainSum:string;explainDivide:string;explainRatio:string;explainProrate:string;explainSubtract:string};
const connector:Record<ExplainLine["formula"],string>={
 multiply:"×",sum:"+",divide:"÷",ratio:"÷",prorate:"×",subtract:"−",
};
const localeFormat:Record<Locale,string>={en:"en-US",es:"es-ES",ar:"ar"};
function dates(p:{from:string;to:string}|null,locale:Locale){
 if(!p)return null;
 const format=new Intl.DateTimeFormat(localeFormat[locale],{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
 const read=(v:string)=>format.format(new Date(v+"T12:00:00Z"));
 return p.from===p.to?read(p.from):read(p.from)+" – "+read(p.to);
}
export default function HowIGotThis({lines,locale,copy,currency="USD"}:{
 lines:readonly ExplainLine[];locale:Locale;copy:Copy;currency?:string;
}){
 if(!lines.length)return null;
 return <details dir={locale==="ar"?"rtl":"ltr"} className="rounded-xl border border-line bg-surface2 text-ink">
   <summary className="flex min-h-12 cursor-pointer items-center rounded-xl px-4 py-3 text-[17px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">{copy.howIGotThis}</summary>
   <div className="space-y-3 border-t border-line px-4 py-3">{lines.map((line,i)=><p key={i} className="break-words text-[17px] leading-relaxed">
     <span className="font-semibold">{line.label}: </span>
     <bdi dir="ltr">{line.inputs.map((input,j)=><span key={j}>
       {j>0?" "+(connector[line.formula]||copy.explainSum)+" ":""}
       {formatCardValue(input.value,locale,currency)}
       {input.name==="qtySold"?" "+copy.explainSold:""}
     </span>)} {"="} {formatCardValue(line.result,locale,currency)}</bdi>
     {line.period&&<span className="text-ink-muted"> · {dates(line.period,locale)}</span>}
     {line.provenance!=="recorded"&&<span className="ms-2 rounded-full bg-surface px-2 py-1 text-sm font-semibold text-ink-muted">
       {line.provenance==="ownerProvided"?copy.explainYouToldMe:copy.explainEstimate}
     </span>}
   </p>)}</div>
 </details>;
}
