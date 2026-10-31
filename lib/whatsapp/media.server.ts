import "server-only";
import { createHash } from "node:crypto";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { attachmentInput, MAX_BYTES, safeFileName, verifySignature } from "@/lib/ai/conversations/attachments";
import type { ConversationScope } from "@/lib/ai/conversations/contracts";
import { authorizedExternalConversation,externalOwnerClientMessageId } from "@/lib/ai/conversations/authorizedTurn.server";

/** Incoming media is reference material, NOT an authorization to record purchases,
 * change inventory or extract a verified receipt. PDF is stored unanalysed until
 * a signed-in owner reviews it on the web. */
export type IncomingWhatsAppMedia = {
  mediaId:string;
  /** A signed webhook provides kind; Graph metadata determines actual MIME. */
  kind?:"image"|"document";
  mimeType?:string;
  fileName?:string;
};
export type DownloadedWhatsAppMedia = {
  bytes:Uint8Array; mimeType:"image/jpeg"|"image/png"|"application/pdf"; name:string;
};
const mediaIdPattern=/^[A-Za-z0-9_-]{1,200}$/;
const acceptedTypes=["image/jpeg","image/png","application/pdf"] as const;
const suffix:Record<DownloadedWhatsAppMedia["mimeType"],string>={
 "image/jpeg":".jpg","image/png":".png","application/pdf":".pdf",
};

export function verifiedMetaMediaUrl(input:unknown):URL {
  if(typeof input!=="string")throw new Error("invalid_meta_media_url");
  const url=new URL(input);
  if(url.protocol!=="https:"||url.hostname!=="lookaside.fbsbx.com"||
    url.username||url.password||url.port||url.hash||!url.pathname.startsWith("/whatsapp_business/"))
    throw new Error("invalid_meta_media_url");
  return url;
}

export function chooseMetaMediaName(original:unknown,mimeType:DownloadedWhatsAppMedia["mimeType"]):string {
  const ext=suffix[mimeType];
  const name=typeof original==="string"&&original.length<=150?original:"attachment"+ext;
  if(!name.toLowerCase().endsWith(ext) && !(mimeType==="image/jpeg"&&name.toLowerCase().endsWith(".jpeg")))
    throw new Error("media_filename_mismatch");
  return safeFileName(name);
}
export function verifyMetaMediaContent(mimeType:string,bytes:Uint8Array,sha256:string):boolean {
  if(!acceptedTypes.some(t=>t===mimeType)||!bytes.length||bytes.length>MAX_BYTES||
     !/^[a-f0-9]{64}$/i.test(sha256))return false;
  return verifySignature(mimeType,bytes) &&
    createHash("sha256").update(bytes).digest("hex")===sha256.toLowerCase();
}

async function boundedBytes(response:Response,maxBytes=MAX_BYTES):Promise<Uint8Array> {
 if(!response.ok||!response.body)throw new Error("meta_media_download_failed");
 const type=response.headers.get("content-length");
 if(type!==null&&(!/^\d+$/.test(type)||Number(type)>maxBytes))throw new Error("meta_media_too_large");
 const reader=response.body.getReader();const chunks:Uint8Array[]=[];let count=0;
 try{
   for(;;){
     const {value,done}=await reader.read();
     if(done)break;
     count+=value.byteLength;
     if(count>maxBytes)throw new Error("meta_media_too_large");
     chunks.push(value);
   }
 }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
 const output=new Uint8Array(count);let index=0;
 for(const c of chunks){output.set(c,index);index+=c.length;}
 return output;
}

/** Meta Graph metadata and the short-lived media URL both use the server-only
 * bearer token. No arbitrary supplied URL, redirects, unbounded body or fallback
 * to an unauthenticated provider request is allowed. */
