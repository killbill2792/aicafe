import {z} from "zod";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {threadIdInput} from "@/lib/ai/conversations/contracts";
import {conversationError,conversationJson,parseInput} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {recoverRichPresentation,presentationReport} from "@/lib/ai/conversations/presentation";
import {renderSavedAnswerPdf,reportBlocks} from "@/lib/ai/conversations/pdfReport.server";

export const runtime="nodejs";export const dynamic="force-dynamic";
type Context={params:Promise<{threadId:string;messageId:string}>};
const privateHeaders={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
export async function GET(request:Request,context:Context){
 try{
  const {threadId,messageId}=await context.params;
  const id=parseInput(threadIdInput,threadId),message=parseInput(z.uuid(),messageId);
  const document=new URL(request.url).searchParams.get("document");
  const index=document===null?null:parseInput(z.coerce.number().int().nonnegative(),document);
  const {scope,service}=await authenticatedConversationContext();
  await service.getThread(id);
  const db=await createServerSupabaseClient();
  const {data,error}=await db.from("ai_messages").select("structured_content,grounding,created_at")
   .eq("id",message).eq("thread_id",id).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).eq("role","supervisor").maybeSingle();
  if(error)throw error;
  if(!data)return conversationJson({error:"message_not_found"},404);
  const snapshot={blocks:Array.isArray(data.structured_content)?data.structured_content:[],grounding:data.grounding as Record<string,unknown>|null,createdAt:String(data.created_at)};
  const selected=index===null?undefined:recoverRichPresentation(snapshot.blocks[index]);
  if(index!==null&&!selected?.pdfSpec)return conversationJson({error:"document_not_found"},404);
  try{
   const pdf=await renderSavedAnswerPdf(snapshot,selected);
   return new Response(new Uint8Array(pdf),{headers:{...privateHeaders,"Content-Type":"application/pdf","Content-Disposition":'attachment; filename="luna-report.pdf"'}});
  }catch{
   // Even a renderer/font failure cannot lose the already saved information.
   const blocks=selected?[selected]:reportBlocks(snapshot);
   const empty={type:"rich_presentation" as const,version:1 as const,layout:"stack" as const,panels:[],suggestions:[]};
   const text=blocks.length?blocks.map(block=>presentationReport(block,snapshot)).join("\n\n"):presentationReport(empty,snapshot);
   return new Response(text,{headers:{...privateHeaders,"Content-Type":"text/plain; charset=utf-8","Content-Disposition":'attachment; filename="luna-report.txt"'}});
  }
 }catch(error){return conversationError(error);}
}
