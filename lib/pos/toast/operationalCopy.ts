import "server-only";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {GUID,createToastClient} from "./client";
import {redactToastRaw} from "./redact";
import {addCalendarDays,localClock} from "./scheduleDates";
// Existing one-object archive path is shared with operational Standard GETs.
import {affectedLocalDays} from "../timecardDay";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAdapter} from "./adapter";
import {stageToastCatalog,stageToastRoster} from "./operationalStaging";
import {syncCanonicalCatalog} from "../syncCatalog";
import {syncCanonicalEmployees} from "../syncEmployees";
import {syncToastLaborReadOnly} from "./laborSync";
import {ToastApiError} from "./client";
import {queueStaleToastLaborRollups} from "./staleLaborRecovery";

export type ToastCopyScope={businessId:string;restaurantGuid:string;locationId:string;
 timezone:string;deadlineAt?:number};
export async function copyToastPublishedMenu(db:SupabaseClient,p:ToastCopyScope){
 await stageToastCatalog(db,p); // mig 099 usage checks continue reading staging.
 return syncCanonicalCatalog(db,p.businessId,createToastAdapter({db,...p}),{restaurantGuid:p.restaurantGuid});
}
export async function copyToastStaff(db:SupabaseClient,p:ToastCopyScope){
 await stageToastRoster(db,p); // keeps pilot links and usage checks consistent.
 return syncCanonicalEmployees(db,p.businessId,createToastAdapter({db,...p}),undefined,{restaurantGuid:p.restaurantGuid});
}
/** Only closed time entries are canonical; incomplete rates remain NULL, never zero. */
export async function copyToastAttendance(db:SupabaseClient,p:ToastCopyScope,
 range:{since:Date;until:Date},mode:"historical"|"modified"="historical"){
 await syncToastLaborReadOnly(db,p,range,"attendance",mode);
 return importStagedToastAttendance(db,p);
}
/** Promote all already-staged entries, even when the Toast API has no changes. */
export async function importStagedToastAttendance(db:SupabaseClient,p:ToastCopyScope){
 const {data,error}=await db.rpc("pos_import_toast_attendance",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid
 });
 if(error)throw new ToastApiError("unavailable");
 const dates=new Set<string>();
 const info=(data??{}) as {changedIntervals?:{start:string;end:string}[];changed?:number;skipped?:number};
 for(const interval of info.changedIntervals??[]){
  for(const day of affectedLocalDays(interval.start,interval.end,p.timezone))
   dates.add(day);
 }
 // Durable jobs survive an interrupted cron slice, including corrected old dates.
 for(const date of dates){
  const {error:queueError}=await db.from("toast_rollup_refresh_jobs").upsert({
   business_id:p.businessId,business_date:date,retry_at:new Date().toISOString(),
   generation:randomUUID()
  },{onConflict:"business_id,business_date"});
  if(queueError)throw new ToastApiError("unavailable");
 }
 // Also repair rows whose canonical shifts were already correct but whose prior
 // derived cost job failed or was never scheduled. The existing durable queue owns retries.
 const staleDates=await queueStaleToastLaborRollups(db,p.businessId,p.timezone);
 return {changed:info.changed??0,skipped:info.skipped??0,affectedDates:[...dates],staleDates};
}
/** A published menu outage must not unverify credentials or block sales. */
export async function recordToastCopyFailure(db:SupabaseClient,p:ToastCopyScope,
 phase:"menu"|"roster"|"labor",error:unknown){
 const category=error instanceof ToastApiError?error.category:"unavailable";
 const {error:writeError}=await db.from("toast_sync_phase_errors").upsert({
  business_id:p.businessId,restaurant_guid:p.restaurantGuid,phase,
  last_error_category:category,last_failed_at:new Date().toISOString()
 },{onConflict:"business_id,restaurant_guid,phase"});
 if(writeError)throw writeError;
 // Surface source-copy failures on the normal owner-facing Toast health path.
 // The credential's verified state is intentionally left unchanged.
 const {error:healthError}=await db.from("toast_sync_health").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   last_attempt_at:new Date().toISOString(),last_failure_category:category,
 },{onConflict:"business_id,restaurant_guid"});
 if(healthError)throw healthError;
}

/** POS0c current-object capture. Uses the existing database stage-snapshot
 * writer, never a new raw dump or financial-total writer. */
const operationalCash=z.object({guid:GUID,amount:z.number().finite(),date:z.string().min(1)}).passthrough();
const operationalStock=z.object({guid:GUID,status:z.enum(["QUANTITY","OUT_OF_STOCK","IN_STOCK"]),
 quantity:z.number().finite().nullish()}).passthrough();
const operationalKitchen=z.object({restaurantGuid:GUID,orderGuid:GUID,selectionGuid:GUID,
 itemFulfillmentLevel:z.number().int().min(0).max(2),prepStationGuid:GUID.nullish()}).passthrough();
