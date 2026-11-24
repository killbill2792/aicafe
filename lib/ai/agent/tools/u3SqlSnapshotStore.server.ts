import "server-only";
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from "node:crypto";
import {serialize,deserialize} from "node:v8";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {U3SqlContext} from "./u3SqlResearch.server";
import type {ResearchSnapshot} from "./u3SqlCursor";

// Physical chunk size bounds a single encrypted RPC, not total research rows.
const CHUNK_BYTES=256*1024;
const scopeParts=(ctx:U3SqlContext)=>[ctx.businessId,ctx.ownerUserId,ctx.threadId,
 ctx.mode??"owner",ctx.sourceType??null,ctx.sourceId??null,ctx.runId??null,
 ctx.mode==="routine"||ctx.mode==="durable"?null:ctx.leaseToken??null];
function key(){
 const secret=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!secret||secret.length<24)throw Error("research_not_configured");
 return createHmac("sha256",secret).update("u3-query-snapshot-chunk-v1").digest();
}
const aad=(ctx:U3SqlContext,id:string,start:number,count:number)=>
 Buffer.from(JSON.stringify([...scopeParts(ctx),id,start,count]),"utf8");
export function encryptSnapshotChunk(ctx:U3SqlContext,id:string,start:number,rows:unknown[]){
 const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(),iv);
 cipher.setAAD(aad(ctx,id,start,rows.length));
 const bytes=Buffer.concat([cipher.update(serialize(rows)),cipher.final()]);
 return [iv,cipher.getAuthTag(),bytes].map(x=>x.toString("base64url")).join(".");
}
export function decryptSnapshotChunk(ctx:U3SqlContext,id:string,start:number,count:number,ciphertext:string):unknown[]{
 const parts=ciphertext.split(".");
 if(parts.length!==3)throw Error("invalid_snapshot_chunk");
 const [iv,tag,bytes]=parts.map(x=>Buffer.from(x,"base64url"));
 if(iv.length!==12||tag.length!==16)throw Error("invalid_snapshot_chunk");
 const cipher=createDecipheriv("aes-256-gcm",key(),iv);
 cipher.setAAD(aad(ctx,id,start,count));cipher.setAuthTag(tag);
 const rows:unknown=deserialize(Buffer.concat([cipher.update(bytes),cipher.final()]));
 if(!Array.isArray(rows)||rows.length!==count)throw Error("invalid_snapshot_chunk");
 return rows;
}
async function rpc(ctx:U3SqlContext,id:string,start:number,count:number|null,ciphertext:string|null){
 const {data,error}=await createAdminSupabaseClient().rpc("u3_query_snapshot_chunk",{
  p_business_id:ctx.businessId,p_owner_user_id:ctx.ownerUserId,p_thread_id:ctx.threadId,
  p_mode:ctx.mode??"owner",p_source_type:ctx.sourceType??null,p_source_id:ctx.sourceId??null,
  p_run_id:ctx.runId??null,p_lease_token:ctx.leaseToken??null,p_snapshot_id:id,
  p_start_row:start,p_row_count:count,p_ciphertext:ciphertext});
 if(error)throw Error("research_snapshot_storage_unavailable");
 return data;
}
/** Stream only complete authenticated observations; failure falls back to
 * replay, never silently omits a source row or creates a business ceiling. */
export class DurableResearchSpool{
 private rows:unknown[]=[];
 private bytes=0;
 private start=0;
 private available=true;
 constructor(private ctx:U3SqlContext,readonly id:string){}
 add(row:unknown,size:number){
  if(!this.available)return;
  this.rows.push(row);this.bytes+=size+32;
 }
 async flush(force=false){
  if(!this.available||!this.rows.length||!force&&this.bytes<CHUNK_BYTES)return;
  const rows=this.rows,start=this.start;
  this.rows=[];this.bytes=0;this.start+=rows.length;
  try{
   const data=await rpc(this.ctx,this.id,start,rows.length,encryptSnapshotChunk(this.ctx,this.id,start,rows));
   if(!data||typeof data!=="object"||!("stored" in data)||data.stored!==true)
    this.available=false;
  }catch{this.available=false;}
 }
}
export async function readDurableResearchPage(ctx:U3SqlContext,snapshot:ResearchSnapshot,offset:number,
 limit:number|null,budget:number){
 try{
  const rows:unknown[]=[];let bytes=2,position=offset;
  while(position<snapshot.totalRows&&(limit===null||rows.length<limit)){
   const raw=await rpc(ctx,snapshot.id,position,null,null);
   if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
   const d=raw as Record<string,unknown>,start=Number(d.start_row),count=Number(d.row_count);
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||count<1||
      start>position||start+count<=position||start+count>snapshot.totalRows||
      typeof d.ciphertext!=="string")return null;
   const chunk=decryptSnapshotChunk(ctx,snapshot.id,start,count,d.ciphertext);
   for(let i=position-start;i<chunk.length;i++){
    const row=chunk[i],size=Buffer.byteLength(JSON.stringify(row),"utf8")+(rows.length?1:0);
    if(limit!==null&&rows.length===limit||bytes+size>budget)
     return {rows,totalRows:snapshot.totalRows,digest:snapshot.digest,truncated:true};
    rows.push(row);bytes+=size;position++;
   }
  }
  return {rows,totalRows:snapshot.totalRows,digest:snapshot.digest,truncated:position<snapshot.totalRows};
 }catch{return null;}
}
