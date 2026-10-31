import "server-only";
import {createHash} from "node:crypto";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {activeBinding} from "./identity.server";
import {buttonQuestion,buildOutbound,type Outbound,type TemplateFields} from "./transport";
import {providerAllowed,sendMeta,type Channel} from "./transport.server";
import type {Incoming} from "./webhook";

const db=()=>createAdminSupabaseClient();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type InboundLease={wamid:string;binding_id:string;business_id:string;owner_user_id:string;
  thread_id:string;kind:"text"|"button"|"image"|"document";
  text_content:string|null;button_payload:string|null;media_id:string|null;
  lease_token:string;provider_at:string};
type OutboundLease={id:string;binding_id:string;business_id:string;owner_user_id:string;
  thread_id:string;kind:Channel;payload:unknown;lease_token:string;
  wa_id:string;phone_number_id:string;last_owner_message_at?:string|null};

export function stableOwnerClientMessageId(wamid:string):string {
  const bytes=Buffer.from(createHash("sha256").update("ai-cafe:whatsapp:owner:"+wamid).digest().subarray(0,16));
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const h=bytes.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function recordSignedStatus(event:Extract<Incoming,{type:"status"}>):Promise<void> {
  const {error}=await db().rpc("whatsapp_record_status",{
    p_wamid:event.wamid,p_state:event.state,
  });
  if(error)throw new Error("status_persistence_failed");
}
export async function enqueueWhatsApp(
  bindingId:string,dedupeKey:string,outbound:Outbound,provenance:Record<string,unknown>,
  inReplyTo?:string,businessDate?:string,
):Promise<string> {
  const kind:Channel=outbound.kind==="daily_brief"?"daily_brief":"reply";
  // Provenance is supplied by the canonical producer, never invented by transport.
  if(!buildOutbound("15555550123",outbound)||typeof provenance.source!=="string"||
    typeof provenance.period!=="string"||!provenance.source||!provenance.period||
    (kind==="reply"&&(!inReplyTo||businessDate!==undefined))||
    (kind==="daily_brief"&&(inReplyTo!==undefined||!businessDate||
       !/^\\d{4}-\\d{2}-\\d{2}$/.test(businessDate))))
    throw new Error("invalid_outbound");
  const {data,error}=await db().rpc("whatsapp_enqueue_outbound",{
    p_binding_id:bindingId,p_key:dedupeKey,p_kind:kind,
    p_payload:outbound.kind==="daily_brief"?{fields:outbound.fields}:{text:outbound.text},
    p_provenance:provenance,p_in_reply_to:inReplyTo??null,
    p_business_date:businessDate??null,
  });
  if(error||typeof data!=="string"||!uuid.test(data))throw new Error("queue_unavailable");
  return data;
}
export type DispatchInbound=(message:{
  wamid:string;scope:{businessId:string;ownerUserId:string};threadId:string;
  clientMessageId:string;kind:InboundLease["kind"];prompt:string|null;mediaId:string|null;
})=>Promise<{ownerMessageId:string}>;
/** PR C supplies the existing serialized Supervisor-turn adapter. Without it, nothing is consumed.
 * A callback must persist the owner turn in ai_messages (by clientMessageId) before returning.
 * This module never creates a second AI agent/conversation or sends a WhatsApp reply. */
export async function consumeInboundOnce(dispatcher?:DispatchInbound):Promise<"disabled"|"empty"|"done"|"retry"|"revoked">{
  if(process.env.WHATSAPP_INBOUND_DISPATCH_ENABLED!=="true"||!dispatcher)return "disabled";
  const {data,error}=await db().rpc("whatsapp_claim_inbound");
  if(error)throw new Error("inbound_claim_failed");
  if(!data)return "empty";
  const lease=data as InboundLease;
  const bound=await activeBinding(lease.binding_id);
  const authorized=bound&&bound.businessId===lease.business_id&&
    bound.ownerUserId===lease.owner_user_id&&bound.threadId===lease.thread_id;
  if(!authorized){
    await finishInbound(lease,"failed",null,"binding_revoked");
    return "revoked";
  }
  try {
    const prompt=lease.kind==="text"?lease.text_content:
      lease.kind==="button"?buttonQuestion(lease.button_payload??""):null;
    if((lease.kind==="text"||lease.kind==="button")&&!prompt)
      throw new Error("unsupported_prompt");
    const result=await dispatcher({wamid:lease.wamid,
      scope:{businessId:lease.business_id,ownerUserId:lease.owner_user_id},
      threadId:lease.thread_id,clientMessageId:stableOwnerClientMessageId(lease.wamid),
      kind:lease.kind,prompt,mediaId:lease.media_id});
    if(!uuid.test(result.ownerMessageId))throw new Error("missing_owner_turn");
    if(!await finishInbound(lease,"completed",result.ownerMessageId,null))
      throw new Error("lease_lost");
    return "done";
  }catch{
    await finishInbound(lease,"queued",null,"dispatcher_failed");
    return "retry";
  }
}
async function finishInbound(lease:InboundLease,state:"completed"|"queued"|"failed",
 ownerMessageId:string|null,errorCode:string|null):Promise<boolean>{
  const {data,error}=await db().rpc("whatsapp_finish_inbound",{
    p_wamid:lease.wamid,p_token:lease.lease_token,p_state:state,
    p_owner_message_id:ownerMessageId,p_error:errorCode,
  });
  if(error)throw new Error("inbound_finish_failed");
  return data===true;
}
/** Default OFF; called only by an explicitly authenticated future worker. On an unknown
 * network outcome this marks "uncertain", NEVER silently resends the same message. */
export async function dispatchOutboundOnce(kind:Channel,send:typeof fetch=fetch):
 Promise<"disabled"|"empty"|"accepted"|"retry"|"failed"|"uncertain"> {
  if(!providerAllowed(kind))return "disabled";
  const {data,error}=await db().rpc("whatsapp_claim_outbound",{p_kind:kind});
  if(error)throw new Error("outbox_claim_failed");
  if(!data)return "empty";
  const lease=data as OutboundLease;
  let outcome:{state:"accepted"|"retry"|"failed"|"uncertain";wamid?:string;reason?:string};
  const bound=await activeBinding(lease.binding_id);
  if(!bound||bound.businessId!==lease.business_id||
     bound.ownerUserId!==lease.owner_user_id||bound.threadId!==lease.thread_id||
     bound.waId!==lease.wa_id||bound.phoneNumberId!==lease.phone_number_id)
    outcome={state:"failed",reason:"binding_revoked"};
  else if(kind==="reply"&&(!bound.lastOwnerMessageAt||
    Date.now()-new Date(bound.lastOwnerMessageAt).getTime()>=24*60*60*1000))
    outcome={state:"failed",reason:"outside_service_window"};
  else {
    const payload=lease.payload as {fields?:unknown;text?:unknown}|null;
    const outbound:Outbound|null=kind==="daily_brief"&&Array.isArray(payload?.fields)?
      {kind:"daily_brief",fields:payload.fields as TemplateFields}:
      kind==="reply"&&typeof payload?.text==="string"?
        {kind:"reply",text:payload.text}:null;
    const built=outbound&&buildOutbound(bound.waId,outbound);
    outcome=outbound&&built?await sendMeta(kind,bound.waId,outbound,send):
      {state:"failed",reason:"invalid_payload"};
  }
  const {data:finished,error:finishError}=await db().rpc("whatsapp_finish_outbound",{
    p_id:lease.id,p_token:lease.lease_token,p_outcome:outcome.state,
    p_provider_wamid:outcome.state==="accepted"?outcome.wamid:null,
    p_error:outcome.state==="accepted"?null:outcome.reason??"unknown_error",
  });
  if(finishError||finished!==true)throw new Error("outbox_finish_failed");
  return outcome.state;
}
