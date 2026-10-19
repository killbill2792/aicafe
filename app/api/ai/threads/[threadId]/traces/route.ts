import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {conversationError,conversationJson,parseInput} from "@/lib/ai/conversations/http.server";
import {threadIdInput} from "@/lib/ai/conversations/contracts";

export const runtime="nodejs";
export const dynamic="force-dynamic";
type RouteContext={params:Promise<{threadId:string}>};
/** Private owner-only diagnostic download. Never expose these traces in console logs. */
export async function GET(request:Request,context:RouteContext){
  try{
    const {threadId}=await context.params;
    const id=parseInput(threadIdInput,threadId);
    const {service,scope}=await authenticatedConversationContext();
    await service.getThread(id);
    const client=await createServerSupabaseClient();
    const url=new URL(request.url);
    const requestId=url.searchParams.get("requestId");
    if(requestId!==null&&!/^[a-zA-Z0-9_.:-]{1,80}$/.test(requestId))
      return conversationJson({error:"invalid_request_id"},400);
    let query=client.from("supervisor_turn_traces")
      .select("request_id,created_at,events,dropped_count,owner_message_id")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",id).order("created_at",{ascending:false}).limit(10);
    if(requestId)query=query.eq("request_id",requestId);
    const {data,error}=await query;
    if(error)throw error;
    return conversationJson({traces:data??[]},200);
  }catch(error){return conversationError(error);}
}
