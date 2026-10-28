import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {determineToastPaymentFee,type ToastCardRule} from "@/lib/calc/toastPaymentFee";
import {getOwnerConfirmedProcessingFeePlans,ownerConfirmedPlanForDate} from "../processingFeeEstimate.server";
import {upsertProcessingFeeDailyFact,setProcessingFeeCandidateEligibility} from "../processingFees";
import {readAllPages} from "./readAllPages";

type Row={payment_ref:string;payment_type:string|null;card_type:string|null;
 card_entry_mode:string|null;amount_cents:number|null;
 original_processing_fee_cents:number|null};
type RawRule=Record<string,unknown>;
const isRawRule=(x:unknown):x is RawRule=>!!x&&typeof x==="object"&&!Array.isArray(x);
function parseCardRules(raw:unknown,defaultOne:boolean):ToastCardRule[]{
 if(!Array.isArray(raw))return [];
 return raw.filter(isRawRule).map(row=>({
  cardType:typeof row.cardType==="string"?row.cardType:defaultOne?"*":"",
  cardEntryMode:typeof row.cardEntryMode==="string"?row.cardEntryMode:defaultOne?"*":"",
  percentageBps:Number(row.percentageBps),fixedFeeCents:Number(row.fixedFeeCents)
 }));
}
/** Transaction-level verified Toast fees outrank an owner estimate.
 * All missing fees stay missing; never publish a partial sum as a day's total.
 */
export async function refreshToastPaymentFeeForDay(db:SupabaseClient,
 businessId:string,businessDate:string){
 const raw=await db.from("toast_payment_facts").select(
  "payment_ref,payment_type,card_type,card_entry_mode,amount_cents,original_processing_fee_cents")
  .eq("business_id",businessId).eq("business_date",businessDate)
  .order("payment_ref").range(0,0);
 if(raw.error && ["42P01","PGRST205"].includes(String(raw.error.code??"")))
  return {status:"not_installed" as const};
 if(raw.error)throw raw.error;
 const rows=await readAllPages((start,end)=>db.from("toast_payment_facts").select(
  "payment_ref,payment_type,card_type,card_entry_mode,amount_cents,original_processing_fee_cents")
  .eq("business_id",businessId).eq("business_date",businessDate)
  .order("payment_ref").range(start,end)) as Row[];
 const plans=await getOwnerConfirmedProcessingFeePlans(db,businessId);
 const plan=ownerConfirmedPlanForDate(plans,businessDate);
 let rules:ToastCardRule[]=[];
 if(plan){
  const {data,error}=await db.from("processing_fee_rate_plans")
   .select("rules").eq("business_id",businessId).eq("id",plan.id).maybeSingle();
  if(error)throw error;
  rules=parseCardRules(data?.rules,plan.rules.length===1);
 }
 const decisions=rows.map(row=>({
  row,decision:determineToastPaymentFee({
   amountCents:row.amount_cents,type:row.payment_type,
   cardType:row.card_type,cardEntryMode:row.card_entry_mode,
   originalProcessingFeeCents:row.original_processing_fee_cents
  },rules)
 }));
 for(const {row,decision} of decisions){
  const {error}=await db.from("toast_payment_facts").update({
    processing_fee_cents:decision.amountCents,fee_status:decision.status,
    fee_basis:decision.basis
  }).eq("business_id",businessId).eq("business_date",businessDate)
   .eq("payment_ref",row.payment_ref);
  if(error)throw error;
 }
 const missing=decisions.length===0||decisions.some(x=>x.decision.amountCents===null);
 if(missing){
  for(const sourceType of ["connected_pos_actual","owner_confirmed_estimate"] as const)
   await setProcessingFeeCandidateEligibility(db,{
    businessId,businessDate,sourceType,provider:"Toast",eligible:false});
  return {status:"missing" as const,count:decisions.length};
 }
 const amountCents=decisions.reduce((sum,x)=>sum+x.decision.amountCents!,0);
 const estimated=decisions.some(x=>x.decision.status==="estimated");
 await upsertProcessingFeeDailyFact(db,{
  businessId,businessDate,amountCents,
  status:estimated?"estimated":"actual",
  sourceType:estimated?"owner_confirmed_estimate":"connected_pos_actual",
  provider:"Toast",sourceReference:"toast-payment-facts:"+businessDate,
  metadata:{basis:estimated?"owner_plan":"toast",transactions:decisions.length}
 });
 // A newly estimated day must not retain a previously certified actual.
 if(estimated)await setProcessingFeeCandidateEligibility(db,{
  businessId,businessDate,sourceType:"connected_pos_actual",provider:"Toast",eligible:false});
 return {status:estimated?"estimated" as const:"actual" as const,
  amountCents,count:decisions.length};
}
