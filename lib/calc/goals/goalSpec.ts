import {z} from "zod";
import {metricCatalog,type MetricUnit} from "@/lib/calc/metrics/catalog";
import {evaluateGoal,type GoalMetric,type Evaluation} from "./evaluate";

/** Goal metrics the certified daily reader (lib/data/metricDay.server.ts) can
 * actually prove today. Labor, COGS and profit metrics need certifications that
 * reader does not provide yet, so offering them would only ever report "not enough data". */
export const GOAL_METRICS=["net_sales","orders","avg_ticket","item_units","item_revenue"] as const;
export type GoalMetricKey=typeof GOAL_METRICS[number];
export const ITEM_METRICS:ReadonlySet<GoalMetricKey>=new Set(["item_units","item_revenue"]);
export const GOAL_MIN_DAYS=7,GOAL_MAX_DAYS=90,BASELINE_DAYS=14,MAX_GUARDRAILS=2;

const metricKey=z.enum(GOAL_METRICS);
export const goalMetricSchema=z.strictObject({
  id:z.enum(["primary","guardrail1","guardrail2"]),role:z.enum(["primary","guardrail"]),
  metricKey,itemId:z.uuid().nullable(),itemName:z.string().min(1).max(200).nullable(),
  comparator:z.enum(["gte","lte"]),targetKind:z.enum(["relative_pct","absolute"]),
  target:z.number().finite(),
}).refine(m=>ITEM_METRICS.has(m.metricKey)===(m.itemId!==null),"Item metrics need an item, café metrics none");
export type GoalMetricSpec=z.infer<typeof goalMetricSchema>;
export const goalEffectSchema=z.strictObject({
  title:z.string().min(1).max(200),metrics:z.array(goalMetricSchema).min(1).max(1+MAX_GUARDRAILS),
  days:z.number().int().min(GOAL_MIN_DAYS).max(GOAL_MAX_DAYS),
  proposedOn:z.iso.date(),baselineFrom:z.iso.date(),baselineTo:z.iso.date(),
  currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
}).refine(e=>e.metrics.filter(m=>m.role==="primary").length===1,"Exactly one primary metric");
export type GoalEffect=z.infer<typeof goalEffectSchema>;

/** Owner-facing request, as the chat tool sends it. */
export type GoalRequest={
  metric:GoalMetricKey;itemId:string|null;direction:"up"|"down";
  targetKind:"percent"|"absolute";target:number;days:number;
  guardrails:Array<{metric:GoalMetricKey;itemId:string|null;direction:"not_below"|"not_above";percent:number}>;
};
/** "up 5%" means at least 5% above the before-period; "down 5%" at most 5% below.
 * A guardrail "not below by 10%" must stay at least 10% under the before-period. */
export function goalMetricsFromRequest(r:GoalRequest,itemNames:ReadonlyMap<string,string>):GoalMetricSpec[]{
  const name=(id:string|null)=>id===null?null:itemNames.get(id)??null;
  const primary:GoalMetricSpec={id:"primary",role:"primary",metricKey:r.metric,itemId:r.itemId,itemName:name(r.itemId),
    comparator:r.direction==="up"?"gte":"lte",targetKind:r.targetKind==="percent"?"relative_pct":"absolute",
    target:r.targetKind==="percent"?(r.direction==="up"?Math.abs(r.target):-Math.abs(r.target)):r.target};
  const guards=r.guardrails.slice(0,MAX_GUARDRAILS).map((g,i):GoalMetricSpec=>({
    id:i===0?"guardrail1":"guardrail2",role:"guardrail",metricKey:g.metric,itemId:g.itemId,itemName:name(g.itemId),
    comparator:g.direction==="not_below"?"gte":"lte",targetKind:"relative_pct",
    target:g.direction==="not_below"?-Math.abs(g.percent):Math.abs(g.percent)}));
  return [primary,...guards];
}

export function addDays(day:string,n:number):string{
  const d=new Date(day+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);
}
const weekday=(day:string)=>new Date(day+"T12:00:00Z").getUTCDay();
/** The before-period days with the same weekday as `date` (newest first). */
export function baselineDatesFor(date:string,from:string,to:string):string[]{
  const out:string[]=[];
  for(let d=to;d>=from;d=addDays(d,-1))if(weekday(d)===weekday(date))out.push(d);
  return out;
}
export function unitOf(key:GoalMetricKey):MetricUnit{return metricCatalog[key].unit;}

/** One monitored day: each metric's value that day and on the matching
 * before-period weekdays. Unknown is stored as null with coverage 0. */
export const goalObservationSchema=z.strictObject({
  values:z.record(z.string(),z.strictObject({value:z.number().nullable(),coverage:z.number().min(0).max(1)})),
  baseline:z.record(z.string(),z.array(z.strictObject({date:z.iso.date(),value:z.number().nullable(),
    coverage:z.number().min(0).max(1)}))),
});
export type GoalObservation=z.infer<typeof goalObservationSchema>;

export function goalSeries(effect:GoalEffect,samples:ReadonlyArray<{businessDate:string;observation:unknown}>):GoalMetric[]{
  const parsed=samples.flatMap(s=>{const o=goalObservationSchema.safeParse(s.observation);
    return o.success?[{date:s.businessDate,o:o.data}]:[];}).sort((a,b)=>a.date.localeCompare(b.date));
  return effect.metrics.map(m=>{
    const base=new Map<string,{date:string;value:number|null;coverage:number}>();
    for(const s of parsed)for(const b of s.o.baseline[m.id]??[])base.set(b.date,b);
    return {id:m.id,role:m.role,comparator:m.comparator,targetKind:m.targetKind,target:m.target,source:"computed",
      baseline:[...base.values()],
      test:parsed.map(s=>({date:s.date,value:s.o.values[m.id]?.value??null,coverage:s.o.values[m.id]?.coverage??0})),
      expectedTestDates:parsed.map(s=>s.date)};
  });
}
export type GoalOutcome={evaluation:Evaluation;asOf:string|null;
  status:"in_progress"|"complete"|"insufficient_evidence";recommendation:"keep"|"revert"|"adjust"};
/** Scores the goal from its daily samples. Before the last day the result is in progress. */
export function scoreGoal(effect:GoalEffect,samples:ReadonlyArray<{businessDate:string;observation:unknown}>,
  windowComplete:boolean):GoalOutcome{
  const series=goalSeries(effect,samples);
  const asOf=series[0]?.test.at(-1)?.date??null;
  const evaluation=asOf===null?{status:"insufficient_data" as const,recommendation:"none" as const,results:{}}:
    evaluateGoal(series,asOf,windowComplete?asOf:"9999-12-31",0.8,"goal");
  const status=!windowComplete?"in_progress":evaluation.status==="insufficient_data"?"insufficient_evidence":"complete";
  const r=evaluation.recommendation;
  return {evaluation,asOf,status,recommendation:r==="keep"||r==="revert"?r:"adjust"};
}
