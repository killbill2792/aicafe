import "server-only";
import {z} from "zod";

// This transport is deliberately not callable by an agent or browser.
// The approval handler must first atomically claim and audit the approved send.
const e164=z.string().regex(/^\+[1-9]\d{1,14}$/);
export type StaffWhatsAppResult=
 |{status:"prepared";reason:"disabled"|"missing_credentials"}
 |{status:"sent";messageId:string}
 |{status:"failed";reason:"provider_rejected"|"provider_unavailable"|"invalid_response"};

export async function sendApprovedStaffWhatsApp(
  recipient:string,template:string,
  opts:{fetcher?:typeof fetch;env?:Record<string,string|undefined>}={},
):Promise<StaffWhatsAppResult>{
 const env=opts.env??process.env;
 if(env.STAFF_WHATSAPP!=="true")return {status:"prepared",reason:"disabled"};
 if(!env.WHATSAPP_TOKEN||!env.WHATSAPP_PHONE_NUMBER_ID)
  return {status:"prepared",reason:"missing_credentials"};
 e164.parse(recipient);
 if(!/^[a-z][a-z0-9_]{0,127}$/.test(template))throw new Error("Invalid WhatsApp template");
 // Never use freeform messages outside an established WhatsApp service window.
 const payload={messaging_product:"whatsapp",to:recipient,type:"template",
  template:{name:template,language:{code:"en_US"}}};
 try{
  const response=await (opts.fetcher??fetch)(
   "https://graph.facebook.com/v22.0/"+encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)+"/messages",
   {method:"POST",headers:{"content-type":"application/json",
    authorization:"Bearer "+env.WHATSAPP_TOKEN},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  if(!response.ok)return {status:"failed",reason:"provider_rejected"};
  const result=await response.json() as {messages?:Array<{id?:unknown}>};
  const id=result.messages?.[0]?.id;
  return typeof id==="string"&&id.length>0&&id.length<256
   ?{status:"sent",messageId:id}:{status:"failed",reason:"invalid_response"};
 }catch{
  // Never auto-retry: a lost response might follow successful Meta acceptance.
  return {status:"failed",reason:"provider_unavailable"};
 }
}
