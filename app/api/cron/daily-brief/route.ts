import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {sendDailyBriefs} from "@/lib/operating/dailyBrief.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
/** Hourly; each café gets its brief once, between 8:00 and 12:00 café time. Counts only in the response. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))return reply(401,{error:"unauthorized"});
  // Checked before any database client is created.
  if(process.env.DAILY_BRIEF_ENABLED!=="true")return reply(503,{disabled:true});
  try{return reply(200,await sendDailyBriefs(createAdminSupabaseClient()));}
  catch{return reply(503,{error:"brief_unavailable"});}
}
