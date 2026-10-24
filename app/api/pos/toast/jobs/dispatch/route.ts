import {verifyBearer} from "@/lib/security/bearer";
import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {pollToastLocation} from "@/lib/pos/toast/poll";
import {stageToastCatalog,stageToastRoster} from "@/lib/pos/toast/operationalStaging";
import {runToastOrderQueue} from "@/lib/pos/toast/orderQueue";
import {ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";export const dynamic="force-dynamic";
type Due={business_id:string;restaurant_guid:string;location_id:string;
 kind:"orders"|"attendance"|"schedules"|"roster"|"catalog";lease_nonce:string};
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,
 headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_DISPATCH_ENABLED!=="true"||process.env.TOAST_POLLING_ENABLED!=="true")
  return reply(503,{error:"disabled"});
 const secret=process.env.TOAST_JOB_SECRET;
 if(!verifyBearer(request,secret))
  return reply(401,{error:"unauthorized"});
 const db=createAdminSupabaseClient();
 const {data:due,error}=await db.rpc("toast_claim_due_sync");
 if(error)return reply(503,{error:"unavailable"});
 const item=(due as Due[]|null)?.[0];
 if(!item)return reply(200,{claimed:0});
 let failure:string|null=null,result:unknown=null;
 try{
  const p={businessId:item.business_id,restaurantGuid:item.restaurant_guid,
   locationId:item.location_id};
  if(item.kind==="roster")result=await stageToastRoster(db,p);
  else if(item.kind==="catalog")result=await stageToastCatalog(db,p);
  else {
   if(item.kind==="orders"&&process.env.TOAST_JOBS_ENABLED==="true")
    await runToastOrderQueue(db);
   result=await pollToastLocation(db,{...p,kind:item.kind});
  }
 }catch(e){failure=e instanceof ToastApiError?e.category:"unavailable";}
 const {data:finished,error:finishError}=await db.rpc("toast_finish_due_sync",{
  p_business_id:item.business_id,p_restaurant_guid:item.restaurant_guid,
  p_kind:item.kind,p_nonce:item.lease_nonce,
  p_success:failure===null,p_failure:failure
 });
 if(finishError||!finished)return reply(503,{error:"lease_completion_failed"});
 if(failure)return reply(failure==="rate_limited"?429:503,{error:failure});
 return reply(200,{claimed:1,kind:item.kind,result});
}
