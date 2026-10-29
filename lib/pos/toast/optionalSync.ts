import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fromZonedTime} from "date-fns-tz";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError,type ToastFailure} from "./client";
import {copyToastPublishedMenu,copyToastStaff,copyToastAttendance,importStagedToastAttendance} from "./operationalCopy";
import {syncToastLaborReadOnly} from "./laborSync";
import {backfillToastStoredLabor} from "./laborBackfill";
import {addCalendarDays,localClock} from "./scheduleDates";

type Location={business_id:string;restaurant_guid:string;location_id:string;
 toast_time_zone:string;closeout_hour:number};
const dateSchema=z.object({restaurantGuid:GUID,lastUpdated:z.string().min(1)});
const reasonSchema=z.array(z.object({guid:GUID,name:z.string().nullish(),
 entityType:z.string().nullish()}).passthrough()).max(300);
const jobSchema=z.array(z.object({guid:GUID,title:z.string().nullish(),
 deleted:z.boolean().nullish()}).passthrough()).max(5000);
const missingScope=(e:unknown)=>e instanceof ToastApiError&&
 ["missing_permissions","missing_scope_or_location"].includes(e.category);
/** One-time catalog identity preflight before the very first sales import.
 * Normal menu, roster and labor refreshes still run after backfill.
 * Never mark first menu copied until the canonical copy completed.
 */
export async function ensureToastFirstCatalog(db:SupabaseClient,p:Location,
 now:Date,deadlineAt:number):Promise<boolean>{
 if(Date.now()>=deadlineAt)return false;
 const {data:state,error:stateError}=await db.from("toast_optional_sync_state")
  .select("menu_copied_at").eq("business_id",p.business_id)
  .eq("restaurant_guid",p.restaurant_guid).maybeSingle();
 if(stateError)throw new ToastApiError("unavailable");
 if(state?.menu_copied_at)return false;
 const {data:credentials,error:ce}=await db.from("toast_api_credentials")
  .select("scopes_available").eq("business_id",p.business_id).maybeSingle();
 if(ce)throw new ToastApiError("unavailable");
 const scopes=(credentials?.scopes_available??{}) as Record<string,boolean>;
 if(scopes.menus===false)return false;
 const metadata=await createToastClient(db,p.business_id).request(
  "/menus/v2/metadata",p.restaurant_guid,dateSchema,{deadlineAt});
 if(metadata.restaurantGuid.toLowerCase()!==p.restaurant_guid.toLowerCase())
  throw new ToastApiError("unauthorized_location");
 await copyToastPublishedMenu(db,{
  businessId:p.business_id,restaurantGuid:p.restaurant_guid,deadlineAt,
  locationId:p.location_id,timezone:p.toast_time_zone});
 const local=localClock(now,p.toast_time_zone);
 const {error}=await db.from("toast_optional_sync_state").upsert({
  business_id:p.business_id,restaurant_guid:p.restaurant_guid,
  menu_last_updated:metadata.lastUpdated,menu_checked_local_day:local.today,
  menu_copied_at:new Date().toISOString(),
 },{onConflict:"business_id,restaurant_guid"});
 if(error)throw new ToastApiError("unavailable");
 return true;
}

