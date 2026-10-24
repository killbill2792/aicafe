import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fromZonedTime} from "date-fns-tz";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError,type ToastFailure} from "./client";
import {stageToastCatalog,stageToastRoster} from "./operationalStaging";
import {syncToastLaborReadOnly} from "./laborSync";
import {addCalendarDays,localClock} from "./scheduleDates";

type Location={business_id:string;restaurant_guid:string;location_id:string;
 toast_time_zone:string;closeout_hour:number};
const dateSchema=z.object({restaurantGuid:GUID,lastUpdated:z.string().min(1)});
const reasonSchema=z.array(z.object({guid:GUID,name:z.string().nullish(),
 entityType:z.string().nullish()}).passthrough()).max(300);
const jobSchema=z.array(z.object({guid:GUID,name:z.string().nullish(),
 deleted:z.boolean().nullish()}).passthrough()).max(5000);
const missingScope=(e:unknown)=>e instanceof ToastApiError&&
 ["missing_permissions","missing_scope_or_location"].includes(e.category);
export async function syncToastOptionalSources(db:SupabaseClient,p:Location,
 now:Date,deadlineAt:number){
 if(Date.now()>=deadlineAt)return {menu:"deferred",labor:"deferred"};
 const {data:credentials,error:ce}=await db.from("toast_api_credentials")
  .select("scopes_available").eq("business_id",p.business_id).maybeSingle();
 if(ce)throw new ToastApiError("unavailable");
 const scopes=(credentials?.scopes_available??{}) as Record<string,boolean>;
 const local=localClock(now,p.toast_time_zone);
 const {data:state,error:se}=await db.from("toast_optional_sync_state")
  .select("menu_last_updated,menu_checked_local_day,roster_local_day,labor_local_day,jobs_local_day,void_reasons_local_day")
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
 const scope={businessId:p.business_id,restaurantGuid:p.restaurant_guid,deadlineAt};
 if(scopes.menus!==false&&state?.menu_checked_local_day!==local.today){
  try{
   const meta=await createToastClient(db,p.business_id)
    .request("/menus/v2/metadata",p.restaurant_guid,dateSchema,{deadlineAt});
   if(meta.restaurantGuid.toLowerCase()!==p.restaurant_guid.toLowerCase())
    throw new ToastApiError("unauthorized_location");
   if(meta.lastUpdated!==state?.menu_last_updated){
    await stageToastCatalog(db,scope);
    menu="updated";
   }else menu="unchanged";
   await update({menu_last_updated:meta.lastUpdated,menu_checked_local_day:local.today});
  }catch(e){recordFailure(e);}
 }
 if(scopes.labor!==false&&Date.now()<deadlineAt){
  if(state?.roster_local_day!==local.today){
   try{await stageToastRoster(db,scope);await update({roster_local_day:local.today});}
   catch(e){recordFailure(e);}
  }
  if(state?.jobs_local_day!==local.today&&Date.now()<deadlineAt){
   try{
    const rows=await createToastClient(db,p.business_id).request("/labor/v1/jobs",
     p.restaurant_guid,jobSchema,{deadlineAt});
    const normalized=rows.map(r=>({...key,job_guid:r.guid,name:r.name??null,
     deleted:Boolean(r.deleted),fetched_at:now.toISOString()}));
    for(let i=0;i<normalized.length;i+=100){
     const {error}=await db.from("toast_job_directory")
      .upsert(normalized.slice(i,i+100),{onConflict:"business_id,restaurant_guid,job_guid"});
     if(error)throw new ToastApiError("unavailable");
    }
    await update({jobs_local_day:local.today});
   }catch(e){recordFailure(e);}
  }
  if(state?.labor_local_day!==local.today&&Date.now()<deadlineAt){
   try{
    const day=addCalendarDays(local.today,-1);
    const start=fromZonedTime(day+"T"+String(p.closeout_hour).padStart(2,"0")+":00:00",
      p.toast_time_zone);
    const end=fromZonedTime(local.today+"T"+String(p.closeout_hour).padStart(2,"0")+":00:00",
      p.toast_time_zone);
    // Production payroll is untouched: the worker writes only provider staging.
    await syncToastLaborReadOnly(db,{...scope,locationId:p.location_id},
     {since:start,until:end},"attendance");
    if(Date.now()<deadlineAt)
     await syncToastLaborReadOnly(db,{...scope,locationId:p.location_id},
      {since:new Date(now.getTime()-7*86400000),until:now},"attendance","modified");
    await update({labor_local_day:local.today});
    labor="staged";
   }catch(e){recordFailure(e);}
  }
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
