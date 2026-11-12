import "server-only";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {notifyOwner} from "@/lib/operating/notifyOwner.server";

const stableNoticeUuid=(key:string):string=>{
 const hash=createHash("sha256").update(key).digest("hex");
 return hash.slice(0,8)+"-"+hash.slice(8,12)+"-4"+hash.slice(13,16)+
  "-a"+hash.slice(17,20)+"-"+hash.slice(20,32);
};
/** Service-role cron uses the existing Operations/ai_messages delivery pair.
 * The SQL lease is NOT a send receipt; a failed partial write retries the
 * same deterministic task/message IDs instead of sending two reminders. */
export async function postVerifiedSourceReminder(db:SupabaseClient,input:{
 businessId:string;ownerUserId:string;proposalId:string;threadId:string;
 productId:string;productName:string;targetPriceCents:number;currency:string;
 approvedAt:string;now:string;timezone:string;
 sourceVerified:boolean;cancelled:boolean;
}):Promise<"not_due"|"leased_elsewhere"|"posted">{
 const {data:posted,error:priorError}=await db.from("supervisor_experiment_notice_receipts")
  .select("local_date,slot").eq("business_id",input.businessId)
  .eq("owner_user_id",input.ownerUserId).eq("source_id",input.proposalId)
  .eq("kind","price_reminder").eq("state","posted");
 if(priorError)throw new Error("reminder_receipt_read_failed");
 const next=nextOwnerPriceReminder({...input,prior:(posted??[]).map(r=>({
  localDate:r.local_date,slot:r.slot}))});
 if(!next)return "not_due";
 const {data:claim,error:claimError}=await db.rpc("supervisor_8a_claim_notice",{
  p_business_id:input.businessId,p_owner_user_id:input.ownerUserId,
  p_source_id:input.proposalId,p_kind:next.kind,
  p_local_date:next.localDate,p_slot:next.slot,
 });
 if(claimError)throw new Error("reminder_claim_failed");
 if(!claim)return "leased_elsewhere";
 const id="price-reminder:"+input.proposalId+":"+next.localDate+":"+next.slot;
 const messageId=stableNoticeUuid(input.businessId+":"+id);
 const text="Toast price update not yet verified for "+input.productName+
  ". Please confirm the exact item and size in Toast. Monitoring starts only "+
  "when a new authenticated Toast publication proves the target price; "+
  "a local confirmation does not prove the source changed.";
 try{
  await notifyOwner(db,{
   businessId:input.businessId,ownerUserId:input.ownerUserId,
   threadId:input.threadId,taskId:id,kind:"price_experiment_reminder",
   localDate:next.localDate,important:true,
  },async()=>{
   const task=await db.from("operating_tasks").upsert({
    business_id:input.businessId,id,agent_id:"alex",
    kind:"price_experiment_reminder",status:"needs_owner",confidence:"low",
    entity_type:"menu_item",entity_id:input.productId,
    payload:{proposalId:input.proposalId,threadId:input.threadId,
     targetPriceCents:input.targetPriceCents,currency:input.currency,
     ownerNoticeDate:next.localDate,slot:next.slot,
     verificationStatus:"not_verified",source:"Toast Menus V2"},
    evidence:[{source:"menu_price_history",facts:{status:"unverified"}}],
   },{onConflict:"business_id,id",ignoreDuplicates:true});
   if(task.error)throw new Error("reminder_inbox_write_failed");
   const message=await db.from("ai_messages").insert({
    id:messageId,business_id:input.businessId,thread_id:input.threadId,
    owner_user_id:input.ownerUserId,author_user_id:null,role:"supervisor",
    content_type:"blocks",text_content:null,
    structured_content:[{type:"text",text}],
    grounding:{status:"insufficient_evidence",intent:"menu_pricing",
     evidence:[{source:"operating_tasks",identifier:id,asOf:next.localDate}]},
   });
   if(message.error&&message.error.code!=="23505")
    throw new Error("reminder_message_write_failed");
  });
  const saved=await db.from("supervisor_experiment_notice_receipts").update({
   state:"posted",posted_at:new Date().toISOString(),task_id:id,
   message_id:messageId,updated_at:new Date().toISOString(),
  }).eq("business_id",input.businessId).eq("id",claim).eq("state","claimed");
  if(saved.error)throw new Error("reminder_post_receipt_failed");
  return "posted";
 }catch(error){
  const updated=await db.from("supervisor_experiment_notice_receipts").update({
   state:"failed",last_error_category:"delivery_incomplete",
   retry_at:new Date(Date.now()+10*60000).toISOString(),
   updated_at:new Date().toISOString(),
  }).eq("business_id",input.businessId).eq("id",claim).eq("state","claimed");
  if(updated.error)throw new Error("reminder_failure_receipt_unavailable");
  throw error;
 }
}

