import {verifyBearer} from "@/lib/security/bearer";
import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {runToastOrderQueue} from "@/lib/pos/toast/orderQueue";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request) {
 const reply=(code:number,body:unknown)=>NextResponse.json(body,{
  status:code,headers:{"Cache-Control":"no-store"}
 });
 // No Vercel cron schedules are added. An authorized scheduler may call this
 // only after explicit customer pilot approval.
 if(process.env.TOAST_JOBS_ENABLED!=="true")return reply(503,{error:"disabled"});
 const secret=process.env.TOAST_JOB_SECRET;
 if(!verifyBearer(request,secret))
    return reply(401,{error:"unauthorized"});
 try{return reply(200,await runToastOrderQueue(createAdminSupabaseClient()));}
 catch{return reply(503,{error:"unavailable"});}
}