export async function downloadWhatsAppMedia(
 input:IncomingWhatsAppMedia,
 token:string,
 fetcher:typeof fetch=fetch,
):Promise<DownloadedWhatsAppMedia>{
 if(!token||!mediaIdPattern.test(input.mediaId))throw new Error("invalid_meta_media_id");
 if((!input.kind&&!input.mimeType)||
   (input.mimeType&&!acceptedTypes.some(t=>t===input.mimeType)))
   throw new Error("unsupported_whatsapp_media");
 const headers={Authorization:"Bearer "+token};
 const metadataResponse=await fetcher("https://graph.facebook.com/v21.0/"+encodeURIComponent(input.mediaId),
   {headers,redirect:"error",signal:AbortSignal.timeout(10_000)});
 if(!metadataResponse.ok)throw new Error("meta_media_metadata_failed");
 const meta=await metadataResponse.json() as Record<string,unknown>;
 const mimeType=meta.mime_type as DownloadedWhatsAppMedia["mimeType"];
 if(!acceptedTypes.some(t=>t===mimeType)||
    (input.mimeType!==undefined&&input.mimeType!==mimeType)||
    (input.kind==="document"&&mimeType!=="application/pdf")||
    (input.kind==="image"&&mimeType!=="image/jpeg"&&mimeType!=="image/png")||
    typeof meta.sha256!=="string"||
    typeof meta.file_size!=="number"||!Number.isSafeInteger(meta.file_size)||
    meta.file_size<1||meta.file_size>MAX_BYTES)throw new Error("unsupported_whatsapp_media");
 const url=verifiedMetaMediaUrl(meta.url);
 const response=await fetcher(url,{headers,redirect:"error",signal:AbortSignal.timeout(10_000)});
 if(response.headers.get("content-type")?.split(";")[0].trim()!==mimeType)
   throw new Error("meta_media_content_type_mismatch");
 const bytes=await boundedBytes(response);
 if(bytes.length!==meta.file_size||
    !verifyMetaMediaContent(mimeType,bytes,meta.sha256))
    throw new Error("invalid_meta_media_signature");
 return {bytes,mimeType,name:chooseMetaMediaName(input.fileName,mimeType)};
}

/** Existing private ai_attachments infrastructure. Never store media publicly;
 * no OCR/purchase/expense write occurs here. The browser's existing attachment
 * listing and signed download route remain the review surfaces. */
export async function saveWhatsAppMediaDraft(params:{
 scope:ConversationScope;threadId:string;wamid:string;media:DownloadedWhatsAppMedia;
}):Promise<{attachmentId:string;state:"stored_unanalysed"}>{
 const {scope,threadId,media,wamid}=params;
 await authorizedExternalConversation(scope,threadId);
 const parsed=attachmentInput.parse({filename:media.name,mimeType:media.mimeType,bytes:media.bytes.byteLength});
 if(!verifySignature(parsed.mimeType,media.bytes))throw new Error("invalid_media_signature");
 const db=createAdminSupabaseClient(),id=externalOwnerClientMessageId(scope,wamid);
 // Meta can redeliver a signed inbound event and the durable worker may retry
 // after persistence. Do not duplicate invoice drafts on any such replay.
 const getExisting=()=>db.from("ai_attachments").select("id,media_type,bytes,original_name")
   .eq("id",id).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("thread_id",threadId).maybeSingle();
 const prior=await getExisting();
 if(prior.error)throw prior.error;
 const sameMetadata=(row:{media_type?:unknown;bytes?:unknown;original_name?:unknown})=>
   row.media_type===parsed.mimeType&&row.bytes===parsed.bytes&&row.original_name===parsed.filename;
 if(prior.data){
   if(!sameMetadata(prior.data))throw new Error("whatsapp_attachment_conflict");
   return {attachmentId:id,state:"stored_unanalysed"};
 }
 const path=[scope.businessId,scope.ownerUserId,threadId,id,safeFileName(parsed.filename)].join("/");
 const storage=db.storage.from("ai-chat-private");
 const uploaded=await storage.upload(path,media.bytes,{
    contentType:parsed.mimeType,cacheControl:"no-store",upsert:false,
 });
 if(uploaded.error){
   // A prior worker may have died after uploading, before metadata insert.
   // Never blindly use upsert:true: only recover a byte-for-byte identical,
   // bounded private object at the deterministic tenant-owned path.
   const read=await storage.download(path);
   if(read.error||!read.data||read.data.size!==media.bytes.byteLength)
     throw uploaded.error;
   const stored=new Uint8Array(await read.data.arrayBuffer());
   if(!Buffer.from(stored).equals(Buffer.from(media.bytes)))
     throw new Error("whatsapp_media_storage_conflict");
 }
 const {error}=await db.from("ai_attachments").insert({
    id,business_id:scope.businessId,owner_user_id:scope.ownerUserId,
    thread_id:threadId,object_path:path,original_name:parsed.filename,
    media_type:parsed.mimeType,bytes:parsed.bytes,processing_state:"stored_unanalysed",
 });
 if(error){
   const again=await getExisting();
   if(!again.error&&again.data&&sameMetadata(again.data))
     return {attachmentId:id,state:"stored_unanalysed"};
   // Only a freshly uploaded object can be rolled back. Never delete an
   // existing orphan that another concurrent worker may be recovering.
   if(!uploaded.error)await storage.remove([path]);
   throw error;
 }
 return {attachmentId:id,state:"stored_unanalysed"};
}
