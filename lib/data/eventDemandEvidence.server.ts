import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readDailyFacts} from "./dailyFacts.server";
import {readToastDayTrust} from "./toastDayTrust.server";
import {posFactReaders} from "./posFactReaders.server";
import {readCafeEvents} from "./cafeEvents.server";
import {readSavedTodayLive} from "./todayLive.server";
import {loadOwnerFacts} from "@/lib/ownerFacts/store.server";
import {readOwnerProposals,readOwnerReports,type OwnerScope} from
  "@/lib/ai/supervisor/loop/reads.server";
import {assembleEventDemandEvidence,checkedEventDemandRequest,eventDemandWindow,
  relevantEventDemandProposals,type EventDemandRequest,type EventDemandEvidence,
  type EventDemandSample} from "@/lib/events/eventDemandEvidence";

/** PR F handoff: read-only, owner-authorized composite performance evidence.
 * The db is the existing authorized server client's DB; scope is NEVER picked
 * by the model. This function checks owner membership even with a service-role
 * client and scopes EVERY private read to the same business and owner. */
export async function readEventDemandEvidence(db:SupabaseClient,scope:OwnerScope,
  request:EventDemandRequest):Promise<EventDemandEvidence>{
  checkedEventDemandRequest(request);
  if(!scope.businessId||!scope.ownerUserId)throw new Error("event_evidence_owner_required");
  const owner=await db.from("memberships").select("role")
    .eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle();
  if(owner.error||owner.data?.role!=="owner")throw new Error("event_evidence_owner_required");
  const period=eventDemandWindow(request);
  const isToday=request.eventDate===request.asOfDate;
  // Source failures are explicitly incomplete, not zero sales or no outcomes.
  // All services below are existing canonical readers; there are no writes.
  const [days,hours,baselineEvents,dayEvents,proposals,facts,live,trust]=
    await Promise.allSettled([
      readDailyFacts(db,scope.businessId,period.from,period.dailyThrough),
      posFactReaders(db,scope.businessId).peakHours({from:period.from,to:period.through}),
      readCafeEvents(db,scope.businessId,period.from,period.through),
      readCafeEvents(db,scope.businessId,request.eventDate,request.eventDate),
      readOwnerProposals(db,scope,{capabilityId:"alex.event_readiness.v1",limit:200}),
      loadOwnerFacts(scope.businessId,db),
      isToday?readSavedTodayLive(db,scope.businessId):Promise.resolve(null),
      readToastDayTrust(db,scope.businessId,period.from,period.through),
    ] as const);
  const ok=<T>(value:PromiseSettledResult<T>,fallback:T):T=>
    value.status==="fulfilled"?value.value:fallback;
  const missing:string[]=[],caveats:string[]=[];
  if(days.status==="rejected")missing.push("daily_sales_unavailable");
  if(hours.status==="rejected")missing.push("hourly_source_unavailable");
  if(baselineEvents.status==="rejected")missing.push("baseline_event_exclusions_unavailable");
  if(baselineEvents.status==="fulfilled"&&baselineEvents.value.length===500)
    caveats.push("baseline_events_bounded");
  if(dayEvents.status==="rejected")missing.push("same_day_event_context_unavailable");
  if(dayEvents.status==="fulfilled"&&dayEvents.value.length===500)
    caveats.push("same_day_events_bounded");
  if(proposals.status==="rejected")missing.push("prior_event_plans_unavailable");
  if(facts.status==="rejected")missing.push("owner_facts_unavailable");
  if(live.status==="rejected")caveats.push("today_live_unavailable");
  if(trust.status==="rejected")caveats.push("toast_day_trust_unavailable");
  if(trust.status==="fulfilled"){
    missing.push(...trust.value.quality);
    caveats.push(...trust.value.notes);
  }
  const hourly=ok(hours,null);
  if(hourly){
    missing.push(...hourly.quality.missingInputs);
    caveats.push(...(hourly.quality.notes??[]));
    if(!hourly.available||!hourly.value)missing.push("hourly_source_unavailable");
  }
  const plans=ok(proposals,[]);
  if(plans.length===200)caveats.push("prior_event_plan_history_bounded");
  const relevant=relevantEventDemandProposals(plans,request);
  const reportCandidates=relevant.filter(p=>p.end<request.eventDate).slice(0,24);
  const sampleCandidates=[...reportCandidates.slice(0,8),
    ...relevant.filter(p=>p.start<=request.eventDate&&p.end>=request.eventDate).slice(0,2)];
  const ids=[...new Set(reportCandidates.map(p=>p.proposal.id))];
  const sampleIds=[...new Set(sampleCandidates.map(p=>p.proposal.id))];
  const [reports,samples]=await Promise.allSettled([
    readOwnerReports(db,scope,ids,{statuses:["complete","insufficient_evidence"],limit:24}),
    sampleIds.length?db.from("supervisor_monitor_samples")
      .select("proposal_id,business_date,observation,evidence_source")
      .eq("business_id",scope.businessId).in("proposal_id",sampleIds)
      .lte("business_date",request.asOfDate).order("business_date").limit(500):
      Promise.resolve({data:[] as EventDemandSample[],error:null}),
  ]);
  if(reports.status==="rejected")missing.push("prior_event_reports_unavailable");
  if(samples.status==="rejected"||samples.status==="fulfilled"&&samples.value.error)
    missing.push("supervisor_monitor_samples_unavailable");
  if(samples.status==="fulfilled"&&samples.value.data?.length===500)
    caveats.push("supervisor_monitor_samples_bounded");
  const prior=ok(reports,[]);
  const sampleRows=samples.status==="fulfilled"&&!samples.value.error?
    (samples.value.data??[]) as EventDemandSample[]:[];
  const saved=ok(live,null);
  return assembleEventDemandEvidence(request,{
    daily:ok(days,[]),hourly:hourly?.available&&hourly.value?hourly.value.hours:[],
    baselineEvents:ok(baselineEvents,[]),dayEvents:ok(dayEvents,[]),
    proposals:plans,reports:prior,samples:sampleRows,ownerFacts:ok(facts,[]),
    live:saved?{netSalesCents:saved.value.netSalesCents,businessDate:saved.value.businessDate,
      readAt:saved.value.readAt,ageMs:saved.ageMs,truncated:saved.value.truncated,
      unparsedOrders:saved.value.unparsedOrders,locationsFailed:saved.value.locationsFailed}:null,
    missing,caveats,
  });
}
