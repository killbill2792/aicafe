import "server-only";
import {formatInTimeZone} from "date-fns-tz";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {eventReadinessCapabilityId,authorizedScheduledEventScope,selectEventObservations,observedEventProposalIds}
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
   .in("status",["draft","approved","committed","manual_confirmed"])
   .order("created_at",{ascending:false}).limit(100);
 if(error)throw new Error("event_live_proposals_unavailable");
 let checked=0,updated=0,failed=0;
 const repo=new SupabaseLoopRepository();
 const eligible=[];
 for(const row of proposals??[]){
   const scope={businessId,ownerUserId:row.owner_user_id,threadId:row.thread_id,
     locale:"en" as const};
   try{
     const proposal=await repo.load(scope,row.id);
     eligible.push(proposal);
   }catch{
     failed++;
     console.warn("events_live_watch_load_failed");
   }
 }
 const observedIds=await observedEventProposalIds(db,businessId,eligible.map(p=>p.id));
 for(const proposal of selectEventObservations(eligible,observedIds)){
   const start=proposal.monitoringStartDate!;
   const end=utcDateOffset(start,proposal.monitorSpec.durationDays-1);
   if(today<start||today>end)continue;
   if(checked>=4)break;
   checked++;
   try{
     const scope=await authorizedScheduledEventScope({
       businessId,ownerUserId:proposal.ownerUserId,threadId:proposal.threadId,
       locale:proposal.locale,
     });
     const report=await monitorLoop(scope,supervisorLoopRegistry,repo,
       proposal,today,true,true,true);
     if(report)updated++;
   }catch{
     failed++;
     console.warn("events_live_watch_failed");
   }
 }
 return {checked,updated,failed};
}
