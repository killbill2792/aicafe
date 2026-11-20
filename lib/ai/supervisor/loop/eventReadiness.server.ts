import "server-only";
import {randomUUID} from "node:crypto";
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
import {readCafeEvents,readCanonicalCafeEvents,readExactCafeEvent,readEventChecklist,type CafeEvent} from "@/lib/data/cafeEvents.server";
import {readDailyFacts} from "@/lib/data/dailyFacts.server";
import {readItemSales,readDiscounts,readLaborEntries,readMenu} from "@/lib/data/canonical/reads.server";
import {posFactReaders} from "@/lib/data/posFactReaders.server";
import {indexHourlyRevenue,compareEventDaySales,compareLiveEventSales} from "@/lib/metrics/core/eventReadiness";
import {cafeToday} from "@/lib/metrics/core/clock";
import {typicalDaySales,changePercent,type OutlookSalesDay} from "@/lib/metrics/core/dayOutlook";
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
 importance:z.enum(["high","medium","low"]).optional(),
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
 observationWindow:z.object({inactiveDates:z.array(isoDay).max(366),closeEarly:z.boolean()}).optional(),
});
export const eventReadinessCapabilityId="alex.event_readiness.v1";

/** Serialize live, close-day and owner-triggered event observations using the
 * same existing handled task ledger and a token-fenced release. */
export async function withEventObservationClaim<T>(db:ReturnType<typeof createAdminSupabaseClient>,
 scope:OwnerLoopScope,p:LoopProposal,day:string,work:()=>Promise<T>){
 const token=randomUUID();
 const closure=Boolean(p.monitoringStartDate&&day>utcDateOffset(p.monitoringStartDate,p.monitorSpec.durationDays-1));
 const args={p_business_id:scope.businessId,p_proposal_id:p.id,p_day:day,p_token:token,p_closure:closure};
 const claimed=await db.rpc("ldi_claim_monitor",{...args,p_owner_id:scope.ownerUserId});
 if(claimed.error)throw claimed.error;
 if(claimed.data!==true)return null;
 try{return await work();}finally{
  const release=await db.rpc("ldi_release_monitor",args);
  if(release.error)throw release.error;
 }
}

/** Observation is permitted without approval; business effects are not.
 * Give the existing monitor loop a transient window for a saved event plan,
 * without calling commitLoop or changing its durable proposal status/revision.
 * Rejected/stale proposals and corrupt facts are never resurrected. */
export function readOnlyEventObservation(p:LoopProposal,current?:ReadonlyMap<string,CafeEvent>,today?:string,timezone="UTC"):LoopProposal|null{
  if(p.capabilityId!==eventReadinessCapabilityId||
    !["draft","approved","committed","manual_confirmed"].includes(p.status))return null;
  const parsed=eventReadinessEffect.safeParse(p.canonicalEffectPayload);
  if(!parsed.success||effectHash(parsed.data)!==p.effectHash)return null;
  const effect=parsed.data;
  const days=Math.round((Date.parse(effect.endDate)-Date.parse(effect.startDate))/86400000)+1;
  if(days<1||days>14||days!==p.monitorSpec.durationDays)return null;
  // A single occurrence retains its one reporting identity beyond the bounded
  // preparation plan. This projection is never an approved or executable effect.
  if(effect.eventIds.length===1&&effect.facts.length===1){
    const event=current?.get(effect.eventIds[0]);
    const fact=effect.facts[0];
    const start=event&&event.startDate<effect.startDate?event.startDate:effect.startDate;
    const end=[effect.endDate,fact.endDate,...(event?[event.endDate]:[])].sort().at(-1)!;
    const duration=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
    if(duration>=1&&duration<=366){
      const inactiveDates:string[]=[];
      if(event&&today){
        for(let day=start;day<=end;day=utcDateOffset(day,1)){
          if(day>=today&&(event.status!=="found"||day<event.startDate||day>event.endDate))inactiveDates.push(day);
        }
      }
      const closeEarly=Boolean(event&&today&&event.lastVerifiedAt&&
        (event.status!=="found"||event.endDate<today)&&end>=today&&
        eventStatusAtBusinessDay(event,today,timezone)!=="found"||event&&today&&event.lastVerifiedAt&&event.endDate<today&&end>=today);
      if(duration!==days||start!==effect.startDate||inactiveDates.length){
        const projected=eventReadinessEffect.parse({...effect,startDate:start,endDate:end,observationWindow:{inactiveDates,closeEarly}});
        return {...p,status:"committed",monitoringStartDate:start,monitorSpec:{...p.monitorSpec,durationDays:duration},
          canonicalEffectPayload:projected,effectHash:effectHash(projected)};
      }
    }
  }
  return {...p,status:"committed",monitoringStartDate:effect.startDate};
}


