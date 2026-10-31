import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {sendDailyBriefs} from "@/lib/operating/dailyBrief.server";
import {enqueueBoundBrief} from "@/lib/whatsapp/morningBriefDelivery.server";
import {dispatchOutboundOnce} from "@/lib/whatsapp/queue.server";
import {providerAllowed} from "@/lib/whatsapp/transport.server";
import {formatInTimeZone} from "date-fns-tz";
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
    // Dispatch only during 05:50–05:59 at the queue item's café, never at 06:23.
    // Provider receipt is tracked independently by A; acceptance != delivery.
    if(providerAllowed("daily_brief")){
      const {data:zones,error}=await db.from("businesses").select("timezone")
        .eq("is_demo",false).limit(1000);
      if(error)throw new Error("brief_dispatch_zones_unavailable");
      const inWindow=(zones??[]).some(b=>{
        if(!b.timezone)return false;
        try{
          const local=formatInTimeZone(now,b.timezone,"HH:mm");
          return local>="05:50"&&local<"06:00";
        }catch{return false;}
      });
      if(inWindow){
        // A's outbox leases and unique owner/day index own concurrency and dedupe.
        for(let i=0;i<10;i++){
          const state=await dispatchOutboundOnce("daily_brief");
          if(state==="empty"||state==="disabled")break;
        }
      }
    }
    return reply(200,result);
  }catch{return reply(503,{error:"brief_unavailable"});}
}
