import {randomUUID,randomInt} from "node:crypto";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
const local="http://127.0.0.1:3000";
const check=(condition,code)=>{if(!condition)throw Error("task17c:"+code);};
export const rows=async(db,sql,args=[])=> (await db.query(sql,args)).rows;
export async function openOwner(browser,cafe){
 const context=await browser.newContext({baseURL:local,serviceWorkers:"block"});
 try{
  const page=await context.newPage();
  await page.goto("/en/login");
  await page.locator("#email").fill(cafe.owner.email);
  await page.locator("#login-password").fill(cafe.owner.password);
  await page.locator("form button[type=submit]").click();
  await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
  return {context,page};
 }catch(e){await context.close();throw e;}
}
export function profiles(){
 const [first,foreign]=TEST_CAFES;
 check(first?.owner&&foreign?.owner&&first.businessId!==foreign.businessId,"two_cafes_required");
 return {first,foreign};
}
export async function createThread(context){
 const r=await context.request.post("/api/ai/threads",{headers:{Origin:local},data:{requestId:randomUUID(),title:"Disposable cross-domain delegation"}});
 check(r.status()===201,"thread_create_failed");
 const id=(await r.json()).thread?.id;
 check(/^[0-9a-f-]{36}$/i.test(id??""),"thread_id_missing");
 return id;
}
export async function makeQuote(context,thread,timezone){
 const expected={title:"Daily stock and supplier check",timezone,time:"08:17",quantity:randomInt(21,90),reference:"quote-"+randomUUID()};
 const csv="item,quantity,reference\nOat milk,"+expected.quantity+","+expected.reference+"\n";
 const response=await context.request.post("/api/ai/threads/"+thread+"/attachments",{
  headers:{Origin:local},multipart:{file:{name:"supplier-quote.csv",mimeType:"text/csv",buffer:Buffer.from(csv)}}});
 check(response.status()===201,"file_upload_failed");
 const attachmentId=(await response.json()).attachment?.id;
 check(/^[0-9a-f-]{36}$/i.test(attachmentId??""),"attachment_id_missing");
 return {attachmentId,expected};
}
export async function delegate(page,thread,attachmentId,expected){
 // The owner delegates a business outcome, never specifies a tool or instructs
 // the model which data to return beyond the ordinary business request.
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async input=>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),165000);
  try{
   const r=await fetch("/api/ai/threads/"+input.thread+"/agent",{method:"POST",credentials:"same-origin",
    signal:abort.signal,headers:{"content-type":"application/json"},
    body:JSON.stringify({locale:"en",text:input.text,clientMessageId:input.clientMessageId,attachmentIds:[input.attachmentId]})});
   if(!r.ok||!r.body)return {done:null,names:[]};
   const rd=r.body.getReader(),decoder=new TextDecoder();let buffer="",done=null,error=false;const names=[];
   while(!done&&!error){
    const frame=await rd.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});let end;
    while((end=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,end).split("\n");buffer=buffer.slice(end+2);
     const event=lines.find(l=>l.startsWith("event: "))?.slice(7);
     const data=JSON.parse(lines.find(l=>l.startsWith("data: "))?.slice(6)??"null");
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break;}
     if(event==="error"){error=true;break;}
    }
   }
   await rd.cancel().catch(()=>{});return {done,names,error};
  }finally{clearTimeout(timer);}
 },{thread,attachmentId,clientMessageId,text:"Read this supplier quote and tell me the exact item, quantity and reference. Compare it with my current menu. Set up a daily internal café check named '"+expected.title+"' at "+expected.time+" café local time so I can keep on top of stock and suppliers. Do not send messages, order anything or change stock or prices."});
 check(!result.error&&result.done?.endReason==="complete"&&/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""),"real_turn_incomplete");
 check(result.names.includes("manage_routine")&&result.names.includes("get_menu_items"),"model_selected_tools_missing");
 return {...result,clientMessageId};
}
