import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {todaySoFarForBusiness} from "@/lib/data/todayLive.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
/** Every 15 minutes: save each Toast café's "today so far" (read-only Toast reads). */
export async function GET(request:Request){
 if(!verifyBearer(request,process.env.CRON_SECRET))return reply(401,{error:"unauthorized"});
 if(process.env.TOAST_AUTO_IMPORT_ENABLED!=="true")return reply(503,{disabled:true});
 const db=createAdminSupabaseClient();
 const {data,error}=await db.from("toast_location_mappings").select("business_id")
  .not("verified_at","is",null).limit(1000);
 if(error)return reply(503,{error:"unavailable"});
 const businesses=[...new Set((data??[]).map(row=>String(row.business_id)))];
 const deadline=Date.now()+270_000;
 let saved=0,failed=0;
 for(const businessId of businesses){
  if(Date.now()>=deadline)break;
  // Readings younger than 10 minutes are kept; older ones are refreshed.
  const read=await todaySoFarForBusiness(db,businessId,{maxAgeMs:10*60_000}).catch(()=>null);
  if(read?.available)saved++;else failed++;
 }
 return reply(200,{businesses:businesses.length,saved,failed});
}
