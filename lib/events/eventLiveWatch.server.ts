import "server-only";
import {formatInTimeZone} from "date-fns-tz";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {eventReadinessCapabilityId,authorizedScheduledEventScope}
  from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {monitorLoop,utcDateOffset} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {withinCafeOpenHours} from "./eventLiveWatch";

/** Only the authenticated cron invokes this after the canonical live Toast
 * reader has refreshed. No UI request, web search or second monitoring ledger. */
export async function watchLiveEvents(businessId:string,businessDate:string):Promise<{
  checked:number;updated:number;failed:number
}>{
 const db=createAdminSupabaseClient();
 const {data:business,error:businessError}=await db.from("businesses")
   .select("timezone,is_demo").eq("id",businessId).maybeSingle();
 if(businessError||!business?.timezone||business.is_demo)
   return {checked:0,updated:0,failed:0};
 const today=formatInTimeZone(new Date(),business.timezone,"yyyy-MM-dd");
 if(today!==businessDate)return {checked:0,updated:0,failed:0};
 const localTime=formatInTimeZone(new Date(),business.timezone,"HH:mm");
 const {data:locations,error:hoursError}=await db.from("locations")
   .select("open_hours").eq("business_id",businessId).limit(30);
 if(hoursError||!withinCafeOpenHours((locations??[]).map(x=>x.open_hours),today,localTime))
   return {checked:0,updated:0,failed:0};
 const {data:proposals,error}=await db.from("supervisor_proposals")
   .select("id,owner_user_id,thread_id,monitoring_start_date,monitor_spec")
   .eq("business_id",businessId).eq("capability_id",eventReadinessCapabilityId)
   .eq("status","committed").lte("monitoring_start_date",today)
   .order("created_at",{ascending:false}).limit(20);
 if(error)throw new Error("event_live_proposals_unavailable");
 let checked=0,updated=0,failed=0;
 const repo=new SupabaseLoopRepository();
 for(const row of proposals??[]){
   const start=row.monitoring_start_date;
   const duration=Number((row.monitor_spec as {durationDays?:unknown}|null)?.durationDays);
   if(typeof start!=="string"||!Number.isSafeInteger(duration)||duration<1||
     duration>14||today>utcDateOffset(start,duration-1))continue;
   if(checked>=4)break; // Bound a single café's live watch workload.
   checked++;
   try{
     const scope=await authorizedScheduledEventScope({
       businessId,ownerUserId:row.owner_user_id,threadId:row.thread_id,locale:"en",
     });
     const proposal=await repo.load(scope,row.id);
     const report=await monitorLoop(scope,supervisorLoopRegistry,repo,
       proposal,today,true,true,true);
     if(report)updated++;
   }catch{
     failed++;
     console.warn("events_live_watch_failed"); // No owner or café identifiers in logs.
   }
 }
 return {checked,updated,failed};
}
