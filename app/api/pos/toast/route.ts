import {NextResponse} from "next/server";
import {encryptToken} from "@/lib/security/tokenCrypto";
import {authorizeToastOwner,setupSchema} from "@/lib/pos/toast/ownerAccess";
import {GUID,trustedToastOrigin,ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request) {
  const id=new URL(request.url).searchParams.get("businessId")??"";
  const db=await authorizeToastOwner(id);
  if(!db)return reply(403,{error:"not_authorized"});
  const {data:c,error}=await db.from("toast_api_credentials")
    .select("api_origin,state,last_verified_at,last_error_category,updated_at,retry_after")
    .eq("business_id",id).maybeSingle();
  if(error)return reply(503,{error:"temporarily_unavailable"});
  const {data:locations,error:locError}=await db.from("toast_location_mappings")
    .select("location_id,restaurant_guid,verified_at").eq("business_id",id);
  if(locError)return reply(503,{error:"temporarily_unavailable"});
  const {data:health,error:healthError}=await db.from("toast_sync_health")
    .select("restaurant_guid,last_order_fetch_at,last_time_entry_fetch_at,last_schedule_fetch_at,last_menu_fetch_at,last_failure_category")
    .eq("business_id",id);
  if(healthError)return reply(503,{error:"temporarily_unavailable"});
  return reply(200,{state:c?.state??"not_connected",apiOrigin:c?.api_origin??null,
    lastVerifiedAt:c?.last_verified_at??null,lastErrorCategory:c?.last_error_category??null,
    retryAfter:c?.retry_after??null,locations:locations??[],syncLocations:health??[]});
}
export async function POST(request:Request){
  if(process.env.TOAST_SETUP_ENABLED!=="true")return reply(503,{error:"setup_disabled"});
  if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
    return reply(415,{error:"invalid_request"});
  const body=await request.json().catch(()=>null);
  const parsed=setupSchema.safeParse(body);
  if(!parsed.success)return reply(400,{error:"invalid_request"});
  const payload=parsed.data;
  const db=await authorizeToastOwner(payload.businessId);
  if(!db)return reply(403,{error:"not_authorized"});
  let origin:string;
  try {origin=trustedToastOrigin(payload.apiUrl);}
  catch(e){return reply(400,{error:e instanceof ToastApiError?e.category:"invalid_host"});}
  const uniqueLocations=new Set(payload.locations.map(l=>l.location_id));
  const uniqueRestaurants=new Set(payload.locations.map(l=>l.restaurant_guid));
  if(uniqueLocations.size!==payload.locations.length||uniqueRestaurants.size!==payload.locations.length)
    return reply(400,{error:"duplicate_location"});
  const {data:owned,error:locError}=await db.from("locations").select("id")
    .eq("business_id",payload.businessId).in("id",payload.locations.map(l=>l.location_id));
  if(locError)return reply(503,{error:"temporarily_unavailable"});
  if((owned??[]).length!==payload.locations.length)return reply(400,{error:"invalid_location"});
  // SQL handles mapping and credential changes in one transaction; any error rolls back both.
  const {error:saveError}=await db.rpc("toast_save_configuration",{
    p_business_id:payload.businessId,p_origin:origin,p_client_id:payload.clientId,
    p_secret_enc:encryptToken(payload.clientSecret),p_mappings:payload.locations,
  });
  if(saveError)return reply(422,{error:"configuration_not_saved"});
  return reply(200,{state:"configured",locationsConfigured:payload.locations.length});
}
export async function DELETE(request:Request){
  const parsed=GUID.safeParse(new URL(request.url).searchParams.get("businessId"));
  if(!parsed.success)return reply(400,{error:"invalid_request"});
  const db=await authorizeToastOwner(parsed.data);
  if(!db)return reply(403,{error:"not_authorized"});
  const {error}=await db.from("toast_api_credentials").delete().eq("business_id",parsed.data);
  if(error)return reply(503,{error:"temporarily_unavailable"});
  return reply(200,{state:"disconnected"});
}