/** One canonical monitored plan per event-day. A committed owner choice wins over
 * an unapproved revised draft; reruns never generate parallel report threads. */
export function selectEventObservations(proposals:readonly LoopProposal[],
  observedIds:ReadonlySet<string>=new Set(),businessDate?:string,
  sampledOnDate:ReadonlySet<string>=new Set(),current?:ReadonlyMap<string,CafeEvent>,today?:string,timezone="UTC"):LoopProposal[]{
  const priority=(p:LoopProposal)=>{
    // Once a day's monitor has emitted a sample, its proposal ID is sticky.
    // Changing draft facts cannot create a second mid-run notice/inbox thread.
    if(sampledOnDate.has(p.id))return 20;
    if(observedIds.has(p.id))return 10;
    return p.status==="committed"||p.status==="manual_confirmed"?2:
      p.status==="approved"?1:0;
  };
  const chosen=new Map<string,LoopProposal>();
  for(const original of [...proposals].sort((a,b)=>
    priority(b)-priority(a)||b.monitorSpec.durationDays-a.monitorSpec.durationDays||b.createdAt.localeCompare(a.createdAt)||
    b.id.localeCompare(a.id))){
    const observation=readOnlyEventObservation(original,current,today,timezone);
    if(!observation)continue;
    const start=observation.monitoringStartDate!;
    if(businessDate){
      if(businessDate<start||businessDate>utcDateOffset(start,observation.monitorSpec.durationDays-1))continue;
      // Sales are café-day facts, not per-event sales. One primary window owns
      // the date even if multiple events and approvals overlap.
      const key=observation.businessId+"|"+businessDate;
      if(!chosen.has(key))chosen.set(key,observation);
    }else if(!chosen.has(start))chosen.set(start,observation);
  }
  return [...chosen.values()];
}
/** Bounded, persisted monitor identity, shared by the live and report crons.
 * Fail closed when it cannot be read: guessing a new ID can duplicate notices. */
export async function observedEventProposalDates(
  db:ReturnType<typeof createAdminSupabaseClient>,businessId:string,
  ids:readonly string[]):Promise<{ids:Set<string>;byDate:Map<string,Set<string>>}>{
  const found=new Set<string>(),byDate=new Map<string,Set<string>>();
  if(!ids.length)return {ids:found,byDate};
  const unique=[...new Set(ids)].slice(0,100);
  // An extended occurrence can have 366 samples; two IDs stay below the provider cap.
  for(let i=0;i<unique.length;i+=2){
    const {data,error}=await db.from("supervisor_monitor_samples")
      .select("proposal_id,business_date").eq("business_id",businessId)
      .in("proposal_id",unique.slice(i,i+2)).limit(1000);
    if(error||!data||data.length>=1000)throw new Error("Event monitoring history unavailable");
    for(const row of data){
      const id=String(row.proposal_id);found.add(id);
      if(typeof row.business_date!=="string")continue;
      const dates=byDate.get(row.business_date)??new Set<string>();
      dates.add(id);byDate.set(row.business_date,dates);
    }
  }
  return {ids:found,byDate};
}
export async function observedEventProposalIds(db:ReturnType<typeof createAdminSupabaseClient>,
  businessId:string,ids:readonly string[]):Promise<Set<string>>{
  return (await observedEventProposalDates(db,businessId,ids)).ids;
}

/** Read the already canonicalized, café-scoped Toast evidence only.
 * A named promotion and a bundled menu item are distinct from generic sales
 * or an order-level discount total; neither proves that physical work occurred. */
