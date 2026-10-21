import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import type {ConversationScope} from "./contracts";
import {ownerInputResponseSchema,type OwnerInputResponse} from "@/lib/ai/supervisor/ownerInput/contracts";

/** The single authenticated/tenant-scoped append boundary for card responses.
 * PostgreSQL locks only this thread and atomically stores the original structured
 * response with its owner message, enforcing one consumption per prompt. */
export async function submitOwnerInputMessage(scope:ConversationScope,threadId:string,
  clientMessageId:string,text:string,response:OwnerInputResponse):
  Promise<{ok:true}|{ok:false;reason:string}>{
  const checked=ownerInputResponseSchema.parse(response);
  const client=await createServerSupabaseClient();
  const {data,error}=await client.rpc("supervisor_submit_owner_question",{
    p_business_id:scope.businessId,p_thread_id:threadId,
    p_client_message_id:clientMessageId,p_text:text,p_response:checked,
  });
  if(error)throw error;
  if(data&&typeof data==="object"&&"ok" in data&&data.ok===true)
    return {ok:true};
  return {ok:false,reason:typeof data==="object"&&data!==null&&
    "reason" in data&&typeof data.reason==="string"?data.reason:"owner_input_not_pending"};
}
