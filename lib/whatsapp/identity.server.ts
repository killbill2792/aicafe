import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {Incoming} from "./webhook";
export type BoundOwner={id:string;businessId:string;ownerUserId:string;threadId:string;
  waId:string;phoneNumberId:string;lastOwnerMessageAt:string|null};
/** A service-role query is NOT proof of ownership. Always recheck current verified Auth
 * phone, owner membership, consent and explicit linked thread in the DB predicate. */
export async function activeBinding(bindingId:string):Promise<BoundOwner|null>{
  const db=createAdminSupabaseClient();
  const {data:active,error:checkError}=await db.rpc("whatsapp_binding_active",{p_id:bindingId});
  if(checkError||active!==true)return null;
  const {data,error}=await db.from("whatsapp_owner_bindings").select(
    "id,business_id,owner_user_id,thread_id,wa_id,phone_number_id,last_owner_message_at"
  ).eq("id",bindingId).maybeSingle();
  if(error||!data)return null;
  return {id:data.id,businessId:data.business_id,ownerUserId:data.owner_user_id,
    threadId:data.thread_id,waId:data.wa_id,phoneNumberId:data.phone_number_id,
    lastOwnerMessageAt:data.last_owner_message_at};
}
/** Only signed route calls this; SQL revalidates identity in the insert transaction.
 * Never create or select a binding on the strength of a webhook phone alone. */
export async function acceptSignedMessage(event:Extract<Incoming,{type:"message"}>):
  Promise<"queued"|"duplicate"|"ignored"|"unauthorized"> {
  const {data,error}=await createAdminSupabaseClient().rpc("whatsapp_accept_inbound",{
    p_phone_id:event.phoneId,p_wa_id:event.waId,p_wamid:event.wamid,
    p_kind:event.kind,p_text:event.text,p_button_payload:event.payload,
    p_media_id:event.mediaId,p_provider_at:event.providerAt,
  });
  if(error)throw new Error("inbound_persistence_failed");
  if(data==="queued"||data==="duplicate"||data==="ignored"||data==="unauthorized")return data;
  throw new Error("invalid_ingest_receipt");
}
