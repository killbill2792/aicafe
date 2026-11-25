import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastClient,GUID,ToastApiError} from "./client";
import {fetchAndIngestToastOrder} from "./orderIngestion";
import {addCalendarDays} from "./scheduleDates";
import {fromZonedTime} from "date-fns-tz";
export const paymentScanSchema=z.object({
 businessId:GUID,restaurantGuid:GUID,businessDate:z.iso.date()
}).strict();
/** Source-specific payment refund/void business dates, never invented from order close dates.
 * A payment GUID list is a review trigger, NOT a dollar settlement amount. */
export async function stageToastPaymentDateReview(db:SupabaseClient,
 p:z.infer<typeof paymentScanSchema>){
 if(p.businessDate>new Date().toISOString().slice(0,10))
   throw new ToastApiError("invalid_response");
 const client=createToastClient(db,p.businessId);
 const day=p.businessDate.replaceAll("-","");
 const results:{kind:"refunded"|"voided";count:number}[]=[];
 for(const [kind,queryKey] of [
  ["refunded","refundBusinessDate"],["voided","voidBusinessDate"]
 ] as const){
   const rows=await client.request("/orders/v2/payments?"+queryKey+"="+day,
     p.restaurantGuid,z.array(GUID).max(2000));
   // One provider response is completely validated before atomic SQL stage.
   const {error}=await db.rpc("toast_stage_payment_day_events",{
    p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
    p_date:p.businessDate,p_kind:kind,p_guids:[...new Set(rows)]
   });
   if(error)throw new ToastApiError("unavailable");
   results.push({kind,count:rows.length});
 }
 return {date:p.businessDate,results,verifiedZero:false,
   refundAmountsVerified:false,settlementAmountsVerified:false,
   financialReportingVerified:false,independentReportVerified:false,
   requiresReview:results.some(r=>r.count>0)};
}


const entrySchema=z.object({guid:GUID,adjustment:z.boolean(),
 fee:z.object({orderGuid:GUID,amountCents:z.number().int(),feeCents:z.number().int().nonnegative()}).optional()});
const progressSchema=z.object({completed_through:z.iso.date().optional(),day:z.iso.date().optional(),
 entries:z.array(entrySchema).optional(),next:z.number().int().nonnegative().optional()}).passthrough();
type Entry=z.infer<typeof entrySchema>;
type KnownPayment={payment_ref:string;payment_type:string|null;payment_status:string|null;
 original_processing_fee_cents:number|null;status:string};
export function needsFinalPaymentDetail(entry:Entry,known:KnownPayment[]){
 if(entry.adjustment||entry.fee||known.length!==1)return true;
 const row=known[0];
 if(row.status!=="actual")return true;
 const type=String(row.payment_type??"").toUpperCase().replace(/[^A-Z]/g,"");
 return !["CASH","GIFTCARD","GIFTCERTIFICATE"].includes(type)&&
  !(type==="CREDIT"&&row.payment_status==="CAPTURED"&&row.original_processing_fee_cents!=null);
}
const paymentDetailSchema=z.object({guid:GUID,orderGuid:GUID,paidBusinessDate:z.number().int(),
 type:z.string().nullish(),paymentStatus:z.string().nullish(),amount:z.number().finite().nullish(),
 originalProcessingFee:z.number().finite().nullish()});
type FinalScope={businessId:string;restaurantGuid:string;timezone:string;closeoutHour:number};
/** Run under the existing location lease, independently from the morning
 * brief. A provider-final capture read starts six hours after closeout;
 * only missing/adjusted payments need details. The cursor survives a timeout.
 * The completion marker means source review complete, not invented fee data. */
