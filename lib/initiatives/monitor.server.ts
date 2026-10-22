import "server-only";
import {createHash,randomUUID} from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { computeMetric, type MetricKey } from "@/lib/calc/metrics/catalog";
import { evaluateInitiative, type GoalMetric } from "@/lib/calc/initiatives/evaluate";
import { writeTeamUpdate } from "@/lib/teamUpdates/write.server";
import { listMonitorBatch,readMonitorGraph,readMetricDay,persistMetricObservation,
  persistInitiativeEvaluation,claimMonitorInitiative,releaseMonitorInitiative } from "@/lib/data/initiatives.server";
import type { InitiativeRow,MetricRow,ObservationRow,InitiativeScope } from "./contracts";
const translations = {en:en.Initiatives,es:es.Initiatives,ar:ar.Initiatives};
const dayOffset = (day:string,days:number) =>
  new Date(Date.parse(day+"T12:00:00Z")+days*86400000).toISOString().slice(0,10);
const allDays = (from:string,to:string) => {
  const dates:string[]=[];
  for(let d=from;d<=to&&dates.length<200;d=dayOffset(d,1))dates.push(d);
  return dates;
};
const due = (from:string,date:string,cadence:InitiativeRow["checkin_cadence"],end:string) => {
  const elapsed=Math.round((Date.parse(date+"T12:00:00Z")-Date.parse(from+"T12:00:00Z"))/86400000);
  return cadence==="daily"||(cadence==="every_3_days"&&elapsed%3===0)||
    (cadence==="weekly"&&elapsed%7===0)||(cadence==="end_only"&&date===end);
};
const interpolate = (s:string,title:string,date:string) =>
  s.replaceAll("{title}",title).replaceAll("{date}",date);
function initiativeDomain(initiative:InitiativeRow,metrics:MetricRow[]) {
  if(initiative.adapter_id==="price_change"||
    metrics.some(m=>m.metric_key?.startsWith("item_")))return "menu_pricing" as const;
  if(metrics.some(m=>["labor_cost","labor_pct","sales_per_labor_hour"].includes(m.metric_key??"")))
    return "labor" as const;
  if(metrics.some(m=>m.metric_key==="ingredient_unit_cost"))return "supplies" as const;
  return "money" as const;
}
export type MonitorStats={checked:number;sampled:number;updates:number;failed:number};

