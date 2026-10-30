import {NextResponse} from "next/server";
import {formatInTimeZone} from "date-fns-tz";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {monitorLoop,midRunDay,utcDateOffset,type LoopProposal,type OwnerLoopScope}
  from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {goalCapabilityId} from "@/lib/ai/supervisor/loop/goal.server";
import {eventReadinessCapabilityId} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {postGoalCheckin} from "@/lib/ai/supervisor/loop/goalCheckins.server";
import {goalEffectSchema,checkinDue} from "@/lib/calc/goals/goalSpec";
const sameWeekday=(a:string,b:string)=>new Date(a+"T12:00:00Z").getUTCDay()===new Date(b+"T12:00:00Z").getUTCDay();
/** A stored day is complete when every reading in it is certified: a price
 * test day has actual coverage, a goal day full coverage on every metric. */
function sampleComplete(observation:unknown):boolean{
  if(!observation||typeof observation!=="object")return false;
  const o=observation as {coverage?:unknown;values?:unknown};
  if(o.coverage!==undefined)return o.coverage==="actual";
  if(o.values&&typeof o.values==="object")
    return Object.values(o.values).every(v=>typeof v==="object"&&v!==null&&(v as {coverage?:unknown}).coverage===1);
  return false;
}
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
   // Events are handled by the Events cron, not by this generic monitor.
   // Keep the original bounded query chain and rotate skipped rows below.
   // Oldest never permanently crowds out newer tenants: every checked
   // proposal rotates to the back of this stable bounded queue.
   .order("monitor_checked_at",{ascending:true,nullsFirst:true})
   .order("id",{ascending:true}).limit(100);
 if(error)return respond(503,{error:"monitor_proposals_unavailable"});
 let sampled=0,reported=0,failed=0;
 for(const row of data??[]){
  try{
   // One event-report writer: the Events cron. Rotate skipped committed rows
   // so they never crowd the bounded generic queue.
   if(row.capability_id===eventReadinessCapabilityId)continue;
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
   // Short windows (price tests, goals up to 14 days) re-read every day each
   // run. Longer goals re-read the last week each run, older days whose
   // sample is still incomplete (late imports), and every day once a week
   // on the start weekday (re-pulled or corrected older days).
   const fullPass=p.monitorSpec.durationDays<=14||sameWeekday(today,start);
   const complete=new Set((await repo.samples(scope,p.id)).filter(s=>sampleComplete(s.observation)).map(s=>s.businessDate));
   const recheckFrom=utcDateOffset(yesterday,-6);
   for(let day=start;day<=yesterday&&day<=end;day=utcDateOffset(day,1)){
      if(!fullPass&&day<recheckFrom&&complete.has(day))continue;
      const report=await monitorLoop(scope,supervisorLoopRegistry,repo,p,day);
      sampled++;
      if(report)reported++;
   }
   // Goal check-ins: today's question, once, on its cadence day. A failed
   // post never blocks the goal's numbers; the next run retries it.
   if(p.capabilityId===goalCapabilityId){
     const goal=goalEffectSchema.safeParse(p.canonicalEffectPayload);
     if(goal.success&&checkinDue(goal.data,start,today))
       await postGoalCheckin(db,{...scope},p.id,goal.data,today).catch(()=>{failed++;});
   }
   // One mid-run update once the first half has passed (sent at most once:
   // the message id is stable per experiment).
   if(yesterday>=midRunDay(start,p.monitorSpec.durationDays)&&yesterday<end)
      await monitorLoop(scope,supervisorLoopRegistry,repo,p,yesterday,true,true);
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
