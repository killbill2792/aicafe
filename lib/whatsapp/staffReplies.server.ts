import "server-only";
import {createHmac,randomUUID} from "node:crypto";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {Incoming} from "./webhook";

type StaffText=Extract<Incoming,{type:"message"}>;
/** A signed worker report has no owner-like AI command privileges. For a free
 * text WhatsApp response, do not infer a specific shift, task, or acceptance. */
export async function acceptSignedStaffText(message:StaffText):Promise<"recorded"|"duplicate"|"unmatched">{
 if(message.kind!=="text"||!message.text)return "unmatched";
 const phone="+"+message.waId;
 const db=createAdminSupabaseClient();
 // An originally unmatched event never becomes attributable to a different
 // employee merely because someone later changed a phone or consent.
 const priorUnmatched=await db.from("staff_communication_unmatched_inbound")
  .select("provider_event_id").eq("provider_event_id",message.wamid).maybeSingle();
 if(priorUnmatched.error)throw new Error("staff_unmatched_lookup_failed");
 if(priorUnmatched.data)return "unmatched";
 const candidates=await db.from("employees").select("id,business_id")
  .eq("phone_e164",phone).eq("active",true).eq("whatsapp_opt_in",true).limit(2);
 if(candidates.error||!candidates.data)throw new Error("staff_identity_lookup_failed");
 if(candidates.data.length!==1){
  // Do not disclose a sender's text to a random tenant or owner. Preserve a
  // source receipt for diagnostics without retaining unknown person's text.
  const key=process.env.WHATSAPP_APP_SECRET;
  if(!key)throw new Error("staff_webhook_secret_missing");
  const digest=createHmac("sha256",key).update(message.waId).digest("hex");
  const {error}=await db.from("staff_communication_unmatched_inbound").upsert({
   provider_event_id:message.wamid,sender_digest:digest,
   reason:candidates.data.length?"ambiguous_employee":"no_opted_in_employee",
  },{onConflict:"provider_event_id",ignoreDuplicates:true});
  if(error)throw new Error("staff_unmatched_receipt_failed");
  return "unmatched";
 }
 const employee=candidates.data[0];
 const {error}=await db.from("staff_communication_messages").insert({
  business_id:employee.business_id,employee_id:employee.id,
  request_id:null,actor:"employee",response_code:"report",
  body:message.text.trim(),channel:"whatsapp",client_nonce:randomUUID(),
  provider_event_id:message.wamid,received_at:message.providerAt,
 });
 if(error){
  if(error.code==="23505"){
   const prior=await db.from("staff_communication_messages")
    .select("id,employee_id,business_id,body").eq("channel","whatsapp")
    .eq("provider_event_id",message.wamid).maybeSingle();
   if(prior.error||!prior.data||prior.data.employee_id!==employee.id||
     prior.data.business_id!==employee.business_id||
     prior.data.body!==message.text.trim())
    throw new Error("staff_provider_event_collision");
   return "duplicate";
  }
  throw new Error("staff_reply_write_failed");
 }
 return "recorded";
}
