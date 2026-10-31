import "server-only";
import { createHash } from "node:crypto";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ConversationApiError } from "./auth.server";
import type { ConversationMessage, ConversationScope, ConversationThread } from "./contracts";
import { getExistingSupervisorReply } from "./replyWriter.server";
import { ConversationService } from "./service";
import { SupabaseConversationRepository } from "./supabase.server";
import { assertOwnerAgentTurnAvailable, labelSupervisorThread } from "./usage.server";

/** Verifies the explicit, previously phone-bound café and owner supplied by the
 * signed transport. No active-café fallback and no browser session forgery.
 * The caller must STILL verify Meta signature, consent, active phone binding and
 * selected thread before calling this internal service. */
export async function authorizedExternalConversation(scope: ConversationScope, threadId: string): Promise<ConversationService> {
  if (!scope.businessId || !scope.ownerUserId || !threadId)
    throw new ConversationApiError(403,"whatsapp_scope_required");
  const admin = createAdminSupabaseClient();
  const {data:membership,error} = await admin.from("memberships").select("role")
    .eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle();
  if (error || membership?.role !== "owner")
    throw new ConversationApiError(403,"owner_access_required");
  const service = new ConversationService(new SupabaseConversationRepository(admin),scope);
  await service.getThread(threadId); // exact linked thread, not the latest/first thread
  return service;
}

/** Provider IDs are not UUIDs. A deterministic, tenant-bound UUID makes webhook
 * redelivery an idempotent owner turn without placing wamid in ai_messages.
 * The durable inbound ledger remains the authoritative provider ID mapping. */
export function externalOwnerClientMessageId(scope: ConversationScope, wamid: string): string {
  if (!scope.businessId || !scope.ownerUserId || !/^wamid\.[A-Za-z0-9._:-]{1,240}={0,2}$/.test(wamid))
    throw new Error("invalid_whatsapp_message_id");
  const bytes = createHash("sha256")
    .update("aicafe-whatsapp-owner-turn-v1\0").update(scope.businessId).update("\0")
    .update(scope.ownerUserId).update("\0").update(wamid).digest();
  bytes[6]=(bytes[6]&0x0f)|0x50;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const h=bytes.subarray(0,16).toString("hex");
  return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join("-");
}

export type AuthorizedTurnRegistration = {
  thread: ConversationThread; owner: ConversationMessage;
  prior: ConversationMessage | null;
};
/** Shared web/WhatsApp persistence boundary; only the caller controls the source
 * authorization. Start ai_agent_jobs after this call, never a second AI system. */
export async function registerAuthorizedSupervisorTurn(input: {
  scope: ConversationScope; service: ConversationService; threadId: string;
  clientMessageId: string; text: string; scopedClient?:import("@supabase/supabase-js").SupabaseClient;
}): Promise<AuthorizedTurnRegistration> {
  const {scope,service,threadId,clientMessageId,text}=input;
  const thread=await service.getThread(threadId);
  await assertOwnerAgentTurnAvailable(scope,input.scopedClient);
  const owner=await service.addOwnerMessage(threadId,clientMessageId,text);
  const prior=await getExistingSupervisorReply(scope,owner);
  if(thread.title===null) {
    try {await labelSupervisorThread(scope,threadId,text);}catch{/* optional */}
  }
  return {thread,owner,prior};
}

/** Channel provenance is stored on the owner turn, not in model history. Only
 * the verified transport's server caller may mark it; browser owner messages
 * cannot set grounding and WhatsApp payloads cannot approve actions. */
