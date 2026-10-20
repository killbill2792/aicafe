import {NextResponse} from "next/server";
import {formatInTimeZone} from "date-fns-tz";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {monitorLoop,utcDateOffset,type LoopProposal,type OwnerLoopScope}
  from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
export const runtime="nodejs";export const dynamic="force-dynamic";export const maxDuration=120;
const respond=(status:number,result:unknown)=>NextResponse.json(result,{status,headers:{"Cache-Control":"no-store"}});
/** Authenticated server cron; reauthz every owner and reread observed source per day.
 * No notifications or POS writes are issued by this job. */
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET;
 if(!secret||request.headers.get("authorization")!=="Bearer "+secret)
   return respond(401,{error:"unauthorized"});
 const db=createAdminSupabaseClient(),repo=new SupabaseLoopRepository();
 const {data,error}=await db.from("supervisor_proposals").select("*")
   .in("status",["manual_confirmed","committed"]).not("monitoring_start_date","is",null)
   // Oldest never permanently crowds out newer tenants: every checked
   // proposal rotates to the back of this stable bounded queue.
   .order("monitor_checked_at",{ascending:true,nullsFirst:true})
   .order("id",{ascending:true}).limit(100);
 if(error)return respond(503,{error:"monitor_proposals_unavailable"});
 let sampled=0,reported=0,failed=0;
 for(const row of data??[]){
  try{
   const member=await db.from("memberships").select("role").eq("business_id",row.business_id)
     .eq("user_id",row.owner_user_id).maybeSingle();
   if(member.error||member.data?.role!=="owner"){failed++;continue;}
   const cafe=await db.from("businesses").select("timezone").eq("id",row.business_id).single();
   if(cafe.error||!cafe.data){failed++;continue;}
   const today=formatInTimeZone(new Date(),cafe.data.timezone||"America/Los_Angeles","yyyy-MM-dd");
   const yesterday=utcDateOffset(today,-1);
   const p:LoopProposal={
     id:row.id,businessId:row.business_id,ownerUserId:row.owner_user_id,
     threadId:row.thread_id,capabilityId:row.capability_id,capabilityVersion:row.capability_version,
     canonicalEffectPayload:row.canonical_effect_payload,effectHash:row.effect_hash,
     baseline:row.baseline,monitorSpec:row.monitor_spec,status:row.status,
     revision:row.revision,locale:row.locale,
     monitoringStartDate:row.monitoring_start_date,createdAt:row.created_at,
   };
   const scope:OwnerLoopScope={businessId:p.businessId,ownerUserId:p.ownerUserId,
     threadId:p.threadId,locale:p.locale};
   const start=p.monitoringStartDate!;
   const end=utcDateOffset(start,p.monitorSpec.durationDays-1);
   // Even after a prolonged cron outage, refresh every day and persist the
   // terminal report BEFORE archiving. Missing coverage must yield an honest
   // insufficient-evidence report, not strand the proposal in this queue.
   // Revisit missed dates, not only yesterday; actual coverage is checked on
   // each day and samples are uniquely idempotent by proposal/business date.
   for(let day=start;day<=yesterday&&day<=end;day=utcDateOffset(day,1)){
      const report=await monitorLoop(scope,supervisorLoopRegistry,repo,p,day);
      sampled++;
      if(report)reported++;
   }
   // Even when some dates have no actual coverage, publish the honest
   // insufficient-evidence outcome when the full window has elapsed.
   if(yesterday>end&&start<=yesterday){
      const result=await monitorLoop(scope,supervisorLoopRegistry,repo,p,yesterday);
      if(result)reported++;
   }
   if(today>utcDateOffset(end,14)){
     // monitorLoop saved the latest corrected terminal outcome above; the
     // transition RPC checks a terminal report exists before sealing it.
     await repo.transition(scope,p.id,p.revision,"finish_monitor");
   }
  }catch{failed++;}
  finally{
   // Rotate even if membership was removed or a source continually fails.
   // Failed/orphaned rows cannot monopolize the oldest-first bounded queue.
   // The revision guard preserves the database's compare-and-swap transition.
   const rotated=await db.from("supervisor_proposals").update({
     monitor_checked_at:new Date().toISOString(),revision:row.revision+1,
     updated_at:new Date().toISOString(),
   }).eq("id",row.id).eq("business_id",row.business_id)
     .eq("owner_user_id",row.owner_user_id).eq("revision",row.revision)
     .in("status",["manual_confirmed","committed"]);
   if(rotated.error)failed++;
  }
 }
 return respond(200,{checked:(data??[]).length,sampled,reported,failed});
}
