import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {runToastSyncTick,TICK_MS} from "@/lib/pos/toast/scheduler";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const reply=(status:number,data:unknown)=>NextResponse.json(data,{
 status,headers:{"Cache-Control":"no-store"}
});
export async function GET(request:Request){
 if(!verifyBearer(request,process.env.CRON_SECRET))
  return reply(401,{error:"unauthorized"});
 // Evaluate this before creating a service-role client, let alone writing data.
 if(process.env.TOAST_AUTO_IMPORT_ENABLED!=="true")
  return reply(503,{disabled:true});
 const started=Date.now();
 try {
  const result=await runToastSyncTick(createAdminSupabaseClient(),new Date(started),
   started+TICK_MS);
  return reply(200,result);
 }catch{
  return reply(503,{error:"sync_unavailable"});
 }
}
