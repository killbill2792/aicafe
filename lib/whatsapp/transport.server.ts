import "server-only";
import {TEST_PHONE_NUMBER_ID,buildOutbound,type Outbound} from "./transport";
export type SendResult={state:"accepted";wamid:string}|{state:"retry"|"failed"|"uncertain";reason:string};
export type Channel="daily_brief"|"reply";
export function providerAllowed(kind:Channel):boolean {
  return process.env.WHATSAPP_PROVIDER_SEND_ENABLED==="true" &&
    process.env.WHATSAPP_POLICY_APPROVED==="true" &&
    (kind==="daily_brief" ? process.env.WHATSAPP_OWNER_BRIEF_SEND_ENABLED==="true" &&
      process.env.WHATSAPP_TEMPLATE_APPROVED==="true" :
      process.env.WHATSAPP_OWNER_REPLY_SEND_ENABLED==="true") &&
    Boolean(process.env.META_WHATSAPP_TOKEN||process.env.WHATSAPP_TOKEN) &&
    (process.env.WHATSAPP_PHONE_NUMBER_ID??TEST_PHONE_NUMBER_ID)===TEST_PHONE_NUMBER_ID;
}
/** API acceptance is NOT delivered. Timeouts/5xx/receipt ambiguity MUST NOT replay. */
export async function sendMeta(kind:Channel,to:string,outbound:Outbound,send:typeof fetch=fetch):
 Promise<SendResult> {
  if(!providerAllowed(kind)||((kind==="daily_brief")!==(outbound.kind==="daily_brief")))
    return {state:"failed",reason:"provider_disabled"};
  const body=buildOutbound(to,outbound);
  if(!body)return {state:"failed",reason:"invalid_payload"};
  const version=process.env.WHATSAPP_GRAPH_VERSION??"v21.0";
  if(!/^v[0-9]{1,2}\.[0-9]{1,2}$/.test(version))
    return {state:"failed",reason:"invalid_graph_version"};
  const token=process.env.META_WHATSAPP_TOKEN||process.env.WHATSAPP_TOKEN;
  const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),8000);
  try {
    const response=await send(`https://graph.facebook.com/${version}/${TEST_PHONE_NUMBER_ID}/messages`,{
      method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
      body:JSON.stringify(body),signal:ctrl.signal,
    });
    if(response.status===429)return {state:"retry",reason:"rate_limited"};
    // 5xx and HTTP success without a definitive provider id are ambiguous.
    if(response.status>=500)return {state:"uncertain",reason:"provider_ambiguous"};
    if(!response.ok)return {state:"failed",reason:"provider_rejected"};
    const receipt:unknown=await response.json();
    const id=(receipt as {messages?:{id?:unknown}[]}|null)?.messages?.[0]?.id;
    return typeof id==="string"&&/^wamid\.[A-Za-z0-9_.:-]{1,240}={0,2}$/.test(id)
      ?{state:"accepted",wamid:id}:{state:"uncertain",reason:"missing_acceptance_id"};
  }catch{return {state:"uncertain",reason:"network_or_timeout_ambiguous"};}
  finally{clearTimeout(timeout);}
}
