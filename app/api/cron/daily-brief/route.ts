import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {sendDailyBriefs} from "@/lib/operating/dailyBrief.server";
import {briefOutboxHook,dispatchDueMorningBriefs} from "@/lib/whatsapp/morningBriefDelivery.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
/** Every five minutes. Each café decides whether its own brief is due
 * (lib/operating/briefSchedule.ts). One canonical producer, one owner thread/inbox
 * item, and only the verified recipient/outbox. No provider calls unless ALL flags opt in. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))return reply(401,{error:"unauthorized"});
  if(process.env.DAILY_BRIEF_ENABLED!=="true")return reply(503,{disabled:true});
  try{
    const now=new Date(),db=createAdminSupabaseClient();
    const result=await sendDailyBriefs(db,now,briefOutboxHook(db,now));
    // Each queued brief carries its own café deadline (migration 148).
    const dispatched=await dispatchDueMorningBriefs(db);
    if(dispatched.reason&&dispatched.reason!=="whatsapp_setting_off")
      console.warn("morning_brief_dispatch_blocked",{reason:dispatched.reason});
    return reply(200,result);
  }catch{return reply(503,{error:"brief_unavailable"});}
}
