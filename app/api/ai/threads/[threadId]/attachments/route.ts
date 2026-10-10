import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { isSupervisorChatConfigured } from "@/lib/ai/conversations/enabled.server";
import { threadIdInput } from "@/lib/ai/conversations/contracts";
import { attachmentInput, MAX_BYTES, safeFileName, verifySignature } from "@/lib/ai/conversations/attachments";
import { conversationError, conversationJson, parseInput, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{threadId:string}>};
const fields="id, original_name, media_type, bytes, processing_state, created_at";
type Row={id:string;original_name:string;media_type:string;bytes:number;processing_state:"stored_unanalysed";created_at:string};
function shape(r:Row){return {id:r.id,originalName:r.original_name,mediaType:r.media_type,
 bytes:r.bytes,processingState:r.processing_state,createdAt:r.created_at};}

export async function GET(_request:Request,context:Context){
 try {
  const id=parseInput(threadIdInput,(await context.params).threadId);
  const {scope,service}=await authenticatedConversationContext();
  await service.getThread(id);
  const db=await createServerSupabaseClient();
  const {data,error}=await db.from("ai_attachments").select(fields)
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("thread_id",id).order("created_at",{ascending:false}).limit(40);
  if(error)throw error;
  return conversationJson({items:(data as Row[]).map(shape)});
 }catch(error){return conversationError(error);}
}

export async function POST(request:Request,context:Context){
 try {
  requireSameOrigin(request);
  if(!isSupervisorChatConfigured())throw new ConversationApiError(503,"supervisor_not_enabled");
  const id=parseInput(threadIdInput,(await context.params).threadId);
  const {scope,service}=await authenticatedConversationContext();
  await service.getThread(id);
  const contentLength=Number(request.headers.get("content-length"));
  if(!Number.isFinite(contentLength)||contentLength<1||contentLength>MAX_BYTES+8192)
   throw new ConversationApiError(413,"attachment_too_large");
  if(!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
   throw new ConversationApiError(415,"multipart_required");
  const body=await request.formData();
  if([...body.keys()].some((key)=>key!=="file") || body.getAll("file").length!==1)
   throw new ConversationApiError(422,"invalid_attachment");
  const file=body.get("file");
  if(!(file instanceof File))throw new ConversationApiError(422,"file_required");
  const parsed=parseInput(attachmentInput,{filename:file.name,mimeType:file.type,bytes:file.size});
  const buffer=new Uint8Array(await file.arrayBuffer());
  if(!verifySignature(parsed.mimeType,buffer))
   throw new ConversationApiError(422,"invalid_file_signature");
  const fileId=crypto.randomUUID();
  const objectPath=[scope.businessId,scope.ownerUserId,id,fileId,safeFileName(parsed.filename)].join("/");
  const db=await createServerSupabaseClient();
  const upload=await db.storage.from("ai-chat-private").upload(objectPath,buffer,{
   contentType:parsed.mimeType,cacheControl:"no-store",upsert:false,
  });
  if(upload.error)throw upload.error;
  const {data,error}=await db.from("ai_attachments").insert({
   id:fileId,business_id:scope.businessId,owner_user_id:scope.ownerUserId,
   thread_id:id,object_path:objectPath,original_name:parsed.filename,
   media_type:parsed.mimeType,bytes:parsed.bytes,
  }).select(fields).single();
  if(error){await db.storage.from("ai-chat-private").remove([objectPath]);throw error;}
  return conversationJson({attachment:shape(data as Row)},201);
 }catch(error){return conversationError(error);}
}
