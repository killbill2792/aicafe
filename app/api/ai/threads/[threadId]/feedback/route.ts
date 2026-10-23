import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { requireSameOrigin, conversationError, readBoundedJson } from "@/lib/ai/conversations/http.server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
export const runtime="nodejs";
const bodySchema=z.strictObject({messageId:z.uuid(),rating:z.enum(["up","down"]),comment:z.string().trim().max(1000).optional()});
export async function POST(request:Request,{params}:{params:Promise<{threadId:string}>}){
  try{
    requireSameOrigin(request);
    const {threadId}=await params;
    if(!z.uuid().safeParse(threadId).success) return NextResponse.json({error:"invalid_thread"},{status:400});
    const body=bodySchema.safeParse(await readBoundedJson(request));
    if(!body.success)return NextResponse.json({error:"invalid_feedback"},{status:400});
    const {scope,service}=await authenticatedConversationContext();
    await service.getThread(threadId);
    const admin=createAdminSupabaseClient();
    // Verify message belongs to this owner and is an actual assistant answer.
    const {data:message,error:messageError}=await admin.from("ai_messages").select("id")
      .eq("id",body.data.messageId).eq("thread_id",threadId).eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId).eq("role","supervisor").maybeSingle();
    if(messageError)throw messageError;
    if(!message)return NextResponse.json({error:"not_found"},{status:404});
    const {data,error}=await admin.from("agent_turn_logs").update({
      owner_feedback:body.data.rating,owner_feedback_comment:body.data.comment??null,
    }).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",threadId).eq("message_id",message.id).select("id").maybeSingle();
    if(error)throw error;
    return data?NextResponse.json({saved:true}):NextResponse.json({error:"feedback_pending"},{status:409});
  }catch(error){return conversationError(error);}
}
