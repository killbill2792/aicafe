import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {createToastClient,GUID,ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
const expected=z.object({businessId:GUID}).strict();
export async function POST(request:Request){
  if(process.env.TOAST_SETUP_ENABLED!=="true")return json(503,{error:"setup_disabled"});
  const body=expected.safeParse(await request.json().catch(()=>null));
  if(!body.success)return json(400,{error:"invalid_request"});
  const businessId=body.data.businessId;
  const db=await authorizeToastOwner(businessId);
  if(!db)return json(403,{error:"not_authorized"});
  const {data:mappings,error}=await db.from("toast_location_mappings")
    .select("restaurant_guid").eq("business_id",businessId);
  if(error||!mappings?.length)return json(400,{error:"no_locations"});
  const client=createToastClient(db,businessId);
  const start=new Date(Date.now()-60000).toISOString(),end=new Date().toISOString();
  const query=(p:string)=>p+"?startDate="+encodeURIComponent(start)+"&endDate="+encodeURIComponent(end);
  try {
    // Verify *each* mapped location and the requested feature families. No ingestion, no writes to Toast.
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
    await db.from("toast_location_mappings").update({verified_at:null}).eq("business_id",businessId);
    await db.from("toast_api_credentials").update({
      state:category==="missing_permissions"?"missing_permissions":"needs_reconnect",
      last_error_category:category,last_verified_at:null
    }).eq("business_id",businessId);
    return json(422,{state:"not_verified",error:category});
  }
}
