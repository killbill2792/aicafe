import "server-only";
import {createHash} from "node:crypto";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {activeBinding} from "./identity.server";
import {consumeInboundOnce,dispatchOutboundOnce,enqueueWhatsApp,stableOwnerClientMessageId,
  type DispatchInbound} from "./queue.server";
import {downloadWhatsAppMedia,saveWhatsAppMediaDraft} from "./media.server";
import {processVerifiedWhatsAppOwnerTurn} from "./supervisor.server";
import {eligibleWhatsAppTextReply,supervisorQuestionForWhatsApp,withinWhatsAppServiceWindow,
  whatsappPlainTextFromSavedBlocks,type WhatsAppOwnerInput} from "./supervisor";
import {validReply} from "./transport";

type InboundRow={
  wamid:string;binding_id:string;business_id:string;owner_user_id:string;thread_id:string;
  state:string;kind:"text"|"button"|"image"|"document";text_content:string|null;
  button_payload:string|null;media_id:string|null;provider_at:string;
};
type ReadyReply={
  wamid:string;binding_id:string;business_id:string;owner_user_id:string;thread_id:string;
  owner_message_id:string;reply_id:string;provider_at:string;
};
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REPLIES_PER_TICK=25;

/** This callback is invoked ONLY by PR A's leased, signed-webhook inbound
 * consumer, never directly from a public route or user-supplied event.
 * Re-read the authoritative durable lease and current verified phone binding
 * before opening any owner/café data or invoking the shared agent. */
export const dispatchVerifiedWhatsAppInbound:DispatchInbound=async(message)=>{
  if(process.env.WHATSAPP_SUPERVISOR_ENABLED!=="true")
    throw new Error("whatsapp_supervisor_disabled");
  if(message.clientMessageId!==stableOwnerClientMessageId(message.wamid))
    throw new Error("invalid_whatsapp_client_key");
  const db=createAdminSupabaseClient();
  const {data:row,error}=await db.from("whatsapp_inbound")
    .select("wamid,binding_id,business_id,owner_user_id,thread_id,state,kind,text_content,button_payload,media_id,provider_at")
    .eq("wamid",message.wamid).maybeSingle();
  if(error||!row)throw new Error("whatsapp_inbound_missing");
  const inbound=row as InboundRow;
  if(inbound.state!=="leased"||inbound.business_id!==message.scope.businessId||
    inbound.owner_user_id!==message.scope.ownerUserId||inbound.thread_id!==message.threadId||
    inbound.kind!==message.kind||inbound.media_id!==message.mediaId)
    throw new Error("whatsapp_inbound_scope_mismatch");
  const binding=await activeBinding(inbound.binding_id);
  if(!binding||binding.businessId!==inbound.business_id||
    binding.ownerUserId!==inbound.owner_user_id||binding.threadId!==inbound.thread_id)
    throw new Error("whatsapp_binding_revoked");
  if(!withinWhatsAppServiceWindow(inbound.provider_at))
    throw new Error("whatsapp_inbound_outside_reply_window");
  let input:WhatsAppOwnerInput;
  let attachmentIds:string[]|undefined;
  if(inbound.kind==="text"){
    if(inbound.text_content!==message.prompt||!inbound.text_content)
      throw new Error("whatsapp_inbound_text_mismatch");
    input={type:"text",text:inbound.text_content};
  }else if(inbound.kind==="button"){
    if(!inbound.button_payload)throw new Error("missing_whatsapp_button_payload");
    // Do not interpret the translated button label or provided prompt as an ID.
    const question=supervisorQuestionForWhatsApp({type:"button",payload:inbound.button_payload});
    if(question!==message.prompt)throw new Error("whatsapp_button_payload_mismatch");
    input={type:"button",payload:inbound.button_payload};
  }else{
    if(!inbound.media_id||inbound.media_id!==message.mediaId)throw new Error("missing_whatsapp_media");
    const token=process.env.META_WHATSAPP_TOKEN||process.env.WHATSAPP_TOKEN;
    if(!token)throw new Error("whatsapp_media_token_not_configured");
    try{
      const media=await downloadWhatsAppMedia({
        mediaId:inbound.media_id,kind:inbound.kind,
      },token);
      const draft=await saveWhatsAppMediaDraft({
        scope:message.scope,threadId:message.threadId,wamid:inbound.wamid,media,
      });
      attachmentIds=[draft.attachmentId];
      input={type:"media",kind:media.mimeType==="application/pdf"?"document":"image"};
    }catch(err){
      // Unsupported Meta media has no trusted bytes to analyze. Record a
      // truthful conversation turn rather than inventing invoice lines.
      // Transient/forged download failures remain retryable, not "unsupported".
      if(!(err instanceof Error)||err.message!=="unsupported_whatsapp_media")throw err;
      input={type:"text",text:"I sent a file that AI Cafe cannot inspect. Please ask me to upload a JPEG or PNG photo or PDF in AI Cafe. Do not infer any receipt details or record purchases."};
    }
  }
  const result=await processVerifiedWhatsAppOwnerTurn({
    scope:message.scope,threadId:message.threadId,wamid:inbound.wamid,
    receivedAt:inbound.provider_at,clientMessageId:message.clientMessageId,
    locale:"en",input,attachmentIds,
  });
  // PR A finishes the durable inbound row to 'completed' AFTER this returns.
  // SQL intentionally refuses outbound enqueue until that acknowledgment.
  return {ownerMessageId:result.ownerMessageId};
};

