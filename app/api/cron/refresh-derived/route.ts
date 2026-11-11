import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {refreshDerivedForBusiness} from "@/lib/alerts/refreshDerived.server";
import {deliverPendingCommitments} from "@/lib/operating/commitments.server";
import {dispatchRoutinesForBusiness} from "@/lib/ai/supervisor/routines/dispatch.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const respond=(status:number,body:unknown)=>NextResponse.json(body,{
  status,headers:{"Cache-Control":"no-store"},
});
/** Every 15 minutes refresh derived rows tenant by tenant; no page-load writes. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))
    return respond(401,{error:"unauthorized"});
  const db=createAdminSupabaseClient();
  let checked=0,refreshed=0,failed=0;
  const routines={routinesChecked:0,runs:0,notices:0,failed:0,evidenceChecks:0};
  const now=new Date();
  // Separate task capability, same authorized cron. Failures remain visible and
  // the database keeps unfinished commitments pending for the next invocation.
  let commitments:{scopes:number;delivered:number;failed:number};
  try{commitments=await deliverPendingCommitments(db,now);}
  catch{commitments={scopes:0,delivered:0,failed:1};}
  const pageSize=100;
  for(let offset=0;;offset+=pageSize){
    const {data,error}=await db.from("businesses").select("id,timezone,is_demo")
      .order("id",{ascending:true}).range(offset,offset+pageSize-1);
    if(error)return respond(503,{error:"refresh_unavailable",checked,refreshed,failed});
    const rows=data??[];
    for(let i=0;i<rows.length;i+=5){
      await Promise.all(rows.slice(i,i+5).map(async business=>{
        if(business.is_demo)return;
        checked++;
        if(!business.timezone){failed++;return;}
        try{
          await refreshDerivedForBusiness(db,business.id,business.timezone,now);
          refreshed++;
        }catch{
          // Isolate one café; no identifiers or sensitive error messages in response.
          failed++;
        }
        // Independent source-change triage follows the authoritative alert refresh.
        try{
          const outcome=await dispatchRoutinesForBusiness(db,business.id,business.timezone,now);
          routines.routinesChecked+=outcome.routinesChecked;
          routines.runs+=outcome.runs;
          routines.notices+=outcome.notices;
          routines.failed+=outcome.failed;
          routines.evidenceChecks+=outcome.evidenceChecks;
        }catch{routines.failed++;}
      }));
    }
    if(rows.length<pageSize)break;
  }
  return respond(failed||commitments.failed||routines.failed?207:200,{checked,refreshed,failed,commitments,routines});
}
