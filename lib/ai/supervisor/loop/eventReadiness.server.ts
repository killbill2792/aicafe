import "server-only";
import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {readCafeEvents,readEventChecklist} from "@/lib/data/cafeEvents.server";
import {readDailyFacts} from "@/lib/data/dailyFacts.server";
import {posFactReaders} from "@/lib/data/posFactReaders.server";
import {medianCents,changePercent} from "@/lib/metrics/core/dayOutlook";
import {indexHourlyRevenue,hourlyMatchesDaily} from "@/lib/metrics/core/eventReadiness";
import {cafeToday} from "@/lib/metrics/core/clock";
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
});
export const eventReadinessEffect=eventReadinessInput.extend({
 facts:z.array(sourceFact).min(1).max(8),
 factsHash:z.string().regex(/^[a-f0-9]{64}$/),
});
export const eventReadinessCapabilityId="alex.event_readiness.v1";
const isWeekday=(day:string,target:string)=>new Date(day+"T12:00:00Z").getUTCDay()===
  new Date(target+"T12:00:00Z").getUTCDay();

/** No new monitoring store: one sample per business day in supervisor_monitor_samples. */
export const eventReadinessCapability=registerLoopCapability({
 id:eventReadinessCapabilityId,version:1,
 inputSchema:eventReadinessInput,effectSchema:eventReadinessEffect,
 proposalDescription:"Draft an inert event-day readiness plan for owner approval using saved café event facts. No staff, purchasing or POS change is performed.",
 dependencyScope:effect=>({kind:"event_readiness",eventIds:effect.eventIds,start:effect.startDate,end:effect.endDate}),
 simulate:async(scope,input)=>{
   const db=await createServerSupabaseClient();
   const {data:{user}}=await db.auth.getUser();
   if(!user||user.id!==scope.ownerUserId||await getActiveBusinessId(user.id)!==scope.businessId)
     throw new Error("owner_required");
   const [{data:member},{data:business}]=await Promise.all([
     db.from("memberships").select("role").eq("business_id",scope.businessId).eq("user_id",user.id).maybeSingle(),
     db.from("businesses").select("timezone,is_demo").eq("id",scope.businessId).maybeSingle(),
   ]);
   if(member?.role!=="owner"||!business?.timezone||business.is_demo)throw new Error("owner_required");
   const today=cafeToday(business.timezone);
   const duration=Math.round((Date.parse(input.endDate)-Date.parse(input.startDate))/86400000)+1;
   if(input.startDate<today||duration<1||duration>14||
     input.startDate>utcDateOffset(today,90))throw new Error("invalid_event_window");
   if(new Set(input.eventIds).size!==input.eventIds.length||
     input.expectedBusyHours.some(h=>h.start>=h.end))throw new Error("invalid_event_plan");
   const found=(await readCafeEvents(db,scope.businessId,input.startDate,input.endDate))
     .filter(e=>input.eventIds.includes(e.id)&&e.status==="found");
   if(found.length!==input.eventIds.length)throw new Error("event_facts_unavailable");
   const facts=found.map(e=>({
     id:e.id,name:e.name,kind:e.kind,startDate:e.startDate,endDate:e.endDate,
     venue:e.venue,areaLabel:e.areaLabel,sourceUrl:e.sourceUrl,
   })).sort((a,b)=>a.id.localeCompare(b.id));
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
   const from=utcDateOffset(businessDate,-56);
   const [days,hours,exclusions]=await Promise.all([
     readDailyFacts(db,scope.businessId,from,businessDate),
     posFactReaders(db,scope.businessId).peakHours({from,to:businessDate}),
     readCafeEvents(db,scope.businessId,from,utcDateOffset(businessDate,-1)),
   ]);
   const certified=days.filter(d=>d.salesDataStatus==="actual");
   const today=certified.find(d=>d.date===businessDate);
   if(!today||!hours.available||!hours.value)return null;
   const byDay=indexHourlyRevenue(hours.value.hours);
   // Unknown or incomplete hours must not be treated as a zero-sales day.
   const reconcile=(day:{date:string;netSalesCents:number})=>
     hourlyMatchesDaily(byDay.get(day.date),day.netSalesCents);
   if(!reconcile(today)||hours.quality.missingInputs.some(x=>x==="hourlySalesPageLimit"||x==="hourlySalesUnavailable"))return null;
   const excluded=new Set(exclusions.filter(e=>e.status==="found").flatMap(e=>{
     const dates:string[]=[];
     for(let d=e.startDate;d<=e.endDate&&dates.length<90;d=utcDateOffset(d,1))dates.push(d);
     return dates;
   }));
   const previous=certified.filter(d=>d.date<businessDate&&isWeekday(d.date,businessDate)&&
     !excluded.has(d.date)&&reconcile(d));
   const observed=byDay.get(businessDate)!;
   const byHour=Array.from({length:24},(_,hourLocal)=>{
     const values=previous.map(d=>byDay.get(d.date)?.get(hourLocal)??0);
     const usualCents=values.length>=3?medianCents(values):null;
     const actualCents=observed.get(hourLocal)??0;
     return {hourLocal,actualCents,usualCents,
       changePercent:usualCents===null?null:changePercent(actualCents,usualCents)};
   });
   const typicalCents=previous.length>=3?medianCents(previous.map(d=>d.netSalesCents)):null;
   return {businessDate,source:"hourly_sales_rollup+daily_rollups",observation:{
     coverage:"actual",actualCents:today.netSalesCents,typicalCents,
     changePercent:typicalCents===null?null:changePercent(today.netSalesCents,typicalCents),
     baselineDays:previous.length,hours:byHour,
   }};
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
   return {status:!windowComplete?"in_progress":complete?"complete":"insufficient_evidence",
     recommendation:"adjust",source:"hourly_sales_rollup+daily_rollups",
     result:{eventIds:effect.eventIds,startDate:effect.startDate,endDate:effect.endDate,
       factsHash:effect.factsHash,observedDays:actual.length,expectedDays:expected,
       checklist,
       missingBaselineDays:actual.filter(s=>s.observation.typicalCents===null).map(s=>s.businessDate),
       days:actual.map(s=>({date:s.businessDate,...s.observation})),
       caveat:"Comparison is observational, not evidence that an event caused a change."}};
 },
});
