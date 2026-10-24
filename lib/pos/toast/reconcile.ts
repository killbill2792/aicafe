import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastClient,GUID,ToastApiError} from "./client";
import {createToastAnalyticsClient} from "./analyticsClient";
import {toastMoneyCents} from "./adapter";
import {parseToastDayPage,type ToastParsedOrder} from "./dayParser";
type Location={businessId:string;restaurantGuid:string;locationId:string;
 timeZone:string;closeoutHour:number};
type Status={import_state:string;recon_state:string;orders_snapshot_sha256:string|null;
 net_sales_cents:number;order_count:number;discounts_cents:number;refunds_cents:number;
 unparsed_count:number;warnings:Record<string,unknown>;imported_at:string|null;
 last_recon_attempt_at:string|null};
const fail=(deadlineAt:number)=>{if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");};
const day8=(date:string)=>date.replaceAll("-","");
const sum=(a:number[])=>a.reduce((x,y)=>x+y,0);
async function pullDay(db:SupabaseClient,p:Location,day:string,deadlineAt:number){
 const client=createToastClient(db,p.businessId),all:unknown[]=[];
 for(let page=1;page<=300;page++){
  fail(deadlineAt);
  const rows=await client.request("/orders/v2/ordersBulk?businessDate="+day8(day)+
   "&pageSize=100&page="+page,p.restaurantGuid,z.array(z.unknown()),{deadlineAt});
  if(rows.length>100)throw new ToastApiError("invalid_response");
  all.push(...rows);
  if(rows.length<100)break;
  if(page===300)throw new ToastApiError("invalid_response");
 }
 return all;
}
export function internalOrderProof(rows:unknown[],p:Location,day:string,
 expectedChecksum:string|null,unparsed:number){
 const parsed=parseToastDayPage(rows,p.restaurantGuid,day,p.timeZone,p.closeoutHour);
 const orders=[...parsed.orders].sort((a,b)=>a.guid.localeCompare(b.guid));
 const checksum=createHash("sha256").update(JSON.stringify(orders)).digest("hex");
 const reasons:string[]=[];
 if(parsed.unparsed.length||unparsed)reasons.push("unparsed_orders");
 if(checksum!==expectedChecksum)reasons.push("changed_snapshot");
 const paidGuids=new Set<string>();
 for(const raw of rows){
  if(!raw||typeof raw!=="object")continue;
  const order=raw as Record<string,unknown>;
  if(order.deleted||order.voided||order.createdInTestMode||order.excessFood)continue;
  for(const entry of (Array.isArray(order.checks)?order.checks:[])){
   const check=entry as Record<string,unknown>;
   if(check.deleted||check.voided)continue;
   const payments=Array.isArray(check.payments)?check.payments as Record<string,unknown>[]:[];
   const eligible=payments.filter(p=>!p.voided&&!["VOIDED","DENIED","CANCELLED","ERROR","ERROR_NETWORK"]
    .includes(String(p.paymentStatus??"")));
   for(const pay of eligible){
    if(typeof pay.guid!=="string"||!GUID.safeParse(pay.guid).success)
     reasons.push("missing_payment_guid");
    else paidGuids.add(pay.guid);
   }
   if(check.paymentStatus==="CLOSED"){
    const charges=Array.isArray(check.appliedServiceCharges)?
     check.appliedServiceCharges as Record<string,unknown>[]:[];
    const gratuity=sum(charges.filter(c=>c.gratuity===true&&typeof c.chargeAmount==="number")
     .map(c=>toastMoneyCents(Number(c.chargeAmount))));
    if(typeof check.amount!=="number"||typeof check.taxAmount!=="number"||
     eligible.some(p=>typeof p.amount!=="number"))
      reasons.push("unknown_check_payment_amount");
    else{
     const expected=toastMoneyCents(check.amount)+toastMoneyCents(check.taxAmount)+gratuity;
     const paymentsTotal=sum(eligible.map(p=>toastMoneyCents(Number(p.amount))));
     if(Math.abs(expected-paymentsTotal)>1)reasons.push("check_payment_mismatch");
    }
    const selections=Array.isArray(check.selections)?
     check.selections as Record<string,unknown>[]:[];
    if(selections.some(sel=>!sel.voided&&typeof sel.price!=="number"))
     reasons.push("unknown_selection_amount");
   }
  }
 }
 return {reasons:[...new Set(reasons)],paidGuids,checksum,orders};
}
async function writeReconciliation(db:SupabaseClient,p:Location,day:string,
 patch:Record<string,unknown>){
 const {error}=await db.from("toast_day_status").update({
  ...patch,last_recon_attempt_at:new Date().toISOString()
 }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("business_date",day).eq("import_state","imported");
 if(error)throw new ToastApiError("unavailable");
 if(patch.recon_state==="matched"||patch.recon_state==="checked_internal"){
  const {error:cert}=await db.rpc("toast_certify_day_voids",{
   p_business_id:p.businessId,p_date:day
  });
  if(cert)throw new ToastApiError("unavailable");
 }
}
async function eraDay(db:SupabaseClient,p:Location,day:string,status:Status,
 deadlineAt:number){
 const client=createToastAnalyticsClient(db,p.businessId,deadlineAt);
 const {data:job,error:je}=await db.from("toast_analytics_jobs")
  .select("report_request_guid,requested_at,state")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("business_date",day).maybeSingle();
 if(je)throw new ToastApiError("unavailable");
 let reportId=job?.report_request_guid as string|null;
 let requested=job?.requested_at as string|null;
 if(!reportId||job?.state==="missing"){
  reportId=await client.requestDay(p.restaurantGuid,day);
  requested=new Date().toISOString();
  const {error}=await db.from("toast_analytics_jobs").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,business_date:day,
   report_request_guid:reportId,requested_at:requested,
   state:"pending",checked_at:null,last_error_category:null
  },{onConflict:"business_id,restaurant_guid,business_date"});
  if(error)throw new ToastApiError("unavailable");
 }
 const result=await client.getDay(reportId);
 if(result.pending){
  if(requested&&Date.now()-Date.parse(requested)>48*3600000){
   const {error}=await db.from("toast_analytics_jobs").update({
    state:"missing",last_error_category:"analytics_timeout"
   }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
    .eq("business_date",day);
   if(error)throw new ToastApiError("unavailable");
   await writeReconciliation(db,p,day,{analytics_state:"missing",
    recon_state:"owner_flagged",warnings:{...status.warnings,analytics_timeout:1}});
  }else await writeReconciliation(db,p,day,{analytics_state:"pending",recon_state:"pending"});
  return;
 }
 const match=result.rows.filter(x=>x.restaurantGuid.toLowerCase()===p.restaurantGuid.toLowerCase()&&
  x.businessDate===day8(day));
 if(match.length!==1)throw new ToastApiError("invalid_response");
 const row=match[0];
 const net=toastMoneyCents(row.netSalesAmount),discount=toastMoneyCents(row.discountAmount);
 const refunds=toastMoneyCents(row.refundAmount);
 const delta=net-status.net_sales_cents,ordersDelta=row.ordersCount-status.order_count;
 const {data:voids,error:ve}=await db.from("toast_void_facts")
  .select("order_guid,amount_cents").eq("business_id",p.businessId)
  .eq("location_id",p.locationId).eq("order_business_date",day);
 if(ve)throw new ToastApiError("unavailable");
 const distinct=new Set((voids??[]).map(r=>r.order_guid)).size;
 const amountGap=row.voidOrdersAmount==null?null:
  toastMoneyCents(row.voidOrdersAmount)-sum((voids??[]).map(v=>Number(v.amount_cents??0)));
 const maxTolerance=Number(process.env.TOAST_RECON_TOLERANCE_CENTS??5);
 const tolerance=Number.isInteger(maxTolerance)&&maxTolerance>=0&&maxTolerance<=100?
  maxTolerance:5;
 const matched=Math.abs(delta)<=tolerance&&ordersDelta===0&&
  row.voidOrdersCount===distinct;
 await writeReconciliation(db,p,day,{
  recon_state:matched?"matched":"mismatch",recon_source:"toast_analytics",
  analytics_state:"available",reconciled_at:new Date().toISOString(),
  toast_net_sales_cents:net,toast_orders_count:row.ordersCount,
  toast_discount_cents:discount,toast_refund_cents:refunds,
  delta_net_cents:delta,delta_orders:ordersDelta,
  delta_discount_cents:discount-status.discounts_cents,
  delta_refund_cents:refunds-status.refunds_cents,
  delta_void_orders:row.voidOrdersCount-distinct,
  void_amount_gap_cents:amountGap,
  warnings:{...status.warnings,...(!matched?{reconciliation_mismatch:1}:{})}
 });
 const {error:save}=await db.from("toast_analytics_jobs").update({
  state:"available",checked_at:new Date().toISOString(),last_error_category:null
 }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("business_date",day);
 if(save)throw new ToastApiError("unavailable");
}
async function internalDay(db:SupabaseClient,p:Location,day:string,status:Status,
 deadlineAt:number){
 const rows=await pullDay(db,p,day,deadlineAt);
 const proof=internalOrderProof(rows,p,day,status.orders_snapshot_sha256,status.unparsed_count);
 const paid=await createToastClient(db,p.businessId).request(
  "/orders/v2/payments?paidBusinessDate="+day8(day),p.restaurantGuid,z.array(GUID).max(2000),
  {deadlineAt});
 const api=new Set(paid);
 if(api.size!==proof.paidGuids.size||[...api].some(x=>!proof.paidGuids.has(x)))
  proof.reasons.push("payment_guid_mismatch");
 await writeReconciliation(db,p,day,{
  recon_state:proof.reasons.length?"mismatch":"checked_internal",
  recon_source:"internal",reconciled_at:new Date().toISOString(),
  warnings:{...status.warnings,...Object.fromEntries(proof.reasons.map(x=>[x,1]))}
 });
}
export async function reconcileToastDays(db:SupabaseClient,p:Location,deadlineAt:number){
 const {data:cred,error:ce}=await db.from("toast_analytics_credentials")
  .select("business_id,verified_at").eq("business_id",p.businessId).maybeSingle();
 if(ce)throw new ToastApiError("unavailable");
 const {data:days,error:de}=await db.from("toast_day_status")
  .select("business_date,import_state,recon_state,orders_snapshot_sha256,net_sales_cents,order_count,discounts_cents,refunds_cents,unparsed_count,warnings,imported_at,last_recon_attempt_at")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("import_state","imported").in("recon_state",["pending","mismatch","owner_flagged"])
  .order("business_date").limit(60);
 if(de)throw new ToastApiError("unavailable");
 let attempted=0;
 for(const item of days??[]){
  if(Date.now()>=deadlineAt)break;
  const day=item.business_date as string,status=item as Status;
  if(status.last_recon_attempt_at&&
   Date.now()-Date.parse(status.last_recon_attempt_at)<(status.recon_state==="pending"?9:60)*60000)
   continue;
  try {
   if(cred?.verified_at)await eraDay(db,p,day,status,deadlineAt);
   else await internalDay(db,p,day,status,deadlineAt);
   attempted++;
  }catch(err){
   const category=err instanceof ToastApiError?err.category:"unavailable";
   const {error:mark}=await db.from("toast_day_status").update({
    last_error_category:category,last_recon_attempt_at:new Date().toISOString()
   }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
    .eq("business_date",day);
   if(mark)throw new ToastApiError("unavailable");
   if(["authentication","missing_permissions","missing_scope_or_location",
    "unauthorized_location","not_configured","invalid_host"].includes(category))break;
  }
 }
 return attempted;
}
