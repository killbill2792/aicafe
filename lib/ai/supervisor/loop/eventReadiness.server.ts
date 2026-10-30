import "server-only";
import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {readSavedTodayLive} from "@/lib/data/todayLive.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import type {OwnerLoopScope,LoopProposal} from "./engine";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {readCafeEvents,readEventChecklist} from "@/lib/data/cafeEvents.server";
import {readDailyFacts} from "@/lib/data/dailyFacts.server";
import {posFactReaders} from "@/lib/data/posFactReaders.server";
import {indexHourlyRevenue,compareEventDaySales,compareLiveEventSales} from "@/lib/metrics/core/eventReadiness";
import {cafeToday} from "@/lib/metrics/core/clock";
import {eventFinalNarrative,eventReportFactsHash,eventReportFallback,eventReportNumericEvidence}
  from "@/lib/events/eventFinalReport.server";
import {effectHash,registerLoopCapability,utcDateOffset} from "./engine";

const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoDay=z.iso.date();
const action=z.strictObject({
 area:z.enum(["staff","prep","ordering","promo","hours","operations"]),
 action:z.string().trim().min(3).max(240),
 reason:z.string().trim().min(3).max(300),
});
export const eventReadinessInput=z.strictObject({
 startDate:isoDay,endDate:isoDay,
 eventIds:z.array(z.uuid()).min(1).max(8),
 summary:z.string().trim().min(3).max(500),
 expectedBusyHours:z.array(z.strictObject({start:time,end:time})).max(8),
 actions:z.array(action).min(1).max(3),
});
const sourceFact=z.strictObject({
 id:z.uuid(),name:z.string(),kind:z.string(),startDate:isoDay,endDate:isoDay,
 venue:z.string().nullable(),areaLabel:z.string().nullable(),sourceUrl:z.string().nullable(),
 venueAddress:z.string().nullable().optional(),startTime:z.string().nullable().optional(),
 endTime:z.string().nullable().optional(),
});
export const eventReadinessEffect=eventReadinessInput.extend({
 facts:z.array(sourceFact).min(1).max(8),
 factsHash:z.string().regex(/^[a-f0-9]{64}$/),
});
export const eventReadinessCapabilityId="alex.event_readiness.v1";

/** Observation is permitted without approval; business effects are not.
 * Give the existing monitor loop a transient window for a saved event plan,
 * without calling commitLoop or changing its durable proposal status/revision.
 * Rejected/stale proposals and corrupt facts are never resurrected. */
export function readOnlyEventObservation(p:LoopProposal):LoopProposal|null{
  if(p.capabilityId!==eventReadinessCapabilityId||
    !["draft","approved","committed","manual_confirmed"].includes(p.status))return null;
  const parsed=eventReadinessEffect.safeParse(p.canonicalEffectPayload);
  if(!parsed.success||effectHash(parsed.data)!==p.effectHash)return null;
  const effect=parsed.data;
  const days=Math.round((Date.parse(effect.endDate)-Date.parse(effect.startDate))/86400000)+1;
  if(days<1||days>14||days!==p.monitorSpec.durationDays)return null;
  // This clone is for monitorLoop only; it is never persisted as a transition.
  return {...p,status:"committed",monitoringStartDate:effect.startDate};
}


// A scheduled run has no browser cookie. Only this server-side factory may mint
// a system scope, after checking current owner membership AND AI entitlement.
const approvedScheduledScopes=new WeakSet<object>();
export async function authorizedScheduledEventScope(scope:OwnerLoopScope):Promise<OwnerLoopScope>{
  const db=createAdminSupabaseClient();
  const [{data:member,error:memberError},{data:business,error:businessError}]=await Promise.all([
    db.from("memberships").select("role").eq("business_id",scope.businessId)
      .eq("user_id",scope.ownerUserId).maybeSingle(),
    db.from("businesses").select("timezone,is_demo").eq("id",scope.businessId).maybeSingle(),
  ]);
  if(memberError||businessError||member?.role!=="owner"||!business?.timezone||business.is_demo)
    throw new Error("owner_required");
  await assertCafeAiAccess(scope.businessId);
  approvedScheduledScopes.add(scope);
  return scope;
}

