import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {isSupervisorChatConfigured,getSupervisorChatReadinessForAuthorizedExternal} from "@/lib/ai/conversations/enabled.server";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";
import type {ConversationScope} from "@/lib/ai/conversations/contracts";
import {authorizedExternalConversation,externalOwnerClientMessageId,markWhatsAppOwnerProvenance,
  registerAuthorizedSupervisorTurn,storedOwnerMessageChannel} from "@/lib/ai/conversations/authorizedTurn.server";
import {assertOwnerAgentTurnAvailable} from "@/lib/ai/conversations/usage.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {runOneTurn,errorCode} from "@/lib/ai/conversations/agentRunner.server";
import {eligibleWhatsAppTextReply,supervisorQuestionForWhatsApp,whatsappPlainTextFromSavedBlocks,type WhatsAppOwnerInput} from "./supervisor";
import type {AgentJob} from "@/lib/ai/agent/jobState";

const CONTINUATION_BUDGET_MS=75_000;
type Locale="en"|"es"|"ar";
export type VerifiedWhatsAppOwnerTurn={
 /** Only PR A's signed webhook+consented durable binding dispatcher creates this.
  * NEVER construct scope/thread from an unverified phone/body payload. */
 scope:ConversationScope;threadId:string;wamid:string;receivedAt:string;
 locale:Locale;input:WhatsAppOwnerInput;
 attachmentIds?:string[];
};
export type WhatsAppSupervisorCompletion={
 ownerMessageId:string;replyId:string;replyText:string;
 receivedAt:string; eligibleAtCompletion:boolean;
};
export type WhatsAppSupervisorProcessing={
 status:"answered"|"queued"|"replayed";
 completed:WhatsAppSupervisorCompletion[];
};

/** PR A worker integration boundary — not a webhook handler or a sender.
 * Default off, no provider network call and no outbox writes. PR A's durable
 * dispatcher must recheck binding/consent AND 24h + length at actual send time
 * before reserving the outbound for each ownerMessageId. */
export async function processVerifiedWhatsAppOwnerTurn(
 verified:VerifiedWhatsAppOwnerTurn,
):Promise<WhatsAppSupervisorProcessing>{
 if(process.env.WHATSAPP_SUPERVISOR_ENABLED!=="true")
   throw new ConversationApiError(503,"whatsapp_supervisor_disabled");
 if(!isSupervisorChatConfigured())throw new ConversationApiError(503,"supervisor_not_enabled");
 const receivedAt=new Date(verified.receivedAt);
 if(!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime()>Date.now()+60_000)
   throw new ConversationApiError(422,"invalid_whatsapp_received_at");
 const {scope,threadId,wamid}=verified;
 const question=supervisorQuestionForWhatsApp(verified.input);
 if(!["en","es","ar"].includes(verified.locale))
   throw new ConversationApiError(422,"invalid_locale");
 const db=createAdminSupabaseClient();
 const service=await authorizedExternalConversation(scope,threadId);
 await assertCafeAiAccess(scope.businessId);
 const ready=await getSupervisorChatReadinessForAuthorizedExternal(scope,db);
 if(!ready.enabled)throw new ConversationApiError(503,ready.reason);
 const registration=await registerAuthorizedSupervisorTurn({
   scope,service,threadId,clientMessageId:externalOwnerClientMessageId(scope,wamid),
   text:question,scopedClient:db,
 });
 // Store the channel before joining the shared job. Never expose wa_id or
 // provider tokens in the agent's history or prompt.
 await markWhatsAppOwnerProvenance(scope,registration.owner,receivedAt.toISOString(),verified.attachmentIds);
 if(registration.prior){
   const priorText=whatsappPlainTextFromSavedBlocks(registration.prior.blocks);
   if(!priorText)return {status:"replayed",completed:[]};
   return {status:"replayed",completed:[{
     ownerMessageId:registration.owner.id,replyId:registration.prior.id,
     replyText:priorText,receivedAt:receivedAt.toISOString(),
     eligibleAtCompletion:eligibleWhatsAppTextReply(priorText,receivedAt),
   }]};
 }
 const jobs=await import("@/lib/ai/agent/jobs.server");
 const start=await jobs.startAgentJob(scope,threadId,registration.owner.id);
 if(start.mode!=="started")return {status:"queued",completed:[]};

 const completed:WhatsAppSupervisorCompletion[]=[];
 let job:AgentJob|null=start.job, owner=registration.owner;
 const since=Date.now();
 while(job){
   // Each continuation is still the owner's selected café/thread and under
   // current membership/AI access. No browser cookie is fabricated.
   const scopeService=await authorizedExternalConversation(scope,threadId);
   await scopeService.getThread(threadId);
   await assertCafeAiAccess(scope.businessId);
   await assertOwnerAgentTurnAvailable(scope,db);
   const channel=await storedOwnerMessageChannel(scope,threadId,owner.id);
   const result=await runOneTurn({
     scope,threadId,owner,ownerText:owner.text??"",locale:verified.locale,
     service,emit:()=>undefined,job,jobs,externalClient:db,
     attachmentIds:owner.id===registration.owner.id?(verified.attachmentIds??[]):[],
   });
   let next:AgentJob|null=null;
   try {
     next=(await jobs.finishAgentJob(job.id,"replyId" in result
       ? {status:"done",replyMessageId:result.replyId,
           ...(result.absorbedOwnerMessageIds.length?{absorbedOwnerMessageIds:result.absorbedOwnerMessageIds}:{})}
       : {status:"failed",errorCode:result.errorCode})).continuation;
   }catch {
     // Do not send any text when the canonical job cannot be marked complete.
     throw new ConversationApiError(503,"agent_job_finish_failed");
   }
   // Only hand the initiating inbound its own reply. Other WA messages
   // consumed by this canonical continuation chain are retrieved separately
   // by their own durable PR A inbound leases (then replayed via ai_messages).
   // Never route a second wamid's answer to the initial phone/message.
   if("replyId" in result && channel==="whatsapp" && owner.id===registration.owner.id){
     const {data,error}=await db.from("ai_messages")
       .select("grounding").eq("id",owner.id).eq("business_id",scope.businessId)
       .eq("owner_user_id",scope.ownerUserId).eq("thread_id",threadId).single();
     if(error||!data||data.grounding?.sourceChannel!=="whatsapp"||
        typeof data.grounding.receivedAt!=="string")
       throw new ConversationApiError(403,"whatsapp_message_provenance_missing");
     const at=data.grounding.receivedAt;
     completed.push({ownerMessageId:owner.id,replyId:result.replyId,
       replyText:result.replyText,receivedAt:at,
       eligibleAtCompletion:eligibleWhatsAppTextReply(result.replyText,at)});
   }
   job=null;
   if(!next)break;
   if(Date.now()-since>CONTINUATION_BUDGET_MS){
     await jobs.finishAgentJob(next.id,{status:"failed",errorCode:"timeout"}).catch(()=>undefined);
     break;
   }
   try {
     owner=await jobs.readOwnerMessage(scope,threadId,next.ownerMessageId);
     job=next;
   }catch(error){
     await jobs.finishAgentJob(next.id,{status:"failed",errorCode:errorCode(error)}).catch(()=>undefined);
     break;
   }
 }
 return {status:"answered",completed};
}
