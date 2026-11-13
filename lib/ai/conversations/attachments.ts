import { z } from "zod";
export const MAX_BYTES = 8*1024*1024; // Modern phone receipts often exceed 2 MiB.
export const MAX_DOCUMENT_BYTES = 2*1024*1024; // Bound parsed text/spreadsheet decompression.
export const allowedTypes = ["text/plain","text/csv","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/pdf","image/jpeg","image/png","image/webp"] as const;
export const attachmentInput = z.strictObject({
 filename:z.string().trim().min(1).max(150),
 mimeType:z.enum(allowedTypes),
 bytes:z.number().int().min(1).max(MAX_BYTES),
}).refine(input=>!["text/plain","text/csv","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(input.mimeType)
  ||input.bytes<=MAX_DOCUMENT_BYTES,{message:"document_too_large",path:["bytes"]});
export function safeFileName(name:string):string {
 return name.replace(/[^a-zA-Z0-9._-]/g,"_").replace(/^\.+/,"file").slice(0,90)||"file";
}
export function verifySignature(type:string,bytes:Uint8Array):boolean {
 if(type==="application/pdf")return bytes.length>5&&String.fromCharCode(...bytes.slice(0,5))==="%PDF-";
 if(type==="image/png")return [137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x);
 if(type==="image/jpeg")return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(type==="image/webp")return String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&
   String.fromCharCode(...bytes.slice(8,12))==="WEBP";
 if(type==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")return bytes.length>64&&
  bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04;
 if(type==="text/plain"||type==="text/csv"){
  try{const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
   return !text.includes("\u0000")&&!text.trimStart().startsWith("<");}
  catch{return false;}
 }
 return false;
}
export type StoredAttachment = {id:string;originalName:string;mediaType:string;bytes:number;createdAt:string;processingState:"stored_unanalysed"};