/** The same fact fingerprint at scan time and at proposal simulation time. */
export function eventPlanFacts(events:readonly import("@/lib/data/cafeEvents.server").CafeEvent[]){
  return events.filter(e=>e.status==="found").map(e=>({
    id:e.id,name:e.name,kind:e.kind,startDate:e.startDate,endDate:e.endDate,
    venue:e.venue,areaLabel:e.areaLabel,sourceUrl:e.sourceUrl,
    venueAddress:e.venueAddress,startTime:e.startTime,endTime:e.endTime,
  })).sort((a,b)=>a.id.localeCompare(b.id));
}


/** No new monitoring store: one sample per business day in supervisor_monitor_samples. */
export const eventReadinessCapability=registerLoopCapability({
 id:eventReadinessCapabilityId,version:1,
 inputSchema:eventReadinessInput,effectSchema:eventReadinessEffect,
 proposalDescription:"Draft an inert event-day readiness plan for owner approval using saved café event facts. No staff, purchasing or POS change is performed.",
 dependencyScope:effect=>({kind:"event_readiness",eventIds:effect.eventIds,start:effect.startDate,end:effect.endDate}),
 simulate:async(scope,input)=>{
   const system=approvedScheduledScopes.has(scope);
   const db=system?createAdminSupabaseClient():await createServerSupabaseClient();
   if(!system){
     const {data:{user}}=await db.auth.getUser();
     if(!user||user.id!==scope.ownerUserId||await getActiveBusinessId(user.id)!==scope.businessId)
       throw new Error("owner_required");
   }
   const [{data:member},{data:business}]=await Promise.all([
     db.from("memberships").select("role").eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle(),
     db.from("businesses").select("timezone,is_demo").eq("id",scope.businessId).maybeSingle(),
   ]);
   if(member?.role!=="owner"||!business?.timezone||business.is_demo)throw new Error("owner_required");
   if(system)await assertCafeAiAccess(scope.businessId);
   const today=cafeToday(business.timezone);
   const duration=Math.round((Date.parse(input.endDate)-Date.parse(input.startDate))/86400000)+1;
   if(input.startDate<today||duration<1||duration>14||
     input.startDate>utcDateOffset(today,90))throw new Error("invalid_event_window");
   if(new Set(input.eventIds).size!==input.eventIds.length||
     input.expectedBusyHours.some(h=>h.start>=h.end))throw new Error("invalid_event_plan");
   const found=(await readCafeEvents(db,scope.businessId,input.startDate,input.endDate))
     .filter(e=>input.eventIds.includes(e.id)&&e.status==="found");
   if(found.length!==input.eventIds.length)throw new Error("event_facts_unavailable");
   const facts=eventPlanFacts(found);
   return {effect:{...input,facts,factsHash:effectHash(facts)},
     baseline:{source:"cafe_events",eventNames:facts.map(f=>f.name),
       expectedBusyHours:input.expectedBusyHours,factsHash:effectHash(facts)},
     monitorSpec:{durationDays:duration,metricScope:"event_readiness:"+input.startDate}};
 },
 // A plan is inert even after approval. Date-scoped monitoring starts on the
 // event date, not on the day after approval (which may be weeks earlier).
 commit:async(_scope,effect)=>({status:"verified",evidenceSource:"event_readiness",
   monitoringStartDate:effect.startDate}),
 monitor:async(scope,effect,businessDate)=>{
   if(businessDate<effect.startDate||businessDate>effect.endDate)return null;
   const db=createAdminSupabaseClient();
   const {data:cafe,error:cafeError}=await db.from("businesses").select("timezone")
     .eq("id",scope.businessId).maybeSingle();
   if(cafeError||!cafe?.timezone)return null;
   const liveDay=formatInTimeZone(new Date(),cafe.timezone,"yyyy-MM-dd");
   const isLive=businessDate===liveDay;
   const saved=isLive?await readSavedTodayLive(db,scope.businessId):null;
   // A partial, old or mismatched reading cannot generate an owner alert.
   if(isLive&&(!saved||saved.value.businessDate!==businessDate||
     saved.ageMs>20*60_000||!Number.isFinite(Date.parse(saved.value.readAt))||
     Date.parse(saved.value.readAt)>Date.now()+60_000||saved.value.truncated||
     saved.value.unparsedOrders>0||saved.value.locationsFailed>0))return null;
   const from=utcDateOffset(businessDate,-56);
   const [days,hours,exclusions]=await Promise.all([
     readDailyFacts(db,scope.businessId,from,businessDate),
     posFactReaders(db,scope.businessId).peakHours({from,to:businessDate}),
     readCafeEvents(db,scope.businessId,from,utcDateOffset(businessDate,-1)),
   ]);
   const certified=days.filter(d=>d.salesDataStatus==="actual");
   const today=certified.find(d=>d.date===businessDate);
   // Finalized daily evidence always wins; never replace it with a live sample.
   if((isLive&&today)||(!isLive&&!today)||!hours.available||!hours.value)return null;
   const byDay=indexHourlyRevenue(hours.value.hours);
   if(hours.quality.missingInputs.some(x=>x==="hourlySalesPageLimit"||x==="hourlySalesUnavailable"))return null;
   const excluded=new Set(exclusions.filter(e=>e.status==="found").flatMap(e=>{
     const dates:string[]=[];
     for(let d=e.startDate;d<=e.endDate&&dates.length<90;d=utcDateOffset(d,1))dates.push(d);
     return dates;
   }));
   // One canonical usual-day definition, shared with get_nearby_events.
   // Missing hourly coverage only reduces the per-hour comparison sample.
   if(isLive&&saved){
     const time=formatInTimeZone(new Date(saved.value.readAt),cafe.timezone,"HH:mm");
     const throughHour=Number(time.slice(0,2));
     const comparison=compareLiveEventSales(certified,byDay,businessDate,
       saved.value.netSalesCents,throughHour,excluded);
     if(!comparison)return null;
     return {businessDate,source:"toast_today_live+hourly_sales_rollup+daily_rollups",
       observation:{coverage:"provisional",...comparison,asOf:saved.value.readAt,
         asOfLocal:time,partialCurrentHour:true}};
   }
   const comparison=compareEventDaySales(certified,byDay,businessDate,excluded);
   if(!comparison)return null;
   return {businessDate,source:"hourly_sales_rollup+daily_rollups",
     observation:{coverage:"actual",...comparison}};
 },
 report:async(scope,effect,samples,windowComplete,window)=>{
   const ticks=window?.proposalId?await readEventChecklist(
     createAdminSupabaseClient(),scope.businessId,window.proposalId):[];
   const checklist={total:effect.actions.length,
     done:ticks.filter(t=>t.state==="done").length,
     dismissed:ticks.filter(t=>t.state==="dismissed").length};
   const observed=samples.filter(s=>s.businessDate>=effect.startDate&&s.businessDate<=effect.endDate)
     .sort((a,b)=>a.businessDate.localeCompare(b.businessDate));
   const expected=Math.round((Date.parse(effect.endDate)-Date.parse(effect.startDate))/86400000)+1;
   const actual=observed.filter(s=>s.observation.coverage==="actual");
   const complete=windowComplete&&actual.length===expected&&
     actual.every(s=>typeof s.observation.typicalCents==="number");
   const live=!windowComplete?[...observed].reverse().find(s=>
     s.businessDate===window?.through&&s.observation.coverage==="provisional"):undefined;
   const o=live?.observation;
   const liveWatch=live&&o&&typeof o.asOf==="string"&&
     typeof o.asOfLocal==="string"&&typeof o.actualCents==="number"?
     {businessDate:live.businessDate,asOf:o.asOf,asOfLocal:o.asOfLocal,
       actualCents:o.actualCents,typicalCents:typeof o.typicalCents==="number"?o.typicalCents:null,
       changePercent:typeof o.changePercent==="number"?o.changePercent:null,
       baselineDays:typeof o.baselineDays==="number"?o.baselineDays:0,
       notable:o.notable===true,coverage:"provisional" as const,
       partialCurrentHour:true}:null;
   const copy=({en,es,ar} as const)[scope.locale].EventsPanel;
   const direction=liveWatch?.changePercent===null?null:
     liveWatch&&liveWatch.changePercent!==null?
     liveWatch.changePercent>=0?"liveAhead":"liveBehind":null;
   const hourEnd=liveWatch?liveWatch.asOfLocal.slice(0,2)+":59":null;
   const midRunText=liveWatch?.notable&&direction&&hourEnd?
     copy[direction].replace("{change}",String(Math.abs(liveWatch.changePercent!)))
       .replace("{time}",liveWatch.asOfLocal).replace("{hourEnd}",hourEnd):undefined;
   // The event monitor owns an existing Operations-task delivery contract.
   // Only notable live findings are delivered here; PR 7 owns final reports.
   const delivery=midRunText&&liveWatch&&hourEnd?{
     agentId:"alex" as const,taskKind:"event_plan" as const,
     entityType:"event_day",entityId:liveWatch.businessDate,confidence:"low" as const,
     payload:{businessDate:liveWatch.businessDate,asOf:liveWatch.asOf,
       asOfLocal:liveWatch.asOfLocal,note:midRunText,provisional:true,
       changePercent:liveWatch.changePercent,baselineDays:liveWatch.baselineDays,
       usualThroughHourEnd:hourEnd},
     evidence:[{source:"toast_today_live+hourly_sales_rollup",
       facts:{businessDate:liveWatch.businessDate,
         actualCents:liveWatch.actualCents,typicalCents:liveWatch.typicalCents,
         baselineDays:liveWatch.baselineDays,
         usualThroughHourEnd:hourEnd,partialCurrentHour:true}}],
     threadText:midRunText,
   }:undefined;
   const status=!windowComplete?"in_progress":complete?"complete":"insufficient_evidence";
   const result={
     eventIds:effect.eventIds,startDate:effect.startDate,endDate:effect.endDate,
     factsHash:effect.factsHash,observedDays:actual.length,expectedDays:expected,
     checklist,liveWatch,
     missingBaselineDays:actual.filter(s=>s.observation.typicalCents===null).map(s=>s.businessDate),
     days:actual.map(s=>({date:s.businessDate,...s.observation})),
     caveat:"Comparison is observational, not evidence that an event caused a change.",
   };
   // Keep PR 6's live reporting and PR 7's final report in the same canonical loop.
   const terminal=windowComplete&&Boolean(window?.proposalId);
   const narrative=terminal&&window?.proposalId
     ?await eventFinalNarrative(scope,window.proposalId,effect.facts.map(f=>f.name),
       effect.summary,result,status==="complete"?"complete":"insufficient_evidence")
     :null;
   const reportText=narrative?.text??(terminal?eventReportFallback(scope.locale,result):null);
   const provenance=narrative?.provenance??[];
   const factsHash=eventReportFactsHash(result,status,effect.summary,effect.facts.map(f=>f.name));
   const finalDelivery=terminal&&reportText?{
     agentId:"alex" as const,taskKind:"event_plan" as const,
     entityType:"event_day",entityId:effect.startDate,
     confidence:status==="complete"?"high" as const:"low" as const,
     payload:{itemName:effect.summary,businessDate:effect.startDate,
       eventReport:true,outcomeStatus:status,text:reportText},
     evidence:[{source:"hourly_sales_rollup+daily_rollups",
       facts:{observedDays:actual.length,expectedDays:expected,
         doneActions:checklist.done,totalActions:checklist.total,nonCausal:true}}],
     numberProvenance:provenance,numericEvidence:eventReportNumericEvidence(result),
     threadText:reportText,
   }:undefined;
   return {status,midRunText,midRunKey:liveWatch?.businessDate,
     delivery:finalDelivery??delivery,
     recommendation:"adjust",source:"hourly_sales_rollup+daily_rollups",
     result:{...result,...(reportText?{reportText,reportFactsHash:factsHash,
       reportTextOrigin:narrative?"model":"facts",reportProvenance:provenance,
       reportNumericEvidence:eventReportNumericEvidence(result)}:{})}};

 },
});
