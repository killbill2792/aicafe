import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {sendDailyBriefs} from "@/lib/operating/dailyBrief.server";
import {enqueueBoundBrief,dispatchDueMorningBriefs} from "@/lib/whatsapp/morningBriefDelivery.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
/** Every five minutes. One canonical producer, one owner thread/inbox item, and
 * only PR A's verified recipient/outbox. No provider calls unless ALL flags opt in. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))return reply(401,{error:"unauthorized"});
  if(process.env.DAILY_BRIEF_ENABLED!=="true")return reply(503,{disabled:true});
  try{
    const now=new Date(),db=createAdminSupabaseClient();
    const result=await sendDailyBriefs(db,now,async input=>{
      if(!input.eligible)return;
      await enqueueBoundBrief(input.eligible,{
        businessId:input.businessId,ownerUserId:input.ownerUserId,threadId:input.threadId,
        businessName:input.businessName,currency:input.currency,timezone:input.timezone,
        today:input.today,yesterday:input.yesterday},input.websiteMessageId,now);
    });
    // Staging migration 134 guards A's SINGLE global claim by the queued
    // café-local date and 05:50–06:00. Missing migration/flags means no send.
    await dispatchDueMorningBriefs(db);
    return reply(200,result);
  }catch{return reply(503,{error:"brief_unavailable"});}
}
