import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {refreshDerivedForBusiness,derivedRefreshSchemaMissing} from "@/lib/alerts/refreshDerived.server";
import {deliverPendingCommitments} from "@/lib/operating/commitments.server";
import {dispatchDueObjectivesAcrossCafes,dispatchRoutinesForBusiness} from "@/lib/ai/supervisor/routines/dispatch.server";
import {deliverDuePushReports} from "@/lib/ai/supervisor/routines/push.server";
import {enqueueInvestigationsForOwner,processDueInvestigations} from "@/lib/ai/supervisor/routines/investigation.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const respond=(status:number,body:unknown)=>NextResponse.json(body,{
  status,headers:{"Cache-Control":"no-store"},
});
/** The existing SQL admission ledger enforces 15-minute refresh and pending
 * source wakes, independent of which minute a protected cron request arrives. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))
    return respond(401,{error:"unauthorized"});
  const db=createAdminSupabaseClient();
  let checked=0,refreshed=0,failed=0,deferred=0;
  const routines={routinesChecked:0,runs:0,notices:0,failed:0,evidenceChecks:0,investigationsQueued:0};
  const now=new Date();
  // Existing general and Watch objectives keep their refresh cadence.
  const dueObjectives=await dispatchDueObjectivesAcrossCafes(db,now,undefined,now.getTime()+35_000,"legacy").catch(()=>
    ({admitted:0,claimed:0,completed:0,failed:1,deferred:0}));
  // Source refresh/triage receives an explicit early 90-second window, after
  // the time-sensitive objective claim but before slower queued push/chat/model
  // lanes. Otherwise their independent budgets can consume all 180 seconds
  // and starve every derived source refresh on every minute tick.
  // SQL lease/15-minute admission remains the same authoritative policy.
  const refreshAdmissionUntil=now.getTime()+90_000;
  const investigationAdmissionUntil=now.getTime()+225_000;
  const pageSize=100;
  const scheduled=await db.rpc("supervisor_list_derived_refresh_businesses");
  const useLegacy=derivedRefreshSchemaMissing(scheduled.error);
  let admissionDeferred=false;
  for(let offset=0;;offset+=pageSize){
    const {data,error}=useLegacy?await db.from("businesses").select("id,timezone,is_demo")
      .order("id",{ascending:true}).range(offset,offset+pageSize-1):scheduled;
    if(error)return respond(503,{error:"refresh_unavailable",checked,refreshed,failed,
      admissionLane:"source_refresh"});
    const rows=data??[];
    for(const business of rows as Array<{id:string;timezone:string|null;is_demo:boolean}>){
        if(business.is_demo)continue;
        if(Date.now()>=refreshAdmissionUntil){
          // Entries not started retain their least-recently-started position.
          deferred++;admissionDeferred=true;continue;
        }
        checked++;
        if(!business.timezone){failed++;continue;}
        try{
          const outcome=await refreshDerivedForBusiness(db,business.id,business.timezone,new Date());
          if(outcome.deferred)deferred++;
          else refreshed++;
        }catch{
          // Isolate one café; no identifiers or sensitive error messages in response.
          failed++;
        }
        // Independent source-change triage follows the authoritative alert refresh.
        try{
          const outcome=await dispatchRoutinesForBusiness(db,business.id,business.timezone,new Date(),
            enqueueInvestigationsForOwner,undefined,{skipObjectives:true});
          routines.routinesChecked+=outcome.routinesChecked;
          routines.runs+=outcome.runs;
          routines.notices+=outcome.notices;
          routines.failed+=outcome.failed;
          routines.evidenceChecks+=outcome.evidenceChecks;
          routines.investigationsQueued+=outcome.investigationsQueued;
        }catch{routines.failed++;}
    }
    if(admissionDeferred||!useLegacy||rows.length<pageSize)break;
  }
  const pushDelivery=await deliverDuePushReports(db,6).catch(()=>({sent:0,retried:0,failed:1}));
  // The legacy manual worker flag alone must not activate scheduled chat work.
  // This additional rollout gate remains off until durable admission/recovery is proven.
  const ownerRunsEnabled=process.env.SUPERVISOR_RUN_WORKER_ENABLED==="true" &&
    process.env.SUPERVISOR_DURABLE_CHAT_ENABLED==="true";
  const ownerWorker=ownerRunsEnabled
    ? await import("@/lib/ai/supervisor/runs/worker.server").catch(()=>null) : null;
  const ownerRuns=ownerWorker ? (async()=>{
    try{return {...await ownerWorker.processOldestDurableRun(now.getTime()+180_000),failed:0};}
    catch{return {processed:0,state:null,failed:1};}
  })() : Promise.resolve({processed:0,state:null,failed:ownerRunsEnabled?1:0});
  // Do not run a large refresh concurrently with an admitted owner run.
  const ownerResult=await ownerRuns;
  // After source-change triage, preserve one bounded investigation slot and
  // the existing owner/push/commitment delivery lanes on this cron authority.
  const investigations={processed:0,collected:0,investigated:0,followUps:0,rechecked:0,failed:0};
  async function investigateOne(deadline:number){
    if(Date.now()>=investigationAdmissionUntil)return;
    try{
      const step=await processDueInvestigations(db,new Date(),1,undefined,undefined,deadline);
      for(const key of ["processed","collected","investigated","followUps","rechecked","failed"] as const)
        investigations[key]+=step[key]??0;
    }catch{investigations.failed++;}
  }
  await investigateOne(now.getTime()+250_000);
  // Separate task capability, same authorized cron. Failures remain visible and
  // the database keeps unfinished commitments pending for the next invocation.
  let commitments:{scopes:number;delivered:number;failed:number};
  try{commitments=await deliverPendingCommitments(db,now);}
  catch{commitments={scopes:0,delivered:0,failed:1};}
  // SQL admits only due or newly queued café work. A missed quarter-hour
  // cannot lose its source-change detection or owner priority notices.
  // A global fair, bounded slice across all cafés, not paid model calls per
  // business. The existing cron remains the only schedule for this capability.
  await investigateOne(now.getTime()+275_000);
  return respond(failed||commitments.failed||routines.failed||investigations.failed||
    dueObjectives.failed||pushDelivery.failed||ownerResult.failed||admissionDeferred?207:200,
    {checked,refreshed,failed,deferred,dueObjectives,pushDelivery,heavyRefresh:true,commitments,routines,investigations,
      ...(ownerRunsEnabled?{ownerRuns:ownerResult}:{})});
}
