import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastClient,GUID,ToastApiError} from "./client";
import {detectToastCheckMode,setToastCheckMode} from "./checkMode";
import {createToastAnalyticsClient} from "./analyticsClient";
import {toastMoneyCents} from "./adapter";
import {compareToastAnalytics,checkToastPaymentBalance,checkToastSelectionBalance} from "@/lib/calc/toastReconciliation";
import {readAllPages} from "./readAllPages";
import {localClock} from "./scheduleDates";
import {parseToastDayPage} from "./dayParser";
type Location={businessId:string;restaurantGuid:string;locationId:string;
 timeZone:string;closeoutHour:number};
type Status={import_state:string;recon_state:string;orders_snapshot_sha256:string|null;
 net_sales_cents:number;order_count:number;discounts_cents:number;refunds_cents:number;
 unparsed_count:number;warnings:Record<string,unknown>;imported_at:string|null;
 last_recon_attempt_at:string|null;internal_state?:string;
 recon_source?:string|null;analytics_state?:string|null;payment_repull_at?:string|null};
const fail=(deadlineAt:number)=>{if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");};
const day8=(date:string)=>date.replaceAll("-","");
const sum=(a:number[])=>a.reduce((x,y)=>x+y,0);
// Internal math and official Analytics are independent evidence.
// A failed external retry never dismisses a previously confirmed mismatch.
function stateWithoutFreshAnalytics(status:Status,internal:string){
 return internal==="mismatch"||
  status.recon_state==="mismatch"&&status.recon_source==="toast_analytics"
  ?"mismatch":"checked_internal";
}
/** Each cache row is generation-scoped so an interrupted 30,000-order proof resumes
 * without mixing it with a repull. No cache can promote or hide imported sales. */
function proofCache(db:SupabaseClient,p:Location,day:string,status:Status){
 const key={business_id:p.businessId,restaurant_guid:p.restaurantGuid,business_date:day,
  snapshot_tag:status.imported_at??status.orders_snapshot_sha256??"unknown"};
 const scope=()=>db.from("toast_internal_check_cache").select("cache_key,payload")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).eq("business_date",day).eq("snapshot_tag",key.snapshot_tag);
 return {key,async load(){
  const rows=await readAllPages((start,end)=>scope().order("cache_key").range(start,end));
  return new Map(rows.map(row=>[row.cache_key,row.payload as unknown]));
 },async save(cacheKey:string,payload:unknown){
  const {error}=await db.from("toast_internal_check_cache").upsert({...key,cache_key:cacheKey,payload});
  if(error)throw new ToastApiError("unavailable");
 },async clear(){
  const {error}=await db.from("toast_internal_check_cache").delete().eq("business_id",p.businessId)
   .eq("restaurant_guid",p.restaurantGuid).eq("business_date",day).eq("snapshot_tag",key.snapshot_tag);
  if(error)throw new ToastApiError("unavailable");
 }};
}
async function pullDay(db:SupabaseClient,p:Location,day:string,deadlineAt:number,
 cache:ReturnType<typeof proofCache>,cached:Map<string,unknown>){
 const client=createToastClient(db,p.businessId),all:unknown[]=[];
 for(let page=1;page<=300;page++){
  fail(deadlineAt);
  const key="orders:"+page;
  const rows=cached.has(key)?z.array(z.unknown()).parse(cached.get(key)):
   await client.request("/orders/v2/ordersBulk?businessDate="+day8(day)+
   "&pageSize=100&page="+page,p.restaurantGuid,z.array(z.unknown()),{deadlineAt});
  if(rows.length>100)throw new ToastApiError("invalid_response");
  if(!cached.has(key))await cache.save(key,rows);
  all.push(...rows);
  if(rows.length<100)break;
  if(page===300)throw new ToastApiError("invalid_response");
 }
 return all;
}
export function internalOrderProof(rows:unknown[],p:Location,day:string,
 expectedChecksum:string|null,unparsed:number){
 const parsed=parseToastDayPage(rows,p.restaurantGuid,day,p.timeZone,p.closeoutHour);
 const newest=new Map<string,(typeof parsed.orders)[number]>();
 for(const o of parsed.orders){const older=newest.get(o.guid);
  if(!older||older.modifiedDate<=o.modifiedDate)newest.set(o.guid,o);}
 const orders=[...newest.values()].sort((a,b)=>a.guid.localeCompare(b.guid));
 const checksum=createHash("sha256").update(JSON.stringify(orders)).digest("hex");
 const reasons:string[]=[];
 if(parsed.unparsed.length||unparsed)reasons.push("unparsed_orders");
 if(checksum!==expectedChecksum)reasons.push("changed_snapshot");
 const paidGuids=new Set<string>();
 for(const raw of rows){
  if(!raw||typeof raw!=="object")continue;
  const order=raw as Record<string,unknown>;
  if(order.deleted||order.voided||order.createdInTestMode||order.excessFood)continue;
  if(order.checks!=null&&!Array.isArray(order.checks))reasons.push("invalid_checks");
  for(const entry of (Array.isArray(order.checks)?order.checks:[])){
   if(!entry||typeof entry!=="object"||Array.isArray(entry)){reasons.push("invalid_checks");continue;}
   const check=entry as Record<string,unknown>;
   if(check.deleted||check.voided)continue;
   if(check.payments!=null&&!Array.isArray(check.payments))reasons.push("invalid_payments");
   const payments=(Array.isArray(check.payments)?check.payments:[])
    .filter((p):p is Record<string,unknown>=>Boolean(p)&&typeof p==="object"&&!Array.isArray(p));
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
    // Toast Orders Check.amount includes discounts and NON-gratuity
    // service charges, but excludes taxes and gratuities. Payment.amount
    // excludes tips; do not add payment.tipAmount on either side.
    const gratuities=charges.filter(c=>c.gratuity===true);
    const gratuity=gratuities.some(c=>typeof c.chargeAmount!=="number")?null:
     sum(gratuities.map(c=>toastMoneyCents(Number(c.chargeAmount))));
    const balance=checkToastPaymentBalance(
     typeof check.amount==="number"?toastMoneyCents(check.amount):null,
     typeof check.taxAmount==="number"?toastMoneyCents(check.taxAmount):null,
     gratuity,eligible.map(p=>typeof p.amount==="number"?toastMoneyCents(p.amount):null));
    if(balance==="unknown")reasons.push("unknown_check_payment_amount");
    else if(balance==="mismatch")reasons.push("check_payment_mismatch");
    const selections=Array.isArray(check.selections)?
     check.selections as Record<string,unknown>[]:[];
    // Deferred gift cards and house-account payments ARE included in the
    // guest check amount even though they are excluded from NET SALES.
    // Toast selection.price is net of all applied discounts, including check-level.
    const selectionPrices=selections.filter(sel=>!sel.voided&&!sel.deleted)
     .map(sel=>typeof sel.price==="number"?toastMoneyCents(sel.price):null);
    const chargePrices=charges.filter(sc=>sc.gratuity!==true)
     .map(sc=>typeof sc.chargeAmount==="number"?
      toastMoneyCents(sc.chargeAmount):null);
    const selectionBalance=checkToastSelectionBalance(
     typeof check.amount==="number"?toastMoneyCents(check.amount):null,
     selectionPrices,chargePrices);
    if(selectionBalance==="unknown")reasons.push("unknown_selection_amount");
    else if(selectionBalance==="mismatch")reasons.push("check_selection_mismatch");
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
 // Re-evaluate void certification on both promotion and downgrade:
 // ERA mismatches must revoke an earlier internal void certificate.
 if(patch.recon_state){
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
 const retained=stateWithoutFreshAnalytics(status,status.internal_state??"matched");
 // Once fresh credentials pass verification, a previously missing report
 // must start a new request rather than permanently short-circuiting.
 let reportId=job?.state==="missing"?null:job?.report_request_guid as string|null;
 let requested=job?.state==="missing"?null:job?.requested_at as string|null;
 if(requested&&Date.now()-Date.parse(requested)>48*3600000){
  const {error:expired}=await db.from("toast_analytics_jobs").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,business_date:day,
   report_request_guid:reportId,requested_at:requested,state:"missing",
   checked_at:new Date().toISOString(),last_error_category:"analytics_timeout"
  },{onConflict:"business_id,restaurant_guid,business_date"});
  if(expired)throw new ToastApiError("unavailable");
  await writeReconciliation(db,p,day,{
   analytics_state:"missing",recon_state:retained,
   warnings:{...status.warnings,analytics_timeout:1}
  });
  await setToastCheckMode(db,p.businessId,"internal","analytics_timeout");
  return "timeout" as const;
 }
 if(!reportId){
  requested??=new Date().toISOString();
  const {error:pendingError}=await db.from("toast_analytics_jobs").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,business_date:day,
   report_request_guid:null,requested_at:requested,
   state:"pending",checked_at:null,last_error_category:null
  },{onConflict:"business_id,restaurant_guid,business_date"});
  if(pendingError)throw new ToastApiError("unavailable");
  try{
   reportId=await client.requestDay(p.restaurantGuid,day);
  }catch(e){
   if(e instanceof ToastApiError&&e.category==="unavailable"){
    // A provider 202 without a GUID is pending, not a new day failure.
    await writeReconciliation(db,p,day,{analytics_state:"pending",
     recon_state:retained});
    return;
   }
   throw e;
  }
  if(!reportId){
   await writeReconciliation(db,p,day,{analytics_state:"pending"});return;
  }
  const {error:save}=await db.from("toast_analytics_jobs").update({
   report_request_guid:reportId
  }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
   .eq("business_date",day);
  if(save)throw new ToastApiError("unavailable");
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
    recon_state:retained,warnings:{...status.warnings,analytics_timeout:1}});
  }else await writeReconciliation(db,p,day,{analytics_state:"pending",recon_state:retained});
  return;
 }
 const match=result.rows.filter(x=>x.restaurantGuid.toLowerCase()===p.restaurantGuid.toLowerCase()&&
  x.businessDate===day8(day));
 if(match.length!==1)throw new ToastApiError("invalid_response");
 const row=match[0];
 const net=toastMoneyCents(row.netSalesAmount),discount=toastMoneyCents(row.discountAmount);
 const refunds=toastMoneyCents(row.refundAmount);

 const {data:voids,error:ve}=await db.from("toast_void_facts")
  .select("order_guid,amount_cents").eq("business_id",p.businessId)
  .eq("location_id",p.locationId).eq("order_business_date",day);
 if(ve)throw new ToastApiError("unavailable");
 const distinct=new Set((voids??[]).map(r=>r.order_guid)).size;
 const amountGap=row.voidOrdersAmount==null||(voids??[]).some(v=>v.amount_cents==null)
  ?null:toastMoneyCents(row.voidOrdersAmount)-sum((voids??[]).map(v=>Number(v.amount_cents)));
 const maxTolerance=Number(process.env.TOAST_RECON_TOLERANCE_CENTS??5);
 const tolerance=Number.isInteger(maxTolerance)&&maxTolerance>=0&&maxTolerance<=100?
  maxTolerance:5;
 const sourceIncomplete=status.unparsed_count>0||
  ["missing_check_amount","missing_deferred_price","missing_refund_amount"].some(
   k=>Number(status.warnings?.[k]??0)>0);
 const comparison=compareToastAnalytics({
  importedNetSalesCents:status.net_sales_cents,analyticsNetSalesCents:net,
  importedOrderCount:status.order_count,analyticsOrderCount:row.ordersCount,
  importedDiscountCents:status.discounts_cents,analyticsDiscountCents:discount,
  importedRefundCents:status.refunds_cents,analyticsRefundCents:refunds,
  importedVoidOrderCount:distinct,analyticsVoidOrderCount:row.voidOrdersCount,
  toleranceCents:tolerance
 });
 await writeReconciliation(db,p,day,{
  recon_state:comparison.matched&&!sourceIncomplete&&status.internal_state==="matched"?"matched":"mismatch",recon_source:"toast_analytics",
  analytics_state:"available",reconciled_at:new Date().toISOString(),last_error_category:null,
  toast_net_sales_cents:net,toast_orders_count:row.ordersCount,
  toast_discount_cents:discount,toast_refund_cents:refunds,
  delta_net_cents:comparison.deltaNetCents,delta_orders:comparison.deltaOrders,
  delta_discount_cents:comparison.deltaDiscountCents,
  delta_refund_cents:comparison.deltaRefundCents,
  delta_void_orders:comparison.deltaVoidOrders,
  void_amount_gap_cents:amountGap,
  warnings:{...Object.fromEntries(Object.entries(status.warnings).filter(([key])=>
   !["reconciliation_mismatch","source_incomplete","analytics_timeout"].includes(key))),
   ...(!comparison.matched?{reconciliation_mismatch:1}:{}),
   ...(sourceIncomplete?{source_incomplete:1}:{})}
 });
 const {error:save}=await db.from("toast_analytics_jobs").update({
  state:"available",checked_at:new Date().toISOString(),last_error_category:null
 }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("business_date",day);
 if(save)throw new ToastApiError("unavailable");
}
async function internalDay(db:SupabaseClient,p:Location,day:string,status:Status,
 deadlineAt:number){
 const cache=proofCache(db,p,day,status),cached=await cache.load();
 const rows=await pullDay(db,p,day,deadlineAt,cache,cached);
 const proof=internalOrderProof(rows,p,day,status.orders_snapshot_sha256,status.unparsed_count);
 const client=createToastClient(db,p.businessId);
 // Toast's documented endpoint returns the full GUID list, without paging parameters.
 const paid=cached.has("paid")?z.array(GUID).parse(cached.get("paid")):
  await client.request("/orders/v2/payments?paidBusinessDate="+day8(day),p.restaurantGuid,z.array(GUID),{deadlineAt});
 if(!cached.has("paid"))await cache.save("paid",paid);
 if(paid.length>20000)throw new ToastApiError("too_many_payments");
 const api=new Set(paid),details=z.object({guid:GUID,orderGuid:GUID,paidBusinessDate:z.number().int()});
 const paymentDetail=async(guid:string)=>{
  const key="payment:"+guid;
  if(cached.has(key))return details.parse(cached.get(key));
  const result=await client.request("/orders/v2/payments/"+guid,p.restaurantGuid,details,{deadlineAt});
  await cache.save(key,result);return result;
 };
 let paidOtherDay=0,unknownOrder=false;const otherDays=new Set<string>();
 const rawPayments=new Map<string,{date:string;order:string}>();
 for(const raw of rows){
  if(!raw||typeof raw!=="object")continue;
  const o=raw as {guid?:string;checks?:{payments?:{guid?:string;paidBusinessDate?:number}[]}[]};
  if(!Array.isArray(o.checks))continue;
  for(const c of o.checks){
   if(!c||typeof c!=="object"||!Array.isArray(c.payments))continue;
   for(const pay of c.payments){
    if(pay&&typeof pay==="object"&&typeof pay.guid==="string"&&typeof o.guid==="string")
     rawPayments.set(pay.guid,{date:String(pay.paidBusinessDate),order:o.guid});
   }
  }
 }
 const gap=(date:string)=>Math.abs(Date.parse(date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6)+"T12:00:00Z")-Date.parse(day+"T12:00:00Z"))/86400000;
 for(const guid of proof.paidGuids){
  if(api.has(guid))continue;
  fail(deadlineAt);
  const known=rawPayments.get(guid);
  const payment=await paymentDetail(guid);
  if(payment.guid===guid&&known&&payment.orderGuid===known.order&&gap(String(payment.paidBusinessDate))<=7&&String(payment.paidBusinessDate)!==day8(day))paidOtherDay++;
  else proof.reasons.push("payment_guid_mismatch");
 }
 // Only cross-day payments need detail calls; a 2,500-payment ordinary day needs one list read.
 for(const guid of api){
  if(proof.paidGuids.has(guid))continue;
  fail(deadlineAt);
  const payment=await paymentDetail(guid);
  if(payment.guid!==guid||String(payment.paidBusinessDate)!==day8(day)){
   proof.reasons.push("payment_guid_mismatch");continue;
  }
  // Import state and canonical order existence cannot prove an individual
  // order was read successfully: an unparsed reimport retains old rows.
  // Fetch the current provider business date for every unmatched payment.
  let remoteDate:string;
  try{
   const remote=await client.request("/orders/v2/orders/"+payment.orderGuid,p.restaurantGuid,
    z.object({guid:GUID,businessDate:z.number().int()}),{deadlineAt});
   const value=String(remote.businessDate);
   if(remote.guid!==payment.orderGuid||!/^20\d{6}$/.test(value))
    throw new ToastApiError("invalid_response");
   remoteDate=value.slice(0,4)+"-"+value.slice(4,6)+"-"+value.slice(6);
   if(Number.isNaN(Date.parse(remoteDate+"T12:00:00Z")))
    throw new ToastApiError("invalid_response");
  }catch(e){
   if(e instanceof ToastApiError&&e.status===404){
    proof.reasons.push("unknown_payment_order");continue;
   }
   throw e;
  }
  if(remoteDate===day){proof.reasons.push("unknown_payment_order");continue;}
  const {data:order,error}=await db.from("orders")
   .select("id,business_date,toast_excluded").eq("business_id",p.businessId)
   .eq("pos_order_id","toast:"+p.restaurantGuid+":"+payment.orderGuid).maybeSingle();
  if(error)throw new ToastApiError("unavailable");
  if(order?.toast_excluded===true){proof.reasons.push("unknown_payment_order");continue;}
  const canonicalDate=order?.business_date as string|null|undefined;
  if(canonicalDate&&canonicalDate!==remoteDate)otherDays.add(canonicalDate);
  if(order&&order.toast_excluded===false&&canonicalDate===remoteDate){
   const {data:other,error:oe}=await db.from("toast_day_status")
    .select("import_state,rechecking_reason,unparsed_count,coverage_complete")
    .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
    .eq("business_date",remoteDate).maybeSingle();
   if(oe)throw new ToastApiError("unavailable");
   // Full, unparsed-free replacement excludes absent orders. Partial imports
   // cannot establish whether this canonical row is merely a stale survivor.
   if(other?.import_state==="imported"&&other.unparsed_count===0&&
    other.coverage_complete===true&&!other.rechecking_reason)continue;
  }
  unknownOrder=true;otherDays.add(remoteDate);
 }
 if(unknownOrder){
  const {data:otherStatus,error:oe}=await db.from("toast_day_status").select("business_date,imported_at")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).in("business_date",[...otherDays]);
  if(oe)throw new ToastApiError("unavailable");
  // Do not keep creating recovery jobs forever when Toast never supplies a
 // complete snapshot; escalate a six-hour unresolved discrepancy to attention.
 const repulled=Boolean(status.payment_repull_at)&&(
  [...otherDays].every(date=>(otherStatus??[]).some(d=>
   d.business_date===date&&d.imported_at&&Date.parse(d.imported_at)>Date.parse(status.payment_repull_at!)))||
  Date.now()-Date.parse(status.payment_repull_at!)>6*3600000);
  if(repulled)proof.reasons.push("unknown_payment_order");
  else {
   // Let the modified-order scan import the other day before declaring a mismatch.
   const today=localClock(new Date(),p.timeZone).today;
   for(const date of new Set([...otherDays,day])){
    if(date>=today)continue;
    const {error}=await db.rpc("toast_queue_backfill",{p_business_id:p.businessId,
     p_restaurant_guid:p.restaurantGuid,p_from:date,p_to:date});
    if(error)throw new ToastApiError("unavailable");
   }
   await writeReconciliation(db,p,day,{payment_repull_at:status.payment_repull_at??new Date().toISOString(),
    recon_state:"pending",internal_state:null});return null;
  }
 }
 const internal=proof.reasons.length?"mismatch":"matched";
 await writeReconciliation(db,p,day,{
  internal_state:internal,internal_reasons:proof.reasons,paid_other_day:paidOtherDay,
  recon_state:stateWithoutFreshAnalytics(status,internal),
  recon_source:status.recon_state==="mismatch"&&status.recon_source==="toast_analytics"
   ?"toast_analytics":"internal",
  reconciled_at:new Date().toISOString(),last_error_category:null,
  warnings:{...status.warnings,...Object.fromEntries(proof.reasons.map(x=>[x,1]))}
 });
 await cache.clear();
 return internal;
}
export async function reconcileToastDays(db:SupabaseClient,p:Location,deadlineAt:number){
 let mode=await detectToastCheckMode(db,p.businessId,p.restaurantGuid,p.timeZone,deadlineAt);
 const {data:days,error:de}=await db.from("toast_day_status")
  .select("business_date,import_state,recon_state,orders_snapshot_sha256,net_sales_cents,order_count,discounts_cents,refunds_cents,unparsed_count,warnings,imported_at,last_recon_attempt_at,internal_state,payment_repull_at,analytics_state,recon_source")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("import_state","imported").is("rechecking_reason",null)
  // Supabase .or() calls overwrite the same PostgREST "or" query key.
  .or(`and(or(recon_state.in.(pending,mismatch,analytics_timeout),and(recon_state.eq.checked_internal,analytics_state.eq.pending)),or(last_recon_attempt_at.is.null,and(recon_state.eq.pending,last_recon_attempt_at.lt.${new Date(Date.now()-9*60000).toISOString()}),and(recon_state.neq.pending,last_recon_attempt_at.lt.${new Date(Date.now()-60*60000).toISOString()})))`)
  .order("last_recon_attempt_at",{ascending:true,nullsFirst:true})
  .order("business_date",{ascending:false}).limit(60);
 if(de)throw new ToastApiError("unavailable");
 let attempted=0;
 for(const item of days??[]){
  if(Date.now()>=deadlineAt)break;
  const day=item.business_date as string,status=item as Status;
  if(status.last_recon_attempt_at&&
   Date.now()-Date.parse(status.last_recon_attempt_at)<(status.recon_state==="pending"?9:60)*60000)
   continue;
  try {

   const internal=status.internal_state??await internalDay(db,p,day,status,deadlineAt);
   if(mode==="official"&&internal){
    try{if(await eraDay(db,p,day,{...status,internal_state:internal},deadlineAt)==="timeout")mode="internal";}
    catch(e){
     const category=e instanceof ToastApiError?e.category:"unavailable";
     const permissionLost=["authentication","missing_permissions"].includes(category);
     // ERA unavailable is unfinished work, not a successful reconciliation.
     // Keep the previous external mismatch visible until fresh ERA data resolves it.
     await writeReconciliation(db,p,day,{
      analytics_state:permissionLost?"missing":"pending",
      recon_state:stateWithoutFreshAnalytics(status,internal),
      last_error_category:category
     });
     if(permissionLost){
      mode="internal";
      await setToastCheckMode(db,p.businessId,"internal",category==="authentication"?
       "analytics_auth_failed":"analytics_forbidden");
     }
    }
   }
   attempted++;
  }catch(err){
   const category=err instanceof ToastApiError?err.category:"unavailable";
   const {error:mark}=await db.from("toast_day_status").update({
    last_error_category:category,last_recon_attempt_at:new Date().toISOString()
   }).eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
    .eq("business_date",day);
   if(mark)throw new ToastApiError("unavailable");
   if(["authentication","missing_permissions","missing_scope_or_location",
    "unauthorized_location","not_configured","invalid_host"].includes(category))continue;
  }
 }
 return attempted;
}
