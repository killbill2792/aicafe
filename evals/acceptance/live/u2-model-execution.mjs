#!/usr/bin/env node
/** U2 live acceptance through the existing authenticated Supervisor and trusted native-tool broker. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw Error("u2_model_execution_live:"+code)};
const query=async(db,sql,args=[]) => (await db.query(sql,args)).rows;
const day=(date,timezone)=>{
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
  timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"
 }).formatToParts(date).map(p=>[p.type,p.value]));
 return parts.year+"-"+parts.month+"-"+parts.day;
};
async function login(browser,cafe){
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
 return {context,page};
}
async function createThread(context){
 const response=await context.request.post("/api/ai/threads",{
  headers:{Origin:"http://127.0.0.1:3000"},
  data:{requestId:randomUUID(),title:"U2 disposable model execution"}});
 if(response.status()!==201)fail("thread_creation_failed");
 const data=await response.json();
 if(!/^[0-9a-f-]{36}$/i.test(data.thread?.id??""))fail("thread_identity_missing");
 return data.thread.id;
}
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async({thread,text,clientMessageId})=>{
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),180000);
  let buffer="",done=null,error=null;const names=[];
  let diagnosticStage=null,diagnosticEndReason=null,diagnosticModelCalls=null,diagnosticProviderFailures=null;
  try{
   const response=await fetch("/api/ai/threads/"+thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:ac.signal,
    headers:{"content-type":"application/json"},
    body:JSON.stringify({text,locale:"en",attachmentIds:[],clientMessageId})});
   if(!response.ok||!response.body)return {error:"agent_http_"+response.status,names,done};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});
    let at;while((at=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,at).split("\n");buffer=buffer.slice(at+2);
     const ev=lines.find(v=>v.startsWith("event: "))?.slice(7);
     const raw=lines.find(v=>v.startsWith("data: "))?.slice(6);
     let data=null;try{data=JSON.parse(raw??"null")}catch{}
     if(ev==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(ev==="done"){done=data;break}
     if(ev==="error"){
      error=data?.code??"agent_error";diagnosticStage=data?.diagnosticStage??null;
      diagnosticEndReason=data?.diagnosticEndReason??null;
      diagnosticModelCalls=data?.diagnosticModelCalls??null;
      diagnosticProviderFailures=data?.diagnosticProviderFailures??null;break;
     }
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"missing_completed_turn"),
    diagnosticStage,diagnosticEndReason,diagnosticModelCalls,diagnosticProviderFailures};
  }catch{return {names,done,error:"transport_failed",diagnosticStage,diagnosticEndReason,diagnosticModelCalls,diagnosticProviderFailures}}
  finally{clearTimeout(timer)}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
    !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??"")){
  const reason=result.done?.endReason??result.diagnosticEndReason;
  const endReason=["complete","timeout","budget","provider_error","tool_errors"].includes(reason)?
   reason:"unknown";
  const validCode=typeof result.error==="string"&&/^[a-z][a-z0-9_-]{0,50}$/.test(result.error);
  const code=validCode?result.error:
   endReason!=="unknown"&&endReason!=="complete"?endReason:"model_incomplete";
  const calls=result.done?.usage?.modelCalls??result.diagnosticModelCalls;
  const reasons=result.done?.diagnosticProviderFailures??result.diagnosticProviderFailures;
  const providerFailures=Array.isArray(reasons)?reasons.slice(0,8).map(x=>[
   "max_output_tokens","content_filter","incomplete_other","missing_terminal","provider_failed","stream_error"
  ].includes(x)?x:"unknown"):[];
  console.log("u2_safe_model_failure",JSON.stringify({
   code,endReason,stage:["setup","model","persist","finish"].includes(result.diagnosticStage)?
     result.diagnosticStage:result.done?"completed_frame":"unknown",
   calls:Number.isSafeInteger(calls)&&calls>=0?calls:null,
   providerFailures,
   tools:result.names.filter(n=>[
    "get_menu_items","get_sales"].includes(n))
  }));
  fail("real_supervisor_"+code);
 }
 return {...result,clientMessageId};
}

export function matchedMoney(text,cents){
 const value=Number(cents);
 if(!Number.isSafeInteger(value)||value<0||typeof text!=="string")return false;
 const exact=(value/100).toFixed(2);
 return text.replace(/,/g,"").split(/[^0-9.]+/).includes(exact);
}
export function assertNativeReceipts(receipts){
 if(!Array.isArray(receipts)||receipts.length<2||receipts.some(r=>r.model!=="gpt-6-luna"||r.outcome!=="completed"||r.nativeSearch!==true||
  !Number.isSafeInteger(r.inputTokens)||r.inputTokens<=0||!Number.isSafeInteger(r.outputTokens)||r.outputTokens<0))
  fail("native_request_receipts_missing");
 if(!receipts.some(r=>Number.isSafeInteger(r.discoveryCalls)&&r.discoveryCalls>0))fail("hosted_discovery_not_observed");
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="u2-model-execution"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
  fail("trusted_shared_luna_candidate_required");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")fail("output_and_scope_required");
 const file=resolve(args[1]),scopeFile=resolve(args[3]),root=realpathSync(process.cwd());
 for(const name of [file,scopeFile]){
  const parent=realpathSync(dirname(name));
  if(parent===root||parent.startsWith(root+sep)||existsSync(name))fail("fresh_private_output_required");
 }
 if(file===scopeFile)fail("distinct_evidence_paths_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 const cafe=TEST_CAFES[0],other=TEST_CAFES[1];let connection,foreign;
 if(!cafe?.owner||!other?.owner||cafe.businessId===other.businessId)fail("two_disposable_cafes_required");
 await db.connect();
 try{
  const [menu]=await query(db,"select id,name,price_cents from public.menu_items where business_id=$1 and is_active=true and name='Latte' limit 1",[cafe.businessId]);
  const [sales]=await query(db,"select business_date::text day,net_sales_cents from public.daily_rollups where business_id=$1 and sales_data_status='actual' and business_date<$2::date and net_sales_cents>0 order by business_date desc limit 1",[cafe.businessId,day(new Date(),cafe.timezone)]);
  if(!menu||!sales)fail("independent_source_missing");
  connection=await login(browser,cafe);
  const thread=await createThread(connection.context);
  const run=async(question)=>{
   const actual=await ownerTurn(connection.page,thread,question);
   const messages=await query(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner' and client_message_id=$3",[cafe.businessId,thread,actual.clientMessageId]);
   if(messages.length!==1)fail("owner_message_missing");
   const usage=await readPersistedModelUsage(db,cafe.businessId,messages[0].id);
   requireObservedProductionModel(usage.model,"gpt-6-luna");
   const [metrics]=await query(db,"select execution_metrics from public.ai_usage_events where id=$1 and business_id=$2",[usage.id,cafe.businessId]);
   const receipts=metrics?.execution_metrics?.flatMap(b=>b.requests??[])??[];
   const reply=await query(db,"select structured_content from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and id=$3",[cafe.businessId,thread,actual.done.reply.id]);
   if(reply.length!==1)fail("persisted_reply_missing");
   const blocks=reply[0].structured_content;
   if(!Array.isArray(blocks)||blocks.some(b=>b.type==="proposal_card"||b.type==="experiment_card"))fail("unexpected_effect");
   return {replyId:actual.done.reply.id,calls:Number(usage.model_call_count),receipts,names:actual.names,text:blocks.filter(b=>b.type==="text").map(b=>b.text).join("")};
  };
  const first=await run("I'm assessing a second coffee shop. For "+sales.day+", what were this cafe's actual recorded net sales, and what is our current saved "+menu.name+" menu price? Give both as "+cafe.currency+" with two decimal places, then distinguish recorded facts from assumptions. Read only. Do not create or change anything.");
  if(!first.names.includes("get_menu_items")||!first.names.includes("get_sales"))fail("independent_business_reads_missing");
  if(!matchedMoney(first.text,menu.price_cents)||!matchedMoney(first.text,sales.net_sales_cents))fail("independent_money_oracle_failed");
  assertNativeReceipts(first.receipts);
  await connection.page.close();connection.page=await connection.context.newPage();
  await connection.page.goto("/en?thread="+encodeURIComponent(thread));
  const second=await run("Keep the same date and drink from my previous question. Repeat their actual saved prices and sales as "+cafe.currency+" with two decimal places. No changes.");
  if(!matchedMoney(second.text,menu.price_cents)||!matchedMoney(second.text,sales.net_sales_cents))fail("conversation_continuity_oracle_failed");
  foreign=await login(browser,other);
  const denied=await foreign.context.request.get("/api/ai/threads/"+thread);
  if(![401,403,404].includes(denied.status()))fail("foreign_thread_not_denied");
  const proposals=await query(db,"select count(*)::int n from public.supervisor_proposals where business_id=$1 and thread_id=$2",[cafe.businessId,thread]);
  if(proposals[0]?.n!==0)fail("read_only_effect_created");
  const scope={businessId:cafe.businessId,otherCafeId:other.businessId,ownerUserId:cafe.owner.userId,threadId:thread,menuId:menu.id,salesDay:sales.day,
   saleCents:String(sales.net_sales_cents),priceCents:String(menu.price_cents),firstReplyId:first.replyId,secondReplyId:second.replyId,
   expectedProviderCalls:first.calls+second.calls};
  writeFileSync(file,JSON.stringify({id:"u2-model-execution",schema_version:1,head_sha:env.HEAD_SHA,status:"passed",observed_model:"gpt-6-luna",checks:{nativeDiscovery:true,sourceMatch:true,continuity:true,foreignDenied:true,noEffect:true}})+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeFile,JSON.stringify(scope)+"\n",{mode:0o600,flag:"wx"});
 }finally{await foreign?.context.close().catch(()=>{});await connection?.context.close().catch(()=>{});await browser.close().catch(()=>{});await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"u2_model_execution_live:unknown");process.exitCode=1});
