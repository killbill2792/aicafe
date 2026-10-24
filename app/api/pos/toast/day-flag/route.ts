import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
import {localClock} from "@/lib/pos/toast/scheduleDates";
const schema=z.object({businessId:GUID,restaurantGuid:GUID,date:z.iso.date(),
 action:z.enum(["flag","clear"]),note:z.string().max(2000).optional()}).strict();
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return reply(404,{error:"not_found"});
 const p=schema.safeParse(await request.json().catch(()=>null));
 if(!p.success)return reply(400,{error:"invalid_request"});
 const {businessId,restaurantGuid,date,action,note}=p.data;
 const db=await authorizeToastOwner(businessId);
 if(!db)return reply(404,{error:"not_found"});
 const {data:mapping,error}=await db.from("toast_location_mappings")
 .select("toast_time_zone").eq("business_id",businessId)
 .eq("restaurant_guid",restaurantGuid).maybeSingle();
 if(error)return reply(503,{error:"unavailable"});
 if(!mapping?.toast_time_zone)return reply(404,{error:"not_found"});
 if(date>=localClock(new Date(),mapping.toast_time_zone).today)return reply(400,{error:"future_day"});
 const {data:existing,error:readError}=await db.from("toast_day_owner_flags")
  .select("business_date").eq("business_id",businessId).eq("restaurant_guid",restaurantGuid)
  .eq("business_date",date).maybeSingle();
 if(readError)return reply(503,{error:"unavailable"});
 if(action==="clear"){
  if(!existing)return reply(200,{cleared:true});
  const {error:write}=await db.from("toast_day_owner_flags").update({cleared_at:new Date().toISOString()})
    .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid).eq("business_date",date);
  if(write)return reply(503,{error:"unavailable"});
 }else{
  const {error:write}=await db.from("toast_day_owner_flags").upsert({
   business_id:businessId,restaurant_guid:restaurantGuid,business_date:date,
   flagged_at:new Date().toISOString(),cleared_at:null,note:note??null
  },{onConflict:"business_id,restaurant_guid,business_date"});
  if(write)return reply(503,{error:"unavailable"});
 }
 const {error:certError}=await db.rpc("toast_certify_day_voids",{p_business_id:businessId,p_date:date});
 if(certError)return reply(503,{error:"unavailable"});
 return reply(200,{flagged:action==="flag"});
}
