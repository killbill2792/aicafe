import "server-only";
import {redactToastRaw} from "./redact";
import {stableToastOrderPage} from "./stableOrder";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError} from "./client";
import {parseToastDayPage,type ToastParsedOrder,type ToastUnparsed,type ToastVoidFact} from "./dayParser";
import {recomputeDailyRollup} from "../rollup";
import {afterToastImport} from "./afterImport";
import {readAllPages} from "./readAllPages";

const daySchema=z.iso.date();
type Params={businessId:string;locationId:string;restaurantGuid:string;businessDate:string;runId:string;deadlineAt?:number};
type StoredPage={page:number;payload:unknown[]};
type RevisionWork={revision:{only:boolean;orders:Record<string,unknown>};token:string};
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
/** Exact existing parser/checksum proof; no missing historical records may be
 * turned into a zero or erased by a partial provider revision. */
export function buildRevisionPages(baseline:unknown[],revisions:Record<string,unknown>,checksum:string,
 scope:{restaurantGuid:string;businessDate:string;timezone:string;closeoutHour:number}):StoredPage[]|null{
 const {restaurantGuid,businessDate,timezone,closeoutHour}=scope;
 const parse=(rows:unknown[])=>parseToastDayPage(rows,restaurantGuid,businessDate,timezone,closeoutHour);
 const before=parse(baseline);
 if(before.unparsed.length||before.orders.length!==baseline.length)return null;
 const seen=new Map<string,ToastParsedOrder>();
 for(const record of before.orders){
  const prev=seen.get(record.guid);
  if(!prev||prev.modifiedDate<=record.modifiedDate)seen.set(record.guid,record);
 }
 const sorted=[...seen.values()].sort((a,b)=>a.guid.localeCompare(b.guid));
 if(seen.size!==baseline.length||createHash("sha256").update(JSON.stringify(sorted)).digest("hex")!==checksum)return null;
 const source=new Map<string,unknown>(baseline.map(row=>[(row as {guid:string}).guid.toLowerCase(),row]));
 for(const [key,row] of Object.entries(revisions)){
  const parsed=parse([row]);
  if(parsed.unparsed.length||parsed.orders.length!==1||parsed.orders[0].guid.toLowerCase()!==key.toLowerCase())return null;
  const prior=seen.get(parsed.orders[0].guid);
  if(!prior||prior.modifiedDate<=parsed.orders[0].modifiedDate)source.set(key.toLowerCase(),row);
 }
 const rows=[...source.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,row])=>row);
 const pages:StoredPage[]=[];
 for(let start=0;start<=rows.length;start+=100)pages.push({page:pages.length+1,payload:rows.slice(start,start+100)});
 return pages.length<=300?pages:null;
}
async function beginRevision(db:SupabaseClient,p:Params,force=false):Promise<RevisionWork>{
 const {data,error}=await db.rpc("toast_begin_revision_import",{p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
  p_date:p.businessDate,p_run_id:p.runId,p_force_full:force});
 if(error||typeof data?.token!=="string"||typeof data.revision?.only!=="boolean"||!data.revision.orders)
  throw new ToastApiError("unavailable");
 return data as RevisionWork;
}
async function localRevisionPages(db:SupabaseClient,p:Params,work:RevisionWork,timezone:string,closeoutHour:number){
 const {data:base,error}=await db.from("toast_day_status")
  .select("import_state,coverage_complete,unparsed_count,last_import_run_id,orders_snapshot_sha256")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).eq("business_date",p.businessDate).maybeSingle();
 if(error)throw new ToastApiError("unavailable");
 if(!base||base.import_state!=="imported"||!base.coverage_complete||base.unparsed_count!==0||
    !GUID.safeParse(base.last_import_run_id).success||typeof base.orders_snapshot_sha256!=="string")return null;
 const rows=await readAllPages((start,end)=>db.from("toast_raw_records").select("payload")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).eq("business_date",p.businessDate).eq("entity","order")
  .or("run_id.eq."+base.last_import_run_id+",seen_run_id.eq."+base.last_import_run_id).order("id").range(start,end));
 const pages=buildRevisionPages(rows.map(row=>row.payload),work.revision.orders,base.orders_snapshot_sha256,
  {restaurantGuid:p.restaurantGuid,businessDate:p.businessDate,timezone,closeoutHour});
 return pages?{pages,baseRunId:base.last_import_run_id as string}:null;
}
function tally(w:Record<string,number>,next:Record<string,number>){
 for(const [key,value] of Object.entries(next))w[key]=(w[key]??0)+value;
}
export async function importToastBusinessDay(db:SupabaseClient,p:Params){
 if(![p.businessId,p.locationId,p.restaurantGuid,p.runId].every(x=>GUID.safeParse(x).success)||
   !daySchema.safeParse(p.businessDate).success)throw new ToastApiError("invalid_response");
 const {data:m,error:me}=await db.from("toast_location_mappings")
   .select("location_id,verified_at,toast_time_zone,closeout_hour")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 const {data:run,error:re}=await db.from("toast_sync_runs").select("state,restaurant_guid,business_id,cursor,kind")
   .eq("id",p.runId).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(re||!run||!["queued","running","paused_rate_limited"].includes(run.state))
   throw new ToastApiError("unauthorized_location");
 if(me||!m?.verified_at||m.location_id!==p.locationId||
   !m.toast_time_zone||m.closeout_hour==null){
   // A revoked or mismapped location is permanent for this verified run.
   // A failure before the first HTTP request still has a durable run state.
   const {error:markError}=await db.rpc("toast_record_day_error",{
    p_run_id:p.runId,p_business_id:p.businessId,
    p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,
    p_category:"unauthorized_location",p_run_fatal:true,p_skip:false
   });
   if(markError)throw new ToastApiError("unavailable");
   throw new ToastApiError("unauthorized_location");
 }
 const client=createToastClient(db,p.businessId);
 const pageSchema=z.array(z.unknown());
 const pages:StoredPage[]=[];
 const deadlineAt=p.deadlineAt??Date.now()+240000;
 let page=1;
 let revision:RevisionWork|null=null,localBase:string|null=null;
 try{
  if(run.kind==="repull_modified"){
   revision=await beginRevision(db,p);
   if(revision.revision.only){
    const local=await localRevisionPages(db,p,revision,m.toast_time_zone,m.closeout_hour);
    if(local){pages.push(...local.pages);localBase=local.baseRunId;}
    else revision=await beginRevision(db,p,true);
   }
  }
  for(;!localBase&&page<=300;page++){
   if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
   const {data:staged,error:se}=await db.from("toast_day_pages").select("payload")
     .eq("run_id",p.runId).eq("business_date",p.businessDate).eq("page",page).maybeSingle();
   if(se)throw new ToastApiError("unavailable");
   const fetched=staged?.payload??await client.request(
     "/orders/v2/ordersBulk?businessDate="+p.businessDate.replaceAll("-","")+"&pageSize=100&page="+page,
     p.restaurantGuid,pageSchema,{deadlineAt});
   // Redact here, once, before anything is stored: the database only saves.
   // Redacting a whole day inside the import request exceeded its time limit.
   const redacted=redactToastRaw(fetched,0,"",undefined,"orders");
   if(!Array.isArray(redacted)||redacted.length>100)throw new ToastApiError("invalid_response");
   const payload=redacted;
   if(!staged){
    const {error:saved}=await db.rpc("toast_stage_day_page",{
     p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_run_id:p.runId,
     p_business_date:p.businessDate,p_page:page,p_payload:payload
    });
    if(saved){console.error("toast_stage_day_page_failed",{code:saved.code??null});throw new ToastApiError("unavailable");}
   }
   pages.push({page,payload});
   if(payload.length<100)break;
  }
  if(page>300){
   throw new ToastApiError("invalid_response");
  }
  if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
  const byGuid=new Map<string,ToastParsedOrder>();
  const unparsed:ToastUnparsed[]=[];
  for(const item of pages){
   const parsed=parseToastDayPage(stableToastOrderPage(item.payload),p.restaurantGuid,p.businessDate,
     m.toast_time_zone,m.closeout_hour);
   unparsed.push(...parsed.unparsed.map(x=>({...x,source_page:item.page})));
   for(const record of parsed.orders){
    const prev=byGuid.get(record.guid);
    if(!prev||prev.modifiedDate<=record.modifiedDate)byGuid.set(record.guid,record);
   }
  }
  const orders=[...byGuid.values()].sort((a,b)=>a.guid.localeCompare(b.guid));
  const normalized=orders.flatMap(x=>x.normalized?[x.normalized]:[]);
  const voids:ToastVoidFact[]=orders.flatMap(x=>x.voids);
  const warnings:Record<string,number>={};
  for(const item of orders)tally(warnings,item.warnings);
  if(unparsed.length)tally(warnings,{unparsed_orders:unparsed.length});
  const summary={
   order_count:normalized.length,net_sales_cents:sum(normalized.map(x=>x.netSalesCents)),
   gross_sales_cents:sum(normalized.map(x=>x.grossSalesCents)),
   discounts_cents:sum(normalized.map(x=>x.discountsCents)),
   refunds_cents:sum(normalized.map(x=>x.refundsCents)),
   tax_cents:sum(normalized.map(x=>x.taxCents)),tip_cents:sum(normalized.map(x=>x.tipCents)),
   open_check_count:sum(orders.map(x=>x.openChecks)),
   service_charges_cents:sum(orders.map(x=>x.serviceChargesCents)),
   gratuity_cents:sum(orders.map(x=>x.gratuityCents)),
   unparsed_count:unparsed.length,warnings,
   snapshot_sha256:createHash("sha256").update(JSON.stringify(orders)).digest("hex"),
   voids,refund_facts:orders.flatMap(x=>x.refundFacts),
   parsed_order_guids:orders.map(x=>x.guid),unparsed
  };
  if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
  const args={p_business_id:p.businessId,p_location_id:p.locationId,
   p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,
   p_orders:normalized,p_summary:summary,p_run_id:p.runId};
  const {data:result,error}=revision?await db.rpc("toast_commit_revision_day",{...args,
   p_revision_token:revision.token,p_base_run_id:localBase,p_local_pages:localBase?pages.map(p=>p.payload):null}):
   await db.rpc("toast_import_day",args);
  if(error){
   // The error code only (e.g. 57014 = statement timeout); never the payload.
   console.error("toast_import_day_failed",{code:error.code??null});
   throw new ToastApiError(error.code==="40001"?"timeout":"unavailable");
  }
  // The canonical day has committed. Narrow ordinary relinks to that day;
  // the existing SQL handler widens only for unresolved prior failure or
  // a catalog change. Never route a post-commit failure into import rollback.
  let linkFailed=false;
  try{
   const args={p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid};
   let linked=await db.rpc("pos_relink_toast_lines",{...args,p_business_date:p.businessDate});
   if(linked.error&&["PGRST202","42883"].includes(linked.error.code??""))
    linked=await db.rpc("pos_relink_toast_lines",args);
   if(linked.error)throw linked.error;
  }catch{
   linkFailed=true;
   try{
    const {error}=await db.from("toast_sync_phase_errors").upsert({
     business_id:p.businessId,restaurant_guid:p.restaurantGuid,
     phase:"sales_link",last_error_category:"unavailable",
     last_failed_at:new Date().toISOString(),
    },{onConflict:"business_id,restaurant_guid,phase"});
    if(error)throw error;
   }catch{console.warn("toast_sales_link_failure_not_persisted");}
  }
  let derivedRefresh={derivedRefreshPending:true,derivedRefreshNote:"derived_refresh_unavailable" as string|null};
  try{derivedRefresh=await afterToastImport(db,p.businessId,m.toast_time_zone);}
  catch{console.warn("toast_derived_refresh_pending");}
  if(linkFailed)derivedRefresh={derivedRefreshPending:true,derivedRefreshNote:"sales_link_unavailable"};
  // SQL has already committed the complete business day and advanced days_done.
  // A trigger queued cost refresh in the SAME transaction. Never route a
  // post-commit cost failure through the page-import checkpoint handler.
  const imported={orders:summary.order_count,unparsed:summary.unparsed_count,
   netSalesCents:summary.net_sales_cents,checksum:summary.snapshot_sha256,result,
   ...derivedRefresh};
  // SQL queued a generation-bound cost refresh in the same transaction.
  // The global 240s budget also bounds this derivative; never start it late.
  // The migrated import also persisted a relink generation. Leave costs
  // pending until linking is recovered; the retry renews the cost generation.
  if(linkFailed||Date.now()>=deadlineAt)return {...imported,costsPending:true};
  let generation:string|null=null;
  try{
   const {data:job,error:queueError}=await db.from("toast_rollup_refresh_jobs")
    .select("generation").eq("business_id",p.businessId)
    .eq("business_date",p.businessDate).maybeSingle();
   if(queueError||!job?.generation)return {...imported,costsPending:true};
   generation=job.generation;
   const {data:rollup,error:rollupError}=await db.from("daily_rollups")
    .select("sales_data_status").eq("business_id",p.businessId)
    .eq("business_date",p.businessDate).maybeSingle();
   if(rollupError||!rollup||!["actual","missing"].includes(rollup.sales_data_status))
    throw new ToastApiError("unavailable");
   await recomputeDailyRollup(db,p.businessId,p.businessDate,{
    salesDataStatus:rollup.sales_data_status as "actual"|"missing"
   });
   const {data:ack,error:ackError}=await db.rpc("toast_ack_rollup_refresh",{
    p_business_id:p.businessId,p_business_date:p.businessDate,p_generation:generation});
   return {...imported,costsPending:Boolean(ackError||ack!==true)};
  }catch{
   if(generation){
    try{
     await db.rpc("toast_defer_rollup_refresh",{
      p_business_id:p.businessId,p_business_date:p.businessDate,
      p_generation:generation,p_category:"unavailable"});
    }catch{ /* The trigger-owned queue remains durable if deferral itself fails. */ }
   }
   return {...imported,costsPending:true};
  }
 }catch(err){
  const category=err instanceof ToastApiError?err.category:"unavailable";
  const fatal=["authentication","missing_permissions","missing_scope_or_location",
   "unauthorized_location","invalid_host","not_configured"].includes(category);
  const args={p_run_id:p.runId,p_business_id:p.businessId,
   p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate};
  // This RPC locks the day to protect any previously imported, good snapshot.
  // A bad shape is day-local: skip it without ending a multi-day backfill.
  const saved=fatal||category==="invalid_response"
   ?await db.rpc("toast_record_day_error",{...args,p_category:category,
      p_run_fatal:fatal,p_skip:!fatal})
   :await db.rpc("toast_checkpoint_day",{...args,p_page:Math.min(page,300),
      p_category:category,p_retry_at:err instanceof ToastApiError?err.retryAt:null});
  if(saved.error)throw new ToastApiError("unavailable");
  throw err;
 }
}
