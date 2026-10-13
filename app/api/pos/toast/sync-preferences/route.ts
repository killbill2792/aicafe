import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
export const runtime="nodejs";export const dynamic="force-dynamic";
const schema=z.object({businessId:GUID,restaurantGuid:GUID,
 kind:z.enum(["orders","attendance","schedules","catalog","roster"]),
 enabled:z.boolean(),intervalMinutes:z.number().int().min(15).max(1440)}).strict();
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,
 headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){
 const id=new URL(request.url).searchParams.get("businessId")??"";
 const db=await authorizeToastOwner(id);
 if(!db)return reply(403,{error:"not_authorized"});
 const [prefs,health,recovery,corrections]=await Promise.all([
  db.from("toast_sync_preferences").select("restaurant_guid,kind,enabled,interval_minutes,next_run_at,last_success_at,last_failure_category")
   .eq("business_id",id).limit(100),
  db.from("toast_sync_health").select("restaurant_guid,last_order_poll_at,last_time_entry_poll_at,last_schedule_poll_at,last_failure_category,retry_after")
   .eq("business_id",id).limit(50),
  db.from("toast_poll_recovery").select("restaurant_guid,kind,state,missing_since,missing_until,next_since")
   .eq("business_id",id).limit(50),
  db.from("toast_canonical_corrections").select("restaurant_guid,business_date,status")
   .eq("business_id",id).eq("status","review_required").limit(100)
 ]);
 if(prefs.error||health.error||recovery.error||corrections.error)
  return reply(503,{error:"unavailable"});
 return reply(200,{preferences:prefs.data??[],freshness:health.data??[],
  recovery:recovery.data??[],unresolvedCorrections:corrections.data??[],
  automaticallyScheduled:false,financialPromotionEnabled:false});
}
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return reply(503,{error:"setup_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
  return reply(415,{error:"invalid_request"});
 const parsed=schema.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return reply(400,{error:"invalid_request"});
 const p=parsed.data,db=await authorizeToastOwner(p.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const {error}=await db.rpc("toast_set_sync_preference",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
  p_kind:p.kind,p_enabled:p.enabled,p_interval:p.intervalMinutes
 });
 if(error)return reply(409,{error:"verified_location_required"});
 return reply(200,{saved:true,enabled:p.enabled,
  schedulerActive:process.env.TOAST_DISPATCH_ENABLED==="true"&&
    process.env.TOAST_POLLING_ENABLED==="true"});
}
