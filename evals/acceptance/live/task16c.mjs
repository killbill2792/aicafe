#!/usr/bin/env node
/** Genuine Task16C owner permission acceptance through the registered
 * Supervisor on disposable migrated cafés. PR #520 owns provider isolation. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw Error("task16c_live:"+code);};
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
  headers:{Origin:local},data:{requestId:randomUUID(),title:"Disposable Task16C revocation proof"}});
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
async function measure(){
 const env=process.env;
 assertLocalLiveEnvironment(env);
 verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="16c"||
    env.AICAFE_SHARED_LUNA_HEAD!==env.HEAD_SHA)
   fail("trusted_shared_scenario_required");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
   fail("separate_private_proof_paths_required");
 const files=[resolve(args[1]),resolve(args[3])];
 const repoRoot=realpathSync(process.cwd()),outside=realpathSync("/proof");
 for(const file of files){
  if(!file.startsWith(outside+sep)||existsSync(file)||
     realpathSync(dirname(file))!==outside||file.startsWith(repoRoot+sep))
    fail("untrusted_proof_location");
 }
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const cafe=TEST_CAFES[0],foreign=TEST_CAFES[1];
 if(!cafe?.owner?.userId||!foreign?.owner?.userId||
    cafe.businessId===foreign.businessId)fail("two_disposable_cafes_required");
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let first=null,second=null;
 await db.connect();
 try{
  first=await login(browser,cafe);
  const thread=await createThread(first.context);
  // Upload through real signed-in private storage and owner-scoped metadata API.
  const upload=await first.context.request.post("/api/ai/threads/"+thread+"/attachments",{
   headers:{Origin:local},timeout:45_000,
   multipart:{file:{name:"task16c-quote.csv",mimeType:"text/csv",
    buffer:Buffer.from("item,quoted_price\nOat milk,47.00\n","utf8")}}});
  if(upload.status()!==201)fail("authenticated_file_upload_failed");
  const attachment=(await upload.json()).attachment?.id;
  if(!uuid(attachment))fail("private_file_id_missing");
  const good=await turn(first.page,thread,
   "Please read the attached supplier quote and separately check the saved café menu "+
   "and existing supplier purchase orders for oat milk. Use the canonical menu and "+
   "purchase-order records before answering. Do not send, approve or change anything.",
   [attachment]);
  if(good.error||good.done?.endReason!=="complete"||!uuid(good.done?.reply?.id)||
    !["get_menu_items","get_supplier_purchase_orders"].every(n=>good.names.includes(n)))
   fail("model_did_not_use_both_registered_readers");
  const own=await db.query("select id::text from public.ai_messages where "+
   "business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
   [cafe.businessId,thread,good.clientMessageId]);
  if(own.rows.length!==1)fail("saved_owner_turn_missing");
  const usage1=await readPersistedModelUsage(db,cafe.businessId,own.rows[0].id);
  requireObservedProductionModel(usage1.model,"gpt-6-luna");
  if(Number(usage1.model_call_count)<2)fail("genuine_multistep_provider_missing");

  const change=async body=>{
   const res=await first.context.request.post("/api/supervisor/access",{
    headers:{Origin:local},data:body});
   if(res.status()!==200)fail("owner_permission_write_unverified");
   const data=await res.json();
   if(data.allowed!==false||data.revision!==1)fail("owner_permission_revision_missing");
  };
  await change({kind:"attachment",enabled:false,attachmentId:attachment,revision:0});
  await change({kind:"public_web",enabled:false,revision:0});
  const rejected=await turn(first.page,thread,
   "Read this selected supplier quote again, without making any changes.",[attachment]);
  if(rejected.error!=="supervisor_file_access_revoked")
   fail("revoked_file_reached_model_or_wrong_denial");
  const denied=await turn(first.page,thread,
   "Check online news for a festival near this café. Use web_search to verify "+
   "public sources; if web research is disabled, report the exact limitation. "+
   "Make no changes.");
  if(denied.error||denied.done?.endReason!=="complete"||
     !denied.names.includes("web_search"))fail("model_did_not_attempt_blocked_web_search");
  const own2=await db.query("select id::text from public.ai_messages where "+
   "business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
   [cafe.businessId,thread,denied.clientMessageId]);
  if(own2.rows.length!==1)fail("web_restriction_owner_turn_missing");
  const usage2=await readPersistedModelUsage(db,cafe.businessId,own2.rows[0].id);
  requireObservedProductionModel(usage2.model,"gpt-6-luna");
  const saved=await db.query("select id from public.ai_messages where "+
   "business_id=$1 and owner_user_id=$2 and thread_id=$3 and role='supervisor'",
   [cafe.businessId,cafe.owner.userId,thread]);
  if(saved.rows.length<2)fail("owner_replies_not_persisted");
  // Other café's actual signed-in session cannot read or revoke this resource.
  second=await login(browser,foreign);
  const foreignRead=await second.context.request.get("/api/ai/threads/"+thread);
  if(foreignRead.status()===200)fail("cross_cafe_thread_leak");
  const foreignRevoke=await second.context.request.post("/api/supervisor/access",{
   headers:{Origin:local},data:{kind:"attachment",enabled:false,
     attachmentId:attachment,revision:0}});
  if(foreignRevoke.status()===200)fail("cross_cafe_permission_write_leak");
  const effect=await db.query("select count(*)::int as n from public.connector_provider_receipts "+
    "where business_id=$1 and owner_user_id=$2",[cafe.businessId,cafe.owner.userId]);
  if(Number(effect.rows[0]?.n)!==0)fail("unapproved_external_effect_receipt");
  const proof={schema_version:1,task:"16c",head_sha:env.HEAD_SHA,
   status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",
   model_calls:Number(usage1.model_call_count)+Number(usage2.model_call_count),
   selected_registered_tools:[...new Set([...good.names,...denied.names])].sort(),
   owner_selected_file_read:true,file_revoked_before_second_model:true,
   public_web_revocation_observed:true,foreign_cafe_denied:true,
   no_unapproved_external_effect:true,feature_proven:false,
   integrated_proven:false,released_proven:false};
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,
    foreignBusinessId:foreign.businessId,threadId:thread,attachmentId:attachment,
    expectedProviderCalls:proof.model_calls};
  writeFileSync(files[0],JSON.stringify(proof)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(files[1],JSON.stringify(scope)+"\n",{mode:0o600,flag:"wx"});
  console.log("Task16C genuine registered-Supervisor source and revocation case passed; private proof ready");
 }finally{
  await second?.context.close().catch(()=>{});
  await first?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  // Do not delete: trusted host independently reads disposable rows,
  // then the shared runner destroys the entire local instance.
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 measure().catch(e=>{console.error(e instanceof Error&&/^task16c_live:/.test(e.message)?
   e.message:"task16c_live:unverified_failure");process.exitCode=1;});
