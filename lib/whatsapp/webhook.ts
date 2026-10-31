import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import {BUTTONS,normalizeRecipient} from "./transport";
export const MAX_WEBHOOK_BYTES=128*1024;
const idPattern=/^wamid\.[A-Za-z0-9_.:-]{1,240}$/;
const allowedButtons=new Set<string>(BUTTONS.map(b=>b.payload));
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>typeof v==="object"&&v!==null&&!Array.isArray(v);
const array=(v:unknown,max:number):unknown[]=>Array.isArray(v)&&v.length<=max?v:(()=>{throw new Error("malformed_event");})();
const string=(v:unknown,max:number):string=>{
  if(typeof v!=="string"||v.length===0||v.length>max)throw new Error("malformed_event");
  return v;
};
function secureEqual(a:string,b:string):boolean {
  const x=createHash("sha256").update(a).digest();
  const y=createHash("sha256").update(b).digest();
  return timingSafeEqual(x,y);
}
export function verifyChallenge(query:URLSearchParams,token:string|undefined):string|null {
  const challenge=query.get("hub.challenge");
  if(!token||query.get("hub.mode")!=="subscribe"||!challenge||
    !/^[A-Za-z0-9_-]{1,256}$/.test(challenge)||
    !secureEqual(query.get("hub.verify_token")??"",token))return null;
  return challenge;
}
export function verifySignature(bytes:Buffer,header:string|null,secret:string|undefined):boolean {
  if(!secret||!header||!/^sha256=[0-9a-f]{64}$/.test(header))return false;
  const digest=createHmac("sha256",secret).update(bytes).digest("hex");
  return timingSafeEqual(Buffer.from(header.slice(7),"hex"),Buffer.from(digest,"hex"));
}
export type Incoming={
  type:"message";phoneId:string;waId:string;wamid:string;kind:"text"|"button"|"image"|"document";
  text:string|null;payload:string|null;mediaId:string|null;providerAt:string;
}|{type:"status";wamid:string;state:"sent"|"delivered"|"read"|"failed"};
export function parseWebhook(bytes:Buffer,expectedPhoneId:string):Incoming[] {
  if(!bytes.length||bytes.length>MAX_WEBHOOK_BYTES)throw new Error("invalid_size");
  let data:unknown;
  try{data=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("malformed_event");}
  if(!object(data)||data.object!=="whatsapp_business_account")throw new Error("malformed_event");
  const result:Incoming[]=[];
  for(const entry of array(data.entry,20)){
    if(!object(entry))throw new Error("malformed_event");
    for(const change of array(entry.changes,20)){
      if(!object(change)||change.field!=="messages"||!object(change.value))throw new Error("malformed_event");
      const value=change.value;
      if(value.messaging_product!==undefined&&value.messaging_product!=="whatsapp")
        throw new Error("malformed_event");
      if(!object(value.metadata)||value.metadata.phone_number_id!==expectedPhoneId)
        throw new Error("wrong_sender");
      for(const msg of array(value.messages??[],100)){
        if(!object(msg))throw new Error("malformed_event");
        const wamid=string(msg.id,250);
        const waId=string(msg.from,16);
        const timestamp=string(msg.timestamp,12);
        if(!idPattern.test(wamid)||!normalizeRecipient(waId)||!/^[0-9]{9,12}$/.test(timestamp))
          throw new Error("malformed_event");
        const kind=msg.type;
        let text:string|null=null,payload:string|null=null,mediaId:string|null=null;
        if(kind==="text"&&object(msg.text))text=string(msg.text.body,4000);
        else if(kind==="button"&&object(msg.button))payload=string(msg.button.payload,100);
        else if(kind==="interactive"&&object(msg.interactive)&&
          msg.interactive.type==="button_reply"&&object(msg.interactive.button_reply))
          payload=string(msg.interactive.button_reply.id,100);
        else if((kind==="image"||kind==="document")&&object(msg[kind]))
          mediaId=string(msg[kind].id,255);
        else throw new Error("unsupported_event");
        if(payload&&!allowedButtons.has(payload))throw new Error("unsupported_event");
        if(text!==null&&text.trim().length===0)throw new Error("malformed_event");
        const normalizedKind=payload?"button":kind;
        if(normalizedKind!=="button"&&normalizedKind!=="text"&&
          normalizedKind!=="image"&&normalizedKind!=="document")throw new Error("unsupported_event");
        const providerAt=new Date(Number(timestamp)*1000);
        if(Number.isNaN(providerAt.getTime()))throw new Error("malformed_event");
        result.push({type:"message",phoneId:expectedPhoneId,waId,wamid,kind:normalizedKind,
          text,payload,mediaId,providerAt:providerAt.toISOString()});
      }
      for(const s of array(value.statuses??[],100)){
        if(!object(s))throw new Error("malformed_event");
        const wamid=string(s.id,250);
        if(!idPattern.test(wamid)||!["sent","delivered","read","failed"].includes(String(s.status)))
          throw new Error("unsupported_event");
        result.push({type:"status",wamid,state:s.status as "sent"|"delivered"|"read"|"failed"});
      }
      if(result.length>200)throw new Error("invalid_size");
    }
  }
  return result;
}
