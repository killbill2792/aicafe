import "server-only";
import {simulationOwnerReader} from "./simulationOwner.server";
import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {readSavedTodayLive} from "@/lib/data/todayLive.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import type {OwnerLoopScope,LoopProposal} from "./engine";
import {readCafeEvents,readEventChecklist} from "@/lib/data/cafeEvents.server";
import {readDailyFacts} from "@/lib/data/dailyFacts.server";
import {readItemSales,readDiscounts,readLaborEntries,readMenu} from "@/lib/data/canonical/reads.server";
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


/** One canonical monitored plan per event-day. A committed owner choice wins over
 * an unapproved revised draft; reruns never generate parallel report threads. */
export function selectEventObservations(proposals:readonly LoopProposal[],
  observedIds:ReadonlySet<string>=new Set()):LoopProposal[]{
  const priority=(p:LoopProposal)=>{
    // Once a day's monitor has emitted a sample, its proposal ID is sticky.
    // Changing draft facts cannot create a second mid-run notice/inbox thread.
    if(observedIds.has(p.id))return 10;
    return p.status==="committed"||p.status==="manual_confirmed"?2:
      p.status==="approved"?1:0;
  };
  const chosen=new Map<string,LoopProposal>();
  for(const original of [...proposals].sort((a,b)=>
    priority(b)-priority(a)||b.createdAt.localeCompare(a.createdAt)||
    b.id.localeCompare(a.id))){
    const observation=readOnlyEventObservation(original);
    if(!observation)continue;
    const start=observation.monitoringStartDate!;
    if(!chosen.has(start))chosen.set(start,observation);
  }
  return [...chosen.values()];
}
/** Bounded, persisted monitor identity, shared by the live and report crons.
 * Fail closed when it cannot be read: guessing a new ID can duplicate notices. */
export async function observedEventProposalIds(
  db:ReturnType<typeof createAdminSupabaseClient>,businessId:string,
  ids:readonly string[]):Promise<Set<string>>{
  if(!ids.length)return new Set();
  const found=new Set<string>();
  const unique=[...new Set(ids)].slice(0,100);
  // One event proposal has at most 14 observed business days. Chunks of 40
  // cannot silently hit the canonical 1,000-row provider cap.
  for(let i=0;i<unique.length;i+=40){
    const {data,error}=await db.from("supervisor_monitor_samples")
      .select("proposal_id").eq("business_id",businessId)
      .in("proposal_id",unique.slice(i,i+40)).limit(1000);
    if(error||!data)throw new Error("Event monitoring history unavailable");
    for(const row of data)found.add(row.proposal_id as string);
  }
  return found;
}

/** Read the already canonicalized, café-scoped Toast evidence only.
 * A named promotion and a bundled menu item are distinct from generic sales
 * or an order-level discount total; neither proves that physical work occurred. */
