import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { requireSameOrigin, conversationError, readBoundedJson } from "@/lib/ai/conversations/http.server";
import {saveOwnerTurnFeedback} from "@/lib/data/adminFeedback.server";
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
    const saved=await saveOwnerTurnFeedback(scope,threadId,body.data.messageId,
      body.data.rating,body.data.comment);
    return saved===null?NextResponse.json({error:"not_found"},{status:404}):
      saved?NextResponse.json({saved:true}):
      NextResponse.json({error:"feedback_pending"},{status:409});
  }catch(error){return conversationError(error);}
}
