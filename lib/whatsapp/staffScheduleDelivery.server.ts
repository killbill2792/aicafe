import "server-only";
import {TEST_PHONE_NUMBER_ID} from "./transport";
import {metaRejection,type SendResult} from "./transport.server";

export function staffProviderBlockers():string[] {
 const enabled=(name:string)=>process.env[name]==="true";
 const missing=[
  ...(!enabled("WHATSAPP_PROVIDER_SEND_ENABLED")?["WHATSAPP_PROVIDER_SEND_ENABLED"]:[]),
  ...(!enabled("WHATSAPP_POLICY_APPROVED")?["WHATSAPP_POLICY_APPROVED"]:[]),
  ...(!enabled("WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED")?["WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED"]:[]),
  ...(!enabled("WHATSAPP_STAFF_TEMPLATE_APPROVED")?["WHATSAPP_STAFF_TEMPLATE_APPROVED"]:[]),
 ];
 if(!process.env.META_WHATSAPP_TOKEN&&!process.env.WHATSAPP_TOKEN)missing.push("META_WHATSAPP_TOKEN");
 if(!/^[a-z][a-z0-9_]{0,100}$/.test(process.env.WHATSAPP_STAFF_SCHEDULE_TEMPLATE??""))
   missing.push("WHATSAPP_STAFF_SCHEDULE_TEMPLATE");
 // Existing signed webhook authenticates ONLY the developer test sender.
 // A real production sender needs its own independently reviewed webhook contract.
 if((process.env.WHATSAPP_PHONE_NUMBER_ID??TEST_PHONE_NUMBER_ID)!==TEST_PHONE_NUMBER_ID)
   missing.push("approved staff webhook sender");
 return missing;
}
/** Meta acceptance is NOT proof of delivery. An uncertain response cannot retry.
 * The single approved English body template must contain one text parameter for
 * the complete shift message; arbitrary text is never sent outside a 24h window. */
export async function sendStaffScheduleTemplate(to:string,message:string,
 send:typeof fetch=fetch):Promise<SendResult>{
 if(staffProviderBlockers().length)return {state:"failed",reason:"staff_provider_disabled"};
 if(!/^\+[1-9][0-9]{1,14}$/.test(to)||message.length<1||message.length>1000)
   return {state:"failed",reason:"invalid_staff_message"};
 const version=process.env.WHATSAPP_GRAPH_VERSION??"v21.0";
 if(!/^v\d{1,2}\.\d{1,2}$/.test(version))return {state:"failed",reason:"invalid_graph_version"};
 const token=process.env.META_WHATSAPP_TOKEN||process.env.WHATSAPP_TOKEN;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
 try {
  const response=await send(`https://graph.facebook.com/${version}/${TEST_PHONE_NUMBER_ID}/messages`,{
   method:"POST",signal:controller.signal,
   headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
   body:JSON.stringify({messaging_product:"whatsapp",to:to.slice(1),type:"template",
     template:{name:process.env.WHATSAPP_STAFF_SCHEDULE_TEMPLATE,
      language:{code:"en_US"},components:[{type:"body",
       parameters:[{type:"text",text:message}]}]}}),
  });
  if(response.status===429)return {state:"retry",reason:"rate_limited"};
  if(response.status>=500)return {state:"uncertain",reason:"provider_ambiguous"};
  if(!response.ok)return {state:"failed",reason:await metaRejection(response)};
  let body:unknown;
  try{body=await response.json();}catch{return {state:"uncertain",reason:"invalid_acceptance_response"};}
  const id=(body as {messages?:Array<{id?:unknown}>}|null)?.messages?.[0]?.id;
  return typeof id==="string"&&/^wamid\.[A-Za-z0-9_.:-]{1,240}={0,2}$/.test(id)
   ?{state:"accepted",wamid:id}:{state:"uncertain",reason:"missing_acceptance_id"};
 }catch{return {state:"uncertain",reason:"network_or_timeout_ambiguous"};}
 finally{clearTimeout(timeout);}
}