export async function eventToastEvidence(db:ReturnType<typeof createAdminSupabaseClient>,
  businessId:string,day:string,
  actions:readonly {area:string;action:string}[]=[],through=day){
  const range={dateFrom:day,dateTo:through};
  const [items,discounts,shifts,menu]=await Promise.all([
    readItemSales(db,businessId,range).catch(()=>({rows:[],truncated:true,error:"unavailable"})),
    readDiscounts(db,businessId,range).catch(()=>({rows:[],truncated:true,error:"unavailable"})),
    readLaborEntries(db,businessId,range).catch(()=>({rows:[],truncated:true,error:"unavailable"})),
    readMenu(db,businessId,range).catch(()=>({rows:[],truncated:true,error:"unavailable"})),
  ]);
  const unavailable=(v:{error?:string;truncated:boolean})=>Boolean(v.error||v.truncated);
  const itemRows=items.rows.filter(r=>r.source==="toast"&&r.status==="actual");
  const menuNames=new Set(menu.rows.filter(r=>r.source==="toast"&&r.status==="actual")
    .map(r=>(r.data as {name?:unknown}|null)?.name)
    .filter((v):v is string=>typeof v==="string"));
  const soldRows=itemRows.flatMap(r=>{
    const data=r.data as {name?:unknown;quantity?:unknown}|null;
    return typeof data?.name==="string"&&
      typeof data.quantity==="number"&&Number.isFinite(data.quantity)&&
      data.quantity>0&&menuNames.has(data.name)
      ?[{name:data.name,quantity:data.quantity}]:[];
  });
  const quantities=new Map<string,number>();
  for(const item of soldRows)quantities.set(item.name,(quantities.get(item.name)??0)+item.quantity);
  const sold=[...quantities].map(([name,quantity])=>({name,quantity}))
    .sort((a,b)=>b.quantity-a.quantity||a.name.localeCompare(b.name));
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


/** A scheduled assessment may propose any non-empty SUBSET of the confirmed
 * events for this café-local day. Reject races, foreign UUIDs, stale or cancelled
 * facts; the city catalog is not modified by selecting a subset. */
export function selectedEventPlanFacts(
  original:readonly import("@/lib/data/cafeEvents.server").CafeEvent[],
  current:readonly import("@/lib/data/cafeEvents.server").CafeEvent[],
  date:string,originalDayHash:string,ids:readonly string[]
){
  const batchIds=new Set(original.map(e=>e.id));
  const currentDay=current.filter(e=>batchIds.has(e.id)&&e.status==="found"&&
    e.startDate<=date&&e.endDate>=date).sort((a,b)=>a.id.localeCompare(b.id));
  const initial=original.filter(e=>e.status==="found"&&
    e.startDate<=date&&e.endDate>=date).sort((a,b)=>a.id.localeCompare(b.id));
  if(effectHash(eventPlanFacts(currentDay))!==originalDayHash||
    effectHash(eventPlanFacts(initial))!==originalDayHash||
    !ids.length||ids.length>8||initial.length>8||new Set(ids).size!==ids.length)
    throw new Error("event_facts_changed");
  const selected=currentDay.filter(e=>ids.includes(e.id));
  if(selected.length!==ids.length)throw new Error("event_facts_changed");
  return eventPlanFacts(selected);
}

/** A closed-day POS total is still evidence when hourly details are missing. */
export function eventDailyOnlyComparison(days:readonly OutlookSalesDay[],date:string,
  excluded:ReadonlySet<string>|null){
  const day=days.find(d=>d.date===date);
  if(!day||!Number.isSafeInteger(day.netSalesCents))return null;
  const base=excluded?typicalDaySales(days,date,date,{exclude:excluded}):null;
  const typicalCents=base?.typicalCents??null;
  return {actualCents:day.netSalesCents,typicalCents,
    changePercent:typicalCents===null?null:changePercent(day.netSalesCents,typicalCents),
    baselineDays:base?.sampleDays??0,hours:[],hourlyCoverage:"missing" as const};
}

/** Reconstruct the saved occurrence status at the end of a café-local date.
 * Verification time is knowledge, not an invented event cancellation time.
 * A change on that date is conservatively treated as no confirmed active day.
 * The original approval and all ordinary POS records remain untouched. */
export function eventWindowAtBusinessDay(event:CafeEvent,day:string,timezone:string){
  const detail=event.verificationDetails;
  const current={status:event.status,startDate:event.startDate,endDate:event.endDate};
  if(!detail||typeof detail!=="object"||Array.isArray(detail))return current;
  const d=detail as {history?:unknown[];change?:unknown};
  const history=(Array.isArray(d.history)?d.history:d.change?[d.change]:[]).flatMap(value=>{
    if(!value||typeof value!=="object")return [];
    const row=value as {verifiedAt?:unknown;status?:unknown;previousStatus?:unknown;previousStartDate?:unknown;previousEndDate?:unknown;newDate?:unknown;newEndDate?:unknown};
    const valid=(s:unknown):s is CafeEvent["status"]=>s==="found"||s==="cancelled"||s==="moved";
    if(typeof row.verifiedAt!=="string"||!Number.isFinite(Date.parse(row.verifiedAt))||
      !valid(row.status)||!valid(row.previousStatus))return [];
    return [{...row,verifiedAt:row.verifiedAt,status:row.status,previousStatus:row.previousStatus}];
  }).sort((a,b)=>Date.parse(a.verifiedAt)-Date.parse(b.verifiedAt));
  if(!history.length)return current;
  let status=history[0].previousStatus;
  let startDate=typeof history[0].previousStartDate==="string"?history[0].previousStartDate:event.startDate;
  let endDate=typeof history[0].previousEndDate==="string"?history[0].previousEndDate:event.endDate;
  for(const change of history){
    if(formatInTimeZone(new Date(change.verifiedAt),timezone,"yyyy-MM-dd")>day)break;
    status=change.status;
    if(typeof change.newEndDate==="string"){
      if(typeof change.newDate==="string")startDate=change.newDate;
      endDate=change.newEndDate;
    }
  }
  return {status,startDate,endDate};
}
export function eventStatusAtBusinessDay(event:CafeEvent,day:string,timezone:string):CafeEvent["status"]{
 return eventWindowAtBusinessDay(event,day,timezone).status;
}
export function eventDayActivity(events:readonly (CafeEvent|null)[],day:string,timezone:string){
  if(events.some(event=>{
    if(!event)return false;
    const range=eventWindowAtBusinessDay(event,day,timezone);
    return range.startDate<=day&&range.endDate>=day&&range.status==="found";
  }))return "active" as const;
  return events.some(event=>event===null)?"unconfirmed" as const:"inactive" as const;
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
   const found=(await readCanonicalCafeEvents(db,scope.businessId,input.startDate,input.endDate))
     .filter(e=>input.eventIds.includes(e.id)&&e.status==="found");
   if(found.length!==input.eventIds.length||
     found.some(e=>e.startDate>input.startDate||e.endDate<input.endDate))
     throw new Error("event_facts_unavailable");
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
   // The stored plan is historical approval evidence, not current event truth.
   // Read the exact IDs before reading any sales, including beyond compact UI lists.
   const events=await Promise.all(effect.eventIds.map(id=>
     readExactCafeEvent(db,scope.businessId,id,businessDate,businessDate,{historical:true})));
   const activity=eventDayActivity(events,businessDate,cafe.timezone);
   if(activity!=="active")return isLive?null:{businessDate,source:"cafe_events",
     observation:{coverage:"event_inactive",eventActivity:activity}};
   const saved=isLive?await readSavedTodayLive(db,scope.businessId):null;
   // A partial, old or mismatched reading cannot generate an owner alert.
   if(isLive&&(!saved||saved.value.businessDate!==businessDate||
     saved.ageMs>20*60_000||!Number.isFinite(Date.parse(saved.value.readAt))||
     Date.parse(saved.value.readAt)>Date.now()+60_000||saved.value.truncated||
     saved.value.unparsedOrders>0||saved.value.locationsFailed>0))return null;
   const from=utcDateOffset(businessDate,-56);
   const [days,hours,exclusions]=await Promise.all([
     readDailyFacts(db,scope.businessId,from,businessDate),
     Promise.resolve().then(()=>posFactReaders(db,scope.businessId).peakHours({from,to:businessDate})).catch(()=>null),
     readCanonicalCafeEvents(db,scope.businessId,from,utcDateOffset(businessDate,-1)).catch(()=>null),
   ]);
   const certified=days.filter(d=>d.salesDataStatus==="actual");
   const today=certified.find(d=>d.date===businessDate);
   // Finalized daily evidence always wins; never replace it with a live sample.
   if((isLive&&today)||(!isLive&&!today))return null;
   const byDay=hours?.available&&hours.value&&
     !hours.quality.missingInputs.some(x=>x==="hourlySalesPageLimit"||x==="hourlySalesUnavailable")
     ?indexHourlyRevenue(hours.value.hours):null;
   const excluded=exclusions?new Set(exclusions.filter(e=>e.status==="found").flatMap(e=>{
     const dates:string[]=[];
     for(let d=e.startDate;d<=e.endDate&&dates.length<90;d=utcDateOffset(d,1))dates.push(d);
     return dates;
   })):null;
   // One canonical usual-day definition, shared with get_nearby_events.
   // Missing hourly coverage only reduces the per-hour comparison sample.
   if(isLive&&saved){
     const time=formatInTimeZone(new Date(saved.value.readAt),cafe.timezone,"HH:mm");
     const throughHour=Number(time.slice(0,2));
     const comparison=byDay&&excluded?compareLiveEventSales(certified,byDay,businessDate,
       saved.value.netSalesCents,throughHour,excluded):null;
     return {businessDate,source:comparison?"toast_today_live+hourly_sales_rollup+daily_rollups":"toast_today_live",
       observation:{coverage:"provisional",...(comparison??{actualCents:saved.value.netSalesCents,
         typicalCents:null,changePercent:null,baselineDays:0,notable:false,hourlyCoverage:"missing"}),asOf:saved.value.readAt,
         asOfLocal:time,partialCurrentHour:true}};
   }
   const hourly=byDay&&excluded?compareEventDaySales(certified,byDay,businessDate,excluded):null;
   const comparison=hourly??eventDailyOnlyComparison(certified,businessDate,excluded);
   if(!comparison)return null;
   return {businessDate,source:hourly?"hourly_sales_rollup+daily_rollups":"daily_rollups",
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
   const actual=[...new Map(observed.filter(s=>s.observation.coverage==="actual")
     .map(s=>[s.businessDate,s])).values()];
   // Compare matched days only. A missing day is not a zero-sales day and
   // an observed total must not masquerade as the complete event total.
   const measured=actual.filter(s=>typeof s.observation.actualCents==="number"&&
     Number.isSafeInteger(s.observation.actualCents));
   const comparable=measured.filter(s=>typeof s.observation.typicalCents==="number"&&
     Number.isSafeInteger(s.observation.typicalCents));
   const total=(rows:typeof actual,key:"actualCents"|"typicalCents")=>{
     if(!rows.length)return null;
     const sum=rows.reduce((acc,row)=>acc+Number(row.observation[key]),0);
     return Number.isSafeInteger(sum)?sum:null;
   };
   const observedSalesCents=total(measured,"actualCents");
   const comparableActualCents=total(comparable,"actualCents");
   const comparableTypicalCents=total(comparable,"typicalCents");
   const salesSummary={observedSalesCents,observedSalesDays:measured.length,
     comparableDays:comparable.length,comparableActualCents,comparableTypicalCents,
     changePercent:comparableActualCents!==null&&comparableTypicalCents!==null?
       changePercent(comparableActualCents,comparableTypicalCents):null};
   // A completed business day can have actual sales but missing item/discount
   // details. Keep that distinction in the same saved Supervisor report.
   const evidenceEnd=effect.observationWindow?.closeEarly?utcDateOffset(cafeToday((await createAdminSupabaseClient().from("businesses").select("timezone").eq("id",scope.businessId).maybeSingle()).data?.timezone??"UTC"),-1):effect.endDate;
   const toastEvidence=windowComplete&&window?.proposalId&&evidenceEnd>=effect.startDate?await Promise.resolve()
     .then(()=>eventToastEvidence(createAdminSupabaseClient(),
       scope.businessId,effect.startDate,effect.actions,evidenceEnd)).catch(()=>({
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
   const complete=windowComplete&&measured.length===expected&&comparable.length===expected;
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
     checklist,liveWatch,toastEvidence,salesSummary,
     eventStatusDays:[...new Map([...observed.filter(s=>s.observation.coverage==="event_inactive")
       .map(s=>({date:s.businessDate,activity:s.observation.eventActivity})),
       ...(effect.observationWindow?.inactiveDates??[]).map(date=>({date,activity:"inactive"}))].map(d=>[d.date,d])).values()],
     toastEvidenceWindow:{from:effect.startDate,to:evidenceEnd},
     missingBaselineDays:actual.filter(s=>s.observation.typicalCents===null).map(s=>s.businessDate),
     days:actual.map(s=>({date:s.businessDate,...s.observation})),
     caveat:"Cancelled, moved or unconfirmed event dates are not treated as active event observations. Event-day sales are observational, not proof of event causality. Recorded item sales, discount totals and staff timecards do not prove a proposed combo, discount or physical preparation was implemented; owner checklist markers are not POS evidence.",
   };
   // Keep PR 6's live reporting and PR 7's final report in the same canonical loop.
   const terminal=windowComplete&&Boolean(window?.proposalId);
   const narrative=terminal&&window?.proposalId
     ?await eventFinalNarrative(scope,window.proposalId,effect.facts.map(f=>f.name),
       effect.summary,result,status==="complete"?"complete":"insufficient_evidence")
     :null;
   const reportText=narrative?.text??(terminal?eventReportFallback(scope.locale,result):null);
   const provenance=narrative?.provenance??[];
   // The writer must persist the exact hash the narrative was generated with.
   // A factual fallback has no model currency claim; use the null-currency hash
   // so a later authorized cron may retry when configured currency is available.
   const factsHash=narrative?.hash??
     eventReportFactsHash(result,status,effect.summary,effect.facts.map(f=>f.name),null);
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
