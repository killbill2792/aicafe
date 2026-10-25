import {verifyBearer} from "@/lib/security/bearer";
import {NextResponse} from "next/server";
import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {pollToastLocation} from "@/lib/pos/toast/poll";
import {GUID,ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const args=z.object({businessId:GUID,locationId:GUID,restaurantGuid:GUID,
  kind:z.enum(["orders","attendance","schedules"])}).strict();
export async function POST(request:Request) {
 const respond=(status:number,data:unknown)=>NextResponse.json(data,{
  status,headers:{"Cache-Control":"no-store"}
 });
 if(process.env.TOAST_POLLING_ENABLED!=="true")return respond(503,{error:"disabled"});
 const secret=process.env.TOAST_JOB_SECRET;
 if(!verifyBearer(request,secret))
   return respond(401,{error:"unauthorized"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
   return respond(415,{error:"invalid_request"});
 const data=args.safeParse(await request.json().catch(()=>null));
 if(!data.success)return respond(400,{error:"invalid_request"});
 try{return respond(200,await pollToastLocation(createAdminSupabaseClient(),data.data));}
 catch(error){
  const reason=error instanceof ToastApiError?error.category:"unavailable";
  return respond(reason==="rate_limited"?429:503,{error:reason});
 }
}
