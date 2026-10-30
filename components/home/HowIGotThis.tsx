"use client";
import {formatCardValue} from "@/lib/format/values";
import type {ExplainLine} from "@/lib/ai/agent/explain";
import {localizedPeriodLabel} from "@/lib/ai/agent/resolve";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
type Locale="en"|"es"|"ar";
type Copy={howIGotThis:string;howCalculated:string;explainMissing:string;explainYouToldMe:string;explainEstimate:string;explainSold:string;
 explainMultiply:string;explainSum:string;explainDivide:string;explainRatio:string;explainProrate:string;explainSubtract:string};
const connector:Record<ExplainLine["formula"],string>={
 multiply:"×",sum:"+",divide:"÷",ratio:"÷",prorate:"×",subtract:"−",breakEven:"÷",
};
const localeFormat:Record<Locale,string>={en:"en-US",es:"es-ES",ar:"ar"};
function basisLabel(key:string,locale:Locale,provenance:ExplainLine["provenance"]):string{
 const copy={en,es,ar}[locale].SupervisorChat;
 const labels:Record<string,string>={
  owner_provided:copy.basisOwnerProvided,actual:copy.basisActual,estimated:copy.basisEstimated,
  default_estimate:copy.basisDefaultEstimate,projected:copy.basisProjected
 };
 // Tool-specific explanations are untrusted display strings, not translation
 // keys. Never render an English basis description inside ES/AR UI.
 if(labels[key])return labels[key];
 const normalized=key.toLowerCase();
 if(/missing|unknown|not available|unavailable|only .+days|partial/.test(normalized))
  return ({en,es,ar}[locale]).SupervisorChat.explainMissing;
 if(/owner|you told me|confirmed/.test(normalized))return copy.basisOwnerProvided;
 if(/recorded|coverage|sales/.test(normalized))return copy.basisActual;
 return provenance==="recorded"?copy.basisActual:
   provenance==="ownerProvided"?copy.basisOwnerProvided:copy.basisEstimated;
}
const calcLabels:Record<string,keyof typeof en.OwnerQuestions>={
 "Ingredients + packaging":"howIngredients","Units/month":"howUnits",
 "Monthly break-even sales":"howBreakEven","netSales":"howSales",
 "Milk cost difference":"milkCostDifference", "Suggested upcharge":"howUpcharge",
 "Labor/drink":"howLabor","Bills/drink":"howBills","Processing fee":"howFees",
 "Card percentage fee":"howFees","Full loaded cost":"howFullCost",
 "Full cost plus fixed card fee":"howFullCost",
 "Recommended price":"howPrice","Break-even":"howBreakEven",
 "Profit price (informational)":"howProfit","Owner profit":"howProfit",
 "Daily break-even sales":"howBreakEven","Recorded business costs":"howCost",
 "costDeltaCents":"howCost","suggestedUpchargeCents":"howUpcharge",
 "milkMl":"howMilkVolume","productCost":"howCost","qtySold":"howSales",
 "laborPerMonth":"howLabor","billsPerMonth":"howBills","fee":"howFees",
 "targetCostRatio":"howTarget","fullCost":"howFullCost","units":"howUnits",
 "baseMilkCost":"milkBaseCost","oatMilkCost":"milkOatCost","targetMilkCost":"milkAlternativeCost",
 "baseMilkPrice":"howPrice","oatMilkPrice":"howPrice",
 "remainingShare":"howRemainingShare",
 "targetProductCostPercent":"howTarget","roundingStepCents":"howRoundingStep",
 "ingredients":"howIngredients","packaging":"howIngredients",
 "wages":"howLabor","staffTax":"howLabor","paidTime":"howLabor",
 "hourlyWage":"howLabor","fixedPerOrder":"cardFixedFee",
 "drinksPerOrder":"howUnits","rate":"howFees","targetMargin":"howMargin",
 "missing":"generic"
};
function localizedLabel(label:string,locale:Locale):string{
 const copy={en,es,ar}[locale].OwnerQuestions;
 const dynamic=label.startsWith("Processing fee:")?"howFees":null;
 const key=dynamic??calcLabels[label];
 // A tool may have already translated this label. Never replace it with an unrelated generic key.
  return key?copy[key]:label;
}
function localizedSource(source:string,locale:Locale):string{
 const copy={en,es,ar}[locale].OwnerQuestions;
 if(/labor|staff|shift/.test(source))return copy.labor;
 if(/price|menu|item|modifier|milk/.test(source))return copy.menu;
 if(/profit|break_even/.test(source))return copy.profit;
 if(/fee|payment/.test(source))return copy.fees;
 if(/sale|order/.test(source))return copy.sales;
 if(/cost|expense/.test(source))return copy.expenses;
 return copy.generic;
}
function dates(p:{from:string;to:string}|null,locale:Locale){
 if(!p)return null;
 const format=new Intl.DateTimeFormat(localeFormat[locale],{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
 const read=(v:string)=>format.format(new Date(v+"T12:00:00Z"));
 return p.from===p.to?read(p.from):read(p.from)+" – "+read(p.to);
}
export default function HowIGotThis({lines,locale,copy,currency}:{
 lines:readonly ExplainLine[];locale:Locale;copy:Copy;currency:string|null;
}){
 if(!lines.length)return null;
 return <details dir={locale==="ar"?"rtl":"ltr"} className="rounded-xl border border-line bg-surface2 text-ink">
   <summary className="flex min-h-12 cursor-pointer items-center rounded-xl px-4 py-3 text-[17px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">{lines.some(line=>line.source==="suggest_new_item_price")?copy.howCalculated:copy.howIGotThis}</summary>
   <div className="space-y-3 border-t border-line px-4 py-3">{lines.map((line,i)=><p key={i} className="break-words text-[17px] leading-relaxed">
     <span className="font-semibold">{localizedLabel(line.label,locale)}: </span>
     {line.formula==="breakEven"&&line.inputs.length===5?
       <bdi dir="ltr">(
         {line.inputs.slice(0,2).map((item,j)=><span key={j}>
           {j>0?" + ":""}{localizedLabel(item.name,locale)}: {formatCardValue(item.value,locale,currency)}
         </span>)}
       ) × {localizedLabel(line.inputs[2].name,locale)}: {formatCardValue(line.inputs[2].value,locale,currency)}
       {" ÷ ("}{localizedLabel(line.inputs[2].name,locale)}: {formatCardValue(line.inputs[2].value,locale,currency)}
       {" − "}{localizedLabel(line.inputs[3].name,locale)}: {formatCardValue(line.inputs[3].value,locale,currency)}
       {" − "}{localizedLabel(line.inputs[4].name,locale)}: {formatCardValue(line.inputs[4].value,locale,currency)}
       {") = "}{formatCardValue(line.result,locale,currency)}</bdi>:
     {line.source==="milk_swap"&&line.inputs.length===3&&line.inputs[2].name==="roundingStepCents"?
       <><span className="text-ink-muted">{({en,es,ar}[locale]).OwnerQuestions.howRoundUp}: </span>
       <bdi dir="ltr">ceil(max(0, {formatCardValue(line.inputs[0].value,locale,currency)}) ÷ {formatCardValue(line.inputs[1].value,locale,currency)} ÷ {formatCardValue(line.inputs[2].value,locale,currency)}) × {formatCardValue(line.inputs[2].value,locale,currency)} {"="} {formatCardValue(line.result,locale,currency)}</bdi></>:
       <bdi dir="ltr">{line.inputs.map((input,j)=><span key={j}>
         {j>0?" "+(connector[line.formula]||copy.explainSum)+" ":""}
         {localizedLabel(input.name,locale)}: {formatCardValue(input.value,locale,currency)}
         {input.name==="qtySold"?" "+copy.explainSold:""}
       </span>)} {"="} {formatCardValue(line.result,locale,currency)}</bdi>}
     {line.period&&<span className="text-ink-muted"> · {line.periodLabelKey?
       localizedPeriodLabel({...line.period,labelKey:line.periodLabelKey,label:dates(line.period,locale)??undefined},locale):
       dates(line.period,locale)}</span>}
      <span className="ms-2 text-ink-muted"> · {({en,es,ar}[locale]).OwnerQuestions.howSource.replace("{source}",localizedSource(line.source,locale))}</span>
     {line.basis&&<span className="ms-2 text-ink-muted"> · {basisLabel(line.basis,locale,line.provenance)}</span>}
     {line.provenance!=="recorded"&&<span className="ms-2 rounded-full bg-surface px-2 py-1 text-sm font-semibold text-ink-muted">
       {line.provenance==="ownerProvided"?copy.explainYouToldMe:line.provenance==="missing"?copy.explainMissing:copy.explainEstimate}
     </span>}
   </p>)}</div>
 </details>;
}