const operationalStation=z.object({guid:GUID}).passthrough();
const operationalAvailability=z.object({restaurantGuid:GUID,status:z.enum(["ONLINE","OFFLINE"])}).passthrough();
const operationalSchedule=z.object({acceptScheduledOrders:z.boolean().optional(),
 servicePeriods:z.array(z.unknown()).optional(),overrides:z.array(z.unknown()).optional()})
 .passthrough().refine(v=>Object.keys(v).length>0);
type OperationalStatus={next_at?:string;last_success_at?:string;last_checked_at?:string;
 status?:string;error?:string|null;count?:number;failures?:number;retry_at?:string|null};
type OperationalPlan={key:string;endpoint:string;family:string;minutes:number;
 businessDate?:string;queryDate?:boolean;schema:z.ZodType;single?:boolean;paginated?:boolean};
const DAY_MS=86400000;
function internalOperationalId(business:string,restaurant:string,endpoint:string,providerKey:string){
 const h=createHash("md5").update([business,restaurant,endpoint,providerKey].join("|")).digest("hex");
 return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join("-");
}
function nativeOperationalKey(endpoint:string,row:Record<string,unknown>,businessDate?:string):string{
 if(endpoint==="kitchen/v1/export/itemFulfillments"){
  const r=operationalKitchen.parse(row);
  return [businessDate,r.orderGuid,r.selectionGuid,r.itemFulfillmentLevel,
   r.prepStationGuid??"none"].join("|");
 }
 if(endpoint==="restaurant-availability/v1/availability"||
    endpoint==="ordermgmt-config/v1/published/orderingSchedule")return "restaurant-singleton";
 const guid=GUID.safeParse(row.guid);
 if(!guid.success)throw new ToastApiError("invalid_response");
 return guid.data.toLowerCase();
}
function operationalPlan(now:Date,timeZone:string,closeoutHour:number):OperationalPlan[]{
 const local=localClock(now,timeZone);
 const today=local.minutes<closeoutHour*60?addCalendarDays(local.today,-1):local.today;
 const yesterday=addCalendarDays(today,-1);
 return [
  {key:"cash_entries_today",endpoint:"cashmgmt/v1/entries",family:"cash",minutes:60,
   businessDate:today,queryDate:true,schema:operationalCash},
  {key:"cash_deposits_today",endpoint:"cashmgmt/v1/deposits",family:"cash",minutes:60,
   businessDate:today,schema:operationalCash},
  {key:"cash_entries_previous",endpoint:"cashmgmt/v1/entries",family:"cash",minutes:360,
   businessDate:yesterday,queryDate:true,schema:operationalCash},
  {key:"cash_deposits_previous",endpoint:"cashmgmt/v1/deposits",family:"cash",minutes:360,
   businessDate:yesterday,schema:operationalCash},
  {key:"stock_inventory",endpoint:"stock/v1/inventory",family:"stock",minutes:20,
   businessDate:today,schema:operationalStock},
  {key:"kitchen_fulfillments",endpoint:"kitchen/v1/export/itemFulfillments",family:"kitchen",minutes:15,
   businessDate:today,queryDate:true,schema:operationalKitchen},
  {key:"kitchen_stations",endpoint:"kitchen/v1/published/prepStations",family:"kitchen",minutes:1440,
   businessDate:today,schema:operationalStation,paginated:true},
  {key:"online_availability",endpoint:"restaurant-availability/v1/availability",family:"availability",
   minutes:10,businessDate:today,schema:operationalAvailability,single:true},
  {key:"ordering_schedule",endpoint:"ordermgmt-config/v1/published/orderingSchedule",
   family:"ordering",minutes:360,businessDate:today,schema:operationalSchedule,single:true},
 ];
}
/** Source-native identity is retained even when the raw row needs an internal
 * UUID for the existing change journal (a restaurant singleton or KDS composite).
 * Missing/partial/204 never withdraws the last-good source object. */
