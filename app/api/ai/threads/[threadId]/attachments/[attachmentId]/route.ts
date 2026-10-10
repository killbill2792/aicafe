import {NextResponse} from "next/server";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {threadIdInput} from "@/lib/ai/conversations/contracts";
import {conversationError,parseInput} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {z} from "zod";
export const runtime="nodejs";export const dynamic="force-dynamic";
type Context={params:Promise<{threadId:string;attachmentId:string}>};
/** Owner-authenticated, short-lived private download. Never return a public URL. */
export async function GET(_request:Request,context:Context){
 try{
  const {threadId,attachmentId}=await context.params;
  const id=parseInput(threadIdInput,threadId);
  const fileId=parseInput(z.uuid(),attachmentId);
  const {scope,service}=await authenticatedConversationContext();
  await service.getThread(id);
  const db=await createServerSupabaseClient();
  const {data,error}=await db.from("ai_attachments").select("object_path")
   .eq("id",fileId).eq("thread_id",id).eq("business_id",scope.businessId)
   .eq("owner_user_id",scope.ownerUserId).maybeSingle();
  if(error)throw error;
  if(!data)return NextResponse.json({error:"attachment_not_found"},{
   status:404,headers:{"Cache-Control":"private, no-store"}});
  const signed=await db.storage.from("ai-chat-private").createSignedUrl(data.object_path,60);
  if(signed.error||!signed.data?.signedUrl)throw signed.error??new Error("storage_unavailable");
  return NextResponse.redirect(signed.data.signedUrl,{
   status:302,headers:{"Cache-Control":"private, no-store"},
  });
 }catch(error){return conversationError(error);}
}
