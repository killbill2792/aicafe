import type {SupabaseClient} from "@supabase/supabase-js";
import {ToastApiError} from "./client";
import {addCalendarDays} from "./scheduleDates";

/** Days imported before payment details were saved (or whose payments were
 * lost) have no Toast processing fees. Re-pull a few of them per run, newest
 * first, so every imported day gets Toast's per-payment fees. Queuing is
 * idempotent: an already queued re-pull for a day is reused. */
export const PAYMENT_GAP_LOOKBACK_DAYS=84;
export const PAYMENT_GAP_PER_RUN=5;
export async function queueToastPaymentGaps(db:SupabaseClient,
 m:{business_id:string;restaurant_guid:string},today:string,deadlineAt:number):Promise<string[]>{
 const from=addCalendarDays(today,-PAYMENT_GAP_LOOKBACK_DAYS);
 const {data:days,error}=await db.from("toast_day_status").select("business_date,order_count")
  .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
  .eq("import_state","imported").gte("business_date",from).lt("business_date",today)
  .order("business_date",{ascending:false}).limit(PAYMENT_GAP_LOOKBACK_DAYS+1);
 if(error)throw new ToastApiError("unavailable");
 const queued:string[]=[];
 for(const day of (days??[]) as Array<{business_date:string;order_count:number|null}>){
  if(queued.length>=PAYMENT_GAP_PER_RUN||Date.now()>=deadlineAt)break;
  // A day without orders has no payments to save.
  if(!(Number(day.order_count)>0))continue;
  const {count,error:countError}=await db.from("toast_payment_facts")
   .select("payment_ref",{count:"exact",head:true})
   .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
   .eq("business_date",day.business_date);
  if(countError)throw new ToastApiError("unavailable");
  if((count??0)>0)continue;
  const {error:queueError}=await db.rpc("toast_queue_owner_repull",{
   p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,p_date:day.business_date});
  if(queueError)throw new ToastApiError("unavailable");
  queued.push(day.business_date);
 }
 return queued;
}