/** Idempotent catch-up after the inbound lease completes, including replies
 * produced by a WEB agent job continuing into a WhatsApp turn. Provider send
 * never runs from here; only PR A's separate fail-closed outbound worker sends.
 * This is deliberately not a second AI loop and never re-asks the model. */
export async function reconcileWhatsAppSupervisorReplies(limit=MAX_REPLIES_PER_TICK):
 Promise<{enqueued:number;skipped:number}>{
  if(process.env.WHATSAPP_SUPERVISOR_ENABLED!=="true")
    return {enqueued:0,skipped:0};
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("invalid_reconcile_limit");
  const db=createAdminSupabaseClient();
  const {data,error}=await db.rpc("whatsapp_ready_supervisor_replies",{p_limit:limit});
  if(error||!Array.isArray(data))throw new Error("whatsapp_reply_reconcile_unavailable");
  let enqueued=0,skipped=0;
  for(const value of data){
    const item=value as ReadyReply;
    if(!item||![item.binding_id,item.business_id,item.owner_user_id,item.thread_id,
      item.owner_message_id,item.reply_id].every(id=>typeof id==="string"&&ID.test(id))||
      typeof item.wamid!=="string"||typeof item.provider_at!=="string"){
      skipped++;continue;
    }
    const binding=await activeBinding(item.binding_id);
    if(!binding||binding.businessId!==item.business_id||
      binding.ownerUserId!==item.owner_user_id||binding.threadId!==item.thread_id||
      !binding.lastOwnerMessageAt||
      !withinWhatsAppServiceWindow(binding.lastOwnerMessageAt)){
      skipped++;continue;
    }
    const {data:messages,error:messageError}=await db.from("ai_messages")
      .select("id,role,content_type,client_message_id,grounding,structured_content")
      .eq("business_id",item.business_id).eq("owner_user_id",item.owner_user_id)
      .eq("thread_id",item.thread_id).in("id",[item.owner_message_id,item.reply_id]).limit(2);
    if(messageError||!messages||messages.length!==2)throw new Error("whatsapp_reply_provenance_unavailable");
    const owner=messages.find(m=>m.id===item.owner_message_id);
    const reply=messages.find(m=>m.id===item.reply_id);
    if(!owner||owner.role!=="owner"||owner.content_type!=="text"||
       owner.client_message_id!==stableOwnerClientMessageId(item.wamid)||
       owner.grounding?.sourceChannel!=="whatsapp"||
       owner.grounding?.receivedAt!==new Date(item.provider_at).toISOString()||
       !reply||reply.role!=="supervisor"||reply.content_type!=="blocks"||
       reply.grounding?.ownerMessageId!==item.owner_message_id)
      throw new Error("whatsapp_reply_provenance_conflict");
    const plain=whatsappPlainTextFromSavedBlocks(reply.structured_content);
    // An invalid/oversized/expired answer remains visible on the linked
    // website, but must NEVER be truncated or pushed into the provider queue.
    if(!plain||!validReply(plain)||!eligibleWhatsAppTextReply(plain,binding.lastOwnerMessageAt)){
      skipped++;continue;
    }
    const dedupeKey="whatsapp:reply:"+
      createHash("sha256").update(item.binding_id).update(":").update(item.wamid).digest("hex");
    await enqueueWhatsApp(item.binding_id,dedupeKey,{kind:"reply",text:plain},{
      source:"ai_messages",period:"owner_turn",ownerMessageId:item.owner_message_id,
      replyMessageId:item.reply_id,
    },item.reply_id,item.wamid);
    enqueued++;
  }
  return {enqueued,skipped};
}

export async function runWhatsAppSupervisorWorker():Promise<{
 inbound:"disabled"|"empty"|"done"|"retry"|"revoked";
 replyQueue:{enqueued:number;skipped:number};outbound:string;
}>{
  if(process.env.WHATSAPP_WORKER_ENABLED!=="true"||
    process.env.WHATSAPP_SUPERVISOR_ENABLED!=="true")
    throw new Error("whatsapp_worker_disabled");
  const inbound=await consumeInboundOnce(dispatchVerifiedWhatsAppInbound);
  // ALWAYS scan after the current inbound lease is acknowledged. In subsequent
  // cron ticks this also reconciles WhatsApp turns finished by the WEB worker.
  const replyQueue=await reconcileWhatsAppSupervisorReplies();
  const outbound=await dispatchOutboundOnce("reply");
  return {inbound,replyQueue,outbound};
}
