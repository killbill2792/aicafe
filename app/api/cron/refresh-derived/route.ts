import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {refreshDerivedForBusiness} from "@/lib/alerts/refreshDerived.server";
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
  const now=new Date();
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
      }));
    }
    if(rows.length<pageSize)break;
  }
  return respond(failed?207:200,{checked,refreshed,failed});
}
