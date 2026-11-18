#!/usr/bin/env node
/**
 * Task16A registered-Supervisor real Luna acceptance, via the shared owner-gated
 * runner from #520 only. The mandate is a disposable SQL read fixture: this
 * never claims a provider phone-OTP grant, nor touches a production café.
 */
import {randomUUID} from "node:crypto";
import {writeFileSync,existsSync,realpathSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw new Error("task16a_live:"+code);};
const expectedTools=["get_supervisor_permissions","manage_routine"];
async function query(db,sql,params=[]){return (await db.query(sql,params)).rows;}

async function login(browser,cafe){
 // Authenticate with the desktop-visible café header first, then verify the
 // actual Supervisor owner experience at a 390px mobile viewport.
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",
  serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30_000});
 await page.setViewportSize({width:390,height:844});
 return {context,page};
}
async function createThread(context){
 const response=await context.request.post("/api/ai/threads",{
  headers:{Origin:"http://127.0.0.1:3000"},
  data:{requestId:randomUUID(),title:"Task16A live permission and routine inspection"}});
 if(response.status()!==201)fail("authenticated_thread_creation_failed");
 const id=(await response.json()).thread?.id;
 if(typeof id!=="string"||!/^[a-f0-9-]{36}$/i.test(id))
  fail("authenticated_thread_identity_invalid");
 return id;
}
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async input=>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),170_000);
  let buffer="",done=null,error=null;const names=[];
  try{
   const response=await fetch("/api/ai/threads/"+input.thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:abort.signal,
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({text:input.text,locale:"en",attachmentIds:[],
      clientMessageId:input.clientMessageId})});
   if(!response.ok||!response.body)
    return {names,done,error:"agent_http_"+response.status};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});
    let end;
    while((end=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,end).split("\n");buffer=buffer.slice(end+2);
     const event=lines.find(line=>line.startsWith("event: "))?.slice(7);
     const value=lines.find(line=>line.startsWith("data: "));
     let data=null;try{data=JSON.parse(value?.slice(6)??"null");}catch{}
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break;}
     if(event==="error"){error=data?.code??"agent_error";break;}
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"stream_without_completion")};
  }catch{return {names,done,error:"transport_failed"};}
  finally{clearTimeout(timer);}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
   !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""))
  fail("real_registered_supervisor_turn_incomplete");
 return {...result,clientMessageId};
}
function evidencePath(flag,name){
 const args=process.argv.slice(2);
 const i=args.indexOf(flag);
 if(i<0||typeof args[i+1]!=="string"||!args[i+1])fail("missing_"+name+"_path");
 const p=resolve(args[i+1]),parent=realpathSync(dirname(p)),root=realpathSync(process.cwd());
 if(parent===root||parent.startsWith(root+sep)||existsSync(p))
  fail("private_fresh_"+name+"_path_required");
 return p;
}
async function measure(){
 const env=process.env;
 assertLocalLiveEnvironment(env);
 verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="16a"||
   env.SUPERVISOR_OPENAI_MODEL!=="gpt-6-luna")
  fail("shared_owner_authorization_required");
 if(process.argv.slice(2).length!==4)fail("two_private_outputs_required");
 const proofPath=evidencePath("--output","proof");
 const scopePath=evidencePath("--scope-output","scope");
 if(proofPath===scopePath)fail("distinct_private_outputs_required");
 const [{default:pg},{chromium}]=await Promise.all([
  import("pg"),import("@playwright/test")]);
 const first=TEST_CAFES[0],foreign=TEST_CAFES[1];
 if(!first?.owner||!foreign?.owner||first.businessId===foreign.businessId)
  fail("disposable_two_cafes_required");
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 const mandateId=randomUUID(),routineId=randomUUID();
 let owner=null,outsider=null;
 await db.connect();
 try{
  owner=await login(browser,first);
  const threadId=await createThread(owner.context);
  const scope={businessId:first.businessId,ownerUserId:first.owner.userId,
   threadId,mandateId,routineId,foreignBusinessId:foreign.businessId};
  // The saved mandate is a read fixture ONLY, not a simulated or claimed
  // provider-verified phone delivery. No grant/OTP function is called here.
  await query(db,"insert into public.supervisor_mandates("+
   "id,revision,business_id,owner_user_id,capability_id,capability_version,"+
   "policy_hash,limit_kind,limit_value,period_kind,expires_at,verified_at) "+
   "values($1,1,$2,$3,'leo.goal.v1',1,$4,'count',5,'cafe_day',"+
   "now()+interval '1 day',now())",
   [mandateId,first.businessId,first.owner.userId,"a".repeat(64)]);
  await query(db,"insert into public.supervisor_routines("+
   "id,business_id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status)"+
   " values($1,$2,$3,$4,'Daily source check','daily','{}'::integer[],'08:00',"+
   "(select timezone from public.businesses where id=$2),'active')",
   [routineId,first.businessId,first.owner.userId,threadId]);

  const before=await query(db,"select id,revision,revoked_at from public.supervisor_mandates "+
   "where id=$1 and business_id=$2",[mandateId,first.businessId]);
  if(before.length!==1||Number(before[0].revision)!==1||before[0].revoked_at)
   fail("real_scoped_mandate_fixture_missing");
  const turn=await ownerTurn(owner.page,threadId,
   "Please check my actual CURRENT standing Supervisor permissions AND list my saved "+
   "recurring routines. Use the authoritative permission reader and the saved-routines "+
   "list tool, not memory. Explain the five-per-day goal limit and which changes still "+
   "need a fresh approval. This is read-only: do not grant, revoke or change anything.");
  for(const tool of expectedTools)
   if(!turn.names.includes(tool))fail("model_did_not_select_"+tool);
  if(turn.names.some(name=>!expectedTools.includes(name)))
   fail("unrequested_effectful_or_extra_tool");
  const ownerRows=await query(db,"select id from public.ai_messages "+
   "where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
   [first.businessId,threadId,turn.clientMessageId]);
  if(ownerRows.length!==1)fail("verified_owner_message_not_saved");
  const usage=await readPersistedModelUsage(db,first.businessId,ownerRows[0].id);
  requireObservedProductionModel(usage.model,"gpt-6-luna");
  const providerCalls=Number(usage.model_call_count);
  if(providerCalls<2||providerCalls>18)fail("actual_model_calls_outside_shared_cap");
  const reply=await query(db,"select id from public.ai_messages "+
   "where business_id=$1 and owner_user_id=$2 and thread_id=$3 "+
   "and id=$4 and role='supervisor'",
   [first.businessId,first.owner.userId,threadId,turn.done.reply.id]);
  if(reply.length!==1)fail("real_model_reply_not_persisted");
  const after=await query(db,"select revision,revoked_at from public.supervisor_mandates "+
   "where id=$1 and business_id=$2",[mandateId,first.businessId]);
  if(after.length!==1||Number(after[0].revision)!==1||after[0].revoked_at)
   fail("model_changed_a_standing_permission");
  const routines=await query(db,"select revision,status from public.supervisor_routines "+
   "where id=$1 and business_id=$2",[routineId,first.businessId]);
  if(routines.length!==1||Number(routines[0].revision)!==1||routines[0].status!=="active")
   fail("model_changed_a_saved_routine");
  const proposals=await query(db,"select id from public.supervisor_proposals "+
   "where business_id=$1 and thread_id=$2",[first.businessId,threadId]);
  if(proposals.length)fail("model_created_unauthorized_proposal");

  // Existing real owner screen reads exactly the same canonical mandate/routine
  // as the model's owner-scoped tool, at a 390px phone viewport.
  await owner.page.goto("/en?thread="+encodeURIComponent(threadId));
  const controls=owner.page.getByRole("button",{name:"Library, routines and permissions"});
  await controls.waitFor({state:"visible",timeout:30_000});
  await controls.click();
  const panel=owner.page.getByRole("dialog",{name:"Supervisor controls"});
  await panel.getByRole("button",{name:"Permissions",exact:true}).click();
  await panel.getByText("Goal tracking",{exact:true}).first().waitFor({timeout:20_000});
  await panel.getByText("5 goal starts per café-local day").first().waitFor({timeout:20_000});
  await panel.getByRole("button",{name:"Routines",exact:true}).click();
  await panel.getByText("Daily source check").waitFor({timeout:20_000});
  const width=await owner.page.evaluate(()=>document.documentElement.scrollWidth);
  if(width>391)fail("real_owner_mobile_horizontal_overflow");

  outsider=await login(browser,foreign);
  const denied=await outsider.context.request.get("/api/ai/threads/"+threadId+"/mandates");
  if(![401,403,404].includes(denied.status()))
   fail("foreign_cafe_permission_read_not_denied");
  const otherRoutines=await outsider.context.request.get("/api/ai/supervisor/routines");
  if(otherRoutines.status()!==200)fail("foreign_cafe_routine_reader_failed");
  const otherJson=await otherRoutines.json();
  if(!Array.isArray(otherJson.routines)||otherJson.routines.some(r=>r.id===routineId))
   fail("foreign_cafe_routine_data_leak");

  const proof={schema_version:1,scenario:"16a",status:"passed",
   head_sha:env.HEAD_SHA,observed_model:usage.model,provider_calls:providerCalls,
   provider_selected_tools:[...new Set(turn.names)].sort(),
   genuine_owner_login:true,real_registered_supervisor:true,
   persisted_owner_reply:true,owner_mobile_controls_verified:true,
   foreign_cafe_authenticated_read_denied:true,
   negative_no_unapproved_effect:true,
   phone_mfa_provider_delivery:"not_tested_sql_fixture_only"};
  writeFileSync(proofPath,JSON.stringify(proof,null,2)+"\n",
   {mode:0o600,flag:"wx"});
  writeFileSync(scopePath,JSON.stringify({...scope,expectedProviderCalls:providerCalls},null,2)+"\n",
   {mode:0o600,flag:"wx"});
  console.log("Task16A shared Luna: local owner/model/permissions/routines DB and UI passed; real phone MFA not tested.");
 }finally{
  await outsider?.context.close().catch(()=>{});
  await owner?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 measure().catch(e=>{console.error(e instanceof Error?e.message:"task16a_live:unknown");process.exitCode=1;});
