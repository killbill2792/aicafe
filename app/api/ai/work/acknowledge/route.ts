import {z} from "zod";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const input=z.strictObject({taskId:z.string().regex(/^u4-failed:[0-9a-f-]{36}$/iu)});
export async function POST(request:Request){
  try{
    requireSameOrigin(request);
    const {taskId}=parseInput(input,await readBoundedJson(request));
    const {scope}=await authenticatedConversationContext();
    const db=await createServerSupabaseClient();
    const {data,error}=await db.rpc("u4_acknowledge_failed_run",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_task_id:taskId,
    });
    if(error)throw error;
    return conversationJson({acknowledged:data===true});
  }catch(error){return conversationError(error);}
}
