#!/usr/bin/env node
/** Real registered model scenario, not another paid runner.
 * Shared #520 owns provider authorization, broker and trusted readbacks. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
const fail=code=>{throw Error("task17b_live:"+code);};
const local="http://127.0.0.1:3000";
const uuid=x=>/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(x??"");
async function login(browser,cafe){
 const context=await browser.newContext({baseURL:local,serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30_000});
 return {context,page};
}
async function createThread(context){
 const res=await context.request.post("/api/ai/threads",{
  headers:{Origin:local},data:{requestId:randomUUID(),title:"Task17B routine and file owner journey"}});
 if(res.status()!==201)fail("thread_create_failed");
 const id=(await res.json()).thread?.id;
 if(!uuid(id))fail("thread_missing");
 return id;
}
async function turn(page,thread,text,attachmentIds=[]){
 const clientMessageId=randomUUID();
 const x=await page.evaluate(async input=>{
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),165_000);
  try{
   const r=await fetch("/api/ai/threads/"+input.thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:stop.signal,
    headers:{"content-type":"application/json"},
    body:JSON.stringify({text:input.text,locale:"en",
      clientMessageId:input.clientMessageId,attachmentIds:input.attachmentIds})});
   if(!r.ok||!r.body)return {error:"http_"+r.status,names:[],done:null};
   const rd=r.body.getReader(),decode=new TextDecoder();
   const names=[];let buffer="",done=null,error=null;
   while(!done&&!error){
    const frame=await rd.read();if(frame.done)break;
    buffer+=decode.decode(frame.value,{stream:true});
    let end;
    while((end=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,end).split("\n");buffer=buffer.slice(end+2);
     const event=lines.find(z=>z.startsWith("event: "))?.slice(7);
     const line=lines.find(z=>z.startsWith("data: "));
     let data=null;try{data=JSON.parse(line?.slice(6)??"null")}catch{}
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break}
     if(event==="error"){error=String(data?.code??"agent_error");break}
    }
   }
   await rd.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"incomplete")};
  }finally{clearTimeout(timer)}
 },{thread,text,attachmentIds,clientMessageId});
 return {...x,clientMessageId};
}

const id="17b-owner-security";
async function measure(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!==id||
    env.AICAFE_SHARED_LUNA_HEAD!==env.HEAD_SHA||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
   fail("trusted_shared_scenario_required");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
   fail("separate_private_proof_paths_required");
 const outputs=[resolve(args[1]),resolve(args[3])],outside=realpathSync("/proof"),root=realpathSync(process.cwd());
 if(outputs[0]===outputs[1])fail("distinct_outputs_required");
 for(const file of outputs)if(!file.startsWith(outside+sep)||existsSync(file)||realpathSync(dirname(file))!==outside||file.startsWith(root+sep))fail("untrusted_output");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const cafe=TEST_CAFES[0],foreign=TEST_CAFES[1];
 if(!cafe?.owner||!foreign?.owner||cafe.businessId===foreign.businessId)fail("two_disposable_cafes_required");
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let first=null,second=null;
 await db.connect();
 try{
  first=await login(browser,cafe);
  const thread=await createThread(first.context);
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId:thread,foreignBusinessId:foreign.businessId};
  const read=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const upload=await first.context.request.post("/api/ai/threads/"+thread+"/attachments",{
   headers:{Origin:local},timeout:45000,
   multipart:{file:{name:"routine-plan.csv",mimeType:"text/csv",
    buffer:Buffer.from("routine_title,cadence,local_time\nQuoteReview17B,daily,08:17\n","utf8")}}});
  if(upload.status()!==201)fail("owner_file_upload_failed");
  scope.attachmentId=(await upload.json()).attachment?.id;
  if(!uuid(scope.attachmentId))fail("private_file_missing");
  let providerCalls=0;
  const observed=new Set(),turns=[];
  async function checkedTurn(prompt,attachmentIds=[]){
   const result=await turn(first.page,thread,prompt,attachmentIds);
   if(result.error||result.done?.endReason!=="complete"||!uuid(result.done?.reply?.id)||!result.names.includes("manage_routine"))
     fail("routine_model_turn_incomplete_or_no_registered_tool");
   const owner=await read("select id from public.ai_messages where business_id=$1 and owner_user_id=$2 and thread_id=$3 and client_message_id=$4 and role='owner'",
    [scope.businessId,scope.ownerUserId,thread,result.clientMessageId]);
   if(owner.length!==1)fail("owner_turn_not_saved");
   const usage=await readPersistedModelUsage(db,scope.businessId,owner[0].id);
   requireObservedProductionModel(usage.model,"gpt-6-luna");
   if(!Number.isSafeInteger(Number(usage.model_call_count))||Number(usage.model_call_count)<2||Number(usage.input_tokens)<=0)fail("model_usage_unverified");
   providerCalls+=Number(usage.model_call_count);
   if(providerCalls>18)fail("shared_provider_cap_exceeded");
   result.names.forEach(n=>observed.add(n));turns.push(result.done.reply.id);
   return result;
  }
  async function state(revision,status,cadence,time,weekdays){
   const rows=await read("select id,title,revision,status,cadence,local_time::text,weekdays,timezone from public.supervisor_routines where business_id=$1 and owner_user_id=$2 and thread_id=$3",
    [scope.businessId,scope.ownerUserId,thread]);
   const r=rows[0];
   if(rows.length!==1||r.title!=="QuoteReview17B"||Number(r.revision)!==revision||r.status!==status||
     r.cadence!==cadence||r.local_time!==time+":00"||JSON.stringify([...r.weekdays].sort())!==JSON.stringify(weekdays)||r.timezone!==cafe.timezone||
     (scope.routineId&&r.id!==scope.routineId))fail("routine_state_mismatch_"+revision);
   scope.routineId=r.id;
  }
  const firstTurn=await checkedTurn("Please check my current standing Supervisor permissions, then set up the routine with the exact title, cadence and cafe-local time in my selected CSV. This authorizes saving that internal routine only. Tell me what it can and cannot do. Do not order, email, change prices or spend anything.",[scope.attachmentId]);
  if(!firstTurn.names.includes("get_supervisor_permissions"))fail("permission_reader_not_selected");
  await state(1,"active","daily","08:17",[]);
  await checkedTurn("Change that same routine to weekly on Mondays and Thursdays at 10:15 in my cafe's local timezone. Keep its exact name and save the edit now.");
  await state(2,"active","weekly","10:15",[1,4]);
  await checkedTurn("Pause that routine temporarily, please. Keep the schedule and name.");
  await state(3,"paused","weekly","10:15",[1,4]);
  await checkedTurn("Resume the same routine now; keep the schedule as it was.");
  await state(4,"active","weekly","10:15",[1,4]);
  await first.page.goto("/en?thread="+encodeURIComponent(thread));
  const control=first.page.getByRole("button",{name:"Library, routines and permissions"});
  await control.waitFor({timeout:30000});await control.click();
  const panel=first.page.getByRole("dialog",{name:"Supervisor controls"});
  await panel.getByRole("button",{name:"Routines",exact:true}).click();
  await panel.getByText("QuoteReview17B",{exact:true}).first().waitFor({timeout:20000});
  await checkedTurn("Permanently revoke QuoteReview17B now. I understand this is irreversible. Do not create any replacement.");
  await state(5,"revoked","weekly","10:15",[1,4]);
  const revoke=await first.context.request.post("/api/supervisor/access",{headers:{Origin:local},
   data:{kind:"attachment",enabled:false,attachmentId:scope.attachmentId,revision:0}});
  if(revoke.status()!==200)fail("owner_file_revoke_failed");
  const denied=await turn(first.page,thread,"Use my selected CSV again, read it only.",[scope.attachmentId]);
  if(denied.error!=="supervisor_file_access_revoked"||denied.names.length)fail("revoked_file_reached_model");
  second=await login(browser,foreign);
  const foreignRoutines=await second.context.request.get("/api/ai/supervisor/routines");
  const other=(await foreignRoutines.json()).routines;
  if(foreignRoutines.status()!==200||!Array.isArray(other)||other.some(r=>r.id===scope.routineId))fail("cross_cafe_routine_visible");
  const foreignAccess=await second.context.request.post("/api/supervisor/access",{headers:{Origin:local},
   data:{kind:"attachment",enabled:true,attachmentId:scope.attachmentId,revision:1}});
  if(foreignAccess.status()===200)fail("cross_cafe_attachment_authorized");
  if((await read("select id from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,thread])).length)fail("routine_created_unrequested_effect");
  if(turns.length!==5||new Set(turns).size!==5)fail("owner_reply_identity_missing");
  for(const reply of turns)if((await read("select id from public.ai_messages where id=$1 and business_id=$2 and owner_user_id=$3 and thread_id=$4 and role='supervisor'",[reply,scope.businessId,scope.ownerUserId,thread])).length!==1)fail("model_reply_not_persisted");
  scope.expectedProviderCalls=providerCalls;
  turns.forEach((reply,i)=>scope["reply"+(i+1)]=reply);
  writeFileSync(outputs[0],JSON.stringify({schema_version:1,scenario:id,head_sha:env.HEAD_SHA,status:"passed",observed_model:"gpt-6-luna",provider_calls:providerCalls,
   providerSelectedTools:[...observed].sort(),checks:{fileDerivedRoutine:true,revisionedLifecycle:true,realOwnerRoutinePanel:true,revokedFileDenied:true,foreignCafeDenied:true,noUnauthorizedProposal:true},
   limitations:["host independently attests final state and provider tool audit; intermediate transitions and owner UI are candidate checks","does not prove unattended routine execution or arbitrary filesystem/external delivery"]})+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(outputs[1],JSON.stringify(scope)+"\n",{mode:0o600,flag:"wx"});
 }finally{
  await second?.context.close().catch(()=>{});
  await first?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 measure().catch(e=>{console.error(e instanceof Error?e.message:"task17b_live:unknown");process.exitCode=1;});
