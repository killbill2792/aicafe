import "server-only";
import type { OperatingTask } from "@/lib/operating/tasks";
export type Delivery = {sent:true;providerId:string}|{sent:false;reason:string};
export function notificationEnabled():boolean {
 return process.env.AI_CAFE_WHATSAPP_ENABLED==="true" &&
 Boolean(process.env.META_WHATSAPP_TOKEN) && Boolean(process.env.META_WHATSAPP_PHONE_ID) &&
 Boolean(process.env.CRON_SECRET);
}
/** Exact persisted task kind only. Never forward free-text employee or supplier data. */
export function safeTaskKind(task:Pick<OperatingTask,"kind"|"status">):string|null{
 if(task.status!=="needs_owner")return null;
 const labels:{[K in OperatingTask["kind"]]:string}={
  price_review:"menu price review",staff_coverage:"staff coverage",
  supply_check:"supply check",money_update:"money review",data_quality:"missing information",
 };
 return labels[task.kind]??null;
}
export async function deliverOwnerTemplate(
 phone:string,kind:string,
 send:typeof fetch=fetch,
):Promise<Delivery>{
 if(!notificationEnabled())return {sent:false,reason:"provider_unavailable"};
 if(!/^\+[1-9][0-9]{7,14}$/.test(phone))return {sent:false,reason:"invalid_destination"};
 if(!Object.values(["menu price review","staff coverage","supply check","money review","missing information"]).includes(kind))
  return {sent:false,reason:"invalid_task"};
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),10000);
 try{
  const result=await send(
   "https://graph.facebook.com/v22.0/"+encodeURIComponent(process.env.META_WHATSAPP_PHONE_ID!)+"/messages",{
    method:"POST",signal:controller.signal,
    headers:{"Authorization":"Bearer "+process.env.META_WHATSAPP_TOKEN!,"Content-Type":"application/json"},
    body:JSON.stringify({
     messaging_product:"whatsapp",to:phone,type:"template",
     template:{name:"ai_cafe_owner_task_alert",language:{code:"en_US"},
      components:[{type:"body",parameters:[{type:"text",text:kind}]}]},
    }),
   });
  if(!result.ok)return {sent:false,reason:"provider_rejected"};
  const data=await result.json() as {messages?:{id?:string}[]};
  const id=data.messages?.[0]?.id;
  return id?{sent:true,providerId:id}:{sent:false,reason:"no_delivery_receipt"};
 }catch{return {sent:false,reason:"network_error"};}
 finally{clearTimeout(timeout);}
}
