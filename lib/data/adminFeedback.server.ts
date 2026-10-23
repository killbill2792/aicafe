import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {ConversationScope} from "@/lib/ai/conversations/contracts";
export async function saveOwnerTurnFeedback(scope:ConversationScope,threadId:string,
 messageId:string,rating:"up"|"down",comment?:string):Promise<boolean|null>{
 const admin=createAdminSupabaseClient();
 const {data:message,error:messageError}=await admin.from("ai_messages").select("id")
  .eq("id",messageId).eq("thread_id",threadId).eq("business_id",scope.businessId)
  .eq("owner_user_id",scope.ownerUserId).eq("role","supervisor").maybeSingle();
 if(messageError)throw messageError;
 if(!message)return null;
 // Never copy owner free-text feedback into operational telemetry; it can hold
 // receipts, bank lines, addresses, or details about employees.
 const {data,error}=await admin.from("agent_turn_logs").update({
  owner_feedback:rating,
  owner_feedback_comment:comment?.trim()?"[comment withheld]":null,
 }).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("thread_id",threadId).eq("message_id",message.id).select("id").maybeSingle();
 if(error)throw error;
 return Boolean(data);
}
