import {NextResponse} from "next/server";
import {verifyBearer} from "@/lib/security/bearer";
import {runWhatsAppSupervisorWorker} from "@/lib/whatsapp/supervisor-bridge.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=150;
const json=(status:number,data:unknown)=>NextResponse.json(data,{
 status,headers:{"Cache-Control":"private, no-store"},
});
/** Protected cron, NOT a public webhook. The signed webhook itself does only
 * bounded validation and durable ingestion before returning 200. */
export async function GET(request:Request){
 if(!verifyBearer(request,process.env.CRON_SECRET))
   return json(401,{error:"unauthorized"});
 if(process.env.WHATSAPP_WORKER_ENABLED!=="true"||
    process.env.WHATSAPP_SUPERVISOR_ENABLED!=="true")
   return json(503,{disabled:true});
 try{return json(200,await runWhatsAppSupervisorWorker());}
 catch(error){
   console.error("whatsapp_supervisor_worker_failed",{
     code:error instanceof Error?error.message:"unknown",
   });
   return json(503,{error:"whatsapp_worker_unavailable"});
 }
}