export async function syncToastOptionalSources(db:SupabaseClient,p:Location,
 now:Date,deadlineAt:number){
 if(Date.now()>=deadlineAt)return {menu:"deferred",labor:"deferred"};
 const {data:credentials,error:ce}=await db.from("toast_api_credentials")
  .select("scopes_available").eq("business_id",p.business_id).maybeSingle();
 if(ce)throw new ToastApiError("unavailable");
 const scopes=(credentials?.scopes_available??{}) as Record<string,boolean>;
 const local=localClock(now,p.toast_time_zone);
 const {data:state,error:se}=await db.from("toast_optional_sync_state")
  .select("menu_last_updated,menu_checked_local_day,roster_local_day,labor_local_day,jobs_local_day,void_reasons_local_day,menu_copied_at,roster_copied_at,attendance_copied_at")
  .eq("business_id",p.business_id).eq("restaurant_guid",p.restaurant_guid).maybeSingle();
 if(se)throw new ToastApiError("unavailable");
 const key={business_id:p.business_id,restaurant_guid:p.restaurant_guid};
 const update=async(values:Record<string,unknown>)=>{
  const {error}=await db.from("toast_optional_sync_state")
   .upsert({...key,...values},{onConflict:"business_id,restaurant_guid"});
  if(error)throw new ToastApiError("unavailable");
 };
 const phaseFailures:ToastFailure[]=[];
 const recordFailure=(e:unknown)=>{
  // A scope being absent is an expected, nonfatal skip. Other failures are
  // recorded while the remaining optional source families still get a chance.
  if(!missingScope(e))
   phaseFailures.push(e instanceof ToastApiError?e.category:"unavailable");
 };
 let menu="scope_missing",labor="scope_missing";
 let staffReady=Boolean(state?.roster_copied_at);
 const scope={businessId:p.business_id,restaurantGuid:p.restaurant_guid,deadlineAt,
  locationId:p.location_id,timezone:p.toast_time_zone};
 if(scopes.menus!==false&&Date.now()<deadlineAt){
  try{
   const meta=await createToastClient(db,p.business_id)
    .request("/menus/v2/metadata",p.restaurant_guid,dateSchema,{deadlineAt});
   if(meta.restaurantGuid.toLowerCase()!==p.restaurant_guid.toLowerCase())
    throw new ToastApiError("unauthorized_location");
   if(!state?.menu_copied_at||meta.lastUpdated!==state?.menu_last_updated||state?.menu_checked_local_day!==local.today){
    await copyToastPublishedMenu(db,scope);
    await update({menu_last_updated:meta.lastUpdated,menu_checked_local_day:local.today,
     menu_copied_at:new Date().toISOString()});
    menu="updated";
   }else menu="unchanged";

  }catch(e){recordFailure(e);}
 }
 if(scopes.labor!==false&&Date.now()<deadlineAt){
  if(!state?.roster_copied_at||state?.roster_local_day!==local.today){
   try{await copyToastStaff(db,scope);await update({roster_local_day:local.today,
    roster_copied_at:new Date().toISOString()});staffReady=true;}
   catch(e){recordFailure(e);}
  }
  if(state?.jobs_local_day!==local.today&&Date.now()<deadlineAt){
   try{
    const rows=await createToastClient(db,p.business_id).request("/labor/v1/jobs",
     p.restaurant_guid,jobSchema,{deadlineAt});
    const normalized=rows.map(r=>({...key,job_guid:r.guid,name:r.title??null,
     deleted:Boolean(r.deleted),fetched_at:now.toISOString()}));
    for(let i=0;i<normalized.length;i+=100){
     const {error}=await db.from("toast_job_directory")
      .upsert(normalized.slice(i,i+100),{onConflict:"business_id,restaurant_guid,job_guid"});
     if(error)throw new ToastApiError("unavailable");
    }
    await update({jobs_local_day:local.today});
   }catch(e){recordFailure(e);}
  }
  if(staffReady&&(!state?.attendance_copied_at||state?.labor_local_day!==local.today)&&Date.now()<deadlineAt){
   try{
    if(!state?.attendance_copied_at){
     // Legacy checks may have staged months of attendance without linking it.
     // Import it after the roster copy, before depending on any API response.
     await importStagedToastAttendance(db,scope);
     const {error:linkedError}=await db.rpc("toast_resolve_linked_timecard_reviews",{
      p_business_id:p.business_id,p_restaurant_guid:p.restaurant_guid});
     if(linkedError)throw new ToastApiError("unavailable");
    }
    const day=addCalendarDays(local.today,-1);
    const start=fromZonedTime(day+"T"+String(p.closeout_hour).padStart(2,"0")+":00:00",
      p.toast_time_zone);
    const end=fromZonedTime(local.today+"T"+String(p.closeout_hour).padStart(2,"0")+":00:00",
      p.toast_time_zone);
    // The canonical importer always replays all staged entries after staff linking.
    await copyToastAttendance(db,scope,{since:start,until:end});
    if(Date.now()<deadlineAt)
     await copyToastAttendance(db,scope,
      {since:new Date(now.getTime()-7*86400000),until:now},"modified");
    if(Date.now()<deadlineAt)
     await syncToastLaborReadOnly(db,scope,
      {since:new Date(now.getTime()-86400000),until:new Date(now.getTime()+6*86400000)},"schedules");
    const {error:reviewsError}=await db.rpc("toast_resolve_linked_timecard_reviews",{
     p_business_id:p.business_id,p_restaurant_guid:p.restaurant_guid});
    if(reviewsError)throw new ToastApiError("unavailable");
    await update({labor_local_day:local.today,attendance_copied_at:new Date().toISOString()});
    labor="synced";
   }catch(e){recordFailure(e);}
  }
 }
 if(scopes.labor!==false&&staffReady&&Date.now()<deadlineAt){
  try{
   await backfillToastStoredLabor(db,{...scope,timeZone:p.toast_time_zone},
    deadlineAt);
  }catch(e){recordFailure(e);}
 }
 if(scopes.labor!==false&&Date.now()<deadlineAt){
  try{
   const {error}=await db.rpc("toast_queue_attendance_repair",{
    p_business_id:p.business_id,p_restaurant_guid:p.restaurant_guid,p_limit:25});
   if(error)throw new ToastApiError("unavailable");
  }catch(e){recordFailure(e);}
 }
 if(scopes.config!==false&&state?.void_reasons_local_day!==local.today&&
  Date.now()<deadlineAt){
  try{
   const reasons=await createToastClient(db,p.business_id).request(
    "/config/v2/voidReasons",p.restaurant_guid,reasonSchema,{deadlineAt});
   if(reasons.length>=300)throw new ToastApiError("invalid_response");
   for(let offset=0;offset<reasons.length;offset+=100){
    const rows=reasons.slice(offset,offset+100).map(r=>({
     ...key,reason_guid:r.guid,name:r.name??null,
     entity_type:r.entityType??null,fetched_at:now.toISOString()
    }));
    const {error}=await db.from("toast_void_reason_directory").upsert(rows,{
     onConflict:"business_id,restaurant_guid,reason_guid"
    });
    if(error)throw new ToastApiError("unavailable");
   }
   await update({void_reasons_local_day:local.today});
  }catch(e){recordFailure(e);}
 }
 if(phaseFailures.length)throw new ToastApiError(phaseFailures[0]);
 return {menu,labor};
}
