import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {formatCafeCurrency} from "@/lib/format/cafeCurrency";
import {diffFields,type DiffField} from "@/lib/format/values";
import {unitOf,type GoalEffect,type GoalMetricSpec,type GoalOutcome} from "./goalSpec";

export type GoalLocale="en"|"es"|"ar";
const copyFor=(l:GoalLocale)=>({en,es,ar} as const)[l].Goals;
const fill=(s:string,v:Record<string,string>)=>Object.entries(v).reduce((t,[k,x])=>t.replaceAll("{"+k+"}",x),s);

export function metricLabel(m:Pick<GoalMetricSpec,"metricKey"|"itemName">,locale:GoalLocale):string{
  return fill(copyFor(locale).metric[m.metricKey],{item:m.itemName??""});
}
/** A daily value in the metric's own unit: money in the café currency, counts, percents. */
export function formatGoalValue(m:Pick<GoalMetricSpec,"metricKey">,value:number,locale:GoalLocale,currency:string|null):string{
  const unit=unitOf(m.metricKey);
  if(unit==="cents")return formatCafeCurrency(Math.round(value),locale,currency).text;
  if(unit==="bps")return new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(value/100)+"%";
  return new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(value);
}
const pct=(n:number,l:GoalLocale)=>new Intl.NumberFormat(l,{maximumFractionDigits:1}).format(Math.abs(n));

export function goalTitle(primary:GoalMetricSpec,locale:GoalLocale,currency:string|null):string{
  const c=copyFor(locale),metric=metricLabel(primary,locale);
  if(primary.targetKind==="relative_pct")
    return fill(primary.comparator==="gte"?c.titleUpPercent:c.titleDownPercent,{metric,pct:pct(primary.target,locale)});
  return fill(primary.comparator==="gte"?c.titleAtLeast:c.titleAtMost,
    {metric,value:formatGoalValue(primary,primary.target,locale,currency)});
}
export function guardrailText(g:GoalMetricSpec,locale:GoalLocale):string{
  const c=copyFor(locale);
  return fill(g.comparator==="gte"?c.guardrailNotBelow:c.guardrailNotAbove,{metric:metricLabel(g,locale),pct:pct(g.target,locale)});
}
/** Rows for the approval card. */
export function goalPreview(effect:GoalEffect,locale:GoalLocale):DiffField[]{
  const c=copyFor(locale);
  const primary=effect.metrics.find(m=>m.role==="primary")!;
  return diffFields([],[
    {field:"goal",label:c.previewGoal,value:{kind:"text",text:effect.title}},
    {field:"metric",label:c.previewMetric,value:{kind:"text",text:metricLabel(primary,locale)}},
    {field:"days",label:c.previewDays,value:{kind:"count",n:effect.days,unit:"days"}},
    ...effect.metrics.filter(m=>m.role==="guardrail").map(g=>(
      {field:g.id,label:c.previewGuardrail,value:{kind:"text" as const,text:guardrailText(g,locale)}})),
  ]);
}
function lines(effect:GoalEffect,outcome:GoalOutcome,locale:GoalLocale):string[]{
  const c=copyFor(locale);
  return effect.metrics.map(m=>{
    const r=outcome.evaluation.results[m.id];
    const label=metricLabel(m,locale)+(m.role==="guardrail"?" ("+c.guardrailWord+")":"");
    if(!r||r.current===null)return fill(c.lineMissing,{metric:label});
    const v=(x:number)=>formatGoalValue(m,x,locale,effect.currency);
    const status=r.met===true?c.met:r.met===false?c.notMet:c.unknown;
    return r.baseline!==null&&r.target!==null
      ?fill(c.line,{metric:label,current:v(r.current),baseline:v(r.baseline),target:v(r.target),status})
      :fill(c.lineNoBaseline,{metric:label,current:v(r.current),status});
  });
}
export function goalMidRunText(effect:GoalEffect,outcome:GoalOutcome,locale:GoalLocale):string{
  const c=copyFor(locale);
  return fill(c.midRun,{title:effect.title,lines:lines(effect,outcome,locale).join("; "),
    days:new Intl.NumberFormat(locale).format(effect.days)});
}
export function goalReportText(effect:GoalEffect,outcome:GoalOutcome,locale:GoalLocale):string{
  const c=copyFor(locale);
  const head=outcome.status==="insufficient_evidence"?c.reportInsufficient:
    outcome.evaluation.status==="met"?c.reportMet:c.reportMissed;
  const rec=outcome.status==="insufficient_evidence"?c.recommendInsufficient:
    outcome.recommendation==="keep"?c.recommendKeep:outcome.recommendation==="revert"?c.recommendRevert:c.recommendAdjust;
  return [fill(head,{title:effect.title}),lines(effect,outcome,locale).join("; ")+".",rec,c.reportCaveat].join(" ");
}