export async function syncToastOperationalSources(db:SupabaseClient,
 p:ToastCopyScope & {closeoutHour:number},now:Date,deadlineAt:number){
 const {data:credentials,error:ce}=await db.from("toast_api_credentials").select("scopes_available")
  .eq("business_id",p.businessId).maybeSingle();
 if(ce)throw new ToastApiError("unavailable");
 const scopes=(credentials?.scopes_available??{}) as Record<string,boolean>;
 const {data:saved,error:se}=await db.from("toast_optional_sync_state")
  .select("operational_sources").eq("business_id",p.businessId)
  .eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(se)throw new ToastApiError("unavailable");
 const current=saved?.operational_sources;
 const states:Record<string,OperationalStatus>=current&&typeof current==="object"&&
  !Array.isArray(current)?{...current as Record<string,OperationalStatus>}:{};
 const persist=async()=>{
  const {error}=await db.from("toast_optional_sync_state").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   operational_sources:states},{onConflict:"business_id,restaurant_guid"});
  if(error)throw new ToastApiError("unavailable");
 };
 const client=createToastClient(db,p.businessId);
 const attempts:string[]=[];
 for(const op of operationalPlan(now,p.timezone,p.closeoutHour)){
  if(Date.now()>=deadlineAt)break;
  const previous=states[op.key]??{};
  // Failures have their own bounded retry clock. Never declare success by a tick.
  if(previous.next_at&&Date.parse(previous.next_at)>now.getTime())continue;
  const checked=now.toISOString();
  attempts.push(op.key);
  const allowed=scopes[op.family]!==false;
  try{
   if(!allowed)throw new ToastApiError("missing_permissions",403);
   let nextToken:string|null=null;
   let cursor:string|null=null;
   const data:Record<string,unknown>[]=[];
   for(let page=0;page<(op.paginated?25:1);page++){
    if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
    const query=op.queryDate&&op.businessDate?"?businessDate="+op.businessDate.replaceAll("-",""):
     cursor?"?pageToken="+encodeURIComponent(cursor):"";
    nextToken=null;
    const response=await client.request(op.endpoint.startsWith("/")?op.endpoint+query:
      "/"+op.endpoint+query,p.restaurantGuid,
      op.single?op.schema:z.array(op.schema).max(15000),{
       deadlineAt,onResponse:meta=>{nextToken=meta.nextPageToken;}
      });
    const rows=(op.single?[response]:response) as Array<Record<string,unknown>>;
    if(!rows.length){if(page===0)break; /* Empty terminal page is normal. */}
    for(const row of rows){
     if(typeof row.restaurantGuid==="string"&&
      row.restaurantGuid.toLowerCase()!==p.restaurantGuid.toLowerCase())
      throw new ToastApiError("unauthorized_location");
     // A row with a missing provider object key makes this capture incomplete.
     nativeOperationalKey(op.endpoint,row,op.businessDate);
     data.push(row);
    }
    if(data.length>15000)throw new ToastApiError("invalid_response");
    if(!op.paginated||!nextToken)break;
    if(nextToken===cursor||page===24)throw new ToastApiError("invalid_response");
    cursor=nextToken;
   }
   // Only complete, validated source sets are written; do NOT delete absent
   // inventory or KDS rows (Toast omits stock IN_STOCK; KDS can return 204).
   for(let offset=0;offset<data.length;offset+=200){
    const rows=data.slice(offset,offset+200).map(row=>{
     const key=nativeOperationalKey(op.endpoint,row,op.businessDate);
     const clean=redactToastRaw(row) as Record<string,unknown>;
     return {...clean,business_id:p.businessId,restaurant_guid:p.restaurantGuid,
      endpoint:op.endpoint,provider_key:key,
      source_key_kind:GUID.safeParse(row.guid).success?"provider_guid":
       op.single?"restaurant_singleton":"provider_composite",
      operational_object_uuid:GUID.safeParse(row.guid).success?undefined:
       internalOperationalId(p.businessId,p.restaurantGuid,op.endpoint,key),
      ...(op.businessDate?{business_date:op.businessDate,
       source_business_date_kind:op.queryDate?"provider_business_date":"observed_cafe_day"}:{}),
      fetched_at:checked,lastSuccessAt:checked};
    });
    const {data:written,error:writeError}=await db.rpc("toast_stage_operational_batch",{
     p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
     p_endpoint:op.endpoint,p_business_date:op.businessDate??null,p_objects:rows
    });
    if(writeError||written!==rows.length)throw new ToastApiError("unavailable");
   }
   states[op.key]={last_checked_at:checked,last_success_at:checked,
    status:data.length?"current":"empty",count:data.length,failures:0,error:null,
    next_at:new Date(now.getTime()+op.minutes*60000).toISOString()};
   await persist();
  }catch(e){
   const reason=e instanceof ToastApiError?e.category:"unavailable";
   const failures=Math.min(6,(previous.failures??0)+1);
   const retry=reason==="missing_permissions"||reason==="missing_scope_or_location"||
    e instanceof ToastApiError&&e.status===204?DAY_MS:
    Math.min(op.minutes*60000,Math.max(60000,2**failures*60000));
   const header=e instanceof ToastApiError&&e.retryAt?Date.parse(e.retryAt):NaN;
   const nextAt=Math.max(now.getTime()+retry,
    Number.isFinite(header)?header:0);
   states[op.key]={...previous,last_checked_at:checked,
    status:e instanceof ToastApiError&&e.status===204?"subscription_unavailable":reason,
    error:reason,failures,next_at:new Date(nextAt).toISOString(),
    retry_at:Number.isFinite(header)?new Date(header).toISOString():null};
   await persist();
  }
 }
 return {attempted:attempts,states};
}