export async function finalizeToastPaymentWindow(db:SupabaseClient,p:FinalScope,closedDay:string,now:Date,deadlineAt:number){
 const ready=(day:string)=>now.getTime()>=fromZonedTime(addCalendarDays(day,1)+"T"+
  String(p.closeoutHour).padStart(2,"0")+":00:00",p.timezone).getTime()+6*3600000;
 const latest=ready(closedDay)?closedDay:addCalendarDays(closedDay,-1);
 const {data:state,error}=await db.from("toast_optional_sync_state").select("operational_sources")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(error)throw new ToastApiError("unavailable");
 const sources=(state?.operational_sources??{}) as Record<string,unknown>;
 let progress=progressSchema.parse(sources.final_payments??{});
 const save=async()=>{const {error}=await db.from("toast_optional_sync_state").upsert({
  business_id:p.businessId,restaurant_guid:p.restaurantGuid,
  operational_sources:{...sources,final_payments:progress}
 },{onConflict:"business_id,restaurant_guid"});if(error)throw new ToastApiError("unavailable");};
 if(progress.completed_through&&progress.completed_through>=latest&&!progress.day)return;
 const day=progress.day??(progress.completed_through?addCalendarDays(progress.completed_through,1):latest);
 if(day>latest||!ready(day)||Date.now()>=deadlineAt)return;
 const {data:imported,error:ie}=await db.from("toast_day_status").select("import_state")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).eq("business_date",day).maybeSingle();
 if(ie)throw new ToastApiError("unavailable");
 if(imported?.import_state!=="imported")return;
 const client=createToastClient(db,p.businessId);
 if(!progress.entries||progress.day!==day){
  const ids=new Map<string,boolean>(),events:{kind:"refunded"|"voided";guids:string[]}[]=[];
  for(const [kind,param] of [["paid","paidBusinessDate"],["refunded","refundBusinessDate"],["voided","voidBusinessDate"]] as const){
   const list=await client.request("/orders/v2/payments?"+param+"="+day.replaceAll("-",""),
    p.restaurantGuid,z.array(GUID).max(20000),{deadlineAt});
   const guids=[...new Set(list.map(g=>g.toLowerCase()))];
   for(const guid of guids)ids.set(guid,Boolean(ids.get(guid)||kind!=="paid"));
   if(kind!=="paid")events.push({kind,guids});
  }
  for(const e of events){
   const {error}=await db.rpc("toast_stage_payment_day_events",{p_business_id:p.businessId,
    p_restaurant_guid:p.restaurantGuid,p_date:day,p_kind:e.kind,p_guids:e.guids});
   if(error)throw new ToastApiError("unavailable");
  }
  progress={completed_through:progress.completed_through,day,
   entries:[...ids].map(([guid,adjustment])=>({guid,adjustment})),next:0,status:"pending",error:null};
  await save();
 }
 const entries=progress.entries!,end=Math.min(entries.length,(progress.next??0)+50);
 const remaining=entries.slice(progress.next??0,end).map(e=>e.guid);
 if(remaining.length){
  const {data:known,error:ke}=await db.from("toast_payment_facts")
   .select("payment_ref,payment_type,payment_status,original_processing_fee_cents,status")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).in("payment_ref",remaining);
  if(ke)throw new ToastApiError("unavailable");
  const byGuid=new Map<string,KnownPayment[]>();
  for(const row of (known??[]) as KnownPayment[]){const k=row.payment_ref.toLowerCase();byGuid.set(k,[...(byGuid.get(k)??[]),row]);}
  const apply=async(entry:Entry)=>{const fee=entry.fee!;
   const {data,error}=await db.rpc("toast_apply_verified_payment_fee",{p_business_id:p.businessId,
    p_restaurant_guid:p.restaurantGuid,p_order_guid:fee.orderGuid,p_payment_guid:entry.guid,
    p_amount_cents:fee.amountCents,p_fee_cents:fee.feeCents});
   if(error)throw new ToastApiError("unavailable");return data===true;};
  try{
   for(; (progress.next??0)<end&&Date.now()<deadlineAt;){
    const index=progress.next??0,entry=entries[index];
    if(!needsFinalPaymentDetail(entry,byGuid.get(entry.guid)??[])){progress.next=index+1;continue;}
    if(entry.fee){
     // The order refresh was already durably queued. Do not call Toast again
     // while its canonical order is waiting to be committed.
     if(!await apply(entry))break;
     progress.next=index+1;continue;
    }
    const payment=await client.request("/orders/v2/payments/"+entry.guid,p.restaurantGuid,paymentDetailSchema,{deadlineAt});
    if(payment.guid.toLowerCase()!==entry.guid)throw new ToastApiError("invalid_response");
    const failed=["VOIDED","DENIED","CANCELLED","ERROR","ERROR_NETWORK"].includes(String(payment.paymentStatus??""));
    if(!entry.adjustment&&String(payment.paidBusinessDate)!==day.replaceAll("-",""))
     throw new ToastApiError("invalid_response");
    if(!entry.adjustment&&failed){progress.next=index+1;continue;}
    const amount=payment.amount,fee=payment.originalProcessingFee;
    if(payment.type==="CREDIT"&&payment.paymentStatus==="CAPTURED"&&amount!=null&&fee!=null&&fee>=0){
     const verified={...entry,fee:{orderGuid:payment.orderGuid,amountCents:Math.round(amount*100),feeCents:Math.round(fee*100)}};
     const applied=await apply(verified);
     if(entry.adjustment||!applied)await fetchAndIngestToastOrder(db,p,payment.orderGuid,deadlineAt);
     if(!applied){
      entry.fee=verified.fee;
      // Save only the verified numeric receipt, never the payment response.
      break;
     }
    }else await fetchAndIngestToastOrder(db,p,payment.orderGuid,deadlineAt);
    progress.next=index+1;
   }
  }catch(e){await save();throw e;}
 }
 if((progress.next??0)>=entries.length){
  progress={completed_through:day,status:"current",last_success_at:new Date().toISOString(),error:null,count:entries.length};
 }
 await save();
}
