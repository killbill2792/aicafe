import {randomUUID,randomInt} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {writeFileSync,unlinkSync} from "node:fs";
import {resolve} from "node:path";
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
 const dueAt=Math.floor((Date.now()+240000)/60000)*60000;
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(dueAt)).map(p=>[p.type,p.value]));
 const expected={title:"Daily stock and supplier check",timezone,time:parts.hour+":"+parts.minute,
   localDate:parts.year+"-"+parts.month+"-"+parts.day,dueAt,quantity:randomInt(21,90),reference:"quote-"+randomUUID()};
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

/** A separate actual Vitest process imports the real routine dispatcher using
 * the repository's existing aliases and TS transform. No replacement scheduler.
 * The generated config is private temporary test configuration, not a tracked
 * production file. It selects just this test-only worker entrypoint. */
export async function scheduledTick(scope,timezone){
 const config=resolve(".task17c-"+randomUUID()+".config.mts");
 writeFileSync(config,'import base from "./vitest.config.ts";\nexport default {...base,test:{...base.test,include:["evals/acceptance/live/task17c-world.mjs"],maxWorkers:1}};\n',{flag:"wx",mode:0o600});
 let child;
 try{
  child=spawn(process.execPath,[resolve("node_modules/vitest/vitest.mjs"),"run","--config",config,"--pool=threads","--maxWorkers=1"],
    {cwd:process.cwd(),detached:true,stdio:"ignore",env:{...process.env,AICAFE_17C_TICK:JSON.stringify({businessId:scope.businessId,timezone})}});
  const exit=once(child,"exit");void exit.catch(()=>{});
  const timer=setTimeout(()=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,"SIGKILL");},120000);
  try{
   const [code,signal]=await exit;
   check(child.pid!==process.pid&&code===0&&!signal,"scheduled_worker_failed");
   return child.pid;
  }finally{clearTimeout(timer);}
 }finally{
  if(child?.pid&&child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,"SIGKILL");
  unlinkSync(config);
 }
}
export async function observeDueOccurrence(db,scope,expected,routineId){
 // No fake time, seeded occurrence, or altered lease. Wait on PostgreSQL time,
 // after the genuine chat-created routine is committed and the owner is offline.
 const [routine]=await rows(db,"select extract(epoch from updated_at)*1000 as updated_ms from public.supervisor_routines where business_id=$1 and id=$2",[scope.businessId,routineId]);
 check(routine&&Number(routine.updated_ms)<expected.dueAt,"routine_not_committed_before_due");
 const deadline=Date.now()+260000;
 for(;;){
  const [clock]=await rows(db,"select extract(epoch from clock_timestamp())*1000 as ms");
  if(Number(clock?.ms)>=expected.dueAt)break;
  check(Date.now()<deadline,"real_schedule_deadline");
  await new Promise(r=>setTimeout(r,250));
 }
 const firstPid=await scheduledTick(scope,expected.timezone);
 const read=()=>rows(db,"select run_id,local_date::text,revision,state,attempts,receipt_ref from public.supervisor_routine_occurrences where business_id=$1 and routine_id=$2 and local_date=$3",[scope.businessId,routineId,expected.localDate]);
 const before=await read();
 const secondPid=await scheduledTick(scope,expected.timezone);
 const after=await read();
 return {firstPid,secondPid,before,after};
}
if(process.env.AICAFE_17C_TICK){
 const {it,expect}=await import("vitest");
 it("real scheduled check while owner is offline",async()=>{
  const {assertLocalLiveEnvironment}=await import("./preflight.mjs");
  const {verifyCheckoutHead}=await import("./runner.mjs");
  assertLocalLiveEnvironment(process.env);verifyCheckoutHead(process.env.HEAD_SHA);
  check(process.env.AICAFE_SHARED_LUNA==="1"&&process.env.AICAFE_SHARED_LUNA_CANDIDATE==="1"&&process.env.AICAFE_SHARED_LUNA_SCENARIO==="17c","worker_trusted_runner_required");
  const scope=JSON.parse(process.env.AICAFE_17C_TICK);
  const {createClient}=await import("@supabase/supabase-js");
  const {dispatchRoutinesForBusiness}=await import("../../../lib/ai/supervisor/routines/dispatch.server.ts");
  const {enqueueInvestigationsForOwner}=await import("../../../lib/ai/supervisor/routines/investigation.server.ts");
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const actual=await dispatchRoutinesForBusiness(db,scope.businessId,scope.timezone,new Date(),enqueueInvestigationsForOwner);
  expect(actual.failed).toBe(0);
  expect(actual.routinesChecked).toBeGreaterThanOrEqual(1);
  // The real routine only checks recorded evidence and enqueues investigations.
  // This lane does not claim Luna investigated an unattended incident.
 },100000);
}
