import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {createToastClient,GUID,ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
const expected=z.object({businessId:GUID}).strict();
export function verificationFailure(previousVerified:boolean,category:string) {
  // A temporary outage, rate-limit or timeout does not revoke access or erase past verification.
  const transient=["unavailable","timeout","rate_limited","invalid_response"].includes(category);
  return {state:transient?(previousVerified?"verified":"configured"):
    category==="missing_permissions"?"missing_permissions":
    category==="unauthorized_location"?"configured":"needs_reconnect",
    preserveVerification:transient};
}
export async function POST(request:Request){
  if(process.env.TOAST_SETUP_ENABLED!=="true")return json(503,{error:"setup_disabled"});
  const body=expected.safeParse(await request.json().catch(()=>null));
  if(!body.success)return json(400,{error:"invalid_request"});
  const businessId=body.data.businessId;
  const db=await authorizeToastOwner(businessId);
  if(!db)return json(403,{error:"not_authorized"});
  const {data:mappings,error}=await db.from("toast_location_mappings")
    .select("restaurant_guid,verified_at").eq("business_id",businessId);
  if(error||!mappings?.length)return json(400,{error:"no_locations"});
  const {data:current}=await db.from("toast_api_credentials").select("state").eq("business_id",businessId).maybeSingle();
  const previouslyVerified=current?.state==="verified"&&mappings.every(l=>l.verified_at);
  const client=createToastClient(db,businessId);
  const start=new Date(Date.now()-60000).toISOString(),end=new Date().toISOString();
  const query=(p:string)=>p+"?startDate="+encodeURIComponent(start)+"&endDate="+encodeURIComponent(end);
  try {
    for(const mapping of mappings) {
      const guid=mapping.restaurant_guid;
      const info=await client.request("/restaurants/v1/restaurants/"+guid,guid,
        z.object({guid:GUID}),{allowUnverified:true});
      if(info.guid.toLowerCase()!==guid.toLowerCase())throw new ToastApiError("unauthorized_location");
      await client.request("/menus/v2/metadata",guid,z.record(z.string(),z.unknown()),{allowUnverified:true});
      await client.request(query("/orders/v2/ordersBulk")+"&pageSize=1&page=1",guid,z.array(z.unknown()),{allowUnverified:true});
      await client.request("/labor/v1/employees",guid,z.array(z.unknown()),{allowUnverified:true});
      await client.request(query("/labor/v1/timeEntries"),guid,z.array(z.unknown()),{allowUnverified:true});
      await client.request(query("/labor/v1/shifts"),guid,z.array(z.unknown()),{allowUnverified:true});
    }
    const at=new Date().toISOString();
    for(const mapping of mappings) {
      const {error:save}=await db.from("toast_location_mappings")
        .update({verified_at:at}).eq("business_id",businessId).eq("restaurant_guid",mapping.restaurant_guid);
      if(save)throw new ToastApiError("unavailable");
    }
    const {error:updated}=await db.from("toast_api_credentials").update({
      state:"verified",last_verified_at:at,last_error_category:null
    }).eq("business_id",businessId);
    if(updated)throw new ToastApiError("unavailable");
    return json(200,{state:"verified",locationsVerified:mappings.length});
  } catch(err){
    const category=err instanceof ToastApiError?err.category:"unavailable";
    const outcome=verificationFailure(Boolean(previouslyVerified),category);
    if(!outcome.preserveVerification)
      await db.from("toast_location_mappings").update({verified_at:null}).eq("business_id",businessId);
    await db.from("toast_api_credentials").update({
      state:outcome.state,last_error_category:category,
      ...(!outcome.preserveVerification?{last_verified_at:null}:{}),
    }).eq("business_id",businessId);
    return json(category==="rate_limited"?429:422,{
      state:outcome.state,verified:outcome.preserveVerification&&Boolean(previouslyVerified),
      error:category,retryAfter:err instanceof ToastApiError?err.retryAt:undefined});
  }
}
