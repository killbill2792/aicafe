import {refreshToastRestaurantInfo} from "@/lib/pos/toast/restaurantInfo";
import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
const expected=z.object({businessId:GUID}).strict();
export function verificationFailure(previousVerified:boolean,category:string) {
  // A temporary outage, rate-limit or timeout does not revoke access or erase past verification.
  const transient=["unavailable","timeout","rate_limited","invalid_response"].includes(category);
  return {state:transient?(previousVerified?"verified":"configured"):
    ["missing_permissions","missing_scope_or_location"].includes(category)?"missing_permissions":
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
  const start=toToastTimestamp(new Date(Date.now()-60000));
  const end=toToastTimestamp(new Date());
  const query=(p:string)=>p+"?startDate="+start+"&endDate="+end;
  const scopesAvailable:{menus:boolean;labor:boolean;config:boolean}={menus:true,labor:true,config:true};
  try {
    for(const mapping of mappings) {
      const guid=mapping.restaurant_guid;
      await refreshToastRestaurantInfo(db,businessId,guid,{allowUnverified:true});
      // Standard access needs only orders and restaurant identity. Optional
      // scopes are probed independently; a 403 must not disconnect sales.
      await client.request(query("/orders/v2/ordersBulk")+"&pageSize=1&page=1",guid,z.array(z.unknown()),{allowUnverified:true});
      for(const [scope,path] of [
        ["menus","/menus/v2/metadata"],["labor","/labor/v1/employees"],
        ["config","/config/v2/voidReasons"]
      ] as const){
        try {
          await client.request(path,guid,z.unknown(),{allowUnverified:true});
        }catch(err) {
          if(err instanceof ToastApiError&&["missing_scope_or_location","missing_permissions"].includes(err.category))
            scopesAvailable[scope]=false;
          else throw err;
        }
      }

    }
    const at=new Date().toISOString();
    for(const mapping of mappings) {
      const {error:save}=await db.from("toast_location_mappings")
        .update({verified_at:at}).eq("business_id",businessId).eq("restaurant_guid",mapping.restaurant_guid);
      if(save)throw new ToastApiError("unavailable");
    }
    const {error:updated}=await db.from("toast_api_credentials").update({
      state:"verified",last_verified_at:at,last_error_category:null,scopes_available:scopesAvailable
    }).eq("business_id",businessId);
    if(updated)throw new ToastApiError("unavailable");
    for(const mapping of mappings){
      const {error:retryError}=await db.rpc("toast_requeue_failed",{
        p_business_id:businessId,p_restaurant_guid:mapping.restaurant_guid});
      if(retryError)throw new ToastApiError("unavailable");
    }
    return json(200,{state:"verified",locationsVerified:mappings.length,scopesAvailable});
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