import {formatInTimeZone} from "date-fns-tz";

export type OwnerNoticeKind="price_reminder"|"toast_price_initial"|
 "toast_price_daily"|"toast_price_final";
export type OwnerNoticeKey={
 businessId:string;ownerUserId:string;sourceId:string;
 kind:OwnerNoticeKind;localDate:string;slot:number;
};
export type ReminderReceipt=Pick<OwnerNoticeKey,"localDate"|"slot">;
const HOUR=3600000;
const safeInstant=(value:string)=>{
 const result=Date.parse(value);
 if(!Number.isFinite(result))throw new Error("invalid_notice_time");
 return result;
};
const localDay=(value:string,timezone:string)=>
 formatInTimeZone(new Date(safeInstant(value)),timezone,"yyyy-MM-dd");
/** Actual first reminder is approval+2 elapsed hours, regardless of DST.
 * A later local day gets a fresh cap, never an unlimited replay backlog. */
export function nextOwnerPriceReminder(input:{
 businessId:string;ownerUserId:string;proposalId:string;
 approvedAt:string;now:string;timezone:string;
 prior:readonly ReminderReceipt[];
 sourceVerified:boolean;cancelled:boolean;
}):OwnerNoticeKey|null{
 if(input.sourceVerified||input.cancelled)return null;
 const now=safeInstant(input.now),approved=safeInstant(input.approvedAt);
 if(now<approved+2*HOUR)return null;
 const date=localDay(input.now,input.timezone);
 const priorToday=input.prior.filter(r=>r.localDate===date);
 if(priorToday.length>=2)return null;
 const slot=priorToday.length+1;
 const lastLocalDay=localDay(input.approvedAt,input.timezone);
 // On the same café-local date, do not send two messages in the first 2h
 // after approval. The next reminder requires at least two more hours.
 if(date===lastLocalDay&&now<approved+slot*2*HOUR)return null;
 // A newer local day uses the first eligible existing cron tick; it must not
 // replay both missed daily slots on one run.
 if(priorToday.some(r=>r.slot===slot))return null;
 return {businessId:input.businessId,ownerUserId:input.ownerUserId,
  sourceId:input.proposalId,kind:"price_reminder",localDate:date,slot};
}
/** Independent Toast price changes are observation events, NOT experiments.
 * Window index is a durable stable key: no rerun can make a new notification. */
export function toastObservationNoticeKey(input:{
 businessId:string;ownerUserId:string;priceHistoryId:string;
 windowIndex:number;localDate:string;final?:boolean;
}):OwnerNoticeKey{
 const {windowIndex}=input;
 if(!Number.isSafeInteger(windowIndex)||windowIndex<0||windowIndex>7)
  throw new Error("invalid_toast_observation_index");
 return {businessId:input.businessId,ownerUserId:input.ownerUserId,
  sourceId:input.priceHistoryId,localDate:input.localDate,slot:0,
  kind:input.final?"toast_price_final":windowIndex===0?
   "toast_price_initial":"toast_price_daily"};
}