export async function markWhatsAppOwnerProvenance(
 scope:ConversationScope,owner:ConversationMessage,receivedAt:string,attachmentIds?:readonly string[],
):Promise<void>{
 const date=new Date(receivedAt);
 if(!Number.isFinite(date.getTime())||date.getTime()>Date.now()+60_000)
   throw new ConversationApiError(422,"invalid_whatsapp_received_at");
 const client=createAdminSupabaseClient();
 const query=()=>client.from("ai_messages").select("role,grounding")
   .eq("id",owner.id).eq("thread_id",owner.threadId)
   .eq("owner_user_id",scope.ownerUserId).eq("business_id",scope.businessId).maybeSingle();
 const {data,error}=await query();
 if(error||data?.role!=="owner")throw new ConversationApiError(403,"message_scope_mismatch");
 const grounding=data.grounding as Record<string,unknown>|null;
 const ids=attachmentIds===undefined&&Array.isArray(grounding?.attachmentIds)
   ?grounding.attachmentIds as string[]:[...(attachmentIds??[])];
 if(ids.length>3||new Set(ids).size!==ids.length||
    ids.some(id=>typeof id!=="string"||!/^[a-f0-9-]{36}$/i.test(id)))
   throw new ConversationApiError(422,"invalid_whatsapp_attachments");
 if(ids.length){
   const {data:owned,error:ownedError}=await client.from("ai_attachments")
      .select("id,media_type").eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId).eq("thread_id",owner.threadId).in("id",ids);
   if(ownedError||!owned||owned.length!==ids.length||
     owned.some(row=>!["image/jpeg","image/png","application/pdf"].includes(row.media_type)))
     throw new ConversationApiError(403,"attachments_not_available");
 }
 const expected={sourceChannel:"whatsapp",receivedAt:date.toISOString(),attachmentIds:ids};
 if(grounding){
   if(grounding.sourceChannel!=="whatsapp"||grounding.receivedAt!==expected.receivedAt||
     JSON.stringify(grounding.attachmentIds??[])!==JSON.stringify(expected.attachmentIds))
     throw new ConversationApiError(409,"message_channel_conflict");
   return;
 }
 const result=await client.from("ai_messages").update({grounding:expected})
   .eq("id",owner.id).eq("thread_id",owner.threadId).eq("owner_user_id",scope.ownerUserId)
   .eq("business_id",scope.businessId).is("grounding",null).select("id");
 if(result.error)throw result.error;
 if(result.data?.length!==1){
   const replay=await query();
   if(replay.error||replay.data?.grounding?.sourceChannel!=="whatsapp"||
     replay.data?.grounding?.receivedAt!==expected.receivedAt||
     JSON.stringify(replay.data?.grounding?.attachmentIds??[])!==JSON.stringify(expected.attachmentIds))
     throw new ConversationApiError(409,"message_channel_conflict");
 }
}

/** Query scope is always explicit, so a continuation for an external message
 * cannot silently become a web-only answer (or vice versa). */
export async function storedOwnerMessageChannel(
 scope:ConversationScope,threadId:string,messageId:string,
):Promise<"whatsapp"|"web">{
 const {data,error}=await createAdminSupabaseClient().from("ai_messages")
   .select("role,grounding").eq("id",messageId)
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("thread_id",threadId).maybeSingle();
 if(error||data?.role!=="owner")throw new ConversationApiError(403,"message_scope_mismatch");
 return (data.grounding as {sourceChannel?:unknown}|null)?.sourceChannel==="whatsapp"?"whatsapp":"web";
}

/** Images attached to a queued WhatsApp owner turn are durable in the same
 * private ai_attachments store. PDFs remain stored for web owner review,
 * not inserted as unsupported image bytes into the model. */
export async function recordedWhatsAppImageIds(scope:ConversationScope,
 threadId:string,ownerMessageId:string):Promise<string[]|null>{
 const client=createAdminSupabaseClient();
 const {data,error}=await client.from("ai_messages").select("role,grounding")
   .eq("id",ownerMessageId).eq("business_id",scope.businessId)
   .eq("owner_user_id",scope.ownerUserId).eq("thread_id",threadId).maybeSingle();
 if(error||data?.role!=="owner")throw new ConversationApiError(403,"message_scope_mismatch");
 const record=data.grounding as {sourceChannel?:unknown;attachmentIds?:unknown}|null;
 if(record?.sourceChannel!=="whatsapp")return null;
 const ids=record.attachmentIds??[];
 if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length||
   ids.some(id=>typeof id!=="string"||!/^[a-f0-9-]{36}$/i.test(id)))
   throw new ConversationApiError(422,"invalid_whatsapp_attachments");
 if(!ids.length)return [];
 const {data:owned,error:ownedError}=await client.from("ai_attachments")
   .select("id,media_type").eq("business_id",scope.businessId)
   .eq("owner_user_id",scope.ownerUserId).eq("thread_id",threadId).in("id",ids);
 if(ownedError||!owned||owned.length!==ids.length)
   throw new ConversationApiError(403,"attachments_not_available");
 if(owned.some(row=>!["image/jpeg","image/png","application/pdf"].includes(row.media_type)))
   throw new ConversationApiError(422,"unsupported_whatsapp_media");
 return ids.filter(id=>owned.some(row=>row.id===id&&row.media_type!=="application/pdf"));
}