export async function eventToastEvidence(db:ReturnType<typeof createAdminSupabaseClient>,
  businessId:string,day:string,
  actions:readonly {area:string;action:string}[]=[]){
  const range={dateFrom:day,dateTo:day};
  const [items,discounts,shifts,menu]=await Promise.all([
    readItemSales(db,businessId,range),
    readDiscounts(db,businessId,range),
    readLaborEntries(db,businessId,range),
    readMenu(db,businessId,range),
  ]);
  const unavailable=(v:{error?:string;truncated:boolean})=>Boolean(v.error||v.truncated);
  const itemRows=items.rows.filter(r=>r.source==="toast"&&r.status==="actual");
  const menuNames=new Set(menu.rows.filter(r=>r.source==="toast"&&r.status==="actual")
    .map(r=>(r.data as {name?:unknown}|null)?.name)
    .filter((v):v is string=>typeof v==="string"));
  const sold=itemRows.flatMap(r=>{
    const data=r.data as {name?:unknown;quantity?:unknown}|null;
    return typeof data?.name==="string"&&
      typeof data.quantity==="number"&&Number.isFinite(data.quantity)&&
      data.quantity>0&&menuNames.has(data.name)
      ?[{name:data.name,quantity:data.quantity}]:[];
  });
  // The current canonical view includes typed *check* and *item* discounts.
  // Empty/malformed names are not evidence of an applied named promotion.
  const recordedDiscounts=discounts.rows.filter(r=>r.source==="toast"&&
    r.status==="actual"&&typeof r.amount_cents==="number");
  const names=new Set<string>();
  for(const row of recordedDiscounts){
    for(const value of [row.check_discounts,row.item_discounts]){
      if(!Array.isArray(value))continue;
      for(const entry of value){
        if(!entry||typeof entry!=="object")continue;
        const d=entry as {name?:unknown;amountCents?:unknown};
        const name=typeof d.name==="string"?d.name.trim():"";
        if(name&&name.length<=120&&typeof d.amountCents==="number"&&
          Number.isSafeInteger(d.amountCents)&&d.amountCents>0)names.add(name);
      }
    }
  }
  const normalized=(value:string)=>value.trim().replace(/\\s+/g," ").toLocaleLowerCase("en-US");
  const plannedPromotion=actions.filter(a=>a.area==="promo")
    .map(a=>normalized(a.action));
  const matches=(name:string)=>plannedPromotion.some(action=>
    name.length>=4&&action.includes(normalized(name)));
  const matchedDiscounts=[...names].filter(matches);
  const matchedCombos=sold.map(r=>r.name).filter(name=>
    /\\b(combo|bundle|meal deal)\\b/i.test(name)&&matches(name));
  // A wage classification is independent of a recorded closed timecard.
  // "needs_match" and "estimated" wages remain valid attendance facts.
  const labor=shifts.rows.filter(r=>{
    if(r.source!=="toast")return false;
    const data=r.data as {clock_in?:unknown;clock_out?:unknown}|null;
    return ["actual","estimated","needs_match"].includes(String(r.status))&&
      typeof data?.clock_in==="string"&&typeof data.clock_out==="string";
  });
  const openLabor=shifts.rows.some(r=>r.source==="toast"&&r.status==="open");
  const partialLabor=unavailable(shifts)||openLabor;
  return {
    itemSales:{coverage:unavailable(items)||unavailable(menu)?"partial" as const:
      sold.length?"verified" as const:"missing" as const,items:sold.slice(0,8)},
    namedDiscounts:{coverage:unavailable(discounts)?"partial" as const:
      names.size?"verified" as const:"missing" as const,
      names:[...names].slice(0,8),matchedRecommendationNames:matchedDiscounts.slice(0,8)},
    discountAmounts:{coverage:unavailable(discounts)?"partial" as const:
      recordedDiscounts.length?"verified" as const:"missing" as const,
      observedOrders:recordedDiscounts.length},
    laborEntries:{coverage:partialLabor?"partial" as const:
      labor.length?"verified" as const:"missing" as const,
      recordedShifts:labor.length,
      wageCoverage:partialLabor||labor.some(r=>r.status!=="actual")?
        "partial" as const:labor.length?"verified" as const:"missing" as const},
    recommendedComboImplemented:matchedCombos.length?"verified" as const:"unverified" as const,
    recommendedDiscountImplemented:matchedDiscounts.length?
      "verified" as const:"unverified" as const,
    physicalPreparationImplemented:"unverified" as const,
  };
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
   const db=system?createAdminSupabaseClient():(await simulationOwnerReader(scope)).client;
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
   // A completed business day can have actual sales but missing item/discount
   // details. Keep that distinction in the same saved Supervisor report.
   const toastEvidence=windowComplete&&window?.proposalId?await Promise.resolve()
     .then(()=>eventToastEvidence(createAdminSupabaseClient(),
       scope.businessId,effect.endDate,effect.actions)).catch(()=>({
       itemSales:{coverage:"missing" as const,items:[]},
       namedDiscounts:{coverage:"missing" as const,names:[],
         matchedRecommendationNames:[]},
       discountAmounts:{coverage:"missing" as const,observedOrders:0},
       laborEntries:{coverage:"missing" as const,recordedShifts:0,
         wageCoverage:"missing" as const},
       recommendedComboImplemented:"unverified" as const,
       recommendedDiscountImplemented:"unverified" as const,
       physicalPreparationImplemented:"unverified" as const,
     })):null;
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
     checklist,liveWatch,toastEvidence,
     missingBaselineDays:actual.filter(s=>s.observation.typicalCents===null).map(s=>s.businessDate),
     days:actual.map(s=>({date:s.businessDate,...s.observation})),
     caveat:"Event-day sales are observational, not proof of event causality. Recorded item sales, discount totals and staff timecards do not prove a proposed combo, discount or physical preparation was implemented; owner checklist markers are not POS evidence.",
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
