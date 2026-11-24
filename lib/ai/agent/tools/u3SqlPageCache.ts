import "server-only";
import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import {serialize,deserialize} from "node:v8";
import type {ResearchSnapshot} from "./u3SqlCursor";

// A transport optimization, never a business-data ceiling. Large results,
// process changes and expiry use the existing exact snapshot revalidation.
// No persistent source copy, credentials, SQL or arguments are cached.
const MEMORY_BYTES=4*1024*1024;
const TTL_MS=45_000;
type RecordBuffer={data:Buffer;jsonBytes:number};
type EncryptedRecord={ciphertext:Buffer;iv:Buffer;tag:Buffer;jsonBytes:number};
type Entry={snapshot:ResearchSnapshot;records:EncryptedRecord[];bytes:number;expires:number;timer:ReturnType<typeof setTimeout>};
const recordCost=(data:Buffer)=>data.length+128;

export class ResearchPageCollector{
 private records:RecordBuffer[]|null=[];
 private bytes=0;
 constructor(private readonly capacity=MEMORY_BYTES){}
 add(row:unknown,jsonBytes:number){
  if(!this.records)return;
  const data=serialize(row),cost=recordCost(data);
  if(this.bytes+cost>this.capacity){this.records=null;return;}
  this.records.push({data,jsonBytes});this.bytes+=cost;
 }
 finish(){return this.records;}
}
export class ResearchPageCache{
 private readonly key=randomBytes(32);
 private entries=new Map<string,Entry>();
 private bytes=0;
 constructor(private readonly capacity=MEMORY_BYTES,private readonly ttl=TTL_MS,
  private readonly now=()=>Date.now()){}
 private remove(id:string){
  const entry=this.entries.get(id);
  if(!entry)return;
  clearTimeout(entry.timer);
  this.bytes-=entry.bytes;this.entries.delete(id);
 }
 remember(snapshot:ResearchSnapshot,records:RecordBuffer[]|null){
  if(!records||records.length!==snapshot.totalRows||!records.length)return;
  const cost=records.reduce((n,r)=>n+recordCost(r.data),256);
  if(cost>this.capacity)return;
  this.remove(snapshot.id);
  for(const id of this.entries.keys()){
   if(this.bytes+cost<=this.capacity)break;
   this.remove(id);
  }
  const encrypted=records.map(({data,jsonBytes})=>{
   const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key,iv);
   const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);
   return {ciphertext,iv,tag:cipher.getAuthTag(),jsonBytes};
  });
  const timer=setTimeout(()=>this.remove(snapshot.id),this.ttl);
  timer.unref?.();
  this.entries.set(snapshot.id,{snapshot:{...snapshot},records:encrypted,bytes:cost,expires:this.now()+this.ttl,timer});
  this.bytes+=cost;
 }
 read(snapshot:ResearchSnapshot,offset:number,limit:number|null,budget:number){
  const entry=this.entries.get(snapshot.id);
  if(!entry)return null;
  if(entry.expires<=this.now()){this.remove(snapshot.id);return null;}
  if(entry.snapshot.digest!==snapshot.digest||entry.snapshot.asOf!==snapshot.asOf||
   entry.snapshot.totalRows!==snapshot.totalRows)return null;
  const rows:unknown[]=[];let bytes=2;
  for(let i=offset;i<entry.records.length;i++){
   const record=entry.records[i],cost=record.jsonBytes+(rows.length?1:0);
   if((limit!==null&&rows.length===limit)||bytes+cost>budget)break;
   const decipher=createDecipheriv("aes-256-gcm",this.key,record.iv);
   decipher.setAuthTag(record.tag);
   rows.push(deserialize(Buffer.concat([decipher.update(record.ciphertext),decipher.final()])));
   bytes+=cost;
  }
  return {rows,totalRows:snapshot.totalRows,digest:snapshot.digest,
   truncated:offset+rows.length<snapshot.totalRows};
 }
}
export const researchPageCache=new ResearchPageCache();
