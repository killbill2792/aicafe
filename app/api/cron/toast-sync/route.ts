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
 const toastEnabled=process.env.TOAST_AUTO_IMPORT_ENABLED==="true";
 const squareEnabled=process.env.SQUARE_AUTO_SYNC_ENABLED==="true";
 if(!toastEnabled&&!squareEnabled)
  return reply(503,{disabled:true});
 const started=Date.now();
 try {
  const db=createAdminSupabaseClient();
  const now=new Date(started);
  const toast=toastEnabled?runToastSyncTick(db,now,started+TICK_MS,"operations"):Promise.resolve({disabled:true});
  if(!squareEnabled)return reply(200,await toast);
  const {syncSquareTick}=await import("@/lib/pos/square/scheduler");
  const [toastResult,square]=await Promise.allSettled([toast,syncSquareTick(db,now)]);
  return reply(toastResult.status==="fulfilled"&&square.status==="fulfilled"?200:503,{
   toast:toastResult.status==="fulfilled"?toastResult.value:{error:"sync_unavailable"},
   square:square.status==="fulfilled"?square.value:{error:"sync_unavailable"}});
 }catch{
  return reply(503,{error:"sync_unavailable"});
 }
}
