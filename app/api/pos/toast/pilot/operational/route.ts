import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {stageToastRoster,stageToastCatalog} from "@/lib/pos/toast/operationalStaging";
import {GUID,ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const common=z.object({businessId:GUID,restaurantGuid:GUID});
const requestSchema=z.discriminatedUnion("action",[
 common.extend({action:z.literal("stage_roster")}).strict(),
 common.extend({action:z.literal("stage_catalog")}).strict(),
 common.extend({action:z.literal("link_employee"),employeeGuid:GUID,canonicalEmployeeId:GUID,
   confirmLink:z.literal(true)}).strict(),
 common.extend({action:z.literal("link_catalog"),kind:z.enum(["item","modifier"]),
   providerGuid:GUID,canonicalId:GUID,confirmLink:z.literal(true)}).strict(),
 common.extend({action:z.literal("import_attendance"),entryGuids:z.array(GUID).min(1).max(100),
   confirmPaidHoursImport:z.literal(true)}).strict(),
]);
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,
 headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){
 const url=new URL(request.url),businessId=url.searchParams.get("businessId")??"";
 const restaurantGuid=url.searchParams.get("restaurantGuid")??"";
 if(!GUID.safeParse(restaurantGuid).success)return reply(400,{error:"invalid_location"});
 const db=await authorizeToastOwner(businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const [staff,catalog,attendance]=await Promise.all([
  db.from("toast_employee_directory").select("employee_guid,display_name,deleted,linked_employee_id")
   .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid).limit(300),
  db.from("toast_catalog_facts").select("kind,provider_guid,name,category,price_cents,linked_menu_item_id,linked_modifier_recipe_id")
   .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid).limit(500),
  db.from("toast_attendance_review").select("external_time_entry_id,reconciliation_status,wage_status")
   .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid).limit(300)
 ]);
 if(staff.error||catalog.error||attendance.error)return reply(503,{error:"unavailable"});
 return reply(200,{roster:staff.data,catalog:catalog.data,attendance:attendance.data,
  wageUnknownIsNotZero:true,scheduledShiftsAreNotPaidHours:true});
}
export async function POST(request:Request){
 if(process.env.TOAST_PILOT_IMPORT_ENABLED!=="true")return reply(503,{error:"pilot_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
  return reply(415,{error:"invalid_request"});
 const parsed=requestSchema.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return reply(400,{error:"invalid_request"});
 const p=parsed.data,db=await authorizeToastOwner(p.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 try{
  if(p.action==="stage_roster")return reply(200,await stageToastRoster(db,p));
  if(p.action==="stage_catalog")return reply(200,await stageToastCatalog(db,p));
  if(p.action==="import_attendance"){
   if(process.env.TOAST_LABOR_CANONICAL_ENABLED!=="true")
     return reply(503,{error:"paid_attendance_import_disabled"});
   const {data,error}=await db.rpc("toast_import_confirmed_attendance",{
    p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_guids:p.entryGuids
   });
   if(error)return reply(409,{error:"attendance_requires_owner_review"});
   return reply(200,{imported:data,requiresRollupReview:true});
  }
  const action=p.action==="link_employee"?"toast_link_employee":"toast_link_catalog";
  const params=p.action==="link_employee"?{
   p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
   p_employee_guid:p.employeeGuid,p_canonical_employee_id:p.canonicalEmployeeId
  }:{
   p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
   p_kind:p.kind,p_provider_guid:p.providerGuid,p_canonical_id:p.canonicalId
  };
  const {error}=await db.rpc(action,params);
  if(error)return reply(409,{error:"mapping_requires_review"});
  return reply(200,{linked:true,canonicalWagesChanged:false,recipesChanged:false});
 }catch(e){return reply(e instanceof ToastApiError&&e.category==="rate_limited"?429:503,
  {error:e instanceof ToastApiError?e.category:"unavailable"});}
}
