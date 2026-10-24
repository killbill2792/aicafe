import "server-only";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError} from "./client";
import {parseToastDayPage,type ToastParsedOrder,type ToastUnparsed,type ToastVoidFact} from "./dayParser";
import {recomputeDailyRollup} from "../rollup";

const daySchema=z.iso.date();
type Params={businessId:string;locationId:string;restaurantGuid:string;businessDate:string;runId:string};
type StoredPage={page:number;payload:unknown[]};
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
function tally(w:Record<string,number>,next:Record<string,number>){
 for(const [key,value] of Object.entries(next))w[key]=(w[key]??0)+value;
}
export async function importToastBusinessDay(db:SupabaseClient,p:Params){
 if(![p.businessId,p.locationId,p.restaurantGuid,p.runId].every(x=>GUID.safeParse(x).success)||
   !daySchema.safeParse(p.businessDate).success)throw new ToastApiError("invalid_response");
 const {data:m,error:me}=await db.from("toast_location_mappings")
   .select("location_id,verified_at,toast_time_zone,closeout_hour")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(me||!m?.verified_at||m.location_id!==p.locationId||
   !m.toast_time_zone||m.closeout_hour==null)throw new ToastApiError("unauthorized_location");
 const {data:run,error:re}=await db.from("toast_sync_runs").select("state,restaurant_guid,business_id,cursor")
   .eq("id",p.runId).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(re||!run||!["queued","running","paused_rate_limited"].includes(run.state))
   throw new ToastApiError("unauthorized_location");
 const client=createToastClient(db,p.businessId);
 const pageSchema=z.array(z.unknown());
 const pages:StoredPage[]=[];
 const deadlineAt=Date.now()+240000;
 let page=1;
 try{
  for(;page<=300;page++){
   const {data:staged,error:se}=await db.from("toast_day_pages").select("payload")
     .eq("run_id",p.runId).eq("business_date",p.businessDate).eq("page",page).maybeSingle();
   if(se)throw new ToastApiError("unavailable");
   const payload=staged?.payload??await client.request(
     "/orders/v2/ordersBulk?businessDate="+p.businessDate.replaceAll("-","")+"&pageSize=100&page="+page,
     p.restaurantGuid,pageSchema,{deadlineAt});
   if(payload.length>100)throw new ToastApiError("invalid_response");
   if(!staged){
    const {error:saved}=await db.rpc("toast_stage_day_page",{
     p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_run_id:p.runId,
     p_business_date:p.businessDate,p_page:page,p_payload:payload
    });
    if(saved)throw new ToastApiError("unavailable");
   }
   pages.push({page,payload});
   if(payload.length<100)break;
  }
  if(page>300){
   await db.rpc("toast_mark_day_failed",{p_business_id:p.businessId,
    p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,
    p_run_id:p.runId,p_category:"too_large"});
   throw new ToastApiError("invalid_response");
  }
  const byGuid=new Map<string,ToastParsedOrder>();
  const unparsed:ToastUnparsed[]=[];
  for(const item of pages){
   const parsed=parseToastDayPage(item.payload,p.restaurantGuid,p.businessDate,
     m.toast_time_zone,m.closeout_hour);
   unparsed.push(...parsed.unparsed);
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
  const {data:result,error}=await db.rpc("toast_import_day",{
   p_business_id:p.businessId,p_location_id:p.locationId,
   p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,
   p_orders:normalized,p_summary:summary,p_run_id:p.runId
  });
  if(error)throw new ToastApiError("unavailable");
  // The SQL transaction fixes canonical revenue and coverage first. Rebuild
  // ingredient, labor and processing-fee costs from the same active orders.
  // Explicit status is mandatory: recompute's inference from nonzero revenue
  // must not promote an incomplete day from 'missing' to 'actual'.
  const {data:rollup,error:rollupError}=await db.from("daily_rollups")
    .select("sales_data_status").eq("business_id",p.businessId)
    .eq("business_date",p.businessDate).maybeSingle();
  if(rollupError||!rollup||!["actual","missing"].includes(rollup.sales_data_status))
    throw new ToastApiError("unavailable");
  await recomputeDailyRollup(db,p.businessId,p.businessDate,{
    salesDataStatus:rollup.sales_data_status as "actual"|"missing"
  });
  return {orders:summary.order_count,unparsed:summary.unparsed_count,
   netSalesCents:summary.net_sales_cents,checksum:summary.snapshot_sha256,result};
 }catch(err){
  if(err instanceof ToastApiError&&err.category==="rate_limited"){
   await db.rpc("toast_pause_day_run",{p_run_id:p.runId,p_business_id:p.businessId,
    p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,p_page:page,
    p_resume_at:err.retryAt});
  }
  throw err;
 }
}