export async function monitorInitiatives(now:Date=new Date()):Promise<MonitorStats> {
  const queue=await listMonitorBatch();
  const stats:MonitorStats={checked:queue.length,sampled:0,updates:0,failed:0};
  const deadline=Date.now()+100_000; // leave 20s for Vercel finalization
  for(const initiative of queue){
    if(Date.now()>=deadline)break;
    let completed=false;
    let claim:InitiativeRow|null=null;
    const token=randomUUID();
    const started=Date.now();
    const assertBudget=()=>{if(Date.now()>deadline-8_000 || Date.now()-started>10_000)
      throw new Error("monitor work time budget exhausted");};
    try{
      // Rotate FIRST: a killed or slow execution cannot monopolize the oldest batch.
      // Compare-and-swap prevents concurrent cron runs processing the same revision.
      claim=await claimMonitorInitiative(initiative,token);
      if(!claim)continue;
      const scope:InitiativeScope={businessId:initiative.business_id,ownerUserId:initiative.owner_user_id};
      const graph=await readMonitorGraph(initiative);
      const domain=initiativeDomain(initiative,graph.metrics);
      const today=formatInTimeZone(now,graph.timezone,"yyyy-MM-dd");
      const yesterday=dayOffset(today,-1);
      if(yesterday<initiative.starts_on)continue;
      const asOf=yesterday<initiative.ends_on?yesterday:initiative.ends_on;
      const first=initiative.baseline_from;
      const lastBaseline=initiative.baseline_to??dayOffset(initiative.starts_on,-1);
      const days=[...allDays(first,lastBaseline),...allDays(initiative.starts_on,asOf)];
      const byMetric=new Map<string,ObservationRow[]>();
      for(const metric of graph.metrics)
        byMetric.set(metric.id,graph.observations.filter(o=>o.metric_id===metric.id));
      // Process up to seven previously unsampled dates per run to bound the cron.
      // Rotation means long outages catch up over successive runs without starving tenants.
      const missingFor=(d:string)=>graph.metrics.some(metric=>metric.source==="computed" &&
        !byMetric.get(metric.id)?.some(o=>o.business_date===d));
      // Current test evidence must not sit behind months of baseline history.
      // Match each expected test weekday to its nearest prior baseline day.
      const testDates=allDays(initiative.starts_on,asOf);
      const baseDates=allDays(first,lastBaseline);
      const closestBaseline=[...new Set(testDates.map(test=>{
        const targetWeekday=new Date(test+"T12:00:00Z").getUTCDay();
        return [...baseDates].reverse().find(base=>
          new Date(base+"T12:00:00Z").getUTCDay()===targetWeekday);
      }).filter((date):date is string=>Boolean(date)))];
      const freshTest=testDates.filter(missingFor).reverse();
      const freshBaseline=closestBaseline.filter(missingFor).reverse();
      const incomplete=days.filter(d=>graph.metrics.some(metric=>metric.source==="computed" &&
        byMetric.get(metric.id)?.some(o=>o.business_date===d&&o.coverage<1)));
      const rotated=(items:string[],max:number)=>{
        if(!items.length)return [];
        const offset=initiative.revision%items.length;
        return [...items.slice(offset),...items.slice(0,offset)].slice(0,max);
      };
      const eligibleCorrection=today<=dayOffset(initiative.ends_on,14);
      const covered=eligibleCorrection?days.filter(d=>graph.metrics.some(metric=>
        metric.source==="computed" &&
        byMetric.get(metric.id)?.some(o=>o.business_date===d&&o.coverage>=1))):[];
      const pending=[...freshTest.slice(0,3),...freshBaseline.slice(0,2),
        ...rotated(incomplete,1),...rotated(covered,1)]
        .filter((day,index,array)=>array.indexOf(day)===index).slice(0,7);
      for(const date of pending){
        assertBudget();
        const computed=graph.metrics.filter(m=>m.source==="computed" &&
          (eligibleCorrection || !byMetric.get(m.id)?.some(o=>o.business_date===date&&o.coverage>=1)));
        if(!computed.length)continue;
        const input=await readMetricDay(initiative.business_id,date,{
          items:computed.some(m=>m.metric_key?.startsWith("item_")||m.metric_key==="cogs_pct"),
          hours:computed.some(m=>m.metric_key==="sales_per_labor_hour"),
          ingredientIds:computed.filter(m=>m.metric_key==="ingredient_unit_cost")
            .map(m=>String(m.params.ingredientId)),
        });
        for(const metric of computed){
          assertBudget();
          if(!metric.metric_key)continue;
          const result=computeMetric(metric.metric_key as MetricKey,metric.params,input);
          const row:ObservationRow={
            metric_id:metric.id,business_date:date,value:result.value,
            coverage:result.coverage,source:"computed",note:result.missing.join(",")||null,
            revision:1,
          };
          if(await persistMetricObservation(scope,initiative.id,token,row)){
            stats.sampled++;
            const prior=byMetric.get(metric.id)!;
            const position=prior.findIndex(o=>o.business_date===date);
            if(position>=0)prior[position]=row;
            else prior.push(row);
          }
        }
      }
      for(const metric of graph.metrics.filter(m=>m.source==="checkin"&&m.checkin_audience==="owner")){
        const already=byMetric.get(metric.id)??[];
        const dueDates=allDays(initiative.starts_on,asOf)
          .filter(date=>metric.params.changeConfirmation===true ? date===initiative.starts_on :
            due(initiative.starts_on,date,initiative.checkin_cadence,initiative.ends_on));
        // Rotate outstanding dates rather than permanently skipping missed
        // cadence check-ins after outages or failed notification attempts.
        const outstanding=dueDates.filter(date=>!already.some(o=>o.business_date===date&&o.coverage>=1));
        const start=outstanding.length?initiative.revision%outstanding.length:0;
        for(const date of [...outstanding.slice(start),...outstanding.slice(0,start)].slice(0,3)){
          assertBudget();
          const t=translations[initiative.locale];
          const question=metric.checkin_question??t.checkinDefault;
          const result=await writeTeamUpdate({
            businessId:initiative.business_id,ownerUserId:initiative.owner_user_id,
            domain,kind:"initiative_checkin",severity:"action",
            subjectType:"owner_initiative",subjectId:initiative.id,
            facts:{initiativeId:initiative.id,metricId:metric.id,date},
            text:interpolate(t.checkin,initiative.title,date)+" "+question,
            locale:initiative.locale,
            actions:[{kind:"checkin",metricId:metric.id,question,date}],
            dedupeKey:"initiative:"+initiative.id+":checkin:"+metric.id+":"+date,
          });
          if(result.created)stats.updates++;
        }
      }
      const goalMetrics:GoalMetric[]=graph.metrics
        .filter(m=>m.source==="computed"||m.source==="checkin")
        .map(m=>({
          id:m.id,role:m.role,comparator:m.comparator,targetKind:m.target_kind,target:Number(m.target),
          baseline:(byMetric.get(m.id)??[]).filter(o=>o.business_date>=first&&o.business_date<=lastBaseline)
            .map(o=>({date:o.business_date,value:o.value,coverage:Number(o.coverage)})),
          test:(m.source==="checkin"?
            m.params.changeConfirmation===true?[initiative.starts_on]:
              allDays(initiative.starts_on,asOf).filter(date=>
                due(initiative.starts_on,date,initiative.checkin_cadence,initiative.ends_on)):
            allDays(initiative.starts_on,asOf))
            .map(date=>{
              const obs=(byMetric.get(m.id)??[]).find(o=>o.business_date===date);
              return {date,value:obs?.value??null,coverage:Number(obs?.coverage??0)};
            }),
          source:m.source,
          expectedTestDates:m.source==="computed" ? allDays(initiative.starts_on,asOf) :
            allDays(initiative.starts_on,asOf).filter(date=>
              m.params.changeConfirmation===true ? date===initiative.starts_on :
              due(initiative.starts_on,date,initiative.checkin_cadence,initiative.ends_on)),
        }));
      const evaluation=evaluateInitiative(goalMetrics,asOf,initiative.ends_on,0.8,initiative.kind);
      // Save each changed daily evidence snapshot, even without a status transition.
      const sameTransition=graph.latest?.status===evaluation.status&&
        graph.latest?.recommendation===evaluation.recommendation;
      const transitionKey=sameTransition&&graph.latest?.transition_key?
        graph.latest.transition_key:
        createHash("sha256").update([
          initiative.id,graph.latest?.transition_key??"initial",asOf,
          evaluation.status,evaluation.recommendation,
        ].join(":")).digest("hex");
      // Replayable immutable snapshot: definitions, baseline and test day inputs.
      const inputs={asOf,endsOn:initiative.ends_on,kind:initiative.kind,
        minCoverage:0.8,metrics:[...goalMetrics].sort((a,b)=>a.id.localeCompare(b.id))};
      await persistInitiativeEvaluation(scope,initiative.id,asOf,
        evaluation.status,evaluation.recommendation,evaluation.results,inputs,transitionKey,token);
      // Retry an undelivered status notification independently. The M0 unique
      // dedupe key avoids a duplicate owner update if the first attempt succeeded.
      const t=translations[initiative.locale];
      assertBudget();
      const written=await writeTeamUpdate({
        businessId:initiative.business_id,ownerUserId:initiative.owner_user_id,
        domain,kind:"initiative_evaluation",
        severity:evaluation.status==="off_track"||evaluation.status==="missed"?"attention":"info",
        subjectType:"owner_initiative",subjectId:initiative.id,
        facts:{initiativeId:initiative.id,status:evaluation.status,
          recommendation:evaluation.recommendation,asOf,transitionKey},
        text:interpolate(t.evaluation,initiative.title,asOf)+" "+
          t.status[evaluation.status]+" — "+t.recommendation[evaluation.recommendation],
        locale:initiative.locale,actions:[{kind:"open"}],
        dedupeKey:"initiative:"+initiative.id+":transition:"+transitionKey,
      });
      if(written.created)stats.updates++;
      // Keep a 14-day correction window for delayed POS/timecard evidence.
      const testAttempted=graph.metrics.filter(metric=>metric.source==="computed").every(metric=>
        testDates.every(date=>(byMetric.get(metric.id)??[]).some(o=>o.business_date===date)));
      const baselineAttempted=graph.metrics.filter(metric=>metric.source==="computed").every(metric=>
        closestBaseline.every(date=>(byMetric.get(metric.id)??[]).some(o=>o.business_date===date)));
      completed=asOf>=initiative.ends_on&&today>dayOffset(initiative.ends_on,14)&&
        testAttempted&&baselineAttempted;
    }catch{stats.failed++;}
    finally{
      if(claim){
        try{await releaseMonitorInitiative(initiative.id,token,completed);}catch{stats.failed++;}
      }
    }
  }
  return stats;
}
