/** Owner-click-only staff communication outbox. An uncertain save must never
 * acquire a replacement nonce, even across a browser reload or changed form. */
import type {CrewOutboxStorage} from "./pendingSend";
export type OwnerPendingMessage={type:"message";employeeId:string;body:string;nonce:string};
export type OwnerPendingAssignment={type:"assignment";employeeId:string;
 workKind:"task"|"checklist";title:string;prompt:string;nonce:string};
export type OwnerPending=OwnerPendingMessage|OwnerPendingAssignment;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function ownerPendingKey(ownerId:string,businessId:string,type:OwnerPending["type"]){
 return "aicafe:owner:staff-channel:pending:v1:"+ownerId+":"+businessId+":"+type;
}
export function parseOwnerPending(raw:string|null,type:OwnerPending["type"]):OwnerPending|null{
 if(!raw)return null;
 try{
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const x=value as Record<string,unknown>;
  if(x.type!==type||typeof x.employeeId!=="string"||!uuid.test(x.employeeId)||
     typeof x.nonce!=="string"||!uuid.test(x.nonce))return null;
  if(type==="message"){
   if(typeof x.body!=="string"||!x.body.trim()||x.body.length>2000)return null;
   return {type:"message",employeeId:x.employeeId,body:x.body,nonce:x.nonce};
  }
  if((x.workKind!=="task"&&x.workKind!=="checklist")||
     typeof x.title!=="string"||!x.title.trim()||x.title.length>200||
     typeof x.prompt!=="string"||!x.prompt.trim()||x.prompt.length>2000)return null;
  return {type:"assignment",employeeId:x.employeeId,workKind:x.workKind,
   title:x.title,prompt:x.prompt,nonce:x.nonce};
 }catch{return null;}
}
export function loadOwnerPending(storage:CrewOutboxStorage,key:string,
 type:OwnerPending["type"]){return parseOwnerPending(storage.getItem(key),type);}
export function saveOwnerPending(storage:CrewOutboxStorage,key:string,
 pending:OwnerPending){storage.setItem(key,JSON.stringify(pending));}

/** The durable record includes local-only discriminators. Strict API schemas
 * DO NOT accept type/workKind. Project only the documented API inputs, never
 * send the outbox record itself. The original stored record stays untouched. */
export function ownerPendingApiPayload(operation:OwnerPending):
 |{employeeId:string;body:string;nonce:string}
 |{employeeId:string;kind:"task"|"checklist";title:string;prompt:string;nonce:string}{
 if(operation.type==="message")return {
  employeeId:operation.employeeId,body:operation.body,nonce:operation.nonce};
 return {employeeId:operation.employeeId,kind:operation.workKind,
  title:operation.title,prompt:operation.prompt,nonce:operation.nonce};
}
